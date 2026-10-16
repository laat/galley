// Codex as a reviewer agent. When the author waits for review, Codex reviews the head
// commit in a throwaway checkout (where it may run the tests, or read-only, as settings say)
// and laatsux posts what it found as a GitHub-style review from the reviewer bot (named in
// settings, "codex" by default), which wakes the author's `pr wait`.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Repo } from '../git.ts';
import { lineInDiff } from '../diff.ts';
import { now, type Actor, type CommentRow, type Priority, type PullRow, type ReviewRunRow, type Side } from '../db.ts';
import { checkPriority, HttpError, splitPriorityPrefix, type Ctx, type HeadStatus, type ReviewColumns, type Service } from '../service.ts';
import { checkReviewerName, MAX_ITERATIONS_LIMIT, readSettings, type CodexSettings } from '../settings.ts';
import { cacheEnv, installCommand } from './install.ts';

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

/** A change to a pull request's own reviewer settings, as the API takes it. Left out: unchanged; null: the setting. */
export interface ReviewerChange {
  enabled?: boolean | string | null;
  max_iterations?: number | string | null;
}

/** A reviewer's settings for one pull request: what is in effect, and its own values (null: the setting). */
export interface ReviewerConfig {
  enabled: boolean;
  max_iterations: number;
  overrides: { enabled: boolean | null; max_iterations: number | null };
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
/** Running the tests takes longer than reading. */
const TEST_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Codex's workspace-write sandbox: it writes only to the checkout and the TMPDIR it is given
 * beside it. Every setting is given here, or Codex takes it from the user's config.toml, where
 * writable_roots or network_access may open more. /tmp and the server's own TMPDIR are left
 * out, since repositories and other agents' worktrees can live there. The user's repository
 * stays read-only: Codex protects the checkout's .git and the worktree's git directory it
 * points to, and the rest of the repository is outside what it may write. Network is only for
 * installing dependencies: with it, code from the pull request could reach laatsux's API on
 * localhost and act as the user.
 */
function workspaceWrite(network: boolean): string[] {
  return [
    '-c',
    `sandbox_workspace_write.network_access=${network}`,
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
  ];
}

/**
 * Codex loads a trusted project's .codex/config.toml, whose MCP servers it starts outside the
 * sandbox, and on a writable checkout it marks the user's repository trusted in their
 * config.toml. Marking the checkout untrusted turns both off; it outranks the repository's
 * own trust.
 */
function untrusted(checkout: string): string[] {
  return ['-c', `projects={${JSON.stringify(checkout)}={trust_level="untrusted"}}`];
}

/** How installing the dependencies went, for the prompt. */
interface Installed {
  command: string;
  /** Why it failed; null when it worked. */
  failure: string | null;
  output: string;
}

/** Heads the list of findings on lines outside the diff in a review's body. */
const OUTSIDE_THE_DIFF = '**Comments on lines outside the diff**';
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

