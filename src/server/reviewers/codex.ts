// Codex as a reviewer agent. When the author waits for review, Codex reviews the head
// commit in a throwaway checkout (read-only sandbox) and laatsux posts what it found as a
// GitHub-style review from the reviewer bot (named in settings, "codex" by default), which
// wakes the author's `pr wait`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../git.ts';
import { lineInDiff } from '../diff.ts';
import { now, type Actor, type CommentRow, type Priority, type PullRow, type ReviewRunRow, type Side } from '../db.ts';
import { checkPriority, HttpError, splitPriorityPrefix, type Ctx, type Service } from '../service.ts';
import { checkReviewerName, MAX_ITERATIONS_LIMIT, readSettings, type CodexSettings } from '../settings.ts';

export interface ModelInfo {
  slug: string;
  name: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
}

interface Finding {
  path: string;
  line: number;
  start_line: number | null;
  side: Side;
  body: string;
  priority: Priority | null;
}

interface Result {
  summary: string;
  comments: Finding[];
}

/** The shape Codex must answer in (OpenAI strict mode: every property required, nullable when optional). */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'comments'],
  properties: {
    summary: { type: 'string', description: 'Overall assessment in Markdown, one to three sentences.' },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'start_line', 'side', 'priority', 'body'],
        properties: {
          path: { type: 'string', description: 'File path relative to the repository root.' },
          line: { type: 'integer', description: 'Last line the comment is about.' },
          start_line: { type: ['integer', 'null'], description: 'First line of a multi-line comment, or null.' },
          side: { type: 'string', enum: ['RIGHT', 'LEFT'], description: 'RIGHT for new line numbers, LEFT for removed lines (old numbers).' },
          priority: {
            type: ['string', 'null'],
            enum: ['high', 'medium', 'low', null],
            description: 'high: must be fixed before merging (bugs, security). medium: should be fixed. low: minor improvement.',
          },
          body: { type: 'string', description: 'The comment in Markdown.' },
        },
      },
    },
  },
};

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** What the CLI calls an author agent running in Codex (see cliActor in src/config.ts). */
const CODEX_AUTHOR = 'codex-agent';
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** A review Codex is running on a pull request, or one it is about to start. */
export interface ReviewAtWork {
  status: 'IN_PROGRESS' | 'QUEUED';
  head_sha: string;
  /** Null while queued. */
  started_at: string | null;
}

export class CodexReviewer {
  /** What review_runs.reviewer calls this kind of reviewer; the name people see is a setting. */
  readonly engine = 'codex';
  private s: Service;
  private bin: string;
  private jobs = new Map<number, { runId: number; done: Promise<void>; abort: AbortController }>();
  /** Automatic reviews still deciding whether to start, and for which pull; shutdown waits for them too. */
  private deciding = new Map<Promise<void>, number>();
  private stopped = false;
  private onWaiting = (pullId: number) => this.consider(pullId);
  private catalog: { at: number; models: ModelInfo[] } | null = null;

  constructor(s: Service, bin = 'codex') {
    this.s = s;
    this.bin = bin;
  }

