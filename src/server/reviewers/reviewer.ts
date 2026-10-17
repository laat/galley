// A reviewer agent. When the author waits for review, it reviews the head commit in a throwaway
// checkout (where it may run the tests, or read-only, as settings say) and galley posts what it
// found as a GitHub-style review from its bot (named in settings), which wakes the author's
// `pr wait`. The tool that reviews is its Engine (codex.ts, claude.ts): how to run it, its
// models, and how to read its answer. The rest is the same for every tool, and lives here.
// Custom reviewers (custom.ts) are reviewers too, with what they read, may answer and are told
// to look for from their definitions.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type Repo, type RunResult } from '../git.ts';
import { lineInDiff } from '../diff.ts';
import { now, type Actor, type CancelReason, type Db, type CommentRow, type Priority, type PullRow, type RepoRow, type ReviewRunRow, type Side } from '../db.ts';
import { checkPriority, HttpError, splitPriorityPrefix, stagingState, type CommentInput, type ChangeEvent, type Ctx, type HeadStatus, type ReviewColumns, type Service } from '../service.ts';
import { checkReviewerName, MAX_ITERATIONS_LIMIT, readSettings, REVIEWER_KINDS, type ReviewerKind, type ReviewerSettings } from '../settings.ts';
import type { Reviews, Verdict } from './definition.ts';
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

/** A finding of a reviewer of the description: about the title, the description, or a commit's message. */
interface DescriptionFinding {
  about: 'title' | 'description' | 'commit';
  commit: string | null;
  body: string;
  priority: Priority | null;
}

/** What a reviewer answers, in its answerSchema. */
export interface Answer {
  summary: string;
  /** Given by reviewers that may approve. */
  verdict?: Verdict;
  comments: (Finding | DescriptionFinding)[];
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

const PRIORITY = {
  type: ['string', 'null'],
  enum: ['high', 'medium', 'low', null],
  description: 'high: must be fixed before merging (bugs, security). medium: should be fixed. low: minor improvement.',
};

/** A comment on lines of the diff. */
const CODE_COMMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'start_line', 'side', 'priority', 'body'],
  properties: {
    path: { type: 'string', description: 'File path relative to the repository root.' },
    line: { type: 'integer', description: 'Last line the comment is about.' },
    start_line: { type: ['integer', 'null'], description: 'First line of a multi-line comment, or null.' },
    side: { type: 'string', enum: ['RIGHT', 'LEFT'], description: 'RIGHT for new line numbers, LEFT for removed lines (old numbers).' },
    priority: PRIORITY,
    body: { type: 'string', description: 'The comment in Markdown.' },
  },
};

/** A comment on the title, the description or a commit message. */
const DESCRIPTION_COMMENT = {
  type: 'object',
  additionalProperties: false,
  required: ['about', 'commit', 'priority', 'body'],
  properties: {
    about: { type: 'string', enum: ['title', 'description', 'commit'], description: "What the comment is about: the pull request's title, its description, or a commit's message." },
    commit: { type: ['string', 'null'], description: 'For a commit message, the SHA of the commit as listed; otherwise null.' },
    priority: PRIORITY,
    body: { type: 'string', description: 'The comment in Markdown.' },
  },
};

/**
 * The shape a reviewer must answer in (OpenAI strict mode: every property required, nullable when
 * optional): comments on lines of the diff, or on the title, description and commit messages, and
 * a verdict from a reviewer that may approve.
 */
export function answerSchema(reviews: Reviews, verdict: Verdict) {
  const approves = verdict === 'approve';
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', ...(approves ? ['verdict'] : []), 'comments'],
    properties: {
      summary: { type: 'string', description: 'Overall assessment in Markdown, one to three sentences.' },
      ...(approves ? { verdict: { type: 'string', enum: ['approve', 'comment'], description: 'approve when nothing needs to change and you leave no comments; comment otherwise.' } } : {}),
      comments: { type: 'array', items: reviews === 'code' ? CODE_COMMENT : DESCRIPTION_COMMENT },
    },
  };
}

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Running the tests takes longer than reading. */
const TEST_RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** Reading a title, a description and commit messages takes less. */
const DESCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** How installing the dependencies went, for the prompt. */
interface Installed {
  command: string;
  /** Why it failed; null when it worked. */
  failure: string | null;
  output: string;
}

/**
 * A review for an engine to run: the checkout is ready, and so are its dependencies when it may
 * run the tests. A review of the description has no checkout: it runs in an empty directory,
 * with no tools.
 */
export interface EngineJob {
  /** What it reviews: the code in the checkout, or the title, description and commit messages in the prompt. */
  reads: Reviews;
  /** The review's own directory, removed afterwards. The checkout is in it, and the engine may keep files there. */
  dir: string;
  /** The checkout of the head; an empty directory for a review of the description. */
  checkout: string;
  /** The user's repository's git directory, which the checkout's .git points into: it stays read-only. Null without a checkout. */
  gitDir: string | null;
  /** The review's TMPDIR, beside the checkout, when it may run the tests; null when it only reads. */
  tmp: string | null;
  /** The environment to run in: caches and TMPDIR in `tmp` when it runs the tests. */
  env: NodeJS.ProcessEnv | undefined;
  prompt: string;
  /** The JSON schema of the answer (answerSchema). */
  schema: object;
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
  /** Whether its sandbox can let the tests listen on localhost without letting them connect to other hosts (the localhost setting). */
  readonly localServers: boolean;
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
  /** What the tool uses when galley does not choose. */
  defaults(): { model?: string; effort?: string };
}

/** Heads the list of findings on lines outside the diff in a review's body. */
export const OUTSIDE_THE_DIFF = '**Comments on lines outside the diff**';
/** Heads the list of a review of the description's findings on the title and description. */
export const ON_THE_DESCRIPTION = '**Comments on the title and description**';

