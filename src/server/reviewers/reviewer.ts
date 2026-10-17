// A reviewer agent. When the author waits for review, it reviews the head commit in a throwaway
// checkout (where it may run the tests, or read-only, as settings say) and laatsux posts what it
// found as a GitHub-style review from its bot (named in settings), which wakes the author's
// `pr wait`. The tool that reviews is its Engine (codex.ts, claude.ts): how to run it, its
// models, and how to read its answer. The rest is the same for every tool, and lives here.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Repo, type RunResult } from '../git.ts';
import { lineInDiff } from '../diff.ts';
import { now, type Actor, type CancelReason, type CommentRow, type Priority, type PullRow, type ReviewRunRow, type Side } from '../db.ts';
import { checkPriority, HttpError, splitPriorityPrefix, stagingState, type Ctx, type HeadStatus, type ReviewColumns, type Service } from '../service.ts';
import { checkReviewerName, MAX_ITERATIONS_LIMIT, readSettings, REVIEWER_KINDS, type ReviewerKind, type ReviewerSettings } from '../settings.ts';
import { cacheEnv, installCommand } from './install.ts';
import { RunLog, type Progress, type ProgressEvent, type SessionUpdate } from './transcript.ts';

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

/** What a reviewer answers, in SCHEMA. */
export interface Answer {
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

/** The shape a reviewer must answer in (OpenAI strict mode: every property required, nullable when optional). */
export const SCHEMA = {
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

/** How installing the dependencies went, for the prompt. */
interface Installed {
  command: string;
  /** Why it failed; null when it worked. */
  failure: string | null;
  output: string;
}

/** A review for an engine to run: the checkout is ready, and so are its dependencies when it may run the tests. */
export interface EngineJob {
  /** The review's own directory, removed afterwards. The checkout is in it, and the engine may keep files there. */
  dir: string;
  checkout: string;
  /** The user's repository's git directory, which the checkout's .git points into: it stays read-only. */
  gitDir: string;
  /** The review's TMPDIR, beside the checkout, when it may run the tests; null when it only reads. */
  tmp: string | null;
  /** The environment to run in: caches and TMPDIR in `tmp` when it runs the tests. */
  env: NodeJS.ProcessEnv | undefined;
  prompt: string;
  settings: ReviewerSettings;
  timeoutMs: number;
  signal: AbortSignal;
  /** Hears what the tool does while it runs, as ACP session updates (transcript.ts). */
  onUpdate: (update: SessionUpdate) => void;
}

/** What a run cost, as the tool reports it: Claude Code the tokens and the cost, Codex the tokens. */
export interface RunUsage {
  cost_usd: number | null;
  /** Input tokens besides those written to and read from the prompt cache. */
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /** Turns of the conversation: the model's answers to the prompt and to its tools' results. */
  turns: number | null;
  duration_ms: number | null;
  /** The models that answered, as the tool names them. */
  models: string[];
}

/** A run that failed after the tool reported what it cost: the run keeps the cost with its error. */
export class EngineError extends Error {
  usage: RunUsage | null;
  constructor(message: string, usage: RunUsage | null) {
    super(message);
    this.usage = usage;
  }
}

/** An engine's answer, and what it cost when the tool says. */
export interface EngineResult {
  answer: Answer;
  usage: RunUsage | null;
}

/** A tool that reviews. It runs a review the reviewer has prepared and reads the answer; the reviewer does the rest. */
export interface Engine {
  /** The tool, as review_runs.reviewer, the settings, the pull request's columns and `…/pulls/{n}/reviewers/{engine}` name it. */
  readonly id: ReviewerKind;
  /** Its name in prose. */
  readonly label: string;
  /** What the CLI calls an author agent running in this tool (cliActor in src/config.ts): its own kind of agent. */
  readonly authorLogin: string;
  /** The tool such an author runs in, in prose. */
  readonly authorTool: string;
  /**
   * Run an install command in the checkout, in a sandbox with network that writes only to the
   * checkout and `tmp`, the TMPDIR in `env`.
   */
  install(command: string[], o: { checkout: string; tmp: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }): Promise<RunResult>;
  /** Run the review and read its answer, telling `job.onUpdate` what the tool does as it goes. Throws with what went wrong. */
  review(job: EngineJob): Promise<EngineResult>;
  /** Where its models come from, when they are read from the tool (`codex debug models`). */
  readonly catalogSource?: string;
  /** The models it offers, cached; empty when the tool is not available. */
  models(): Promise<ModelInfo[]>;
  /** The efforts a model accepts, from the cached catalog (null when unknown). */
  efforts(model: string): string[] | null;
  /** What the tool uses when laatsux does not choose. */
  defaults(): { model?: string; effort?: string };
}

/** Heads the list of findings on lines outside the diff in a review's body. */
export const OUTSIDE_THE_DIFF = '**Comments on lines outside the diff**';

/** A review the reviewer is running on a pull request, or one it is about to start. */
export interface ReviewAtWork {
  status: 'IN_PROGRESS' | 'QUEUED';
  head_sha: string;
  /** Null while queued. */
  started_at: string | null;
}

/** A review running on a pull request. */
interface Job {
  runId: number;
  done: Promise<void>;
  abort: AbortController;
  /** What it has done so far (transcript.ts). */
  log: RunLog;
}

export class Reviewer {
  /** What review_runs.reviewer calls this kind of reviewer; the name people see is a setting. */
  readonly engine: ReviewerKind;
  protected s: Service;
  protected tool: Engine;
  private jobs = new Map<number, Job>();
  /** Reviews still deciding whether to start, and for which pull; shutdown waits for them too. `resume`: one a stop interrupted (see resume). */
  private deciding = new Map<Promise<void>, { pullId: number; resume: boolean }>();
  private stopped = false;
  /** Cuts short the time stop() gives running reviews (see interrupt). */
  private hurry = new AbortController();
  private onWaiting = (pullId: number) => this.consider(pullId);

  constructor(s: Service, tool: Engine) {
    this.s = s;
    this.tool = tool;
    this.engine = tool.id;
  }

  /** The tool's name in prose ("Codex"). */
  get label(): string {
    return this.tool.label;
  }

  /** The meta key holding the reviewer's actor id. */
  private get actorKey(): string {
    return `${this.engine}_actor_id`;
  }

  /** The reviewer's identity: one actor, whose login follows the name in settings. */
  actor(): Actor {
    const id = Number(this.s.db.getMeta(this.actorKey));
    const known = id ? this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id) : undefined;
    if (known) return known;
    let name = this.settings().name;
    const taken = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', name);
    // A name the reviewer can not take leaves it with "<name>-reviewer".
    if (taken && !this.onlyReviewedForUs(taken) && !this.takeOver(taken, name)) {
      const base = `${name}-reviewer`;
      name = base;
      for (let i = 2; this.s.db.get('SELECT 1 FROM actors WHERE login = ?', name); i++) name = `${base}-${i}`;
    }
    const actor = this.s.db.actor(name, 'Bot');
    this.s.db.setMeta(this.actorKey, String(actor.id));
    return actor;
  }

  /** Make room for the reviewer under `name`, which `taken` has; false leaves `taken` as it is. */
  protected takeOver(_taken: Actor, _name: string): boolean {
    return false;
  }

  /** Its section of the Settings page. */
  settingsUrl(): string {
    return `/settings#${this.engine}`;
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
    if (other && !this.onlyReviewedForUs(other)) {
      const who = other.id === this.s.viewer().id ? 'you' : 'someone else (an author agent or another reviewer)';
      throw new HttpError(422, `the name "${login}" is already used by ${who}; choose another`);
    }
    this.unambiguous(login);
    if (!other) {
      this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', login, me.id);
      return;
    }
    this.s.db.transaction(() => {
      this.absorb(other, me);
      this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', login, me.id);
    });
  }

  /**
   * Refuse a name that `--reviewer` would take for another reviewer agent: its kind or its name,
   * in any case (see answersTo). Staging with it would turn on the other one.
   */
  private unambiguous(login: string): void {
    const l = login.toLowerCase();
    for (const kind of REVIEWER_KINDS) {
      if (kind === this.engine) continue;
      const id = Number(this.s.db.getMeta(`${kind}_actor_id`));
      const name = (id && this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id)?.login) || readSettings(this.s.db)[kind].name;
      if (l === kind || l === name.toLowerCase()) {
        const label = this.s.reviewerAgents().find((r) => r.engine === kind)?.label ?? kind;
        throw new HttpError(422, `"${login}" would ask for the ${label} reviewer (--reviewer ${login}); choose another`);
      }
    }
  }