  /** The reviewer's identity: one actor, whose login follows the name in settings. */
  actor(): Actor {
    const id = Number(this.s.db.getMeta('codex_actor_id'));
    const known = id ? this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id) : undefined;
    if (known) return known;
    let name = this.settings().name;
    const taken = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', name);
    if (taken && !this.onlyReviewedForUs(taken)) {
      // Older CLIs called author agents running in Codex "codex". That author moves to the name
      // the CLI uses now, keeping its pull requests, so the agent can still work on them; if
      // that name exists too, both are the same kind of author and become one. A name the
      // reviewer can not take this way leaves it with "<name>-reviewer".
      if (taken.id !== this.s.viewer().id && name === 'codex') {
        const current = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', CODEX_AUTHOR);
        if (current) this.s.db.transaction(() => this.absorb(taken, current));
        else this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', CODEX_AUTHOR, taken.id);
      } else {
        const base = `${name}-reviewer`;
        name = base;
        for (let i = 2; this.s.db.get('SELECT 1 FROM actors WHERE login = ?', name); i++) name = `${base}-${i}`;
      }
    }
    const actor = this.s.db.actor(name, 'Bot');
    this.s.db.setMeta('codex_actor_id', String(actor.id));
    return actor;
  }

  /**
   * Give the reviewer a new name. Its earlier reviews keep belonging to it. A name that was
   * only ever used for this reviewer's reviews is folded in; one used by you or an author is refused.
   */
  rename(name: string): void {
    const me = this.actor();
    const login = checkReviewerName(name);
    if (me.login === login) return;
    const other = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', login);
    if (!other) {
      this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', login, me.id);
      return;
    }
    if (!this.onlyReviewedForUs(other)) {
      const who = other.id === this.s.viewer().id ? 'you' : 'someone else (an author agent or another reviewer)';
      throw new HttpError(422, `the name "${login}" is already used by ${who}; choose another`);
    }
    this.s.db.transaction(() => {
      this.absorb(other, me);
      this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', login, me.id);
    });
  }

  /** Move everything `other` did over to `me`, and drop `other`: two names for one actor. */
  private absorb(other: Actor, me: Actor): void {
    for (const [table, column] of [
      ['pulls', 'author_id'],
      ['revisions', 'actor_id'],
      ['reviews', 'author_id'],
      ['comments', 'author_id'],
      ['comments', 'resolved_by_id'],
      ['events', 'actor_id'],
    ]) {
      this.s.db.run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, me.id, other.id);
    }
    this.s.db.run('DELETE FROM actors WHERE id = ?', other.id);
  }

  /** Whether an actor has done nothing but post reviews that came from Codex runs. */
  private onlyReviewedForUs(a: Actor): boolean {
    if (a.id === this.s.viewer().id) return false;
    const db = this.s.db;
    if (db.get('SELECT 1 FROM pulls WHERE author_id = ?', a.id)) return false;
    if (db.get('SELECT 1 FROM comments WHERE author_id = ? AND review_id IS NULL', a.id)) return false;
    if (db.get('SELECT 1 FROM events WHERE actor_id = ?', a.id)) return false;
    return !db.get('SELECT 1 FROM reviews WHERE author_id = ? AND id NOT IN (SELECT review_id FROM review_runs WHERE review_id IS NOT NULL)', a.id);
  }

  /** Move off `login` if this reviewer holds it, so the human can have it. */
  releaseName(login: string): void {
    const id = Number(this.s.db.getMeta('codex_actor_id'));
    const me = id ? this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id) : undefined;
    if (!me || me.login !== login) return;
    const base = `${login}-reviewer`;
    let name = base;
    for (let i = 2; this.s.db.get('SELECT 1 FROM actors WHERE login = ?', name); i++) name = `${base}-${i}`;
    this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', name, me.id);
  }

  /** Begin reacting to authors who wait for review. */
  start(): void {
    // The human is set up before the reviewer picks a name, so they can never share one.
    this.s.claimViewerLogin();
    // Runs cut short by a server restart will never finish.
    this.s.db.run("UPDATE review_runs SET status = 'failed', error = 'The laatsux server stopped during the review.', finished_at = ? WHERE status = 'running'", now());
    // Earlier versions recorded the reviewer's login in review_runs; fold those identities into one.
    for (const { reviewer } of this.s.db.all<{ reviewer: string }>('SELECT DISTINCT reviewer FROM review_runs WHERE reviewer != ?', this.engine)) {
      const old = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', reviewer);
      const me = this.actor();
      this.s.db.transaction(() => {
        if (old && old.id !== me.id && this.onlyReviewedForUs(old)) this.absorb(old, me);
        this.s.db.run('UPDATE review_runs SET reviewer = ? WHERE reviewer = ?', this.engine, reviewer);
      });
    }
    // Earlier reviews carried the priority in the text ("[P1] ..."); move it into the field.
    const me = this.actor();
    for (const c of this.s.db.all<Pick<CommentRow, 'id' | 'body'>>('SELECT id, body FROM comments WHERE author_id = ? AND priority IS NULL', me.id)) {
      const split = splitPriorityPrefix(c.body);
      if (split.priority) this.s.db.update('comments', c.id, { priority: split.priority, body: split.body });
    }
    this.s.bus.on('author-waiting', this.onWaiting);
  }

  /** Stop reacting, kill running reviews and wait until they have recorded how they ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.s.bus.off('author-waiting', this.onWaiting);
    await Promise.allSettled([...this.deciding.keys()]);
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map((j) => j.done));
  }

  settings(): CodexSettings {
    return readSettings(this.s.db).codex;
  }

  isRunning(pullId: number): boolean {
    return this.jobs.has(pullId);
  }

  /**
   * The review running on this pull request, or the automatic one about to start: the author
   * started waiting, the decision is still being made, and nothing stands in its way.
   */
  atWork(pull: PullRow): ReviewAtWork | null {
    const job = this.jobs.get(pull.id);
    const run = job && this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', job.runId);
    if (run?.status === 'running') return { status: 'IN_PROGRESS', head_sha: run.head_sha, started_at: run.started_at };
    if ([...this.deciding.values()].includes(pull.id) && this.wouldReview(pull)) return { status: 'QUEUED', head_sha: pull.head_sha, started_at: null };
    return null;
  }

  runs(pull: PullRow): ReviewRunRow[] {
    return this.s.db.all<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? ORDER BY id', pull.id, this.engine);
  }

  /** How many automatic reviews this pull request gets: its own limit, or the setting. */
  limit(pull: PullRow): number {
    return pull.codex_max_iterations ?? this.settings().maxIterations;
  }

  /**
   * Raise (or lower, or with null reset) this pull request's limit. If the author is waiting
   * and the new limit allows it, Codex starts at once instead of at the author's next wait.
   */
  setLimit(ctx: Ctx, limit: number | null): number {
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_ITERATIONS_LIMIT)) {
      throw new HttpError(422, `the limit must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
    }
    this.s.db.update('pulls', ctx.pull.id, { codex_max_iterations: limit });
    this.s.emit(ctx.pull.id, 'updated', this.s.viewer());
    if ((this.s.waiters.get(ctx.pull.id) ?? 0) > 0) this.consider(ctx.pull.id);
    return limit ?? this.settings().maxIterations;
  }

  automaticReviews(pull: PullRow): number {
    return this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_runs WHERE pull_id = ? AND reviewer = ? AND trigger = 'auto' AND status = 'done'", pull.id, this.engine)!.n;
  }

  /** Decide in the background whether to review automatically (see maybeReview). */
  consider(pullId: number): void {
    const p = this.maybeReview(pullId)
      .catch((e) => console.error('codex review:', e))
      .finally(() => this.deciding.delete(p));
    this.deciding.set(p, pullId);
  }

  /** Review automatically if Codex is on, this head has not been tried, and the cap is not reached. */
  async maybeReview(pullId: number): Promise<void> {
    if (this.stopped || !this.settings().enabled || this.jobs.has(pullId)) return;
    const stale = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
    if (!stale || stale.state === 'closed') return;
    if (stale.author_id === this.actor().id) return;
    const repo = this.s.repoById(stale.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, stale.number);
    if (this.jobs.has(pullId) || !this.wouldReview(ctx.pull)) return;
    this.launch(ctx, 'auto');
  }

  /** Whether an automatic review of the pull request's head would start now. */
  private wouldReview(pull: PullRow): boolean {
    if (this.stopped || !this.settings().enabled || pull.state === 'closed' || pull.author_id === this.actor().id) return false;
    // One attempt per head, failed or not: a failure is retried by asking from the page.
    if (this.s.db.get('SELECT 1 FROM review_runs WHERE pull_id = ? AND reviewer = ? AND head_sha = ?', pull.id, this.engine, pull.head_sha)) return false;
    return this.automaticReviews(pull) < this.limit(pull);
  }

  /** Review now, whatever the settings say about automatic reviews. */
  request(ctx: Ctx): number {
    if (this.stopped) throw new HttpError(503, 'the server is shutting down');
    if (this.jobs.has(ctx.pull.id)) throw new HttpError(409, 'Codex is already reviewing this pull request');
    if (ctx.pull.state === 'closed') throw new HttpError(422, 'reopen the pull request first');
    return this.launch(ctx, 'manual');
  }

  private launch(ctx: Ctx, trigger: 'auto' | 'manual'): number {
    const settings = this.settings();
    const actor = this.actor();
    const runId = this.s.db.insert('review_runs', {
      pull_id: ctx.pull.id,
      reviewer: this.engine,
      head_sha: ctx.pull.head_sha,
      trigger,
      status: 'running',
      model: settings.model || null,
      effort: settings.effort || null,
      started_at: now(),
    });
    this.s.emit(ctx.pull.id, 'codex_started', actor);
    const abort = new AbortController();
    const done = this.review(ctx, runId, settings, trigger, abort.signal)
      .then(() => this.s.emit(ctx.pull.id, 'codex_finished', actor))
      .catch((e: Error) => {
        this.s.db.update('review_runs', runId, { status: 'failed', error: e.message.slice(0, 4000), finished_at: now() });
        this.s.emit(ctx.pull.id, 'codex_failed', actor);
      })
      .finally(() => this.jobs.delete(ctx.pull.id));
    this.jobs.set(ctx.pull.id, { runId, done, abort });
    return runId;
  }

  /** Wait for a running review (used by tests and shutdown). */
  async settle(pullId: number): Promise<void> {
    await this.jobs.get(pullId)?.done;
  }

  private async review(ctx: Ctx, runId: number, settings: CodexSettings, trigger: 'auto' | 'manual', signal: AbortSignal): Promise<void> {
    const { git } = ctx;
    const pull = ctx.pull;
    const dir = mkdtempSync(join(tmpdir(), 'laatsux-review-'));
    const checkout = join(dir, 'checkout');
    const schemaFile = join(dir, 'schema.json');
    const outFile = join(dir, 'review.json');
    try {
      await git.run(['worktree', 'add', '--detach', checkout, pull.head_sha]);
      writeFileSync(schemaFile, JSON.stringify(SCHEMA));
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', checkout, '--color', 'never', '--output-schema', schemaFile, '-o', outFile];
      if (settings.model) args.push('-m', settings.model);
      if (settings.effort) args.push('-c', `model_reasoning_effort="${settings.effort}"`);
      args.push('-');
      const input = await this.prompt(ctx, trigger, settings);
      const r = await run(this.bin, args, { cwd: checkout, input, allowFail: true, timeoutMs: RUN_TIMEOUT_MS, signal }).catch((e: Error) => {
        throw new Error(`could not run ${this.bin}: ${e.message}`);
      });
      if (signal.aborted) throw new Error('The laatsux server stopped during the review.');
      if (r.code !== 0) {
        const why = r.timedOut ? `timed out after ${RUN_TIMEOUT_MS / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
        throw new Error(`codex ${why}:\n${lastLines(r.stderr || r.stdout, 15)}`);
      }
      let result: Result;
      try {
        result = JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        throw new Error(`codex did not write a review:\n${lastLines(r.stderr || r.stdout, 15)}`);
      }
      await this.post(ctx, runId, result, settings, trigger);
    } finally {
      await git.run(['worktree', 'remove', '--force', checkout], { allowFail: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Post the findings as one review. Lines outside the diff cannot carry a comment, so they go in the body. */
  private async post(ctx: Ctx, runId: number, result: Result, settings: CodexSettings, trigger: 'auto' | 'manual'): Promise<void> {
    const { pull, git } = ctx;
    const rev = this.s.db.get<{ base_sha: string }>('SELECT base_sha FROM revisions WHERE pull_id = ? AND head_sha = ? ORDER BY seq DESC', pull.id, pull.head_sha);
    const files = await git.diff(rev?.base_sha ?? pull.base_sha, pull.head_sha);
    const inline: Finding[] = [];
    const loose: Finding[] = [];
    for (const raw of Array.isArray(result.comments) ? result.comments : []) {
      // Models write one-line comments as start_line == line, and sometimes give a range backwards.
      let [start, line] = [raw.start_line ?? null, raw.line];
      if (start !== null && start > line) [start, line] = [line, start];
      if (start === line) start = null;
      // The priority belongs in its field, even when the model writes "[P1] ..." in the text.
      const split = splitPriorityPrefix(String(raw.body ?? ''));
      let priority: Priority | null = split.priority;
      try {
        priority = checkPriority(raw.priority) ?? priority;
      } catch {}
      const c: Finding = { ...raw, body: split.body, priority, line, start_line: start, side: raw.side === 'LEFT' ? 'LEFT' : 'RIGHT' };
      const file = files.find((f) => f.path === c.path);
      const ok = file && Number.isInteger(c.line) && lineInDiff(file, c.side, c.line) && (c.start_line === null || lineInDiff(file, c.side, c.start_line));
      (ok ? inline : loose).push(c);
    }
    const n = trigger === 'auto' ? this.automaticReviews(pull) + 1 : null;
    const parts = [String(result.summary ?? '').trim() || (inline.length || loose.length ? 'Codex left comments.' : 'Codex found nothing to comment on.')];
    if (loose.length) {
      parts.push('**Comments on lines outside the diff**', loose.map((c) => `- \`${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\`${c.priority ? ` (${c.priority} priority)` : ''}: ${c.body.trim().replace(/\n/g, '\n  ')}`).join('\n'));
    }
    const model = [settings.model || 'default model', settings.effort ? `${settings.effort} effort` : null].filter(Boolean).join(', ');
    parts.push(`<sub>Codex (${model}) reviewed \`${pull.head_sha.slice(0, 7)}\`${n ? `, automatic review ${n} of ${this.limit(pull)}` : ', on request'}.</sub>`);
    const review = await this.s.createReview(
      ctx,
      {
        event: 'COMMENT',
        body: parts.join('\n\n'),
        commit_id: pull.head_sha,
        comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side, start_line: c.start_line, start_side: c.start_line ? c.side : null, body: c.body, priority: c.priority })),
      },
      this.actor(),
    );
    // Done as soon as the review is in, so nobody is told Codex is still at it while its checkout is removed.
    this.s.db.update('review_runs', runId, { status: 'done', review_id: review.id, finished_at: now() });
  }

  private async prompt(ctx: Ctx, trigger: 'auto' | 'manual', settings: CodexSettings): Promise<string> {
    const { pull } = ctx;
    const commits = await this.s.commits(ctx);
    const threads = (await this.s.threads(ctx, this.actor())).filter((t) => !t.pending && !t.resolved);
    const n = this.automaticReviews(pull) + 1;
    const out = [
      'You are reviewing a pull request before a person reviews it. The current directory is a checkout of its head commit.',
      '',
      `Title: ${pull.title}`,
      '',
      'Description:',
      pull.body.trim() || '(none)',
      '',
      `The pull request is everything between ${pull.base_sha} (where it branched off ${pull.base_ref}) and HEAD (${pull.head_sha}). Commits:`,
      ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.message.split('\n')[0]}`),
      '',
      `Run \`git diff ${pull.base_sha} HEAD\` to see the changes and read the surrounding code as needed. Do not modify any files.`,
      '',
      'Look for bugs, regressions, security problems, missing error handling, and changes that do not do what the description says. Mention missing tests only where they matter. Skip style preferences and anything a formatter or linter would catch. If the pull request is fine, say so in the summary and leave no comments.',
      '',
      'Give each comment a priority: high for bugs, security problems and anything that must be fixed before merging; medium for what should be fixed; low for minor improvements. Do not write the priority into the comment text.',
      '',
      'Each comment is about lines of the diff: changed lines or the three lines of context around them. Use side RIGHT and new line numbers, or side LEFT and old line numbers for removed lines. `line` is the last line; `start_line` is the first line of a range, or null. To propose a replacement, put a ```suggestion block in the body; it replaces lines start_line..line exactly.',
    ];
    if (threads.length) {
      out.push('', 'Open review threads (do not repeat them; mention in the summary if one is still not addressed):');
      for (const t of threads) {
        const where = t.root.subject_type === 'commit' ? `commit ${t.root.commit_id?.slice(0, 7)} message` : `${t.root.path}${t.root.line ? `:${t.root.line}` : ''}${t.placement.outdated ? ' (outdated)' : ''}`;
        out.push(`- ${where}`);
        for (const c of [t.root, ...t.replies]) out.push(`  ${this.s.db.actorById(c.author_id).login}: ${c.body.trim().replace(/\n/g, '\n    ')}`);
      }
    }
    if (trigger === 'auto' && n > 1) out.push('', `This is automatic review ${n} of at most ${this.limit(pull)}. Focus on what changed since the earlier reviews and whether their comments were addressed.`);
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------ catalog

  /** Models from `codex debug models`, cached; empty when Codex is not available. */
  async models(): Promise<ModelInfo[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.models;
    let models: ModelInfo[] = [];
    try {
      const r = await run(this.bin, ['debug', 'models'], { allowFail: true, timeoutMs: 30_000 });
      const data = JSON.parse(r.stdout);
      const list: any[] = Array.isArray(data) ? data : (data.models ?? []);
      models = list
        .filter((m) => m.slug && m.visibility !== 'hide')
        .map((m) => ({
          slug: String(m.slug),
          name: String(m.display_name ?? m.slug),
          description: String(m.description ?? ''),
          efforts: (m.supported_reasoning_levels ?? []).map((l: any) => String(l.effort ?? l)),
          defaultEffort: String(m.default_reasoning_level ?? ''),
        }));
    } catch {
      models = [];
    }
    this.catalog = { at: Date.now(), models };
    return models;
  }

  /** The efforts a model accepts, from the cached catalog (null when unknown). */
  efforts(model: string): string[] | null {
    const slug = model || this.defaults().model;
    const m = this.catalog?.models.find((x) => x.slug === slug);
    return m && m.efforts.length ? m.efforts : null;
  }

  /** What Codex uses when laatsux does not choose: the top-level settings in its config.toml. */
  defaults(): { model?: string; effort?: string } {
    const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    const top = text.split(/^\s*\[/m)[0];
    const get = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
    return { model: get('model'), effort: get('model_reasoning_effort') };
  }
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join('\n');
}