  /** Its section of the Settings page. */
  settingsUrl(): string {
    return '/settings#codex';
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
    // Runs from before findings were counted: count them from the review each posted, its
    // comments and the findings its body lists. Without a review the count stays unknown.
    for (const run of this.s.db.all<{ id: number; review_id: number }>("SELECT id, review_id FROM review_runs WHERE status = 'done' AND findings IS NULL AND review_id IS NOT NULL")) {
      const review = this.s.db.get<{ body: string }>('SELECT body FROM reviews WHERE id = ?', run.review_id);
      if (!review) continue;
      const inline = this.s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE review_id = ?', run.review_id)!.n;
      this.s.db.update('review_runs', run.id, { findings: inline + outsideTheDiff(review.body) });
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

  /**
   * Whether Codex is done with the pull request's head: its latest review of the commit found
   * nothing, it has used up its automatic reviews, or it is off for the pull request. A failed
   * review of the commit holds things up until someone asks for another one.
   */
  headStatus(pull: PullRow): HeadStatus {
    const work = this.atWork(pull);
    if (work) return { state: work.status === 'QUEUED' ? 'queued' : 'reviewing', done: false, commit: work.head_sha };
    const commit = pull.head_sha;
    const last = this.attempt(pull);
    if (last?.status === 'failed') return { state: 'failed', done: false, commit };
    if (last?.status === 'done' && last.findings === 0) return { state: 'clean', done: true, commit };
    if (!this.enabled(pull)) return { state: 'off', done: true, commit };
    if (this.automaticReviews(pull) >= this.limit(pull)) return { state: 'capped', done: true, commit };
    // It found something in this commit and reviews the author's next one, or it reviews this one when the author waits.
    return { state: last ? 'findings' : 'unreviewed', done: false, commit };
  }

  /** How many automatic reviews this pull request gets: its own limit, or the setting. */
  limit(pull: PullRow): number {
    return pull.codex_max_iterations ?? this.settings().maxIterations;
  }

  /** Whether Codex reviews this pull request automatically: its own choice, or the setting. */
  enabled(pull: PullRow): boolean {
    return pull.codex_enabled === null ? this.settings().enabled : pull.codex_enabled === 1;
  }

  /** Whether a reviewer asked for by login (`pr create --reviewer`) is this one: "codex", or its name. */
  answersTo(login: string): boolean {
    const l = login.toLowerCase();
    return l === this.engine || l === this.actor().login.toLowerCase();
  }

  /** What is in effect for a pull request, and its own values (null where it follows the setting). */
  config(pull: PullRow): ReviewerConfig {
    return {
      enabled: this.enabled(pull),
      max_iterations: this.limit(pull),
      overrides: { enabled: pull.codex_enabled === null ? null : pull.codex_enabled === 1, max_iterations: pull.codex_max_iterations },
    };
  }

  /** Check a change to a pull request's own settings and give the columns that store it. Null goes back to the setting. */
  columns(change: ReviewerChange): ReviewColumns {
    const cols: ReviewColumns = {};
    if (change.enabled !== undefined) {
      const on = change.enabled;
      if (on !== null && on !== true && on !== false && on !== 'true' && on !== 'false') throw new HttpError(422, 'enabled must be true, false or null');
      cols.codex_enabled = on === null ? null : on === true || on === 'true' ? 1 : 0;
    }
    if (change.max_iterations !== undefined) {
      const raw = change.max_iterations;
      const limit = raw === null || raw === '' ? null : Number(raw);
      if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_ITERATIONS_LIMIT)) {
        throw new HttpError(422, `the limit must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
      }
      cols.codex_max_iterations = limit;
    }
    return cols;
  }

  /**
   * Change this pull request's own settings: turn automatic reviews on or off, raise or lower
   * the limit, or with null go back to the setting. If the author is waiting and Codex may now
   * review, it starts at once instead of at the author's next wait.
   */
  configure(ctx: Ctx, change: ReviewerChange): ReviewerConfig {
    this.s.db.update('pulls', ctx.pull.id, this.columns(change));
    this.s.emit(ctx.pull.id, 'updated', this.s.viewer());
    if ((this.s.waiters.get(ctx.pull.id) ?? 0) > 0) this.consider(ctx.pull.id);
    return this.config(this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', ctx.pull.id)!);
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

  /** Review automatically if Codex is on for this pull request, this head has not been tried, and the cap is not reached. */
  async maybeReview(pullId: number): Promise<void> {
    if (this.stopped || this.jobs.has(pullId)) return;
    const stale = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
    if (!stale || stale.state === 'closed' || !this.enabled(stale)) return;
    if (stale.author_id === this.actor().id) return;
    const repo = this.s.repoById(stale.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, stale.number);
    if (this.jobs.has(pullId) || !this.wouldReview(ctx.pull)) return;
    this.launch(ctx, 'auto');
  }

  /** Whether an automatic review of the pull request's head would start now. */
  private wouldReview(pull: PullRow): boolean {
    if (this.stopped || !this.enabled(pull) || pull.state === 'closed' || pull.author_id === this.actor().id) return false;
    // One attempt per head, failed or not: a failure is retried by asking from the page.
    if (this.attempt(pull)) return false;
    return this.automaticReviews(pull) < this.limit(pull);
  }

  /**
   * The latest review of the pull request's head, running, done or failed. A review whose
   * findings were never counted (one from an older version that could not be counted later)
   * does not count, so Codex reviews the commit again.
   */
  private attempt(pull: PullRow): ReviewRunRow | undefined {
    return this.s.db.get<ReviewRunRow>(
      "SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? AND head_sha = ? AND NOT (status = 'done' AND findings IS NULL) ORDER BY id DESC",
      pull.id,
      this.engine,
      pull.head_sha,
    );
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
    // The real path (/private/var, not /var), as Codex sees it, so the trust setting for the checkout applies.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laatsux-review-')));
    const checkout = join(dir, 'checkout');
    const schemaFile = join(dir, 'schema.json');
    const outFile = join(dir, 'review.json');
    // The one place besides the checkout that Codex may write to when it runs the tests.
    const tmp = join(dir, 'tmp');
    const timeoutMs = settings.runTests ? TEST_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
    try {
      await git.run(['worktree', 'add', '--detach', checkout, pull.head_sha]);
      writeFileSync(schemaFile, JSON.stringify(SCHEMA));
      let env: NodeJS.ProcessEnv | undefined;
      let installed: Installed | null = null;
      if (settings.runTests) {
        mkdirSync(tmp);
        env = cacheEnv(tmp);
        installed = await this.install(git, pull.head_sha, checkout, tmp, env, signal);
        if (signal.aborted) throw new Error('The laatsux server stopped during the review.');
      }
      const sandbox = settings.runTests ? ['-s', 'workspace-write', ...workspaceWrite(false)] : ['-s', 'read-only'];
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', ...sandbox, ...untrusted(checkout), '-C', checkout, '--color', 'never', '--output-schema', schemaFile, '-o', outFile];
      if (settings.model) args.push('-m', settings.model);
      if (settings.effort) args.push('-c', `model_reasoning_effort="${settings.effort}"`);
      args.push('-');
      const input = await this.prompt(ctx, trigger, settings, installed);
      const r = await run(this.bin, args, { cwd: checkout, env, input, allowFail: true, timeoutMs, signal }).catch((e: Error) => {
        throw new Error(`could not run ${this.bin}: ${e.message}`);
      });
      if (signal.aborted) throw new Error('The laatsux server stopped during the review.');
      if (r.code !== 0) {
        const why = r.timedOut ? `timed out after ${timeoutMs / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
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
      // Some tools leave read-only directories (Go's module cache), which neither git nor rmSync can remove.
      if (settings.runTests) await run('chmod', ['-R', 'u+w', dir], { allowFail: true });
      await git.run(['worktree', 'remove', '--force', checkout], { allowFail: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Install the checkout's dependencies before Codex starts, in its sandbox with network, from
   * the lockfile and without running the repository's scripts. Null when there is no lockfile.
   */
  private async install(git: Repo, sha: string, checkout: string, tmp: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Installed | null> {
    const how = await installCommand(git, sha, tmp);
    if (!how) return null;
    const command = how.command.join(' ');
    const args = ['sandbox', '-c', 'sandbox_mode="workspace-write"', ...workspaceWrite(true), ...untrusted(checkout), '--', ...how.command];
    try {
      const r = await run(this.bin, args, { cwd: checkout, env: { ...env, ...how.env }, allowFail: true, timeoutMs: INSTALL_TIMEOUT_MS, signal });
      const failure = r.code === 0 ? null : r.timedOut ? `timed out after ${INSTALL_TIMEOUT_MS / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
      return { command, failure, output: lastLines(`${r.stdout}\n${r.stderr}`, 20) };
    } catch (e) {
      return { command, failure: 'could not start', output: (e as Error).message };
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
      parts.push(OUTSIDE_THE_DIFF, loose.map((c) => `- \`${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\`${c.priority ? ` (${c.priority} priority)` : ''}: ${c.body.trim().replace(/\n/g, '\n  ')}`).join('\n'));
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
    this.s.db.update('review_runs', runId, { status: 'done', review_id: review.id, findings: inline.length + loose.length, finished_at: now() });
  }

  private async prompt(ctx: Ctx, trigger: 'auto' | 'manual', settings: CodexSettings, installed: Installed | null): Promise<string> {
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
      `Run \`git diff ${pull.base_sha} HEAD\` to see the changes and read the surrounding code as needed.${settings.runTests ? '' : ' Do not modify any files.'}`,
      '',
      ...(settings.runTests ? [...testInstructions(installed), ''] : []),
      'Look for bugs, regressions, security problems, missing error handling, and changes that do not do what the description says. Mention missing tests only where they matter. Skip style preferences and anything a formatter or linter would catch. If the pull request is fine, say so in the summary and leave no comments.',
      '',
      'Focus on problems this change introduces or makes reachable. An issue that was there before it, or one outside what the pull request sets out to do, is not a defect of this change: say in the comment that it is pre-existing or out of scope, and give it low priority.',
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

/** How many findings a review's body lists under OUTSIDE_THE_DIFF, one "- `path:line`" item each. */
function outsideTheDiff(body: string): number {
  const at = body.indexOf(OUTSIDE_THE_DIFF);
  if (at < 0) return 0;
  // The list is the paragraph after the heading; a finding's own lines are indented.
  const list = body.slice(at).split('\n\n')[1] ?? '';
  return list.split('\n').filter((l) => l.startsWith('- `')).length;
}

/** What Codex is told about the installed dependencies and running the tests. */
function testInstructions(installed: Installed | null): string[] {
  const indent = (text: string) => text.replace(/^/gm, '    ');
  const out = !installed
    ? ['No dependencies are installed: the repository root has no lockfile laatsux installs from (pnpm-lock.yaml, package-lock.json, yarn.lock or bun.lock).']
    : installed.failure
      ? [`laatsux could not install the dependencies: \`${installed.command}\` ${installed.failure}. Its output ended with:`, '', indent(installed.output)]
      : [`laatsux installed the dependencies with \`${installed.command}\`, which runs no install scripts, so a package that needs a build step may not work. Its output ended with:`, '', indent(installed.output)];
  out.push(
    '',
    "To check your findings, you may run the typecheck, tests or build with the repository's own tooling (its package scripts). There is no network, so you can not install anything: a check that fails for lack of network, a missing dependency or tool, or the sandbox is not a finding. You can write only to this checkout and $TMPDIR (point caches there). The checkout is thrown away after the review, so changes you make to it are lost: report findings only in your answer.",
  );
  return out;
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join('\n');
}