/** A review's findings: comments to post as threads, and the rest for its body, under a heading. */
interface Findings {
  comments: CommentInput[];
  heading: string;
  loose: string[];
}

/** A review the reviewer is running on a pull request, or one it is about to start. */
export interface ReviewAtWork {
  status: 'IN_PROGRESS' | 'QUEUED';
  head_sha: string;
  /** Null while queued. */
  started_at: string | null;
}

/**
 * What a run goes by, fixed when it starts: a custom reviewer's definition changed meanwhile
 * applies from its next run on.
 */
interface Plan {
  settings: ReviewerSettings;
  tool: Engine;
  reads: Reviews;
  verdict: Verdict;
  instructions: string;
}

/** A pull request's own values for a reviewer; null follows the setting. */
export interface OwnSettings {
  enabled: boolean | null;
  maxIterations: number | null;
}

/** A review running on a pull request. */
interface Job {
  runId: number;
  done: Promise<void>;
  abort: AbortController;
  /** What it has done so far (transcript.ts). */
  log: RunLog;
  /** What it reads, as its plan says: the definition may have changed since it started. */
  reads: Reviews;
}

/** The meta key holding a custom reviewer's actor id, by its name. */
export const customActorKey = (name: string) => `reviewer_actor_id:${name}`;

export class Reviewer {
  protected s: Service;
  /** The tool that reviews; custom reviewers share Codex's and Claude's. */
  tool: Engine;
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
  }

  /** The tool that reviews. */
  get engine(): ReviewerKind {
    return this.tool.id;
  }

  /**
   * What review_runs.reviewer, the API (`…/pulls/{n}/reviewers/{key}`) and pages call the
   * reviewer: its tool for Codex and Claude, whose names are settings; a custom reviewer's name.
   */
  get key(): string {
    return this.engine;
  }

  /** The reviewer in prose: its tool ("Codex"), or a custom reviewer's name. */
  get label(): string {
    return this.tool.label;
  }

  /** What it reads: the code, or (custom reviewers only) the title, description and commit messages. */
  get reviews(): Reviews {
    return 'code';
  }

  /** Whether it may approve: custom reviewers that say so. Codex and Claude only comment. */
  get verdict(): Verdict {
    return 'comment';
  }

  /** What a custom reviewer is told to look for; empty for what Codex and Claude look for. */
  get instructions(): string {
    return '';
  }

  /** Whether it reviews pull requests in a repository: Codex and Claude review every one. */
  appliesTo(_repo: RepoRow): boolean {
    return true;
  }

  /** Whether it reviews the pull request: it reviews its repository. */
  appliesToPull(_pull: PullRow): boolean {
    return true;
  }

  /** The meta key holding the reviewer's actor id. */
  protected get actorKey(): string {
    return `${this.engine}_actor_id`;
  }

  /**
   * What the reviewer reads of the pull request now, as review_runs.subject records it: the head,
   * or for a reviewer of the description, the version of the title, description and commit
   * messages. It reviews each version once: a commit that changes none of them is not reviewed again.
   */
  subject(pull: Pick<PullRow, 'head_sha' | 'title' | 'body' | 'messages_sha'>, reads: Reviews = this.reviews): string {
    if (reads === 'code') return pull.head_sha;
    // Before galley has hashed the messages (Service.doSync does), the head stands in for them.
    const read = createHash('sha256').update(`${pull.title}\0${pull.body}\0${pull.messages_sha ?? pull.head_sha}`).digest('hex');
    return `description:${read}`;
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

  /** What it is, in a few words under its name, when its name does not say (custom reviewers). */
  describe(): string | null {
    return null;
  }

  /** Its section of the Settings page. */
  settingsUrl(): string {
    return `/settings#${this.key}`;
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
    // A custom reviewer by that name, valid or not: its file would be in the way.
    if (this.s.custom?.names().some((name) => name.toLowerCase() === l)) throw new HttpError(422, `"${login}" is the name of a custom reviewer; choose another`);
    for (const kind of REVIEWER_KINDS) {
      if (kind === this.key) continue;
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

  /** Whether an actor has done nothing but post reviews that came from reviewer runs, and is no other reviewer (custom ones too, also when their files are gone). */
  protected onlyReviewedForUs(a: Actor): boolean {
    if (a.id === this.s.viewer().id) return false;
    const db = this.s.db;
    const others = db.get(
      `SELECT 1 FROM meta WHERE (key IN (${REVIEWER_KINDS.map((k) => `'${k}_actor_id'`).join(', ')}) OR key LIKE '${customActorKey('')}%') AND key != ? AND value = ?`,
      this.actorKey,
      String(a.id),
    );
    if (others) return false;
    if (db.get('SELECT 1 FROM pulls WHERE author_id = ?', a.id)) return false;
    if (db.get('SELECT 1 FROM comments WHERE author_id = ? AND review_id IS NULL', a.id)) return false;
    if (db.get('SELECT 1 FROM events WHERE actor_id = ?', a.id)) return false;
    return !db.get('SELECT 1 FROM reviews WHERE author_id = ? AND id NOT IN (SELECT review_id FROM review_runs WHERE review_id IS NOT NULL)', a.id);
  }

  /** Move off `login` if this reviewer holds it, so the human can have it. */
  releaseName(login: string): void {
    const id = Number(this.s.db.getMeta(this.actorKey));
    const me = id ? this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id) : undefined;
    if (me?.login === login) moveOff(this.s.db, me);
  }

  /** Begin reacting to authors who wait for review. */
  start(): void {
    // The human is set up before the reviewer picks a name, so they can never share one.
    this.s.claimViewerLogin();
    this.migrate();
    // Runs the server stopped under, or that were still running when it was killed, run again.
    this.s.db.run("UPDATE review_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND reviewer = ?", now(), this.key);
    this.s.bus.on('author-waiting', this.onWaiting);
    this.resume();
  }

  /**
   * Run again the reviews asked for by hand that a stop interrupted, where the pull request is
   * still open and its head has not moved. An interrupted automatic review needs nothing: it
   * does not count as an attempt (see attempt), so the head is reviewed when the author waits.
   */
  private resume(): void {
    const runs = this.s.db.all<ReviewRunRow & { pull: string }>(
      `SELECT r.*, json_object('head_sha', p.head_sha, 'title', p.title, 'body', p.body, 'messages_sha', p.messages_sha) AS pull FROM review_runs r JOIN pulls p ON p.id = r.pull_id
        WHERE r.reviewer = ?1 AND r.status = 'interrupted' AND r.trigger = 'manual'
          AND p.state != 'closed' AND COALESCE(p.github_state, 'open') = 'open'
          AND r.id = (SELECT MAX(id) FROM review_runs WHERE pull_id = r.pull_id AND reviewer = ?1)`,
      this.key,
    );
    for (const run of runs) {
      if (runSubject(run) !== this.subject(JSON.parse(run.pull))) continue;
      // About to start from now on (see atWork), so nothing takes the reviewer for done meanwhile.
      const p: Promise<void> = this.rerun(run).then(
        () => void this.deciding.delete(p),
        (e: unknown) => {
          console.error(`${this.key} review:`, e);
          this.deciding.delete(p);
          // It does not run again after all: failed, so it holds nothing up and can be asked for again.
          const error = String(e instanceof Error ? e.message : e).slice(0, 4000);
          this.s.db.run("UPDATE review_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'interrupted'", error, now(), run.id);
          this.s.emit(run.pull_id, 'reviewer_failed', this.actor());
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
    if (this.stopped || this.jobs.has(run.pull_id) || stagingState(ctx.pull) === 'done' || runSubject(run) !== this.subject(ctx.pull)) return;
    // Nor for a repository its reviewer no longer reviews (a custom reviewer's definition changed meanwhile).
    if (!this.appliesToPull(ctx.pull)) return;
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
    // With no time to post, the running reviews end before this returns to its caller: a custom
    // reviewer defined again by the same name right after (CustomReviewers.load) finds them ended.
    // Reviews still deciding start none now (they check `stopped`).
    if (graceMs <= 0) for (const job of this.jobs.values()) this.halt(job, 'interrupted');
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
   * or pushed to, edited, or moved onto another base (only a review of what changed since: an
   * earlier commit, or an earlier version of the title, description and commit messages). It does
   * not count and does not run again; the timeline says why. If the author is waiting, a review of its head is about to start before
   * anyone hears of the cancellation, so the author's wait goes on for it.
   */
  cancel(pull: PullRow, reason: CancelReason): void {
    const job = this.jobs.get(pull.id);
    const run = job && this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', job.runId);
    if (!job || run?.status !== 'running') return;
    // What it reads as it started: a code review is not cancelled by an edit because its definition says description now.
    if ((reason === 'pushed' || reason === 'edited' || reason === 'base_moved') && runSubject(run) === this.subject(pull, job.reads)) return;
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
    return this.s.db.all<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? ORDER BY id', pull.id, this.key);
  }

  /**
   * Whether the reviewer is done with the pull request's head: its latest review of the commit
   * found nothing, approved it or was cancelled, the author answered what it found (answered), it
   * has used up its automatic reviews (or the reviewer stopped them), or it is off for the pull
   * request, as every one is once it is published. A failed review of the commit holds things up
   * until someone asks for another one, unless automatic reviews are stopped: then only a running
   * review does, or one asked for by hand that a stop interrupted, until it has run again.
   * For a reviewer of the description, it is about the version of the title, description and
   * commit messages the head has (see subject).
   */
  headStatus(pull: PullRow): HeadStatus {
    const status = this.status(pull);
    return this.reviews === 'description' ? { ...status, description: true } : status;
  }

  private status(pull: PullRow): HeadStatus {
    const work = this.atWork(pull);
    if (work) return { state: work.status === 'QUEUED' ? 'queued' : 'reviewing', done: false, commit: work.head_sha, startedAt: work.started_at };
    const commit = pull.head_sha;
    // It runs again when the server starts (see resume); an interrupted automatic review is just not an attempt.
    const latest = this.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? ORDER BY id DESC', pull.id, this.key);
    if (latest?.status === 'interrupted' && latest.trigger === 'manual' && runSubject(latest) === this.subject(pull)) return { state: 'interrupted', done: false, commit };
    const last = this.attempt(pull);
    if (last?.status === 'failed' && !pull.iterations_stopped) return { state: 'failed', done: false, commit, failedAt: last.finished_at };
    if (last?.status === 'cancelled') return { state: 'cancelled', done: true, commit, cancelled: last.reason };
    if (last?.status === 'done' && last.findings === 0) {
      const approved = this.s.db.get<{ state: string }>('SELECT state FROM reviews WHERE id = ?', last.review_id)?.state === 'APPROVED';
      return { state: approved ? 'approved' : 'clean', done: true, commit };
    }
    // Published, GitHub's reviews take over: none reviews it on its own (wouldReview).
    if (!this.enabled(pull) || pull.published_url) return { state: 'off', done: true, commit };
    const automatic = { used: this.automaticReviews(pull), limit: this.limit(pull) };
    // Stopped (Service.stopIterating), it has no automatic review left, whatever the counts say.
    if (automatic.used >= automatic.limit || pull.iterations_stopped) return { state: 'capped', done: true, commit, automatic };
    // It reviews this commit when the author waits.
    if (!last) return { state: 'unreviewed', done: false, commit, automatic };
    // It found something in this commit and reviews the author's next one, unless the author answers it without one.
    // A reviewer of the description has only a new version of it for an answer.
    if (this.reviews !== 'description' && this.answered(pull, last)) return { state: 'answered', done: true, commit, automatic };
    return { state: 'findings', done: false, commit, automatic };
  }

  /**
   * Whether the author answered a review's findings: it has seen the review, and each thread the
   * review opened is resolved or has a reply from the author. Findings in the review's body (on
   * lines outside the diff) have no thread to reply in, so seeing them is enough.
   */
  private answered(pull: PullRow, run: ReviewRunRow): boolean {
    const review = run.review_id === null ? undefined : this.s.db.get<{ submitted_at: string }>('SELECT submitted_at FROM reviews WHERE id = ?', run.review_id);
    if (!review || review.submitted_at > pull.author_seen_at) return false;
    const open = this.s.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments c WHERE c.review_id = ? AND c.in_reply_to_id IS NULL AND c.resolved_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM comments r WHERE r.in_reply_to_id = c.id AND r.author_id = ?)`,
      run.review_id,
      pull.author_id,
    )!.n;
    return open === 0;
  }

  /** This pull request's own values, from its columns for this reviewer; null follows the setting. */
  own(pull: PullRow): OwnSettings {
    const enabled = pull[`${this.engine}_enabled`];
    return { enabled: enabled === null ? null : enabled === 1, maxIterations: pull[`${this.engine}_max_iterations`] };
  }

  /** The columns that store this pull request's own values, changed by `change` (its fields left out stay). `pull` has those the pull request has so far. */
  protected ownColumns(change: Partial<OwnSettings>, _pull?: Partial<Pick<PullRow, 'reviewer_overrides'>>): ReviewColumns {
    const cols: ReviewColumns = {};
    if (change.enabled !== undefined) cols[`${this.engine}_enabled`] = change.enabled === null ? null : change.enabled ? 1 : 0;
    if (change.maxIterations !== undefined) cols[`${this.engine}_max_iterations`] = change.maxIterations;
    return cols;
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

  /** Whether its sandbox can let the tests listen on localhost, so the localhost setting applies to it. */
  get localServers(): boolean {
    return this.tool.localServers;
  }

  /** Where its models come from, when they are read from the tool. */
  get catalogSource(): string | undefined {
    return this.tool.catalogSource;
  }

  /** Whether a reviewer asked for by login (`pr create --reviewer`) is this one: its kind ("codex"), or its name. */
  answersTo(login: string): boolean {
    const l = login.toLowerCase();
    return l === this.key.toLowerCase() || l === this.actor().login.toLowerCase();
  }

  /** What is in effect for a pull request, and its own values (null where it follows the setting). */
  config(pull: PullRow): ReviewerConfig {
    const own = this.own(pull);
    return { enabled: this.enabled(pull), max_iterations: this.limit(pull), overrides: { enabled: own.enabled, max_iterations: own.maxIterations } };
  }

  /**
   * Check a change to a pull request's own settings and give the columns that store it. Null goes
   * back to the setting. `pull` has the columns so far, which a custom reviewer's change is merged into.
   */
  columns(change: ReviewerChange, pull?: Partial<Pick<PullRow, 'reviewer_overrides'>>): ReviewColumns {
    const own: Partial<OwnSettings> = {};
    if (change.enabled !== undefined) {
      const on = change.enabled;
      if (on !== null && on !== true && on !== false && on !== 'true' && on !== 'false') throw new HttpError(422, 'enabled must be true, false or null');
      own.enabled = on === null ? null : on === true || on === 'true';
    }
    if (change.max_iterations !== undefined) {
      const raw = change.max_iterations;
      const limit = raw === null || raw === '' ? null : Number(raw);
      if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_ITERATIONS_LIMIT)) {
        throw new HttpError(422, `the limit must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
      }
      own.maxIterations = limit;
    }
    return this.ownColumns(own, pull);
  }

  /**
   * Change this pull request's own settings: turn automatic reviews on or off, raise or lower
   * the limit, or with null go back to the setting. If the author is waiting and the reviewer
   * may now review, it starts at once instead of at the author's next wait.
   */
  configure(ctx: Ctx, change: ReviewerChange): ReviewerConfig {
    this.s.db.transaction(() => {
      const pull = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', ctx.pull.id)!;
      this.s.db.update('pulls', pull.id, this.columns(change, pull));
    });
    // A limit set by hand resumes stopped automatic reviews, as Resume does (which tells pages and reconsiders every reviewer).
    if (change.max_iterations === undefined || !this.s.resumeIterating(ctx, this.s.viewer())) {
      this.s.emit(ctx.pull.id, 'updated', this.s.viewer());
      if ((this.s.waiters.get(ctx.pull.id) ?? 0) > 0) this.consider(ctx.pull.id);
    }
    return this.config(this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', ctx.pull.id)!);
  }

  automaticReviews(pull: PullRow): number {
    return this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_runs WHERE pull_id = ? AND reviewer = ? AND trigger = 'auto' AND status = 'done'", pull.id, this.key)!.n;
  }

  /** Automatic reviews done or running: the round the pull request is in, as far as this reviewer goes (Service.automaticRound). */
  automaticReviewsStarted(pull: PullRow): number {
    return this.s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_runs WHERE pull_id = ? AND reviewer = ? AND trigger = 'auto' AND status IN ('done', 'running')", pull.id, this.key)!.n;
  }

  /** Decide in the background whether to review automatically (see maybeReview). */
  consider(pullId: number): void {
    const p = this.maybeReview(pullId)
      .catch((e) => console.error(`${this.key} review:`, e))
      .finally(() => this.deciding.delete(p));
    this.deciding.set(p, { pullId, resume: false });
  }

  /** Review automatically if the reviewer is on for this pull request, what it reads has not been tried, and the cap is not reached. */
  async maybeReview(pullId: number): Promise<void> {
    if (this.stopped) return;
    // One at work is left to finish; one being cancelled ends first.
    const ending = this.jobs.get(pullId);
    if (ending && !ending.abort.signal.aborted) return;
    await ending?.done;
    if (this.stopped || this.jobs.has(pullId)) return;
    const stale = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
    if (!stale || stagingState(stale) !== 'staged' || !this.enabled(stale) || !this.appliesToPull(stale)) return;
    if (stale.author_id === this.actor().id) return;
    const repo = this.s.repoById(stale.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, stale.number);
    if (this.jobs.has(pullId) || !this.wouldReview(ctx.pull)) return;
    this.launch(ctx, 'auto');
  }

  /**
   * Whether an automatic review of the pull request's head would start now: not once it is
   * published (GitHub's reviews take over; asking by hand still works), nor once it is closed, here
   * or on GitHub, or merged.
   */
  private wouldReview(pull: PullRow): boolean {
    if (this.stopped || !this.enabled(pull) || stagingState(pull) !== 'staged' || pull.author_id === this.actor().id || !this.appliesToPull(pull)) return false;
    // The reviewer stopped automatic reviews (Service.stopIterating); asking by hand still works.
    if (pull.iterations_stopped) return false;
    // One attempt per head (or version of the description), failed and cancelled ones too: a failure is retried by asking from the page. An interrupted one runs again.
    if (this.attempt(pull)) return false;
    return this.automaticReviews(pull) < this.limit(pull);
  }

  /**
   * The latest review of what the reviewer reads now (subject), running, done, failed or
   * cancelled. One the server stopped under does not count, nor does a review whose findings were
   * never counted (one from an older version that could not be counted later), so the reviewer
   * reviews the commit again.
   */
  private attempt(pull: PullRow): ReviewRunRow | undefined {
    return this.s.db.get<ReviewRunRow>(
      "SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = ? AND COALESCE(subject, head_sha) = ? AND status != 'interrupted' AND NOT (status = 'done' AND findings IS NULL) ORDER BY id DESC",
      pull.id,
      this.key,
      this.subject(pull),
    );
  }

  /** Review now, whatever the settings say about automatic reviews. */
  request(ctx: Ctx): number {
    if (this.stopped) throw new HttpError(503, 'the server is shutting down');
    if (!this.appliesTo(ctx.repo)) throw new HttpError(404, `${this.label} does not review ${ctx.repo.github_slug ?? 'repositories without a GitHub remote'}`);
    if (this.jobs.has(ctx.pull.id)) throw new HttpError(409, `${this.label} is already reviewing this pull request`);
    if (ctx.pull.state === 'closed') throw new HttpError(422, 'reopen the pull request first');
    // Published, it can be reviewed again to check an update, until it is merged.
    if (ctx.pull.github_state === 'merged') throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
    return this.launch(ctx, 'manual');
  }

  private launch(ctx: Ctx, trigger: 'auto' | 'manual'): number {
    const plan: Plan = { settings: this.settings(), tool: this.tool, reads: this.reviews, verdict: this.verdict, instructions: this.instructions };
    const { settings } = plan;
    const actor = this.actor();
    const runId = this.s.db.insert('review_runs', {
      pull_id: ctx.pull.id,
      reviewer: this.key,
      head_sha: ctx.pull.head_sha,
      subject: this.subject(ctx.pull),
      trigger,
      status: 'running',
      model: settings.model || null,
      effort: settings.effort || null,
      started_at: now(),
    });
    this.s.emit(ctx.pull.id, 'reviewer_started', actor);
    const abort = new AbortController();
    // Progress is not a change: it wakes no `pr wait`, only pages showing the run.
    const log = new RunLog(this.s.db, runId, () => this.s.bus.emit('progress', { pullId: ctx.pull.id, runId } satisfies ProgressEvent));
    const done = this.review(ctx, runId, plan, trigger, abort.signal, log)
      .then(() => {
        log.finish();
        this.s.emit(ctx.pull.id, 'reviewer_finished', actor);
      })
      .catch((e: Error) => {
        log.finish();
        // Interrupted or cancelled, it was recorded as such when it was stopped (halt).
        const stopped: string | null = abort.signal.aborted ? abort.signal.reason : null;
        if (!stopped) this.s.db.update('review_runs', runId, { status: 'failed', error: e.message.slice(0, 4000), finished_at: now() });
        this.s.emit(ctx.pull.id, `reviewer_${stopped ?? 'failed'}`, actor);
      })
      .finally(() => {
        this.jobs.delete(ctx.pull.id);
        // The pages of every pull request say how many reviews a stopping server still waits for.
        if (this.s.stopping) this.s.bus.emit('change', { pullId: null, type: 'stopping', actor: 'galley' } satisfies ChangeEvent);
      });
    this.jobs.set(ctx.pull.id, { runId, done, abort, log, reads: plan.reads });
    return runId;
  }

  /** Wait for the decision whether to review, and for the review it started or one running (used by tests). */
  async settle(pullId: number): Promise<void> {
    await Promise.allSettled([...this.deciding].filter(([, d]) => d.pullId === pullId).map(([p]) => p));
    await this.jobs.get(pullId)?.done;
  }

  private async review(ctx: Ctx, runId: number, plan: Plan, trigger: 'auto' | 'manual', signal: AbortSignal, log: RunLog): Promise<void> {
    const { settings, reads } = plan;
    const { git } = ctx;
    const pull = ctx.pull;
    // The real path (/private/var, not /var), as the tool sees it, so its settings for the checkout apply.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'galley-review-')));
    const checkout = join(dir, 'checkout');
    // The one place besides the checkout that the tool may write to when it runs the tests.
    const tmp = join(dir, 'tmp');
    const timeoutMs = reads === 'description' ? DESCRIPTION_TIMEOUT_MS : settings.runTests ? TEST_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS;
    try {
      // A review of the description reads no code: it runs in an empty directory.
      if (reads === 'description') mkdirSync(checkout);
      else await git.run(['worktree', 'add', '--detach', checkout, pull.head_sha]);
      let env: NodeJS.ProcessEnv | undefined;
      let installed: Installed | null = null;
      if (settings.runTests) {
        mkdirSync(tmp);
        env = cacheEnv(tmp);
        installed = await this.install(plan.tool, git, pull.head_sha, checkout, tmp, env, signal, log);
        signal.throwIfAborted();
      }
      const prompt = reads === 'description' ? await this.descriptionPrompt(ctx, trigger, plan) : await this.prompt(ctx, trigger, plan, installed);
      log.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } });
      const onUpdate = (u: SessionUpdate) => log.update(u);
      const schema = answerSchema(reads, plan.verdict);
      const job: EngineJob = { reads, dir, checkout, gitDir: reads === 'code' ? git.gitDir : null, tmp: settings.runTests ? tmp : null, env, prompt, schema, settings, timeoutMs, signal, onUpdate };
      const result = await plan.tool.review(job).catch((e: Error) => {
        if (e instanceof EngineError && e.usage) this.s.db.update('review_runs', runId, { usage: JSON.stringify(e.usage) });
        throw e;
      });
      signal.throwIfAborted();
      if (result.usage) this.s.db.update('review_runs', runId, { usage: JSON.stringify(result.usage) });
      await this.post(ctx, runId, result.answer, plan, trigger, signal);
    } finally {
      if (settings.runTests) await makeWritable(dir);
      if (reads === 'code') await git.run(['worktree', 'remove', '--force', checkout], { allowFail: true });
      removeDir(dir);
    }
  }

  /**
   * Install the checkout's dependencies before the review starts, in the tool's sandbox with
   * network, from the lockfile and without running the repository's scripts. Null when there is
   * no lockfile.
   */
  private async install(tool: Engine, git: Repo, sha: string, checkout: string, tmp: string, env: NodeJS.ProcessEnv, signal: AbortSignal, log: RunLog): Promise<Installed | null> {
    const how = await installCommand(git, sha, tmp);
    if (!how) return null;
    const command = how.command.join(' ');
    // galley's own step, the first in the transcript: what the run is doing until the tool starts.
    const step = (status: 'in_progress' | 'completed' | 'failed', output?: string) =>
      log.update(
        status === 'in_progress'
          ? { sessionUpdate: 'tool_call', toolCallId: 'galley-install', title: command, kind: 'execute', status, rawInput: { command } }
          : { sessionUpdate: 'tool_call_update', toolCallId: 'galley-install', status, content: [{ type: 'content', content: { type: 'text', text: output ?? '' } }] },
      );
    step('in_progress');
    try {
      const r = await tool.install(how.command, { checkout, tmp, env: { ...env, ...how.env }, timeoutMs: INSTALL_TIMEOUT_MS, signal });
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
   * outside the diff cannot carry a comment, so they go in the body, as do findings on the title
   * and description. A reviewer that may approve approves when it says so and found nothing;
   * otherwise it comments. No reviewer agent requests changes.
   */
  private async post(ctx: Ctx, runId: number, result: Answer, plan: Plan, trigger: 'auto' | 'manual', signal: AbortSignal): Promise<void> {
    const { pull } = ctx;
    const { settings } = plan;
    const found = plan.reads === 'code' ? await this.codeFindings(ctx, result) : await this.descriptionFindings(ctx, result);
    let findings = found.comments.length + found.loose.length;
    const approve = plan.verdict === 'approve' && result.verdict === 'approve' && findings === 0;
    // Not approving with nothing to point at, its summary says what is wrong: that asks something of the author.
    if (plan.verdict === 'approve' && !approve && findings === 0) findings = 1;
    const n = trigger === 'auto' ? this.automaticReviews(pull) + 1 : null;
    const fallback = approve ? `${this.label} found nothing to change.` : findings ? `${this.label} left comments.` : `${this.label} found nothing to comment on.`;
    const parts = [String(result.summary ?? '').trim() || fallback];
    if (found.loose.length) parts.push(found.heading, found.loose.join('\n'));
    // A custom reviewer's name is not its tool's.
    const model = [this.label === plan.tool.label ? null : plan.tool.label, settings.model || 'default model', settings.effort ? `${settings.effort} effort` : null].filter(Boolean).join(', ');
    const what = plan.reads === 'description' ? `the title, description and commit messages at \`${pull.head_sha.slice(0, 7)}\`` : `\`${pull.head_sha.slice(0, 7)}\``;
    parts.push(`<sub>${this.label} (${model}) reviewed ${what}${n ? `, automatic review ${n} of ${this.limit(pull)}` : ', on request'}.</sub>`);
    await this.s.createReview(
      ctx,
      { event: approve ? 'APPROVE' : 'COMMENT', body: parts.join('\n\n'), commit_id: pull.head_sha, comments: found.comments },
      this.actor(),
      // Cancelled or interrupted while the review was being prepared: it is not posted. Done
      // together with storing it, so nobody is told the reviewer is still at it while its checkout is removed.
      (reviewId) => {
        signal.throwIfAborted();
        this.s.db.update('review_runs', runId, { status: 'done', review_id: reviewId, findings, finished_at: now() });
      },
    );
  }

  /** A code review's comments: those on lines of the diff, and the rest for the body. */
  private async codeFindings(ctx: Ctx, result: Answer): Promise<Findings> {
    const { pull, git } = ctx;
    const rev = this.s.db.get<{ base_sha: string }>('SELECT base_sha FROM revisions WHERE pull_id = ? AND head_sha = ? ORDER BY seq DESC', pull.id, pull.head_sha);
    const files = await git.diff(rev?.base_sha ?? pull.base_sha, pull.head_sha);
    const inline: Finding[] = [];
    const loose: Finding[] = [];
    for (const raw of (Array.isArray(result.comments) ? result.comments : []) as Finding[]) {
      // Models write one-line comments as start_line == line, and sometimes give a range backwards.
      let [start, line] = [raw.start_line ?? null, raw.line];
      if (start !== null && start > line) [start, line] = [line, start];
      if (start === line) start = null;
      const c: Finding = { ...raw, ...priorityOf(raw), line, start_line: start, side: raw.side === 'LEFT' ? 'LEFT' : 'RIGHT' };
      const file = files.find((f) => f.path === c.path);
      const ok = file && Number.isInteger(c.line) && lineInDiff(file, c.side, c.line) && (c.start_line === null || lineInDiff(file, c.side, c.start_line));
      (ok ? inline : loose).push(c);
    }
    return {
      comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side, start_line: c.start_line, start_side: c.start_line ? c.side : null, body: c.body, priority: c.priority })),
      heading: OUTSIDE_THE_DIFF,
      loose: loose.map((c) => `- \`${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\`${c.priority ? ` (${c.priority} priority)` : ''}: ${c.body.trim().replace(/\n/g, '\n  ')}`),
    };
  }

  /** A review of the description's comments: those on a commit's message on that commit, as a person's are, and the rest for the body. */
  private async descriptionFindings(ctx: Ctx, result: Answer): Promise<Findings> {
    const commits = await this.s.commits(ctx);
    const out: Findings = { comments: [], heading: ON_THE_DESCRIPTION, loose: [] };
    for (const raw of (Array.isArray(result.comments) ? result.comments : []) as DescriptionFinding[]) {
      const { body, priority } = priorityOf(raw);
      // Models shorten SHAs; one that names no commit of the pull request goes in the body.
      const sha = raw.about === 'commit' && typeof raw.commit === 'string' && raw.commit.length >= 4 ? commits.find((c) => c.sha.startsWith(raw.commit!.toLowerCase()))?.sha : undefined;
      if (sha) {
        out.comments.push({ subject_type: 'commit', commit_id: sha, body, priority });
        continue;
      }
      const about = raw.about === 'title' ? 'Title' : raw.about === 'commit' ? `Commit${raw.commit ? ` \`${String(raw.commit).slice(0, 7)}\`` : ''}` : 'Description';
      out.loose.push(`- ${about}${priority ? ` (${priority} priority)` : ''}: ${body.trim().replace(/\n/g, '\n  ')}`);
    }
    return out;
  }

  private async prompt(ctx: Ctx, trigger: 'auto' | 'manual', plan: Plan, installed: Installed | null): Promise<string> {
    const { pull } = ctx;
    const { settings } = plan;
    const commits = await this.s.commits(ctx);
    // A custom reviewer looks for what it is told to; Codex and Claude for what is wrong with the change.
    const focus = plan.instructions
      ? [plan.instructions, '', 'If the pull request is fine, say so in the summary and leave no comments.']
      : [
          'Look for bugs, regressions, security problems, missing error handling, and changes that do not do what the description says. Mention missing tests only where they matter. Skip style preferences and anything a formatter or linter would catch. If the pull request is fine, say so in the summary and leave no comments.',
          '',
          'Focus on problems this change introduces or makes reachable. An issue that was there before it, or one outside what the pull request sets out to do, is not a defect of this change: say in the comment that it is pre-existing or out of scope, and give it low priority.',
        ];
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
      ...(settings.runTests ? [...testInstructions(installed, settings.localhost && plan.tool.localServers), ''] : []),
      ...focus,
      '',
      'Give each comment a priority: high for bugs, security problems and anything that must be fixed before merging; medium for what should be fixed; low for minor improvements. Do not write the priority into the comment text.',
      '',
      'Each comment is about lines of the diff: changed lines or the three lines of context around them. Use side RIGHT and new line numbers, or side LEFT and old line numbers for removed lines. `line` is the last line; `start_line` is the first line of a range, or null. To propose a replacement, put a ```suggestion block in the body; it replaces lines start_line..line exactly.',
      ...verdictText(plan),
      ...(await this.threadsText(ctx)),
      ...this.roundText(pull, trigger, 'what changed since the earlier reviews'),
    ];
    return out.join('\n') + '\n';
  }

  /** What a reviewer of the description is told: its instructions, and the title, description and commit messages, which it has instead of a checkout. */
  private async descriptionPrompt(ctx: Ctx, trigger: 'auto' | 'manual', plan: Plan): Promise<string> {
    const { pull } = ctx;
    const commits = await this.s.commits(ctx);
    const out = [
      "You are reviewing a pull request's title, description and commit messages before a person reviews it. You do not have its code: what you review is below.",
      '',
      plan.instructions,
      '',
      `Title: ${pull.title}`,
      '',
      'Description:',
      pull.body.trim() || '(none)',
      '',
      `Its commits, onto ${pull.base_ref}, oldest first:`,
      ...commits.flatMap((c) => ['', `commit ${c.sha}`, c.message.trim().replace(/^/gm, '    ')]),
      '',
      'If they follow the instructions, say so in the summary and leave no comments. Otherwise say what to change, one comment per thing. `about` says whether a comment is about the title, the description or a commit message; for a commit message, `commit` is its SHA.',
      '',
      'Give each comment a priority: high for what must be fixed before merging; medium for what should be fixed; low for minor improvements. Do not write the priority into the comment text.',
      ...verdictText(plan),
      ...(await this.threadsText(ctx)),
      ...this.roundText(pull, trigger, 'what changed since the earlier reviews'),
    ];
    return out.join('\n') + '\n';
  }

  /** The open review threads, which the reviewer should not repeat. */
  private async threadsText(ctx: Ctx): Promise<string[]> {
    const threads = (await this.s.threads(ctx, this.actor())).filter((t) => !t.pending && !t.resolved);
    if (!threads.length) return [];
    const out = ['', 'Open review threads (do not repeat them; mention in the summary if one is still not addressed):'];
    for (const t of threads) {
      const where = t.root.subject_type === 'commit' ? `commit ${t.root.commit_id?.slice(0, 7)} message` : `${t.root.path}${t.root.line ? `:${t.root.line}` : ''}${t.placement.outdated ? ' (outdated)' : ''}`;
      out.push(`- ${where}`);
      for (const c of [t.root, ...t.replies]) out.push(`  ${this.s.db.actorById(c.author_id).login}: ${c.body.trim().replace(/\n/g, '\n    ')}`);
    }
    return out;
  }

  /** Which automatic review this is, after the first. */
  private roundText(pull: PullRow, trigger: 'auto' | 'manual', focus: string): string[] {
    const n = this.automaticReviews(pull) + 1;
    if (trigger !== 'auto' || n <= 1) return [];
    return ['', `This is automatic review ${n} of at most ${this.limit(pull)}. Focus on ${focus} and whether their comments were addressed.`];
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

  /** What the tool uses when galley does not choose. */
  defaults(): { model?: string; effort?: string } {
    return this.tool.defaults();
  }
}