  /** Move everything `other` did over to `me`, and drop `other`: two names for one actor. */
  protected absorb(other: Actor, me: Actor): void {
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

  /** Whether an actor has done nothing but post reviews that came from reviewer runs, and is no other reviewer. */
  protected onlyReviewedForUs(a: Actor): boolean {
    if (a.id === this.s.viewer().id) return false;
    const db = this.s.db;
    if (REVIEWER_KINDS.some((kind) => kind !== this.engine && db.getMeta(`${kind}_actor_id`) === String(a.id))) return false;
    if (db.get('SELECT 1 FROM pulls WHERE author_id = ?', a.id)) return false;
    if (db.get('SELECT 1 FROM comments WHERE author_id = ? AND review_id IS NULL', a.id)) return false;
    if (db.get('SELECT 1 FROM events WHERE actor_id = ?', a.id)) return false;
    return !db.get('SELECT 1 FROM reviews WHERE author_id = ? AND id NOT IN (SELECT review_id FROM review_runs WHERE review_id IS NOT NULL)', a.id);
  }

  /** Move off `login` if this reviewer holds it, so the human can have it. */
  releaseName(login: string): void {
    const id = Number(this.s.db.getMeta(this.actorKey));
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
    this.migrate();
    // Runs the server stopped under, or that were still running when it was killed, run again.
    this.s.db.run("UPDATE review_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND reviewer = ?", now(), this.engine);
    this.s.bus.on('author-waiting', this.onWaiting);
    this.resume();
  }

  /**
   * Run again the reviews asked for by hand that a stop interrupted, where the pull request is
   * still open and its head has not moved. An interrupted automatic review needs nothing: it
   * does not count as an attempt (see attempt), so the head is reviewed when the author waits.
   */
  private resume(): void {
    const runs = this.s.db.all<ReviewRunRow>(
      `SELECT r.* FROM review_runs r JOIN pulls p ON p.id = r.pull_id
        WHERE r.reviewer = ?1 AND r.status = 'interrupted' AND r.trigger = 'manual' AND r.head_sha = p.head_sha
          AND p.state != 'closed' AND COALESCE(p.github_state, 'open') = 'open'
          AND r.id = (SELECT MAX(id) FROM review_runs WHERE pull_id = r.pull_id AND reviewer = ?1)`,
      this.engine,
    );
    for (const run of runs) {
      // About to start from now on (see atWork), so nothing takes the reviewer for done meanwhile.
      const p: Promise<void> = this.rerun(run).then(
        () => void this.deciding.delete(p),
        (e: unknown) => {
          console.error(`${this.engine} review:`, e);
          this.deciding.delete(p);
          // It does not run again after all: failed, so it holds nothing up and can be asked for again.
          const error = String(e instanceof Error ? e.message : e).slice(0, 4000);
          this.s.db.run("UPDATE review_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'interrupted'", error, now(), run.id);
          this.s.emit(run.pull_id, `${this.engine}_failed`, this.actor());
        },
      );
      this.deciding.set(p, { pullId: run.pull_id, resume: true });
    }
  }

  /**
   * Run an interrupted review again, unless the branch moved on while the server was down, or
   * the pull request was closed or merged meanwhile. Published, it is asked about on GitHub first
   * (as following GitHub does on a timer), which records a merge or close there. When GitHub does
   * not answer, it runs, and a merge found later cancels it.
   */
  private async rerun(run: ReviewRunRow): Promise<void> {
    const known = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', run.pull_id)!;
    if (known.state === 'published') await this.s.followGithub({ due: true });
    const repo = this.s.repoById(known.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, known.number);
    if (this.stopped || this.jobs.has(run.pull_id) || stagingState(ctx.pull) === 'done' || ctx.pull.head_sha !== run.head_sha) return;
    this.launch(ctx, 'manual');
  }

  /** Bring what earlier versions stored up to date, before the reviewer starts. */
  protected migrate(): void {}

  /**
   * Stop reacting, give running reviews up to `graceMs` to post, then interrupt the rest, and
   * wait until they have recorded how they ended. Interrupted reviews run again when the server
   * starts. interrupt() cuts the time short.
   */
  async stop(graceMs = 0): Promise<void> {
    this.stopped = true;
    this.s.bus.off('author-waiting', this.onWaiting);
    await Promise.allSettled([...this.deciding.keys()]);
    const jobs = [...this.jobs.values()];
    const ended = Promise.allSettled(jobs.map((j) => j.done));
    if (graceMs > 0 && jobs.length && !this.hurry.signal.aborted) {
      await new Promise<void>((resolve) => {
        const end = () => {
          clearTimeout(timer);
          this.hurry.signal.removeEventListener('abort', end);
          resolve();
        };
        const timer = setTimeout(end, graceMs);
        this.hurry.signal.addEventListener('abort', end);
        ended.then(end);
      });
    }
    for (const job of this.jobs.values()) this.halt(job, 'interrupted');
    await ended;
  }

  /** Interrupt running reviews now, also while stop() gives them time to post. */
  interrupt(): void {
    this.hurry.abort();
  }

  /**
   * Cancel the review running on the pull request, for what just happened to it: closed here,
   * merged or closed on GitHub, published (which cancels only a review of the commit published),
   * or pushed to (only a review of an earlier commit). It does not count and does not run again;
   * the timeline says why. If the author is waiting, a review of its head is about to start before
   * anyone hears of the cancellation, so the author's wait goes on for it.
   */
  cancel(pull: PullRow, reason: CancelReason): void {
    const job = this.jobs.get(pull.id);
    const run = job && this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', job.runId);
    if (!job || run?.status !== 'running') return;
    if (reason === 'pushed' && run.head_sha === pull.head_sha) return;
    if (reason === 'published' && run.head_sha !== pull.published_source_sha) return;
    this.halt(job, 'cancelled', reason);
    this.s.addEvent(pull, this.actor(), 'review_cancelled', { head: run.head_sha, reason });
    if ((this.s.waiters.get(pull.id) ?? 0) > 0) this.consider(pull.id);
  }

  /**
   * Kill a running review, recorded as interrupted (it runs again when the server starts) or
   * cancelled. Recorded at once, so it is no longer at work for whatever is said next.
   */
  private halt(job: Job, status: 'interrupted' | 'cancelled', reason: CancelReason | null = null): void {
    this.s.db.run("UPDATE review_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ? AND status = 'running'", status, reason, now(), job.runId);
    // Its transcript ends here, and pages hear no more of its progress.
    job.log.finish();
    job.abort.abort(status);
  }

  settings(): ReviewerSettings {
    return readSettings(this.s.db)[this.engine];
  }

  isRunning(pullId: number): boolean {
    return this.jobs.has(pullId);
  }

  /** How many reviews are running, on all pull requests. */
  runningCount(): number {
    return this.jobs.size;
  }

  /**
   * The review running on this pull request, or one about to start: an automatic one (the author
   * started waiting, the decision is still being made, and nothing stands in its way), or one a
   * stop interrupted.
   */
  atWork(pull: PullRow): ReviewAtWork | null {
    const job = this.jobs.get(pull.id);
    const run = job && this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', job.runId);
    if (run?.status === 'running') return { status: 'IN_PROGRESS', head_sha: run.head_sha, started_at: run.started_at };
    const decisions = [...this.deciding.values()].filter((d) => d.pullId === pull.id);
    if (decisions.some((d) => d.resume) || (decisions.length && this.wouldReview(pull))) return { status: 'QUEUED', head_sha: pull.head_sha, started_at: null };
    return null;
  }

  /** The review running on this pull request, and what it has done so far. */
  live(pull: PullRow): { run: ReviewRunRow; progress: Progress } | null {
    const job = this.jobs.get(pull.id);
    const run = job && this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', job.runId);
    return job && run?.status === 'running' ? { run, progress: job.log.progress() } : null;
  }

  runs(pull: PullRow): ReviewRunRow[] {
    return this.s.db.all<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? ORDER BY id', pull.id, this.engine);
  }

  /**
   * Whether the reviewer is done with the pull request's head: its latest review of the commit
   * found nothing or was cancelled, it has used up its automatic reviews (or the reviewer stopped
   * them), or it is off for the pull request. A failed review of the commit holds things up until
   * someone asks for another one, unless automatic reviews are stopped: then only a running review
   * does, or one asked for by hand that a stop interrupted, until it has run again.
   */
  headStatus(pull: PullRow): HeadStatus {
    const work = this.atWork(pull);
    if (work) return { state: work.status === 'QUEUED' ? 'queued' : 'reviewing', done: false, commit: work.head_sha, startedAt: work.started_at };
    const commit = pull.head_sha;
    // It runs again when the server starts (see resume); an interrupted automatic review is just not an attempt.
    const latest = this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? ORDER BY id DESC', pull.id, this.engine);
    if (latest?.status === 'interrupted' && latest.trigger === 'manual' && latest.head_sha === commit) return { state: 'interrupted', done: false, commit };
    const last = this.attempt(pull);
    if (last?.status === 'failed' && !pull.iterations_stopped) return { state: 'failed', done: false, commit, failedAt: last.finished_at };
    if (last?.status === 'cancelled') return { state: 'cancelled', done: true, commit, cancelled: last.reason };
    if (last?.status === 'done' && last.findings === 0) return { state: 'clean', done: true, commit };
    if (!this.enabled(pull)) return { state: 'off', done: true, commit };
    const automatic = { used: this.automaticReviews(pull), limit: this.limit(pull) };
    // Stopped (Service.stopIterating), it has no automatic review left, whatever the counts say.
    if (automatic.used >= automatic.limit || pull.iterations_stopped) return { state: 'capped', done: true, commit, automatic };
    // It found something in this commit and reviews the author's next one, or it reviews this one when the author waits.
    return { state: last ? 'findings' : 'unreviewed', done: false, commit, automatic };
  }

  /** This pull request's own values, from its columns for this reviewer; null follows the setting. */
  own(pull: PullRow): { enabled: boolean | null; maxIterations: number | null } {
    const enabled = pull[`${this.engine}_enabled`];
    return { enabled: enabled === null ? null : enabled === 1, maxIterations: pull[`${this.engine}_max_iterations`] };
  }

  /** How many automatic reviews this pull request gets: its own limit, or the setting. */
  limit(pull: PullRow): number {
    return this.own(pull).maxIterations ?? this.settings().maxIterations;
  }

  /** Whether the reviewer reviews this pull request automatically: its own choice, or the settings. */
  enabled(pull: PullRow): boolean {
    return this.own(pull).enabled ?? this.bySettings(pull);
  }

  /** Whether the settings have the reviewer review this pull request automatically. */
  bySettings(pull: PullRow): boolean {
    return this.settings().enabled && !this.skips(pull);
  }

  /** Whether the settings leave this pull request to the other reviewers: it is by the reviewer's own kind of agent. */
  skips(pull: PullRow): boolean {
    return this.settings().skipOwnKind && this.s.db.actorById(pull.author_id).login === this.tool.authorLogin;
  }

  /** The tool its own kind of agent runs in ("Claude Code"), for saying what it skips. */
  get authorTool(): string {
    return this.tool.authorTool;
  }

  /** Where its models come from, when they are read from the tool. */
  get catalogSource(): string | undefined {
    return this.tool.catalogSource;
  }

  /** Whether a reviewer asked for by login (`pr create --reviewer`) is this one: its kind ("codex"), or its name. */
  answersTo(login: string): boolean {
    const l = login.toLowerCase();
    return l === this.engine || l === this.actor().login.toLowerCase();
  }

  /** What is in effect for a pull request, and its own values (null where it follows the setting). */
  config(pull: PullRow): ReviewerConfig {
    const own = this.own(pull);
    return { enabled: this.enabled(pull), max_iterations: this.limit(pull), overrides: { enabled: own.enabled, max_iterations: own.maxIterations } };
  }

  /** Check a change to a pull request's own settings and give the columns that store it. Null goes back to the setting. */
  columns(change: ReviewerChange): ReviewColumns {
    const cols: ReviewColumns = {};
    if (change.enabled !== undefined) {
      const on = change.enabled;
      if (on !== null && on !== true && on !== false && on !== 'true' && on !== 'false') throw new HttpError(422, 'enabled must be true, false or null');
      cols[`${this.engine}_enabled`] = on === null ? null : on === true || on === 'true' ? 1 : 0;
    }
    if (change.max_iterations !== undefined) {
      const raw = change.max_iterations;
      const limit = raw === null || raw === '' ? null : Number(raw);
      if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_ITERATIONS_LIMIT)) {
        throw new HttpError(422, `the limit must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
      }
      cols[`${this.engine}_max_iterations`] = limit;
    }
    return cols;
  }

  /**
   * Change this pull request's own settings: turn automatic reviews on or off, raise or lower
   * the limit, or with null go back to the setting. If the author is waiting and the reviewer
   * may now review, it starts at once instead of at the author's next wait.
   */
  configure(ctx: Ctx, change: ReviewerChange): ReviewerConfig {
    this.s.db.update('pulls', ctx.pull.id, this.columns(change));
    // A limit set by hand resumes stopped automatic reviews, as Resume does (which tells pages and reconsiders every reviewer).
    if (change.max_iterations === undefined || !this.s.resumeIterating(ctx, this.s.viewer())) {
      this.s.emit(ctx.pull.id, 'updated', this.s.viewer());
      if ((this.s.waiters.get(ctx.pull.id) ?? 0) > 0) this.consider(ctx.pull.id);
    }
    return this.config(this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', ctx.pull.id)!);
  }

  automaticReviews(pull: PullRow): number {
    return this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_runs WHERE pull_id = ? AND reviewer = ? AND trigger = 'auto' AND status = 'done'", pull.id, this.engine)!.n;
  }

  /** Automatic reviews done or running: the round the pull request is in, as far as this reviewer goes (Service.automaticRound). */
  automaticReviewsStarted(pull: PullRow): number {
    return this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_runs WHERE pull_id = ? AND reviewer = ? AND trigger = 'auto' AND status IN ('done', 'running')", pull.id, this.engine)!.n;
  }

  /** Decide in the background whether to review automatically (see maybeReview). */
  consider(pullId: number): void {
    const p = this.maybeReview(pullId)
      .catch((e) => console.error(`${this.engine} review:`, e))
      .finally(() => this.deciding.delete(p));
    this.deciding.set(p, { pullId, resume: false });
  }

  /** Review automatically if the reviewer is on for this pull request, this head has not been tried, and the cap is not reached. */
  async maybeReview(pullId: number): Promise<void> {
    if (this.stopped) return;
    // One at work is left to finish; one being cancelled ends first.
    const ending = this.jobs.get(pullId);
    if (ending && !ending.abort.signal.aborted) return;
    await ending?.done;
    if (this.stopped || this.jobs.has(pullId)) return;
    const stale = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
    if (!stale || stagingState(stale) === 'done' || !this.enabled(stale)) return;
    if (stale.author_id === this.actor().id) return;
    const repo = this.s.repoById(stale.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, stale.number);
    if (this.jobs.has(pullId) || !this.wouldReview(ctx.pull)) return;
    this.launch(ctx, 'auto');
  }

  /** Whether an automatic review of the pull request's head would start now: not once it is closed, here or on GitHub, or merged. */
  private wouldReview(pull: PullRow): boolean {
    if (this.stopped || !this.enabled(pull) || stagingState(pull) === 'done' || pull.author_id === this.actor().id) return false;
    // The reviewer stopped automatic reviews (Service.stopIterating); asking by hand still works.
    if (pull.iterations_stopped) return false;
    // One attempt per head, failed and cancelled ones too: a failure is retried by asking from the page. An interrupted one runs again.
    if (this.attempt(pull)) return false;
    return this.automaticReviews(pull) < this.limit(pull);
  }

  /**
   * The latest review of the pull request's head, running, done, failed or cancelled. One the
   * server stopped under does not count, nor does a review whose findings were never counted (one
   * from an older version that could not be counted later), so the reviewer reviews the commit again.
   */
  private attempt(pull: PullRow): ReviewRunRow | undefined {
    return this.s.db.get<ReviewRunRow>(
      "SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? AND head_sha = ? AND status != 'interrupted' AND NOT (status = 'done' AND findings IS NULL) ORDER BY id DESC",
      pull.id,
      this.engine,
      pull.head_sha,
    );
  }

  /** Review now, whatever the settings say about automatic reviews. */
  request(ctx: Ctx): number {
    if (this.stopped) throw new HttpError(503, 'the server is shutting down');
    if (this.jobs.has(ctx.pull.id)) throw new HttpError(409, `${this.label} is already reviewing this pull request`);
    if (ctx.pull.state === 'closed') throw new HttpError(422, 'reopen the pull request first');
    // Published, it can be reviewed again to check an update, until it is merged.
    if (ctx.pull.github_state === 'merged') throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
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
    this.s.emit(ctx.pull.id, `${this.engine}_started`, actor);
    const abort = new AbortController();
    // Progress is not a change: it wakes no `pr wait`, only pages showing the run.
    const log = new RunLog(this.s.db, runId, () => this.s.bus.emit('progress', { pullId: ctx.pull.id, runId } satisfies ProgressEvent));
    const done = this.review(ctx, runId, settings, trigger, abort.signal, log)
      .then(() => {
        log.finish();
        this.s.emit(ctx.pull.id, `${this.engine}_finished`, actor);
      })
      .catch((e: Error) => {
        log.finish();
        // Interrupted or cancelled, it was recorded as such when it was stopped (halt).
        const stopped: string | null = abort.signal.aborted ? abort.signal.reason : null;
        if (!stopped) this.s.db.update('review_runs', runId, { status: 'failed', error: e.message.slice(0, 4000), finished_at: now() });
        this.s.emit(ctx.pull.id, `${this.engine}_${stopped ?? 'failed'}`, actor);
      })
      .finally(() => this.jobs.delete(ctx.pull.id));
    this.jobs.set(ctx.pull.id, { runId, done, abort, log });
    return runId;
  }

  /** Wait for the decision whether to review, and for the review it started or one running (used by tests). */
  async settle(pullId: number): Promise<void> {
    await Promise.allSettled([...this.deciding].filter(([, d]) => d.pullId === pullId).map(([p]) => p));
    await this.jobs.get(pullId)?.done;
  }

  private async review(ctx: Ctx, runId: number, settings: ReviewerSettings, trigger: 'auto' | 'manual', signal: AbortSignal, log: RunLog): Promise<void> {
    const { git } = ctx;
    const pull = ctx.pull;
    // The real path (/private/var, not /var), as the tool sees it, so its settings for the checkout apply.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laatsux-review-')));
    const checkout = join(dir, 'checkout');
    // The one place besides the checkout that the tool may write to when it runs the tests.
    const tmp = join(dir, 'tmp');
    const timeoutMs = settings.runTests ? TEST_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
    try {
      await git.run(['worktree', 'add', '--detach', checkout, pull.head_sha]);
      let env: NodeJS.ProcessEnv | undefined;
      let installed: Installed | null = null;
      if (settings.runTests) {
        mkdirSync(tmp);
        env = cacheEnv(tmp);
        installed = await this.install(git, pull.head_sha, checkout, tmp, env, signal, log);
        signal.throwIfAborted();
      }
      const prompt = await this.prompt(ctx, trigger, settings, installed);
      log.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } });
      const onUpdate = (u: SessionUpdate) => log.update(u);
      const job = { dir, checkout, gitDir: git.gitDir, tmp: settings.runTests ? tmp : null, env, prompt, settings, timeoutMs, signal, onUpdate };
      const result = await this.tool.review(job).catch((e: Error) => {
        if (e instanceof EngineError && e.usage) this.s.db.update('review_runs', runId, { usage: JSON.stringify(e.usage) });
        throw e;
      });
      signal.throwIfAborted();
      if (result.usage) this.s.db.update('review_runs', runId, { usage: JSON.stringify(result.usage) });
      await this.post(ctx, runId, result.answer, settings, trigger, signal);
    } finally {
      if (settings.runTests) await makeWritable(dir);
      await git.run(['worktree', 'remove', '--force', checkout], { allowFail: true });
      removeDir(dir);
    }
  }

  /**
   * Install the checkout's dependencies before the review starts, in the tool's sandbox with
   * network, from the lockfile and without running the repository's scripts. Null when there is
   * no lockfile.
   */
  private async install(git: Repo, sha: string, checkout: string, tmp: string, env: NodeJS.ProcessEnv, signal: AbortSignal, log: RunLog): Promise<Installed | null> {
    const how = await installCommand(git, sha, tmp);
    if (!how) return null;
    const command = how.command.join(' ');
    // laatsux's own step, the first in the transcript: what the run is doing until the tool starts.
    const step = (status: 'in_progress' | 'completed' | 'failed', output?: string) =>
      log.update(
        status === 'in_progress'
          ? { sessionUpdate: 'tool_call', toolCallId: 'laatsux-install', title: command, kind: 'execute', status, rawInput: { command } }
          : { sessionUpdate: 'tool_call_update', toolCallId: 'laatsux-install', status, content: [{ type: 'content', content: { type: 'text', text: output ?? '' } }] },
      );
    step('in_progress');
    try {
      const r = await this.tool.install(how.command, { checkout, tmp, env: { ...env, ...how.env }, timeoutMs: INSTALL_TIMEOUT_MS, signal });
      const failure = r.code === 0 ? null : r.timedOut ? `timed out after ${INSTALL_TIMEOUT_MS / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
      step(failure ? 'failed' : 'completed', `${r.stdout}\n${r.stderr}`.trim());
      return { command, failure, output: lastLines(`${r.stdout}\n${r.stderr}`, 20) };
    } catch (e) {
      step('failed', (e as Error).message);
      return { command, failure: 'could not start', output: (e as Error).message };
    }
  }

  /**
   * Post the findings as one review, unless the review was stopped before it is stored. Lines
   * outside the diff cannot carry a comment, so they go in the body.
   */
  private async post(ctx: Ctx, runId: number, result: Answer, settings: ReviewerSettings, trigger: 'auto' | 'manual', signal: AbortSignal): Promise<void> {
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
    const parts = [String(result.summary ?? '').trim() || (inline.length || loose.length ? `${this.label} left comments.` : `${this.label} found nothing to comment on.`)];
    if (loose.length) {
      parts.push(OUTSIDE_THE_DIFF, loose.map((c) => `- \`${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\`${c.priority ? ` (${c.priority} priority)` : ''}: ${c.body.trim().replace(/\n/g, '\n  ')}`).join('\n'));
    }
    const model = [settings.model || 'default model', settings.effort ? `${settings.effort} effort` : null].filter(Boolean).join(', ');
    parts.push(`<sub>${this.label} (${model}) reviewed \`${pull.head_sha.slice(0, 7)}\`${n ? `, automatic review ${n} of ${this.limit(pull)}` : ', on request'}.</sub>`);
    await this.s.createReview(
      ctx,
      {
        event: 'COMMENT',
        body: parts.join('\n\n'),
        commit_id: pull.head_sha,
        comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side, start_line: c.start_line, start_side: c.start_line ? c.side : null, body: c.body, priority: c.priority })),
      },
      this.actor(),
      // Cancelled or interrupted while the review was being prepared: it is not posted. Done
      // together with storing it, so nobody is told the reviewer is still at it while its checkout is removed.
      (reviewId) => {
        signal.throwIfAborted();
        this.s.db.update('review_runs', runId, { status: 'done', review_id: reviewId, findings: inline.length + loose.length, finished_at: now() });
      },
    );
  }

  private async prompt(ctx: Ctx, trigger: 'auto' | 'manual', settings: ReviewerSettings, installed: Installed | null): Promise<string> {
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

  /** The tool's models, cached; empty when it is not available. */
  models(): Promise<ModelInfo[]> {
    return this.tool.models();
  }

  /** The efforts a model accepts, from the cached catalog (null when unknown). */
  efforts(model: string): string[] | null {
    return this.tool.efforts(model);
  }

  /** What the tool uses when laatsux does not choose. */
  defaults(): { model?: string; effort?: string } {
    return this.tool.defaults();
  }
}

/** How many findings a review's body lists under OUTSIDE_THE_DIFF, one "- `path:line`" item each. */
export function outsideTheDiff(body: string): number {
  const at = body.indexOf(OUTSIDE_THE_DIFF);
  if (at < 0) return 0;
  // The list is the paragraph after the heading; a finding's own lines are indented.
  const list = body.slice(at).split('\n\n')[1] ?? '';
  return list.split('\n').filter((l) => l.startsWith('- `')).length;
}

/** What the reviewer is told about the installed dependencies and running the tests. */
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

/** Some tools leave read-only directories (Go's module cache), which neither git nor rmSync can remove. */
export async function makeWritable(dir: string): Promise<void> {
  await run('chmod', ['-R', 'u+w', dir], { allowFail: true }).catch(() => {});
}

/** Remove a directory a review worked in. Failing to is logged: it must not replace the review's result. */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`could not remove ${dir}:`, (e as Error).message);
  }
}

export function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join('\n');
}