/** Give a reviewer's bot another name than its own, "<name>-reviewer", so the human can have it. */
export function moveOff(db: Db, bot: Actor): void {
  const base = `${bot.login}-reviewer`;
  let name = base;
  for (let i = 2; db.get('SELECT 1 FROM actors WHERE login = ?', name); i++) name = `${base}-${i}`;
  db.run('UPDATE actors SET login = ? WHERE id = ?', name, bot.id);
}

/** What a reviewer that may approve is told about its verdict. */
function verdictText(plan: Plan): string[] {
  if (plan.verdict !== 'approve') return [];
  return ['', 'Answer with the verdict approve when nothing needs to change and you leave no comments, and comment otherwise.'];
}

/** What a run reviewed (Reviewer.subject); runs from before it was recorded reviewed their head. */
export function runSubject(run: Pick<ReviewRunRow, 'subject' | 'head_sha'>): string {
  return run.subject ?? run.head_sha;
}

/** A finding's priority, from its field or (as models write it) "[P1] ..." in its text. */
function priorityOf(raw: { body?: unknown; priority?: unknown }): { body: string; priority: Priority | null } {
  const split = splitPriorityPrefix(String(raw.body ?? ''));
  let priority: Priority | null = split.priority;
  try {
    priority = checkPriority(raw.priority) ?? priority;
  } catch {}
  return { body: split.body, priority };
}

/** The findings a review's body lists under OUTSIDE_THE_DIFF, one "- `path:line` (high priority): …" item each, as their priorities (null for none). */
export function outsideTheDiff(body: string): (Priority | null)[] {
  const at = body.indexOf(OUTSIDE_THE_DIFF);
  if (at < 0) return [];
  // The list is the paragraph after the heading; a finding's own lines are indented.
  const list = body.slice(at).split('\n\n')[1] ?? '';
  return list
    .split('\n')
    .filter((l) => l.startsWith('- `'))
    .map((l) => (/^- `[^`]*` \((high|medium|low) priority\):/.exec(l)?.[1] as Priority | undefined) ?? null);
}

/** The findings a review of the description's body lists under ON_THE_DESCRIPTION, one "- Title (high priority): …" item each, as their priorities. */
export function onTheDescription(body: string): (Priority | null)[] {
  const at = body.indexOf(ON_THE_DESCRIPTION);
  if (at < 0) return [];
  const list = body.slice(at).split('\n\n')[1] ?? '';
  return list
    .split('\n')
    .filter((l) => /^- (Title|Description|Commit)\b/.test(l))
    .map((l) => (/^- [^(:]*\((high|medium|low) priority\):/.exec(l)?.[1] as Priority | undefined) ?? null);
}

/** What the reviewer is told about the installed dependencies and running the tests. */
function testInstructions(installed: Installed | null, localServers: boolean): string[] {
  const indent = (text: string) => text.replace(/^/gm, '    ');
  const out = !installed
    ? ['No dependencies are installed: the repository root has no lockfile galley installs from (pnpm-lock.yaml, package-lock.json, yarn.lock or bun.lock).']
    : installed.failure
      ? [`galley could not install the dependencies: \`${installed.command}\` ${installed.failure}. Its output ended with:`, '', indent(installed.output)]
      : [`galley installed the dependencies with \`${installed.command}\`, which runs no install scripts, so a package that needs a build step may not work. Its output ended with:`, '', indent(installed.output)];
  const checks = localServers
    ? "To check your findings, you may run the typecheck, the whole test suite (tests that start servers on localhost included) or the build with the repository's own tooling (its package scripts). There is no network beyond localhost, so you can not install anything"
    : "To check your findings, you may run the typecheck, tests or build with the repository's own tooling (its package scripts). There is no network, so you can not install anything";
  out.push(
    '',
    `${checks}: a check that fails for lack of network, a missing dependency or tool, or the sandbox is not a finding. You can write only to this checkout and $TMPDIR (point caches there). The checkout is thrown away after the review, so changes you make to it are lost: report findings only in your answer.`,
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
