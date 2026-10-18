import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FETCH_ENV, ghCredentials, Repo, run, type Commit, type RawCommit, type RunResult } from './git.ts';
import { githubSlug } from '../config.ts';
import { diffHunkFor, expandedLine, lineInDiff, mapLine, rangeTouched, withContext, type FileDiff } from './diff.ts';
import type { CodexReviewer } from './reviewers/codex.ts';
import type { ClaudeReviewer } from './reviewers/claude.ts';
import type { CustomReviewers } from './reviewers/custom.ts';
import type { ReviewAtWork, Reviewer } from './reviewers/reviewer.ts';
import { busy, doneForAutoPublish, doneForHandover, toReview, type HeadState, type HeadStatus } from './reviewers/head-status.ts';
import { agentReviews, askedAt, unansweredThreads, unseenFeedback, type Feedback } from './feedback.ts';
import { addEvent, eventsAfter, eventsSince, lastEvent, type EventData, type EventType } from './events.ts';
import { MERGE_METHODS, readSettings, type MergeMethod } from './settings.ts';
import { reviewDecision } from './github.ts';
import { earlierThreads, earlierThreadsQuery, githubAsks, githubBusy, githubWaits, prependThreads, present, readGithub, PULL_FIELDS, PULL_FIELDS_WITHOUT_TEAMS, type GithubPull, type GithubStatus } from './github-follow.ts';
import {
  Db,
  now,
  PRIORITIES,
  type Actor,
  type CancelReason,
  type Priority,
  type CommentRow,
  type EventRow,
  type GithubState,
  type PullRow,
  type RepoRow,
  type ReviewRow,
  type ReviewState,
  type RevisionRow,
  type Side,
  type SubjectType,
} from './db.ts';

export class HttpError extends Error {
  status: number;
  /** More fields for the error's JSON, beside `message` and `status`. */
  fields: Record<string, unknown>;
  constructor(status: number, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/**
 * Signing a commit failed. `why`: what went wrong in a few words, when galley can tell from what
 * the signing program said (signingCause); null when it can not. `transient`: trying again later
 * may get past it. Both are in the error's JSON as `signing` (an extension), so the CLI can tell
 * an agent what to do.
 */
export class SigningError extends HttpError {
  why: string | null;
  transient: boolean;
  constructor(message: string, cause: SigningCause | null, status = 502) {
    super(status, message, { signing: { why: cause?.why ?? null, transient: cause?.transient ?? false } });
    this.why = cause?.why ?? null;
    this.transient = cause?.transient ?? false;
  }
}

/** What went wrong when signing failed, as far as galley can tell, and whether trying again later may get past it (signingCause). */
interface SigningCause {
  why: string;
  transient: boolean;
}

/**
 * A change to a pull request, or with pullId null to what any page may show. Open pages refresh
 * for it, and it wakes a `pr wait` on the pull request unless its author made it.
 */
export interface ChangeEvent {
  pullId: number | null;
  type: string;
  /** The login of the actor that made it (Service.emit); null for one from a source. */
  actor: string | null;
  /** Where a change no actor made comes from (Service.emitSystem); null for an actor's. */
  source: ChangeSource | null;
}

/** Where a change no actor made comes from: GitHub, git (a fetch, a rename, a conflict check), the settings, or galley itself (a stall, a stopping server). */
export type ChangeSource = 'github' | 'git' | 'settings' | 'galley';

export interface Ctx {
  repo: RepoRow;
  pull: PullRow;
  git: Repo;
}

export interface CommentInput {
  body: string;
  path?: string | null;
  line?: number | null;
  side?: Side | null;
  start_line?: number | null;
  start_side?: Side | null;
  subject_type?: SubjectType | null;
  /** galley extension: high, medium or low. */
  priority?: string | null;
  commit_id?: string | null;
  /** galley extension: the left side of the diff the comment was made on (for commit and interdiff views). */
  base_commit_id?: string | null;
}

export interface Placement {
  line: number | null;
  startLine: number | null;
  outdated: boolean;
}

export interface Thread {
  root: CommentRow;
  replies: CommentRow[];
  placement: Placement;
  resolved: boolean;
  pending: boolean;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** A pull request's own reviewer agent settings, as stored; left out, a column follows the setting. */
export type ReviewColumns = Partial<Pick<PullRow, 'codex_enabled' | 'codex_max_iterations' | 'claude_enabled' | 'claude_max_iterations' | 'reviewer_overrides'>>;

const EVENT_STATE: Record<ReviewEvent, ReviewState> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

/** Wait statuses after which nothing more is coming: closed here, or merged or closed on GitHub. */
const ENDED: WaitResult['status'][] = ['closed', 'merged', 'closed_on_github'];

/**
 * What each `state` of a list takes in: a staging state (see stagingState), merged on GitHub, or
 * gh's open and closed. Open is staged and published, so agents that know gh find theirs; closed
 * takes in merged, as on GitHub.
 */
const LISTED = new Map([
  ['staged', "state = 'staged'"],
  ['published', "state = 'published' AND COALESCE(github_state, 'open') = 'open'"],
  ['done', "(state = 'closed' OR COALESCE(github_state, 'open') != 'open')"],
  ['merged', "github_state = 'merged'"],
  ['open', "state != 'closed' AND COALESCE(github_state, 'open') = 'open'"],
  ['closed', "(state = 'closed' OR COALESCE(github_state, 'open') != 'open')"],
]);

export interface WaitResult {
  /**
   * `merged` and `closed_on_github` are about the published pull request on GitHub; `agents_done`,
   * see Service.agentsDone; `conflicts`, the head conflicts with its base (Service.baseConflicts);
   * `pushed` and `push_failed`, what came of pushing the head the author waited with once it is
   * published (Service.pushUpdate); `edited` and `edit_failed`, what came of publishing its edits of
   * the title and description then, when it pushed nothing (Service.publishEdits).
   */
  status: 'feedback' | 'published' | 'pushed' | 'push_failed' | 'edited' | 'edit_failed' | 'closed' | 'merged' | 'closed_on_github' | 'agents_done' | 'conflicts' | 'timeout';
  reviews: ReviewRow[];
  comments: CommentRow[];
  /** What the author confirms with markSeen once it has shown this feedback. */
  seenAt?: string;
  /** With `agents_done`: the head the reviewer agents are done with, and what each made of it. */
  agentsDone?: AgentsDone;
  /** The head, when it conflicts with its base: the author confirms with markSeen that it was told. */
  conflicts?: string;
  /** With `pushed` and `push_failed`: the push. */
  push?: GithubPush;
  /** With `edited` and `edit_failed`, and with a push it came with: the author's edits of the title and description, published. */
  edit?: GithubEdit;
  /**
   * Whether the author has anything to address once it has read this: feedback in it that asks
   * something of it (feedback.ts), a thread waiting for its answer, or a reviewer agent's findings
   * in the head it has not answered (Reviewer.answered). Worked out before the feedback counts as
   * seen: once seen, findings with no thread to reply in count as answered.
   */
  asksAuthor?: boolean;
  /** What the reviewer agents that still have the head to review are at ("claude-review is about to review 8c64534"). */
  stillToReview?: string[];
}

/**
 * A push of a published pull request's head to its branch on GitHub, made when the author waited
 * with it (Service.pushUpdate), as its `github_push` event in the timeline has it.
 */
export interface GithubPush {
  at: string;
  url: string;
  /** The staged head it pushed, or tried to. */
  source: string;
  /** The commit GitHub got: a signed copy of `source` when it signed; null when nothing was pushed. */
  head: string | null;
  /** What galley expected the branch on GitHub to be, which a force-push leased on. */
  before: string | null;
  sign: boolean;
  signed: number;
  force: boolean;
  result: 'pushed' | 'failed';
  /** Why nothing was pushed. */
  error?: string;
  /**
   * A failure that is not GitHub refusing the push: GitHub could not be reached or asked, or
   * signing failed for now (`signing`). Tried again when the author next waits, or for signing when
   * `signing.next_at` comes, and not told to the author meanwhile. A refusal is final for the
   * commit, and so is a signing that failed otherwise or too often.
   */
  retry?: boolean;
  /** Why nothing was pushed: signing failed. */
  signing?: SigningFailure;
  /**
   * Refused because the branch on GitHub has commits galley does not have: galley fetched the
   * branch into its remote-tracking branch `ref` (`origin/feature`), at `sha`, for the author to
   * rebase onto; or could not, and `error` says why. `rewritten`: the branch there no longer has
   * all galley knew it to have (a rebase or a force-push on GitHub): the commit galley pushed last,
   * or a tip it fetched since. The author then rebases only its own commits onto it, those after
   * `since`: the staged head galley pushed last, or the tip it rebased onto since (preparePush).
   * Also on a head galley refused for commits such a rewrite removed, with what it fetched before.
   */
  fetched?: { ref: string; sha: string; rewritten: boolean; since?: string } | { ref: string; error: string };
  /**
   * Pushed on top of the branch as rewritten on GitHub: it no longer had `from`, the commit galley
   * pushed last, and was at `to` (`before`) when galley fetched it (preparePush).
   */
  rewritten?: { from: string; to: string };
}

/** What of a pull request galley publishes besides its commits: its title, and its description (the body). */
export type EditField = 'title' | 'description';

/**
 * The author's edits of a published pull request's title and description, published to GitHub
 * when it waited (Service.publishEdits), as its `github_edit` event in the timeline has it. Each
 * field it tried is in one of `published`, `edited_on_github` and `failed`.
 */
export interface GithubEdit {
  at: string;
  url: string;
  /**
   * The pull request's latest event when galley read the title and description it tried: the edits
   * they include are the events up to it, and an edit after it is one since (Service.authorEdits),
   * also one made while gh ran.
   */
  read_upto: number;
  /** What GitHub got. */
  published: EditField[];
  /** What it left alone: someone edited it on GitHub since galley last published it. */
  edited_on_github: EditField[];
  /** What it could not publish, and why (`error`). */
  failed: EditField[];
  error?: string;
  /**
   * A failure that is not GitHub refusing the edit: GitHub could not be reached or asked. Tried
   * again when the author next waits, and not told to the author meanwhile. A refusal is final
   * for the text it tried.
   */
  retry?: boolean;
  /** The title and description as they were then: one it left is not tried again with the same text. */
  title: string;
  body: string;
}

/**
 * A signing that failed (SigningError), as auto-publish and pushes after publishing record it
 * (Service.signingFailure). `why`: what went wrong in a few words, when galley can tell; null
 * when it can not, which is final. `final`: trying again can not get past it, such as a prompt
 * the user denied. `failures`: how many times in a row signing failed so, this time included.
 * Tried again at `next_at` while that is at most `retries`, the setting then (signingRetries);
 * null when it is not tried again.
 */
export interface SigningFailure {
  why: string | null;
  final?: true;
  failures: number;
  retries: number;
  next_at: string | null;
}

/** The tip of a base branch (Service.baseTip). */
export interface BaseTip {
  /** The branch it is the tip of: the remote-tracking one (origin/main) when there is one, else the local one. */
  ref: string;
  /** Its commit; null when there is no such branch. */
  sha: string | null;
  /** Whether that is the remote-tracking branch. */
  tracking: boolean;
}

/**
 * Whether a pull request's head merges cleanly into the tip of its base branch, as galley worked
 * it out with `git merge-tree` (see Service.baseConflicts).
 */
export interface BaseConflicts {
  /** The base branch it is about (pulls.base_ref). */
  branch: string;
  /** The branch it was merged into (BaseTip.ref). */
  ref: string;
  /** That branch's tip, as this repository has it (galley fetches it: Service.fetchBases); null when there is no such branch. */
  base: string | null;
  head: string;
  /** Whether the head merges cleanly: false when it conflicts, null when git could not tell (see error). */
  clean: boolean | null;
  /** The files that conflict. A conflict can be in no file, such as a directory renamed two ways (see messages). */
  files: string[];
  /** git's message for each conflict in none of those files. */
  messages: string[];
  /** Commits the base has that the head does not; null when git could not tell. */
  behind: number | null;
  /** Why git could not tell, when it could not. */
  error: string | null;
}

/** The reviewer agents are done with the head: what `pr wait` tells the author once per commit. */
export interface AgentsDone {
  sha: string;
  /**
   * What each reviewer agent made of the commit ("codex-review found nothing in 8c64534"); none for
   * those turned off. Once automatic reviews are stopped, who stopped them, said once for all.
   */
  reviewers: string[];
}

/** Where the agents are with a pull request: what auto-publish waits for from them (Service.autoPublishChecklist). */
export interface Readiness {
  /** `reviewer`: what the API calls it (Reviewer.key). */
  reviewers: { login: string; engine: string; reviewer: string; status: HeadStatus }[];
  /** The author is running `pr wait`. */
  authorWaiting: boolean;
  /** Reviews and comments the author has not been shown. */
  unseen: number;
  /** Unresolved threads a person started (agents' threads do not count). */
  openThreads: number;
}

/** Whose move a pull request waits for: the author agent's, the reviewer agents', the reviewer's, or nobody's. */
export type Whose = 'author' | 'reviewer_agents' | 'reviewer' | 'none';

/**
 * Where the author agent is: working on feedback it was handed (until its next action), or acted
 * on since it came without being handed it (until it stalls), not yet handed feedback that asks
 * something of it, waiting in `pr wait`, or stopped. Stalled is stopped for Service.stallMs while
 * the reviewer agents wait for it to start them, or with feedback it acted on since it came.
 */
export type AuthorState = 'waiting' | 'unseen' | 'working' | 'stopped' | 'stalled';

/** One reason for whose turn it is, as the list row and `pr view` say it. */
export interface TurnReason {
  /**
   * The author agent, a reviewer agent, what changed since the reviewer's last review, the decision,
   * unresolved threads, an update not on GitHub yet (on nobody's turn, a push whose signing galley
   * tries again), conflicts with the base, what GitHub has for the reviewer (on nobody's turn, what
   * it waits for), or auto-publish (on nobody's turn, what it waits for before it publishes; on the
   * reviewer's, what holds it up that no other reason says).
   */
  kind: 'author' | 'reviewer_agent' | 'changes' | 'approved' | 'changes_requested' | 'threads' | 'unpublished' | 'conflicts' | 'github' | 'auto_publish';
  /** A few words. The reviewer is named by login, so it reads the same to the reviewer and to agents. */
  text: string;
  /** Since when it has been so: waiting, reviewing, working on feedback, or stopped. */
  since?: string | null;
  /** The author's AuthorState, or a reviewer agent's HeadState. */
  state?: AuthorState | HeadState;
  /** A reviewer agent's: it still has the head to review (toReview). An API extension, so the CLI need not know the states. */
  to_review?: boolean;
  /** A reviewer agent's engine. */
  engine?: string;
  /** A reviewer agent as the API calls it (`…/reviewers/{reviewer}`), for asking it to review again. */
  reviewer?: string;
  /** A reviewer agent of the title, description and commit messages (HeadStatus.description): only a new version of them answers its findings. */
  description?: boolean;
}

/**
 * Whose move a pull request waits for (#6). The author agent's from being handed feedback that
 * asks something of it, or a conflict with the base, until its next action (a push, an edit, a
 * reply, a wait); also from acting on the pull request after such feedback came without being
 * handed it, until it stalls. While a reviewer agent still has the head to review, the reviewer
 * agents', or the author's when they start only once it waits (#94). Published, a commit GitHub
 * does not have is the author's too: its wait pushes it; and so are the author's edits of the
 * title and description, which its wait publishes. Then the reviewer's: the reviewer agents
 * are done with the head (or none reviews it), feedback the author is not waiting for is the
 * reviewer's to pass on, a push failed, publishing an edit failed or would overwrite one made on
 * GitHub, the user's own edit is not published, the head conflicts with the base, or the author
 * stalled. Nobody's once it is closed (here, or merged or closed on GitHub), or published with
 * nothing new (or a commit being pushed, or whose signing is tried again, or edits being
 * published), no feedback the author has yet to be handed and no conflict with the base; then the
 * reasons say what GitHub waits for, if anything.
 * With auto-merge on, GitHub merging it is not the reviewer's to do. Nor is publishing what
 * auto-publish publishes on its own: staged with auto-publish on, it is nobody's turn where it
 * would be the reviewer's, unless auto-publish waits for something of theirs (waitsForUser); the
 * reason says what it waits for. When it waits for the author to wait, that is the author's turn,
 * as when the reviewer agents start only once it waits, until it stalls.
 */
export interface Turn {
  whose: Whose;
  reasons: TurnReason[];
}

/** Auto-publish, while it is on: who turned it on, when, and the publish options fixed then. */
export interface AutoPublish {
  by: number;
  at: string;
  sign: boolean;
  draft: boolean;
  /** Force-push if publishing needs it. */
  force: boolean;
  /** Turn on auto-merge on GitHub after publishing, with this merge method; null for no auto-merge. */
  autoMerge: MergeMethod | null;
}

/**
 * One thing auto-publish waits for (`blocking`), or warns of, as the pull request's page lists it
 * (Service.autoPublishChecklist). `key`: `signing`, `reviewer:<key>` (Reviewer.key), `author`,
 * `threads`, `conflicts` or `merge_method`. `failed`: not ok until someone acts, rather than once
 * the agents are done. A reviewer agent's item has its status in place of text, and the retry of
 * a signing that failed its failure (AutoPublishRetry), which the page words.
 */
export type AutoPublishItem = { key: string; ok: boolean; blocking: boolean; failed: boolean } & (
  | { text: string }
  | { reviewer: { login: string; status: HeadStatus } }
  | { signing: AutoPublishRetry }
);

/** The signing auto-publish tries again (Service.autoPublishRetry): when it failed, why, and when it is tried again. */
export type AutoPublishRetry = SigningFailure & { at: string; error: string; next_at: string };

/** What publishing now asks the user to acknowledge (Service.publishAsks): the request's field for it, and why. */
export interface PublishAsk {
  field: 'during_review' | 'during_conflict';
  text: string;
}

/** Automatic reviews, once the reviewer stopped them: who did, when, and after which round (see Service.automaticRound). */
export interface IterationsStopped {
  by: number;
  at: string;
  round: number;
}

/**
 * The last time galley turned on auto-merge for the published pull request, and what came of
 * it: on, merged at once (GitHub had nothing to wait for), requested (gh accepted it, but which
 * of the two it was could not be checked), or failed. It says what GitHub did then; the merge
 * itself is recorded when following the pull request finds it (followGithub).
 */
export interface AutoMerge {
  state: 'enabled' | 'merged' | 'requested' | 'failed';
  by: number;
  at: string;
  url: string;
  method: MergeMethod;
  /** gh's message, when it failed. */
  error?: string;
}

/**
 * Why auto-publish was turned off before it published. (Events from before it ended at the first
 * publish also say `merged` or `closed_on_github`.)
 */
export type AutoPublishOff = 'cancelled' | 'closed' | 'changes_requested' | 'base_changed';

/** A repository on GitHub, as galley shows it: what merging there allows. */
export interface GithubRepo {
  merging: {
    /** "Allow auto-merge" in the repository's settings. */
    autoMerge: boolean;
    methods: MergeMethod[];
  };
}

/** Whether publishing can turn on auto-merge in a repository: GitHub allows auto-merge there, and maybe not the method from settings. */
export interface AutoMergeOption {
  method: MergeMethod;
  methodAllowed: boolean;
  methods: MergeMethod[];
}

/** A push to a pull request's branch on GitHub, ready to go (Service.preparePush). */
interface PushPlan {
  /** The commit to push: the head, or its signed copy. */
  pushed: string;
  /** How many commits were signed for it. */
  signed: number;
  /** It replaces the commit the branch has on GitHub, with a lease on that commit (`before`). */
  force: boolean;
  /** The commit galley takes the branch on GitHub to have (Service.onGitHub), or the fetched branch it goes on top of. */
  before: string | null;
  /** It goes on top of the branch as rewritten on GitHub (`before`), which no longer has `from`, the commit galley pushed last. */
  rewritten?: { from: string; to: string };
  /** The commits that rewrite removed which it brings back, as the user confirmed when publishing by hand. */
  broughtBack?: string[];
  /** The `git push` arguments. */
  args: string[];
}

/**
 * What publishing the head would bring back of the commits a rewrite on GitHub removed
 * (Service.bringsBack): publishing refuses it unless the user confirms each of them.
 */
export interface BringsBack {
  /** The rewrite: the branch no longer has `from`, and galley fetched it into `ref` at `to`. */
  from: string;
  to: string;
  ref: string;
  /** The removed commits it would bring back, newest first. */
  commits: string[];
}

/** How often galley asks GitHub about published pull requests: while something runs there, and otherwise. */
export const FOLLOW_BUSY_MS = 20_000;
export const FOLLOW_IDLE_MS = 60_000;

/**
 * How long an author agent may stay away from `pr wait` while the reviewer agents wait for it to
 * start them, or after acting on feedback it was not handed. After that it has stalled, its
 * session has probably ended, and the pull request is the reviewer's turn (Service.turn).
 */
export const AUTHOR_STALL_MS = 30 * 60 * 1000;

/** How long a `pr wait` that ended still counts as waiting, in case the author comes straight back (Service.setWaiting). */
export const WAIT_GRACE_MS = 3000;

/** How long each step of an unattended publish (signing a commit, the push, each gh call) may take. */
export const UNATTENDED_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * How long after signing failed for now auto-publish or a push after publishing tries again; each
 * retry after that waits three times as long as the one before: 5, 15, 45 minutes. Each try may
 * show a prompt.
 */
export const SIGNING_RETRY_MS = 5 * 60 * 1000;

/** How long after fetching a repository's base branches galley may fetch them again (Service.fetchBases). */
export const FETCH_EVERY_MS = 60_000;
/** How long fetching a branch may take: a base branch, or a pull request's after a refused push (Service.fetchHead). */
const FETCH_TIMEOUT_MS = 30_000;
/** How long galley's first fetch of a GitHub repository, for its clone, may take (Service.registerGithub). */
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** A repository's latest round of fetching its base branches (Service.fetchBases): when it started, which, and while it runs, the fetch. */
interface FetchRound {
  at: number;
  bases: Set<string>;
  running: Promise<void> | null;
}

/** What GitHub's GraphQL API answered (Service.graphql). */
interface GraphqlAnswer {
  data: Record<string, any> | null;
  errors: { type?: string; message?: string }[];
}

/**
 * Where galley keeps refs in the repositories it stages from. Each server has a namespace of its
 * own under it (Db.instance), so servers staging from one repository never touch each other's.
 * A database pins its revisions in its namespace when it gets its id (Service.pinRevisions).
 */
export const REFS = 'refs/galley';

/** The key a repository gets in URLs: the GitHub owner/name of its remote, or local/<dir> without one. */
function repoKey(slug: string | null, gitDir: string, workDir: string | null): [string, string] {
  return slug ? (slug.split('/') as [string, string]) : ['local', basename(workDir ?? gitDir.replace(/\.git$/, ''))];
}

export interface ServiceOptions {
  db: Db;
  baseUrl: string;
  ghBin?: string;
  viewerLogin?: string;
  /** How long after fetching a repository's base branches they may be fetched again (FETCH_EVERY_MS). */
  fetchEveryMs?: number;
  /** The server's data directory, where galley keeps its own clones of GitHub repositories, in repos/ (registerGithub). */
  dataDir?: string;
  /** Whether a repository registered by its GitHub owner/name gets a clone of galley's own (GALLEY_CLONES); without, repositories are registered by path. */
  clones?: boolean;
  /** Where galley fetches a GitHub repository from and pushes it to, for its clones: GitHub's https URL unless given (tests give a local repository). */
  githubUrl?: (slug: string) => string;
}

export class Service {
  db: Db;
  baseUrl: string;
  ghBin: string;
  bus = new EventEmitter();
  /** Codex and Claude as reviewer agents, when the server runs them. */
  codex: CodexReviewer | null = null;
  claude: ClaudeReviewer | null = null;
  /** The user's own reviewer agents, from their definition files. */
  custom: CustomReviewers | null = null;
  /** The server is stopping, once the reviews running now have posted (see startServer's close). */
  stopping = false;
  /**
   * The desktop apps following /events now (desktop/live.ts), each with the computer it runs on
   * (computer.ts) and whether it opens galley links: its menu's "Open galley links in the app" is
   * on, and galley:// links go to it.
   */
  desktopApps = new Set<{ computer: string; openLinks: boolean }>();
  /** Number of `pr wait` calls currently blocked, per pull id (authorWaiting, waitingPulls). */
  private waiters = new Map<number, number>();
  /** When an author that keeps the reviewer agents waiting has stalled (AUTHOR_STALL_MS; tests shorten it). */
  stallMs = AUTHOR_STALL_MS;
  /** How long a wait that ended still counts (WAIT_GRACE_MS; tests shorten it). */
  waitGraceMs = WAIT_GRACE_MS;
  /** How long after signing failed for now it is first tried again (SIGNING_RETRY_MS; tests shorten it). */
  signingRetryMs = SIGNING_RETRY_MS;
  private syncing = new Map<number, Promise<PullRow>>();
  private viewerLogin: string;
  /** How long after fetching a repository's base branches they may be fetched again, except right before publishing (fetchBases). */
  fetchEveryMs: number;
  /** The data directory, which galley's clones are in (registerGithub); null for a service that keeps none. */
  dataDir: string | null;
  /** Whether repositories registered by their GitHub owner/name get a clone of galley's own (registerGithub). */
  clones: boolean;
  /** Where galley fetches a GitHub repository from, by its owner/name, and where its clones push to. */
  githubUrl: (slug: string) => string;

  constructor(opts: ServiceOptions) {
    this.db = opts.db;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.ghBin = opts.ghBin ?? 'gh';
    this.fetchEveryMs = opts.fetchEveryMs ?? FETCH_EVERY_MS;
    // Absolute, since git runs elsewhere: with another cwd, and hooks in the clone (git-http.ts).
    this.dataDir = opts.dataDir ? resolve(opts.dataDir) : null;
    this.clones = opts.clones ?? false;
    this.githubUrl = opts.githubUrl ?? ((slug) => `https://github.com/${slug}.git`);
    this.viewerLogin = opts.viewerLogin ?? this.db.getMeta('viewer_login') ?? process.env.USER ?? 'you';
    this.bus.setMaxListeners(0);
  }

  /** Whether a desktop app on `computer` follows the server, and whether one there opens galley links (desktopApps). */
  desktopApp(computer: string): { connected: boolean; openLinks: boolean } {
    const there = [...this.desktopApps].filter((a) => a.computer === computer);
    return { connected: there.length > 0, openLinks: there.some((a) => a.openLinks) };
  }

  // ---------------------------------------------------------------- actors

  /** The human using the web UI. */
  viewer(): Actor {
    return this.db.actor(this.viewerLogin, 'User');
  }

  setViewerLogin(login: string): void {
    this.viewerLogin = login;
    this.db.setMeta('viewer_login', login);
    this.claimViewerLogin();
    // A custom reviewer by the human's name can not have it now.
    this.custom?.load();
  }

  /** The human's login belongs to the human: a reviewer bot holding it moves to another name. */
  claimViewerLogin(): void {
    for (const r of this.reviewerAgents()) r.releaseName(this.viewerLogin);
    this.custom?.releaseName(this.viewerLogin);
    this.viewer();
  }

  /**
   * The actor, refused with 403 and `message` when it is an agent (a Bot): for what is the user's
   * to do, as docs/api.md lists it. Deleting, pinning and stop-iterating are checked here, asking
   * for or configuring a reviewer agent in Reviewer, settings in the API. Publishing and
   * auto-publish are the author's too (requireUserOrAuthor).
   */
  requireHuman(actor: Actor, message = 'only the user can do this'): Actor {
    if (actor.type === 'Bot') throw new HttpError(403, message);
    return actor;
  }

  /**
   * The actor, refused with 403 unless it is the user or the pull request's author: for publishing
   * and auto-publish, which the agent that staged a pull request may do when the user asks it to.
   * Any other agent is refused, one that reviews under its own name among them. `what`: what is
   * refused, as "publish it".
   */
  requireUserOrAuthor(actor: Actor, pull: PullRow, what: string): Actor {
    if (actor.type !== 'Bot' || actor.id === pull.author_id) return actor;
    throw new HttpError(403, `only the user or the author of this pull request (${this.db.actorById(pull.author_id).login}) can ${what}, not ${actor.login}`);
  }

  /** Look up the GitHub login of whoever `gh` is authenticated as, so the UI can show their avatar. */
  async detectViewer(): Promise<void> {
    if (this.db.getMeta('viewer_login')) return;
    try {
      const r = await run(this.ghBin, ['api', 'user', '--jq', '.login'], { allowFail: true });
      const login = r.stdout.trim();
      if (r.code === 0 && login) this.setViewerLogin(login);
    } catch {
      // gh is not installed; keep the OS user name.
    }
  }

  emit(pullId: number | null, type: string, actor: Actor): void {
    this.bus.emit('change', { pullId, type, actor: actor.login, source: null } satisfies ChangeEvent);
  }

  /**
   * Announce a change no actor made, from `source`. Never as an actor: an author agent may be
   * named "github" or "git" (GALLEY_ACTOR), and its `pr wait` would take the change for its own.
   */
  emitSystem(pullId: number | null, type: string, source: ChangeSource): void {
    this.bus.emit('change', { pullId, type, actor: null, source } satisfies ChangeEvent);
  }

  // --------------------------------------------------------- GitHub repos

  /** The failures of GitHub's GraphQL API logged so far, as `<slug> <failureKey>`: each is logged once, until a restart. */
  private graphqlErrors = new Set<string>();

  /**
   * Ask GitHub's GraphQL API with gh about the repository `slug`: the query gets its `owner` and
   * `name` as variables, and `vars`. GitHub answers what it could alongside its errors (a number
   * that is not there, a scope the token lacks), so both come back; null when gh gave no answer
   * (not logged in, offline, timed out). Each failure is logged once per repository (failureKey).
   */
  private async graphql(slug: string, query: string, vars: Record<string, string> = {}): Promise<GraphqlAnswer | null> {
    const [owner, name] = slug.split('/');
    // -f, not -F: -F would turn a repository named "123" or "true" into a number or boolean.
    const args = ['api', 'graphql', '-f', `query=${query}`, ...Object.entries({ owner, name, ...vars }).flatMap(([k, v]) => ['-f', `${k}=${v}`])];
    let answer: GraphqlAnswer | null = null;
    let failures: string[];
    try {
      const r = await run(this.ghBin, args, { allowFail: true, timeoutMs: 15_000 });
      try {
        const json = JSON.parse(r.stdout);
        answer = { data: json.data ?? null, errors: json.errors ?? [] };
      } catch {}
      if (answer?.errors.length) failures = answer.errors.map((e) => e.message ?? JSON.stringify(e));
      else if (r.code === 0 && answer?.data) failures = [];
      else if (r.timedOut) failures = ['gh timed out'];
      // Neither: refused before GraphQL answered (a token revoked, say, gets GitHub's REST error), gh says why on stderr.
      else failures = [(r.stderr || r.stdout).trim() || `gh exited with ${r.code}`];
    } catch (e) {
      failures = [(e as Error).message];
    }
    for (const message of failures) {
      const key = `${slug} ${failureKey(message)}`;
      if (this.graphqlErrors.has(key)) continue;
      this.graphqlErrors.add(key);
      console.error(`asking GitHub about ${slug} failed: ${message}`);
    }
    return answer;
  }

  private githubRepoCache = new Map<string, { at: number; value: GithubRepo | null; loading?: Promise<void> }>();

  /**
   * The repository on GitHub: what merging allows. Null when the last attempt to ask GitHub
   * failed. Never waits on the network: it answers from the cache (or with nothing) and refreshes
   * it in the background.
   */
  githubRepo(slug: string): GithubRepo | null {
    const hit = this.githubRepoCache.get(slug);
    if (!hit || (Date.now() - hit.at > 5 * 60_000 && !hit.loading)) this.refreshGithubRepo(slug);
    return hit?.value ?? null;
  }

  refreshGithubRepo(slug: string): Promise<void> {
    const current = this.githubRepoCache.get(slug);
    if (current?.loading) return current.loading;
    const query = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}';
    const loading = this.graphql(slug, query)
      .then((answer): GithubRepo | null => {
        const repo = answer?.data?.repository;
        // What merging allows is not known now.
        if (!repo) return null;
        const allowed = { squash: repo.squashMergeAllowed, merge: repo.mergeCommitAllowed, rebase: repo.rebaseMergeAllowed };
        return { merging: { autoMerge: repo.autoMergeAllowed === true, methods: MERGE_METHODS.filter((m) => allowed[m] === true) } };
      })
      .then((value) => {
        this.githubRepoCache.set(slug, { at: Date.now(), value });
        // Pages rendered before this answer came show old or no options; let them refresh.
        if (JSON.stringify(value) !== JSON.stringify(current?.value ?? null)) {
          this.emitSystem(null, 'github_repo', 'github');
        }
      });
    this.githubRepoCache.set(slug, { at: current?.at ?? 0, value: current?.value ?? null, loading });
    return loading;
  }

  private githubIssueCache = new Map<string, { at: number; value: IssueSummary | null; loading?: boolean }>();
  private githubIssueQueue: Map<string, Set<number>> | null = null;

  /**
   * The title and state of an issue or pull request on GitHub, for links to it. Like `githubRepo`, it
   * never waits on the network: the lookups one page render asks for go out together, afterwards.
   * `lookUp: false` answers from the cache alone.
   */
  githubIssue(slug: string, number: number, opts: { lookUp?: boolean } = {}): IssueSummary | null {
    const key = `${slug}#${number}`;
    const hit = this.githubIssueCache.get(key);
    if (opts.lookUp !== false && (!hit || (Date.now() - hit.at > 5 * 60_000 && !hit.loading))) {
      this.githubIssueCache.set(key, { at: hit?.at ?? 0, value: hit?.value ?? null, loading: true });
      if (!this.githubIssueQueue) {
        const queue = (this.githubIssueQueue = new Map());
        setImmediate(() => {
          this.githubIssueQueue = null;
          for (const [repo, numbers] of queue) void this.refreshGithubIssues(repo, [...numbers]);
        });
      }
      this.githubIssueQueue.set(slug, (this.githubIssueQueue.get(slug) ?? new Set()).add(number));
    }
    return hit?.value ?? null;
  }

  async refreshGithubIssues(slug: string, numbers: number[]): Promise<void> {
    // Numbers are digits (references.ts), so they can go into the query itself.
    const fields = numbers.map((n) => `i${n}:issueOrPullRequest(number:${n}){__typename ...on Issue{title state stateReason} ...on PullRequest{title state isDraft}}`);
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(' ')}}}`;
    // An unknown number fails the query but still answers for the others.
    const found: Record<string, any> | null = (await this.graphql(slug, query))?.data?.repository ?? null;
    let changed = false;
    for (const n of numbers) {
      const key = `${slug}#${n}`;
      const before = this.githubIssueCache.get(key)?.value ?? null;
      const value = found ? issueSummary(found[`i${n}`]) : before;
      this.githubIssueCache.set(key, { at: Date.now(), value });
      if (JSON.stringify(value) !== JSON.stringify(before)) changed = true;
    }
    // Pages rendered before the answer came link without titles; let them refresh.
    if (changed) this.emitSystem(null, 'github_issues', 'github');
  }

  // ------------------------------------------------------ following GitHub

  /** Published pull requests that galley follows on GitHub: not known to be merged or closed there, and not closed here. */
  followed(): PullRow[] {
    return this.db.all<PullRow>("SELECT * FROM pulls WHERE state = 'published' AND COALESCE(github_state, 'open') = 'open'");
  }

  private following: Promise<void> = Promise.resolve();
  /** When galley last asked GitHub about each repository's pull requests. */
  private githubAskedAt = new Map<string, number>();
  /** Whether to ask GitHub for the names of teams asked to review: not once it refused them for want of the read:org scope, until a restart. */
  githubTeamNames = true;

  /**
   * Ask GitHub about the published pull requests it follows, with one query per repository for
   * all of them, and record what changed: merged or closed there, checks, reviews, threads,
   * conflicts. With `due`, only the repositories due: every 20 seconds while something runs
   * there (checks, workflow runs, Copilot), every minute otherwise; the server asks so on a
   * timer. Pages never wait for it. Calls take turns.
   */
  followGithub(opts: { due?: boolean } = {}): Promise<void> {
    this.following = this.following.then(() => this.askGithub(opts.due ?? false).catch((e) => console.error('following GitHub failed:', e)));
    return this.following;
  }

  private async askGithub(due: boolean): Promise<void> {
    const onGithub = this.followed().flatMap((pull) => {
      const m = pull.published_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
      return m ? [{ pull, slug: m[1], number: Number(m[2]) }] : [];
    });
    for (const [slug, items] of Map.groupBy(onGithub, (x) => x.slug)) {
      const every = items.some(({ pull }) => githubBusy(githubStatus(pull))) ? FOLLOW_BUSY_MS : FOLLOW_IDLE_MS;
      // A second of slack, so a timer ticking every 20 seconds does not skip a round.
      if (due && Date.now() - (this.githubAskedAt.get(slug) ?? 0) < every - 1000) continue;
      this.githubAskedAt.set(slug, Date.now());
      const ask = (fields: string) => {
        // Aliased by pull id: one GitHub pull request can have been published from several staged ones.
        const pulls = items.map(({ pull, number }) => `p${pull.id}:pullRequest(number:${number}){${fields}}`);
        return this.graphql(slug, `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${pulls.join(' ')}}}`);
      };
      // What GitHub says counts as of when galley asked, not when the answer came: a question asked
      // before a push may be answered after it, about the commit that push replaced (turn).
      const sentAt = now();
      let answer = await ask(this.githubTeamNames ? PULL_FIELDS : PULL_FIELDS_WITHOUT_TEAMS);
      // Refused for the teams' names: ask again without them, from now on.
      if (this.githubTeamNames && answer?.errors.some((e) => e.type === 'INSUFFICIENT_SCOPES')) {
        this.githubTeamNames = false;
        answer = await ask(PULL_FIELDS_WITHOUT_TEAMS);
      }
      const found: Record<string, GithubPull | null> | null = answer?.data?.repository ?? null;
      // Those without an answer (gh failed, or the pull request is gone) are asked again next time.
      for (const { pull, number } of items) {
        const node = found?.[`p${pull.id}`];
        if (node?.state) await this.recordGithub(pull.id, node, slug, number, sentAt);
      }
    }
  }

  /** Record what GitHub says about a published pull request, asked at `sentAt`: merged or closed there, or how it stands while open. */
  async recordGithub(pullId: number, node: GithubPull, slug: string, number: number, sentAt: string): Promise<void> {
    if (node.state !== 'OPEN') return this.recordGithubEnd(pullId, node);
    const complete = await this.readEarlierThreads(slug, number, node);
    const type = this.db.transaction(() => {
      const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
      // Closed here, or merged or closed on GitHub, while gh answered: no longer followed.
      if (!pull || pull.state !== 'published' || (pull.github_state ?? 'open') !== 'open') return null;
      // What was seen before, also when a publish followed it again after a close on GitHub.
      const previous = pull.github_status ? (JSON.parse(pull.github_status) as GithubStatus) : null;
      // Threads on pages it could not read stay as they were.
      const status = readGithub(node, previous, sentAt, complete);
      this.db.update('pulls', pull.id, { github_state: 'open', github_status: JSON.stringify(status) });
      // Pages show the status; tell them when it changed, not each time galley asked. The first
      // answer since galley's latest push or publish, or since it turned on auto-merge, is news even
      // when GitHub says the same: what it said before may have been taken for news of a commit that
      // push replaced, or for auto-merge being on when it says it is off (turn).
      const since = [pull.published_at ?? '', this.autoMerge(pull)?.at ?? ''].reduce((a, b) => (a > b ? a : b));
      const same = previous && previous.checkedAt >= since && JSON.stringify({ ...previous, checkedAt: null }) === JSON.stringify({ ...status, checkedAt: null });
      return pull.github_state === 'open' && same ? null : 'github_status';
    });
    // From GitHub, like what merging allows: pages refresh. It is for the reviewer; the author's `pr wait` hears only of a merge or close.
    if (type) this.emitSystem(pullId, type, 'github');
  }

  /**
   * The review threads before the first page, for a pull request with more of them than it holds
   * (up to 20 pages more). False when some could not be read.
   */
  private async readEarlierThreads(slug: string, number: number, node: GithubPull): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      const cursor = earlierThreads(node);
      if (!cursor) return true;
      const page = (await this.graphql(slug, earlierThreadsQuery(number), { cursor }))?.data?.repository?.pullRequest?.reviewThreads;
      if (!page) return false;
      prependThreads(node, page);
    }
    return !earlierThreads(node);
  }

  /** Record that a published pull request was merged or closed on GitHub. */
  private recordGithubEnd(pullId: number, node: GithubPull): void {
    const state: GithubState = node.state === 'MERGED' ? 'merged' : 'closed';
    const viewer = this.viewer();
    const type = this.db.transaction(() => {
      const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
      // Closed here or deleted while GitHub answered: no longer followed.
      if (!pull || pull.state !== 'published' || pull.github_state === state) return null;
      const merged = state === 'merged';
      const at = (merged ? node.mergedAt : node.closedAt) ?? now();
      const closer = present(node.timelineItems).findLast((i) => i.__typename === 'ClosedEvent');
      const by = (merged ? node.mergedBy?.login : closer?.actor?.login) ?? null;
      const commit = node.mergeCommit?.oid ?? null;
      const ts = now();
      this.db.update('pulls', pull.id, { github_state: state, github_closed_at: at, github_closed_by: by, github_merge_sha: commit, updated_at: ts });
      // Published again after it was closed on GitHub, and still closed there: that close is in the timeline already.
      if (!merged && pull.github_closed_at === at) return 'github_state';
      // The event says when galley learned of it, so `pr wait` delivers it like any news; `at` says when it happened.
      this.addEvent(pull, viewer, merged ? 'merged' : 'closed_on_github', { url: pull.published_url, by, at, commit }, ts);
      return merged ? 'merged' : 'closed_on_github';
    });
    if (!type) return;
    this.cancelReviews(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId)!, state === 'merged' ? 'merged' : 'closed_on_github');
    this.emitSystem(pullId, type, 'github');
  }

  // ----------------------------------------------------------------- repos

  /**
   * Register the repository at `path`, keyed by its common git dir so its worktrees share one
   * entry. Its name in URLs is the GitHub owner/name of its remote, or local/<dir> without one.
   */
  async registerRepo(path: string): Promise<RepoRow> {
    const r = await run('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
    if (r.code !== 0) throw new HttpError(422, `not a git repository: ${path}`);
    const gitDir = r.stdout.trim();
    const workDir = basename(gitDir) === '.git' ? dirname(gitDir) : null;
    const { remote, slug } = await this.remoteOf(new Repo(gitDir));

    const existing = this.db.get<RepoRow>('SELECT * FROM repos WHERE git_dir = ?', gitDir);
    if (existing) {
      if (existing.remote !== remote || existing.work_dir !== workDir) this.db.update('repos', existing.id, { remote, work_dir: workDir });
      this.followSlug(existing, slug);
      return this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', existing.id)!;
    }

    const [owner, name] = this.freeKey(repoKey(slug, gitDir, workDir), null);
    const id = this.db.transaction(() => {
      // A repository's own key wins over another's old one.
      this.db.run('DELETE FROM repo_aliases WHERE owner = ? AND name = ?', owner, name);
      return this.db.insert('repos', { git_dir: gitDir, work_dir: workDir, owner, name, remote, github_slug: slug, created_at: now() });
    });
    return this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)!;
  }

  /** The remote a repository follows, origin or else its first, and the GitHub repository it names. */
  private async remoteOf(git: Repo): Promise<{ remote: string; slug: string | null }> {
    const remotes = await git.remotes();
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
    return { remote, slug: githubSlug(await git.remoteUrl(remote)) };
  }

  /**
   * Record the GitHub repository that a registered one's remote names now. When it is another
   * one than the key names (renamed or transferred there, or added to a local repository), the
   * key follows, as registering the repository now would give it, and the old one stays an
   * alias: its pages redirect, and its API paths still work.
   */
  private followSlug(repo: RepoRow, slug: string | null): void {
    if (slug !== repo.github_slug) this.db.update('repos', repo.id, { github_slug: slug });
    // Without a GitHub repository to follow, the key stays.
    if (!slug) return;
    const [owner, base] = repoKey(slug, repo.git_dir, repo.work_dir);
    // A number it got because another repository had the name stays while the remote names the
    // same repository and the name is the other's, or its old one. A name ending in digits, or
    // one kept from before keys followed the remote, is no such number.
    const numbered =
      slug === repo.github_slug &&
      repo.name.startsWith(base) &&
      /^-\d+$/.test(repo.name.slice(base.length)) &&
      !!this.db.get('SELECT 1 FROM repos WHERE owner = ? AND name = ? AND id != ? UNION ALL SELECT 1 FROM repo_aliases WHERE owner = ? AND name = ? AND repo_id != ?', owner, base, repo.id, owner, base, repo.id);
    if (repo.owner === owner && (repo.name === base || numbered)) return;
    const [, name] = this.freeKey([owner, base], repo.id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM repo_aliases WHERE owner = ? AND name = ?', owner, name);
      this.db.run('INSERT OR REPLACE INTO repo_aliases (owner, name, repo_id) VALUES (?, ?, ?)', repo.owner, repo.name, repo.id);
      this.db.update('repos', repo.id, { owner, name });
    });
    this.emitSystem(null, 'repo_renamed', 'git');
  }

  /** Follow each repository's remote to the GitHub repository it names now (followSlug), as registering it again would. galley's clones follow none. */
  async followRemotes(): Promise<void> {
    for (const repo of this.repos()) {
      if (this.isClone(repo) || !existsSync(repo.git_dir)) continue;
      try {
        const { remote, slug } = await this.remoteOf(this.git(repo));
        if (remote !== repo.remote) this.db.update('repos', repo.id, { remote });
        this.followSlug(repo, slug);
      } catch (e) {
        console.error(`could not read the remotes of ${repo.git_dir}:`, e);
      }
    }
  }

  /** Registrations by GitHub owner/name under way, by the name in lowercase, so registering one twice at once clones it once. */
  private registering = new Map<string, Promise<RepoRow>>();

  /**
   * Register the repository GitHub has as `slug` (owner/name), by that name, as the CLI does from
   * another machine: the one registered already with it as its GitHub repository (one registered by
   * path stays so), or under a name it had before (followSlug), or else a new one in a clone of
   * galley's own (createClone). Registering it twice at once clones it once.
   */
  async registerGithub(slug: string): Promise<RepoRow> {
    const m = slug.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
    if (!m || m[2] === '.' || m[2] === '..') throw new HttpError(422, `not a GitHub repository's owner/name: ${slug}`);
    const name = `${m[1]}/${m[2]}`;
    const key = name.toLowerCase();
    let registering = this.registering.get(key);
    if (!registering) {
      registering = this.registerSlug(name).finally(() => this.registering.delete(key));
      this.registering.set(key, registering);
    }
    return registering;
  }

  private async registerSlug(slug: string): Promise<RepoRow> {
    const [owner, name] = slug.split('/');
    // GitHub's names are the same in any case, its former ones too (movedRepo).
    const known =
      this.db.get<RepoRow>('SELECT * FROM repos WHERE github_slug = ? COLLATE NOCASE ORDER BY id LIMIT 1', slug) ??
      this.db.get<RepoRow>('SELECT repos.* FROM repo_aliases JOIN repos ON repos.id = repo_aliases.repo_id WHERE repo_aliases.owner = ? COLLATE NOCASE AND repo_aliases.name = ? COLLATE NOCASE', owner, name);
    if (known) return known;
    if (!this.dataDir) throw new HttpError(501, 'this server keeps no clones of its own');
    return this.createClone(slug);
  }

  /**
   * Make galley's own clone of a GitHub repository and register it: bare, in the data directory as
   * repos/<id>.git, with git_dir relative to it, so the data directory can move to another machine
   * as it is. Branches come from the CLI, over git's smart HTTP (git-http.ts). Base branches, and
   * the branch of a published pull request when GitHub refused a push, are fetched from GitHub into
   * refs/remotes/origin/ (fetchBases, fetchHead), and publishing pushes to GitHub by URL, with
   * gh's credentials (preparePush); no fetch refspec, since galley names what it fetches. It starts
   * with GitHub's default branch, which origin/HEAD and HEAD name.
   */
  private async createClone(slug: string): Promise<RepoRow> {
    const dataDir = this.dataDir!;
    const repos = join(dataDir, 'repos');
    mkdirSync(repos, { recursive: true });
    // Under a name of its own until it has the default branch, so a clone that failed leaves nothing behind.
    const made = mkdtempSync(join(repos, 'new-'));
    try {
      await run('git', ['init', '--bare', '--quiet', made]);
      const git = new Repo(made);
      const url = this.githubUrl(slug);
      await git.run(['config', 'remote.origin.url', url]);
      const signal = this.fetchAbort.signal;
      const opts = { gh: this.ghBin, cwd: tmpdir(), timeoutMs: CLONE_TIMEOUT_MS, signal };
      const stopping = new HttpError(503, 'galley is stopping');
      const branch = await git.defaultBranchAt(url, opts).catch((e: Error) => {
        throw signal.aborted ? stopping : new HttpError(502, `could not ask GitHub for the default branch of ${slug}: ${e.message}`);
      });
      const error = await git.fetchBranch(url, branch, `refs/remotes/origin/${branch}`, opts);
      if (signal.aborted) throw stopping;
      if (error) throw new HttpError(502, `could not fetch ${branch} of ${slug} from GitHub: ${error}`);
      await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
      // So a ref of HEAD (contents) means the default branch, as on GitHub.
      await git.run(['symbolic-ref', 'HEAD', `refs/remotes/origin/${branch}`]);
      const [owner, name] = this.freeKey(slug.split('/') as [string, string], null);
      const id = this.db.transaction(() => {
        this.db.run('DELETE FROM repo_aliases WHERE owner = ? AND name = ?', owner, name);
        const id = this.db.insert('repos', { git_dir: relative(dataDir, made), work_dir: null, owner, name, remote: 'origin', github_slug: slug, created_at: now() });
        const gitDir = join('repos', `${id}.git`);
        renameSync(made, join(dataDir, gitDir));
        this.db.update('repos', id, { git_dir: gitDir });
        return id;
      });
      return this.repoById(id);
    } catch (e) {
      rmSync(made, { recursive: true, force: true });
      throw e;
    }
  }

  /** Whether the repository is galley's own clone (createClone), not the user's repository, registered by path. */
  isClone(repo: RepoRow): boolean {
    return !isAbsolute(repo.git_dir);
  }

  /** Where the CLI sends branches to galley's clone of the repository and fetches them back (git-http.ts); null for a repository registered by path. */
  gitUrl(repo: RepoRow): string | null {
    return this.isClone(repo) ? `${this.baseUrl}/git/${repo.owner}/${repo.name}.git` : null;
  }

  /** The key `owner/name`, or `name-2` and on when another repository has it. */
  private freeKey([owner, base]: [string, string], self: number | null): [string, string] {
    let name = base;
    for (let i = 2; this.db.get('SELECT 1 FROM repos WHERE owner = ? AND name = ? AND id IS NOT ?', owner, name, self); i++) name = `${base}-${i}`;
    return [owner, name];
  }

  repo(owner: string, name: string): RepoRow {
    const repo = this.db.get<RepoRow>('SELECT * FROM repos WHERE owner = ? AND name = ?', owner, name) ?? this.movedRepo(owner, name);
    if (!repo) throw new HttpError(404, `repository ${owner}/${name} is not known to galley`);
    return repo;
  }

  /** The repository that had the key `owner/name` before its GitHub slug changed (followSlug). */
  movedRepo(owner: string, name: string): RepoRow | undefined {
    return this.db.get<RepoRow>('SELECT repos.* FROM repo_aliases JOIN repos ON repos.id = repo_aliases.repo_id WHERE repo_aliases.owner = ? AND repo_aliases.name = ?', owner, name);
  }

  repos(): RepoRow[] {
    return this.db.all<RepoRow>('SELECT * FROM repos ORDER BY owner, name');
  }

  /** The repository's git directory: the user's, or galley's clone in the data directory. */
  gitDir(repo: RepoRow): string {
    if (isAbsolute(repo.git_dir)) return repo.git_dir;
    if (!this.dataDir) throw new Error(`${repo.git_dir} is in a data directory this service was not given`);
    return join(this.dataDir, repo.git_dir);
  }

  git(repo: RepoRow): Repo {
    return new Repo(this.gitDir(repo));
  }

  async defaultBranch(repo: RepoRow): Promise<string> {
    const git = this.git(repo);
    const r = await git.run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${repo.remote}/HEAD`], { allowFail: true });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(`${repo.remote}/`, '');
    for (const b of ['main', 'master', 'trunk', 'develop']) {
      if ((await git.resolve(`refs/heads/${b}`)) || (await git.resolve(`refs/remotes/${repo.remote}/${b}`))) return b;
    }
    throw new HttpError(422, 'could not determine the base branch; pass --base');
  }

  /**
   * The tip of a base branch. The remote-tracking branch wins over the local one, because that is
   * what the pull request will be compared against once it is on GitHub. From `refs` (Repo.refs)
   * when the caller has read them, else from git.
   */
  async baseTip(repo: RepoRow, branch: string, refs?: Map<string, string>): Promise<BaseTip> {
    const git = this.git(repo);
    const resolve = async (ref: string) => (refs ? (refs.get(ref) ?? null) : await git.resolve(ref));
    const tracking = await resolve(`refs/remotes/${repo.remote}/${branch}`);
    if (tracking) return { ref: `${repo.remote}/${branch}`, sha: tracking, tracking: true };
    return { ref: branch, sha: await resolve(`refs/heads/${branch}`), tracking: false };
  }

  // ----------------------------------------------------------------- pulls

  pullUrl(repo: RepoRow, pull: Pick<PullRow, 'number'>): string {
    return `${this.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
  }

  async ctx(owner: string, name: string, number: number, opts: { sync?: boolean } = {}): Promise<Ctx> {
    const repo = this.repo(owner, name);
    let pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE repo_id = ? AND number = ?', repo.id, number);
    if (!pull) throw new HttpError(404, `no pull request found for s#${number} in ${owner}/${name}`);
    if (opts.sync !== false) pull = await this.sync(pull);
    return { repo, pull, git: this.git(repo) };
  }

  pulls(repo: RepoRow | null, filter: { state?: string; head?: string; base?: string } = {}): PullRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (repo) {
      where.push('repo_id = ?');
      params.push(repo.id);
    }
    if (filter.state && filter.state !== 'all') {
      const listed = LISTED.get(filter.state);
      if (!listed) throw new HttpError(422, `state must be one of ${[...LISTED.keys(), 'all'].join(', ')}`);
      where.push(listed);
    }
    if (filter.head) {
      where.push('head_ref = ?');
      params.push(filter.head.replace(/^[^:]+:/, ''));
    }
    if (filter.base) {
      where.push('base_ref = ?');
      params.push(filter.base);
    }
    return this.db.all<PullRow>(`SELECT * FROM pulls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`, ...params);
  }

  repoById(id: number): RepoRow {
    return this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)!;
  }

  /**
   * What staging asks of the reviewer agents (a galley extension to POST /pulls), as the
   * pull request's own settings. `reviewers` turns the named ones on, with their own limit
   * when one is given; `automatic_reviews` turns all of them on or off. Logins that no reviewer
   * agent answers to are ignored, like gh's other reviewers, and returned so the caller can say so.
   */
  reviewRequest(repo: RepoRow, reviewers: unknown, automatic: unknown): { columns: ReviewColumns; ignored: string[] } {
    if (automatic !== undefined && typeof automatic !== 'boolean') throw new HttpError(422, 'automatic_reviews must be true or false');
    if (reviewers !== undefined && !Array.isArray(reviewers)) throw new HttpError(422, 'reviewers must be an array');
    // Those that review the repository; a custom reviewer of other repositories is no reviewer here.
    const agents = this.reviewerAgents().filter((a) => a.appliesTo(repo));
    const columns: ReviewColumns = {};
    if (automatic !== undefined) for (const agent of agents) Object.assign(columns, agent.columns({ enabled: automatic }, columns));
    const ignored: string[] = [];
    for (const r of reviewers ?? []) {
      // A login, as in GitHub's requested reviewers, or { login, max_iterations }.
      const { login, max_iterations = null } = typeof r === 'string' ? { login: r } : (r ?? {});
      const name = String(login ?? '').trim();
      if (!name) throw new HttpError(422, 'each reviewer needs a login');
      const agent = agents.find((a) => a.answersTo(name));
      if (!agent) {
        ignored.push(name);
        continue;
      }
      if (automatic === false) throw new HttpError(422, `${name} was asked to review, but automatic reviews are turned off`);
      Object.assign(columns, agent.columns({ enabled: true, max_iterations }, columns));
    }
    return { columns, ignored };
  }

  async createPull(
    repo: RepoRow,
    input: { title?: string; body?: string; head?: string; base?: string; draft?: boolean; fill?: 'default' | 'first' | 'verbose'; reviews?: ReviewColumns; client?: string | null },
    actor: Actor,
  ): Promise<PullRow> {
    const git = this.git(repo);
    const head = input.head?.replace(/^[^:]+:/, '');
    if (!head) throw new HttpError(422, 'head branch is required');
    const base = input.base || (await this.defaultBranch(repo));
    if (head === base) throw new HttpError(422, `head branch "${head}" is the same as base branch "${base}"`);
    const headSha = await git.resolve(`refs/heads/${head}`);
    if (!headSha) throw new HttpError(422, this.isClone(repo) ? `galley does not have branch "${head}": push it to ${this.gitUrl(repo)} first` : `head branch "${head}" does not exist in ${repo.git_dir}`);
    const baseTip = await this.newBaseTip(repo, base);
    if (!baseTip) throw new HttpError(422, `base branch "${base}" does not exist`);
    // One merged on GitHub is done with (sync no longer follows its branch): the branch can be
    // staged again. One closed on GitHub keeps it, since publishing it again reopens the loop.
    const existing = this.db.get<PullRow>(
      "SELECT * FROM pulls WHERE repo_id = ? AND head_ref = ? AND state != 'closed' AND COALESCE(github_state, '') != 'merged'",
      repo.id,
      head,
    );
    if (existing) {
      throw new HttpError(422, `a pull request for branch "${head}" into branch "${existing.base_ref}" already exists:\n${this.pullUrl(repo, existing)}`);
    }
    const mergeBase = await git.mergeBase(baseTip, headSha);
    if (!mergeBase) throw new HttpError(422, `${head} and ${base} have no common history`);
    const commits = await git.log(mergeBase, headSha);
    if (commits.length === 0) throw new HttpError(422, `No commits between ${base} and ${head}`);
    let title = input.title?.trim();
    let body = input.body;
    if (!title || (input.fill && body === undefined)) {
      const filled = fillFromCommits(commits, head, input.fill ?? 'default');
      title ||= filled.title;
      body ??= filled.body;
    }
    body ??= '';

    const ts = now();
    const pull = this.db.transaction(() => {
      const number = (this.db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM pulls WHERE repo_id = ?', repo.id)!.n);
      const id = this.db.insert('pulls', {
        repo_id: repo.id,
        number,
        title,
        body,
        state: 'staged',
        draft: input.draft ? 1 : 0,
        base_ref: base,
        head_ref: head,
        head_sha: headSha,
        base_sha: mergeBase,
        author_id: actor.id,
        created_at: ts,
        updated_at: ts,
        author_seen_at: ts,
        messages_sha: messagesSha(commits),
        client: input.client ?? null,
        ...input.reviews,
      });
      this.db.insert('revisions', { pull_id: id, seq: 1, head_sha: headSha, base_sha: mergeBase, before_sha: null, forced: 0, actor_id: actor.id, created_at: ts });
      return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
    });
    await this.pin(git, pull, 1, headSha);
    this.emit(pull.id, 'created', actor);
    return pull;
  }

  /**
   * The tip of a branch a pull request is to have as its base (baseTip). galley's clone starts with
   * GitHub's default branch alone: it fetches another from GitHub first, when GitHub has it.
   */
  private async newBaseTip(repo: RepoRow, branch: string): Promise<string | null> {
    if (this.isClone(repo) && !(await this.baseTip(repo, branch)).sha) await this.fetchBases(repo, { base: branch });
    return (await this.baseTip(repo, branch)).sha;
  }

  /** Keep every reviewed head reachable, so old revisions survive the agent rewriting history. */
  private async pin(git: Repo, pull: PullRow, seq: number, sha: string): Promise<void> {
    await this.moveRef(git, this.ref(pull, seq), null, sha);
  }

  /**
   * Pin every revision, and the signed copies each pull request was last published as, in this
   * server's namespace, once for each namespace: a copy of the database, or one from before
   * namespaces, must not count on refs that another server may delete. Until every pin is in
   * place, each start tries again.
   */
  async pinRevisions(): Promise<void> {
    const namespace = `${REFS}/${this.db.instance}`;
    if (this.db.getMeta('pinned_namespace') === namespace) return;
    let done = true;
    for (const repo of this.repos()) {
      const git = this.git(repo);
      if (!existsSync(git.gitDir)) continue; // Repository moved or deleted: nothing to pin.
      // A pin that failed is tried again while the ref is missing and the commit is there (a stale
      // lock, say). A ref pointing elsewhere stays as it is, and a commit that is gone needs no pin.
      const pin = async (ref: string, sha: string) => {
        if (!(await this.moveRef(git, ref, null, sha)) && !(await git.resolve(ref)) && (await git.exists(sha))) done = false;
      };
      for (const pull of this.db.all<PullRow>('SELECT * FROM pulls WHERE repo_id = ?', repo.id)) {
        for (const rev of this.revisions(pull)) await pin(this.ref(pull, rev.seq), rev.head_sha);
        if (pull.published_head_sha && pull.published_source_sha && pull.published_head_sha !== pull.published_source_sha) {
          await pin(this.ref(pull, 'published'), pull.published_head_sha);
        }
      }
    }
    if (done) this.db.setMeta('pinned_namespace', namespace);
  }

  /** One of this server's refs for a pull request: a revision's, or the signed copies it was last published as. */
  private ref(pull: PullRow, name: number | 'published'): string {
    return `${REFS}/${this.db.instance}/pull/${pull.number}/${name}`;
  }

  /**
   * Create, move or delete (`to` null) one of this server's refs. A ref that is not where this
   * server left it (`from`, null for none) is not this server's to change: it is left alone, and logged.
   * Returns whether the ref ended up at `to`.
   */
  private async moveRef(git: Repo, ref: string, from: string | null, to: string | null): Promise<boolean> {
    const refused = await git.moveRef(ref, from, to);
    if (refused) console.error(`left ${ref} alone in ${git.gitDir}:`, refused);
    return !refused;
  }

  /** Detect pushes to the head branch (and moves of the merge base) and record them as revisions. */
  sync(pull: PullRow): Promise<PullRow> {
    // Merged on GitHub is final like a close: its branch may be staged again, for other work.
    if (pull.state === 'closed' || pull.github_state === 'merged') return Promise.resolve(pull);
    const running = this.syncing.get(pull.id);
    if (running) return running;
    const p = this.doSync(pull).finally(() => this.syncing.delete(pull.id));
    this.syncing.set(pull.id, p);
    return p;
  }

  private async doSync(stale: PullRow): Promise<PullRow> {
    const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', stale.id)!;
    const repo = this.repoById(pull.repo_id);
    const git = this.git(repo);
    // Callers that joined this sync get the row as it is when it ends, not as it was when it began.
    const current = () => this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
    const head = await git.resolve(`refs/heads/${pull.head_ref}`);
    if (!head) return current(); // Branch deleted locally; keep showing the last known state.
    const baseTip = (await this.baseTip(repo, pull.base_ref)).sha;
    this.observeBase(pull.id, baseTip);
    const mergeBase = (baseTip && (await git.mergeBase(baseTip, head))) ?? pull.base_sha;
    if (head === pull.head_sha && mergeBase === pull.base_sha) return current();

    const forced = !(await git.isAncestor(pull.head_sha, head));
    const newCommits = forced ? [] : (await git.log(pull.head_sha, head)).map((c) => c.sha);
    const messages = messagesSha(await git.log(mergeBase, head));
    const author = this.db.actorById(pull.author_id);
    const ts = now();
    const seq = this.db.transaction(() => {
      // Merged on GitHub while this looked at the branch: its commits stay as they were merged.
      if (current().github_state === 'merged') return null;
      const seq = this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM revisions WHERE pull_id = ?', pull.id)!.n;
      this.db.insert('revisions', { pull_id: pull.id, seq, head_sha: head, base_sha: mergeBase, before_sha: pull.head_sha, forced: forced ? 1 : 0, actor_id: author.id, created_at: ts });
      this.db.update('pulls', pull.id, { head_sha: head, base_sha: mergeBase, messages_sha: messages, updated_at: ts });
      this.addEvent(pull, author, 'pushed', { before: pull.head_sha, after: head, forced, commits: newCommits, base_before: pull.base_sha, base_after: mergeBase }, ts);
      return seq;
    });
    if (seq === null) return current();
    // A review of what changed: the code, or (reviewers of the description) its commit messages,
    // which a base that moved changes too, when it takes in some of the commits or is another.
    if (head !== pull.head_sha) this.cancelReviews(current(), 'pushed');
    else if (messages !== pull.messages_sha) this.cancelReviews(current(), 'base_moved');
    if (messages !== pull.messages_sha) this.reconsiderDescription(current());
    await this.pin(git, pull, seq, head);
    // Whether the new head merges cleanly: a waiting author hears of it when it is known, since it
    // does not wake for its own push.
    this.checkConflicts(pull.id);
    this.emit(pull.id, 'pushed', author);
    return current();
  }

  /** Check every open pull request for pushes. Called on an interval by the server. */
  async pollAll(): Promise<void> {
    const open = this.db.all<PullRow>("SELECT * FROM pulls WHERE state != 'closed' AND COALESCE(github_state, '') != 'merged'");
    const byRepo = Map.groupBy(open, (p) => p.repo_id);
    for (const [repoId, pulls] of byRepo) {
      const repo = this.repoById(repoId);
      let refs: Map<string, string>;
      try {
        refs = await this.git(repo).refs();
      } catch {
        continue; // Repository moved or deleted.
      }
      for (const pull of pulls) {
        const head = refs.get(`refs/heads/${pull.head_ref}`);
        const base = (await this.baseTip(repo, pull.base_ref, refs)).sha;
        const key = `${head} ${base}`;
        if (head && this.lastPolled.get(pull.id) !== key) {
          // Once synced: a sync that failed (a git error) is tried again on the next poll.
          try {
            await this.sync(pull);
            this.lastPolled.set(pull.id, key);
            this.syncErrors.delete(pull.id);
          } catch (e) {
            const error = (e as Error).message;
            if (failureKey(error) !== this.syncErrors.get(pull.id)) console.error(`could not sync ${pull.head_ref} (s#${pull.number}) in ${repo.git_dir}: ${error}`);
            this.syncErrors.set(pull.id, failureKey(error));
          }
        }
        this.observeBase(pull.id, base ?? null);
      }
    }
  }
  /** The branches each pull request was last synced at by the poll, as `<head> <base>`. */
  private lastPolled = new Map<number, string>();
  /** How the poll's last sync of each pull request failed (failureKey), logged once. */
  private syncErrors = new Map<number, string>();

  /**
   * A push to galley's clone of the repository (git-http.ts) may have moved the heads of its open
   * pull requests: they are synced now, rather than at the next poll, so a call right after the
   * push finds it recorded.
   */
  async received(repo: RepoRow): Promise<void> {
    const open = this.db.all<PullRow>("SELECT * FROM pulls WHERE repo_id = ? AND state != 'closed' AND COALESCE(github_state, '') != 'merged'", repo.id);
    for (const pull of open) {
      // A sync under way (the poll's) may have read the branch before the push: after it, one that reads it now.
      await this.syncing.get(pull.id)?.catch(() => {});
      await this.sync(pull).catch((e: Error) => console.error(`could not sync ${pull.head_ref} (s#${pull.number}) after a push to ${repo.owner}/${repo.name}: ${e.message}`));
    }
  }

  // ---------------------------------------------------------- fetching bases

  /** Per repository: when galley last started to fetch its base branches, which, and the fetch under way. */
  private fetchRounds = new Map<number, FetchRound>();
  /** git's message for each base branch whose last fetch failed, by `<repo id> <branch>`: the first while it fails the same way (failureKey). */
  private fetchErrors = new Map<string, string>();
  /** Aborted when the server closes (stopFetching). */
  private fetchAbort = new AbortController();

  /**
   * Fetch the base branches of the repository's open pull requests, published or not, so the
   * check for conflicts sees what was merged there since. Each comes from
   * GitHub over https with gh's credentials, whatever the remote's URL: an ssh remote's agent may
   * ask for approval in a window, and this runs in the background. A repository not on GitHub is
   * not fetched. Each goes into its remote-tracking branch, and only one that is there already:
   * without one, the base is the local branch (baseTip). galley's clone fetches each base, and one
   * GitHub does not have is a branch staged here (stacked pull requests). The poll then sees the
   * base move, as when the user fetches. At most once every fetchEveryMs per repository, however
   * many pages and pull requests ask; a round that fetched nothing (each base a local branch, say)
   * does not count.
   * `base` (publishing) fetches that base alone, now, and leaves the throttle as it was. Each joins
   * the fetch under way if that fetches the same bases, and comes after it otherwise. Never throws:
   * a failure is kept for the page (fetchError) and logged once.
   */
  fetchBases(repo: RepoRow, opts: { base?: string } = {}): Promise<void> {
    if (this.fetchAbort.signal.aborted || !repo.github_slug) return Promise.resolve();
    const last = this.fetchRounds.get(repo.id);
    const open = () => this.db.all<PullRow>("SELECT * FROM pulls WHERE repo_id = ? AND state != 'closed' AND COALESCE(github_state, 'open') = 'open'", repo.id);
    const bases = new Set(opts.base !== undefined ? [opts.base] : open().map((p) => p.base_ref));
    if (last?.running) {
      // A fetch that set out before a pull request was staged, say, may not fetch its base: this one comes after it.
      if ([...bases].every((b) => last.bases.has(b))) return last.running;
      return last.running.then(() => this.fetchBases(repo, opts));
    }
    if (opts.base === undefined) {
      // A second of slack, so a timer ticking every 20 seconds does not skip a round.
      if (last && Date.now() - last.at < this.fetchEveryMs - 1000) return Promise.resolve();
      // Nothing to fetch yet: a pull request staged next is fetched as soon as something asks.
      if (!bases.size) return Promise.resolve();
    }
    const round: FetchRound = { at: opts.base === undefined ? Date.now() : (last?.at ?? 0), bases, running: null };
    this.fetchRounds.set(repo.id, round);
    const throttled = last?.at ?? 0;
    round.running = this.fetchRepo(repo, round.bases)
      .then((fetched) => {
        // Nothing fetched (each base is a local branch, say): what is staged next is fetched as soon as something asks.
        if (!fetched) round.at = throttled;
      })
      .catch((e) => console.error(`fetching the base branches into ${repo.git_dir} failed:`, e))
      .finally(() => (round.running = null));
    return round.running;
  }

  /** Fetch the base branches of every repository due (fetchBases). The server does so on a timer. */
  async fetchAllBases(): Promise<void> {
    const open = this.db.all<PullRow>("SELECT * FROM pulls WHERE state != 'closed' AND COALESCE(github_state, 'open') = 'open'");
    for (const id of new Set(open.map((p) => p.repo_id))) await this.fetchBases(this.repoById(id));
  }

  /** Stop fetching: fetches under way are stopped, and no other starts. The server waits for this before it closes the database. */
  async stopFetching(): Promise<void> {
    this.fetchAbort.abort();
    await Promise.all([...this.fetchRounds.values()].map((r) => r.running));
  }

  /** git's message when the last fetch of a repository's base branch failed; null when it worked, or galley has not fetched it. */
  fetchError(repo: RepoRow, branch: string): string | null {
    return this.fetchErrors.get(`${repo.id} ${branch}`) ?? null;
  }

  /** Fetch `bases` (fetchBases); whether it fetched any. */
  private async fetchRepo(repo: RepoRow, bases: Set<string>): Promise<boolean> {
    const git = this.git(repo);
    if (!existsSync(git.gitDir)) return false; // Repository moved or deleted.
    const clone = this.isClone(repo);
    const signal = this.fetchAbort.signal;
    let changed = false;
    let fetched = false;
    for (const branch of bases) {
      const tracking = `refs/remotes/${repo.remote}/${branch}`;
      const known = await git.resolve(tracking);
      if (signal.aborted || (!known && !clone)) continue;
      fetched = true;
      const url = this.githubUrl(repo.github_slug!);
      let error = await git.fetchBranch(url, branch, tracking, { gh: this.ghBin, cwd: repo.work_dir ?? tmpdir(), timeoutMs: FETCH_TIMEOUT_MS, signal });
      if (signal.aborted) continue;
      // Never on GitHub: a branch staged here as the base (a stacked pull request), sent by the CLI.
      if (error && !known && /couldn't find remote ref/i.test(error)) error = null;
      const key = `${repo.id} ${branch}`;
      const was = this.fetchErrors.get(key) ?? null;
      // Failed as before, if in other words (failureKey): the page and the log have it.
      if (error === was || (error !== null && was !== null && failureKey(error) === failureKey(was))) continue;
      changed = true;
      if (error) {
        console.error(`could not fetch ${repo.remote}/${branch} into ${repo.git_dir}: ${error}`);
        this.fetchErrors.set(key, error);
      } else this.fetchErrors.delete(key);
    }
    // Pages say when the base could not be fetched; the base moving is announced when the poll sees it.
    if (changed) this.emitSystem(null, 'base_fetch', 'git');
    return fetched;
  }

  // --------------------------------------------------------- base conflicts

  /** What checkConflicts last found for each pull request. */
  private conflictsFound = new Map<number, BaseConflicts>();
  /** The tip of each pull request's base branch as last seen (sync and the poll look), which auto-publish needs an answer for. */
  private baseTips = new Map<number, string | null>();
  /** Pull requests whose check has not started yet; it reads the branches when it starts. */
  private conflictsQueued = new Set<number>();
  /** The checks, one at a time, so a server starting with many open pull requests runs one git at a time. The server waits for them before it closes. */
  conflictChecks: Promise<void> = Promise.resolve();

  /**
   * Whether the head merges cleanly into the tip of its base branch, while the pull request is
   * open; null otherwise. Also for a head GitHub has, whose conflicts the author hears of from
   * galley as before publishing: GitHub's own answer (githubStatus) is for the reviewer. Not once
   * the branch on GitHub moved on from it (movedOnGithub): the head says nothing then of the
   * branch GitHub would merge. Never waits on git: it answers from what was found (or with null)
   * and works it out in the background, as it does when the base moves (observeBase). Until then,
   * the answer is for the base as it was.
   */
  baseConflicts(pull: PullRow): BaseConflicts | null {
    if (stagingState(pull) === 'done') return null;
    if (!this.headUnpublished(pull) && this.movedOnGithub(pull)) return null;
    const found = this.conflictsFound.get(pull.id);
    if (found?.head === pull.head_sha && found.branch === pull.base_ref) return found;
    this.checkConflicts(pull.id);
    return null;
  }

  /**
   * What baseConflicts found, if it is for the base's tip as last seen; null while the answer for
   * that tip is still being worked out. What auto-publish goes by: an answer for a base that has
   * moved since says nothing about the merge GitHub would do.
   */
  currentConflicts(pull: PullRow): BaseConflicts | null {
    const found = this.baseConflicts(pull);
    const tip = this.baseTips.get(pull.id);
    return found && (tip === undefined || found.base === tip) ? found : null;
  }

  /**
   * The branch on GitHub has another commit than the one galley pushed last, as following saw it
   * after that push: one made there (a conflict resolved there, Update branch), or pushed by
   * someone else.
   */
  private movedOnGithub(pull: PullRow): boolean {
    const github = githubStatus(pull);
    return !!github?.head && github.head !== pull.published_head_sha && github.checkedAt >= (pull.published_at ?? '');
  }

  /** The head is one GitHub does not have, of a pull request that is not done: GitHub has no answer for whether it merges cleanly, so galley's stands in for it. */
  headUnpublished(pull: PullRow): boolean {
    return stagingState(pull) !== 'done' && pull.head_sha !== (pull.published_source_sha ?? pull.published_head_sha);
  }

  /** Whether the head's conflicts with the base as it is now are still being worked out. */
  private conflictsPending(pull: PullRow): boolean {
    return this.headUnpublished(pull) && this.currentConflicts(pull) === null;
  }

  /**
   * What baseConflicts finds for the base's tip as the repository has it now, once it is worked out:
   * what publishing by hand asks about. Null for a head GitHub has.
   */
  private async conflictsNow(pull: PullRow): Promise<BaseConflicts | null> {
    if (!this.headUnpublished(pull)) return null;
    // A check reads the branches when it starts, so this one sees the base as it is now.
    this.checkConflicts(pull.id);
    await this.conflictChecks;
    return this.currentConflicts(pull);
  }

  /**
   * Record the tip of the pull request's base branch as just seen. When what was found is for
   * another tip, or git could not tell, work it out again: on each poll, until it can.
   */
  private observeBase(id: number, tip: string | null): void {
    this.baseTips.set(id, tip);
    const found = this.conflictsFound.get(id);
    if (found && (found.base !== tip || found.clean === null)) this.checkConflicts(id);
  }

  /**
   * Merge the head into the tip of the base branch (`git merge-tree`, no working tree), unless what
   * was found is for these already, and tell pages, a waiting author and auto-publish when the
   * answer changed. In the background, after the checks before it.
   */
  private checkConflicts(id: number): void {
    if (this.conflictsQueued.has(id)) return;
    this.conflictsQueued.add(id);
    this.conflictChecks = this.conflictChecks
      .then(async () => {
        this.conflictsQueued.delete(id);
        const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id);
        if (!pull) return;
        const repo = this.repoById(pull.repo_id);
        const git = this.git(repo);
        const tip = await this.baseTip(repo, pull.base_ref);
        const base = tip.sha;
        // Seen just now, so the answer for it counts once it comes (currentConflicts), without
        // waiting for the next poll to see the same tip; a later look overwrites it.
        this.baseTips.set(id, base);
        const before = this.conflictsFound.get(id);
        if (before && before.head === pull.head_sha && before.branch === pull.base_ref && before.base === base && before.clean !== null) return;
        const found: BaseConflicts = {
          branch: pull.base_ref,
          ref: tip.ref,
          base,
          head: pull.head_sha,
          clean: null,
          files: [],
          messages: [],
          behind: null,
          error: null,
        };
        if (!base) found.error = `there is no ${repo.remote}/${pull.base_ref} or ${pull.base_ref} branch in this repository`;
        else {
          try {
            Object.assign(found, await git.mergeTree(base, pull.head_sha));
          } catch (e) {
            found.error = (e as Error).message;
          }
          found.behind = await git.countCommits(pull.head_sha, base).catch(() => null);
        }
        this.conflictsFound.set(id, found);
        if (JSON.stringify(found) !== JSON.stringify(before)) this.emitSystem(id, 'base_conflicts', 'git');
      })
      .catch((e) => console.error('checking for conflicts with the base failed:', e));
  }

  addEvent<T extends EventType>(pull: PullRow, actor: Actor, type: T, data: EventData[T], ts = now()): void {
    addEvent(this.db, pull, actor, type, data, ts);
  }

  events(pull: PullRow): EventRow[] {
    return this.db.all<EventRow>('SELECT * FROM events WHERE pull_id = ? ORDER BY id', pull.id);
  }

  revisions(pull: PullRow): RevisionRow[] {
    return this.db.all<RevisionRow>('SELECT * FROM revisions WHERE pull_id = ? ORDER BY seq', pull.id);
  }

  async updatePull(
    ctx: Ctx,
    input: { title?: string; body?: string; base?: string; state?: string; draft?: boolean },
    actor: Actor,
  ): Promise<PullRow> {
    const { pull, repo } = ctx;
    const ts = now();
    const changes: Record<string, string | number | null> = {};
    if (input.base !== undefined && input.base !== pull.base_ref) {
      if (!(await this.newBaseTip(repo, input.base))) throw new HttpError(422, `base branch "${input.base}" does not exist`);
    }
    this.db.transaction(() => {
      if (input.title !== undefined && input.title.trim() && input.title !== pull.title) {
        changes.title = input.title.trim();
        this.addEvent(pull, actor, 'renamed', { from: pull.title, to: changes.title }, ts);
      }
      if (input.body !== undefined && input.body !== pull.body) {
        changes.body = input.body;
        this.addEvent(pull, actor, 'body_edited', { from: pull.body, to: input.body }, ts);
      }
      if (input.base !== undefined && input.base !== pull.base_ref) {
        changes.base_ref = input.base;
        this.addEvent(pull, actor, 'base_changed', { from: pull.base_ref, to: input.base }, ts);
        this.autoPublishOff(pull, actor, 'base_changed', ts);
      }
      if (input.draft !== undefined && (input.draft ? 1 : 0) !== pull.draft) {
        changes.draft = input.draft ? 1 : 0;
        this.addEvent(pull, actor, input.draft ? 'convert_to_draft' : 'ready_for_review', {}, ts);
      }
      if (input.state === 'closed' && pull.state !== 'closed') {
        changes.state = 'closed';
        changes.closed_at = ts;
        this.addEvent(pull, actor, 'closed', {}, ts);
        this.autoPublishOff(pull, actor, 'closed', ts);
      } else if (input.state === 'open' && pull.state === 'closed') {
        changes.state = pull.published_url ? 'published' : 'staged';
        changes.closed_at = null;
        this.addEvent(pull, actor, 'reopened', {}, ts);
      }
      if (Object.keys(changes).length) {
        changes.updated_at = ts;
        this.db.update('pulls', pull.id, changes);
      }
    });
    let updated = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
    if (Object.keys(changes).length) {
      if (changes.state === 'closed') this.cancelReviews(updated, 'closed');
      else if (changes.title !== undefined || changes.body !== undefined) {
        // A review of the title and description that were (Reviewer.cancel).
        this.cancelReviews(updated, 'edited');
        this.reconsiderDescription(updated);
      }
      if (changes.base_ref || changes.state) updated = await this.sync(updated);
      this.emit(pull.id, 'updated', actor);
    }
    return updated;
  }

  async deletePull(ctx: Ctx, actor: Actor): Promise<void> {
    const { pull, git } = ctx;
    this.requireHuman(actor, 'only the user can delete a staged pull request; close it instead');
    for (const rev of this.revisions(pull)) await this.moveRef(git, this.ref(pull, rev.seq), rev.head_sha, null);
    this.db.run('DELETE FROM pulls WHERE id = ?', pull.id);
    this.emit(null, 'deleted', actor);
  }

  // ---------------------------------------------------------- diffs, commits

  commits(ctx: Ctx): Promise<Commit[]> {
    return ctx.git.log(ctx.pull.base_sha, ctx.pull.head_sha);
  }

  files(ctx: Ctx): Promise<FileDiff[]> {
    return ctx.git.diff(ctx.pull.base_sha, ctx.pull.head_sha);
  }

  // -------------------------------------------------------------- comments

  comment(id: number): CommentRow {
    const c = this.db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', id);
    if (!c) throw new HttpError(404, `comment ${id} not found`);
    return c;
  }

  review(id: number): ReviewRow {
    const r = this.db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', id);
    if (!r) throw new HttpError(404, `review ${id} not found`);
    return r;
  }

  /** Comments of pending reviews are only visible to the reviewer writing them, as on GitHub. */
  private visible(viewer: Actor) {
    return `(review_id IS NULL OR review_id IN (SELECT id FROM reviews WHERE state != 'PENDING' OR author_id = ${Number(viewer.id)}))`;
  }

  /** Whether `viewer` may see a comment: everything but other people's pending review comments. */
  canSee(c: CommentRow, viewer: Actor): boolean {
    if (!c.review_id) return true;
    const r = this.db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', c.review_id);
    return !r || r.state !== 'PENDING' || r.author_id === viewer.id;
  }

  issueComments(pull: PullRow): CommentRow[] {
    return this.db.all<CommentRow>("SELECT * FROM comments WHERE pull_id = ? AND kind = 'issue' ORDER BY id", pull.id);
  }

  reviewComments(pull: PullRow, viewer: Actor): CommentRow[] {
    return this.db.all<CommentRow>(`SELECT * FROM comments WHERE pull_id = ? AND kind = 'review' AND ${this.visible(viewer)} ORDER BY id`, pull.id);
  }

  reviews(pull: PullRow, viewer: Actor): ReviewRow[] {
    return this.db.all<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND (state != 'PENDING' OR author_id = ?) ORDER BY id", pull.id, viewer.id);
  }

  pendingReview(pull: PullRow, actor: Actor): ReviewRow | undefined {
    return this.db.get<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND author_id = ? AND state = 'PENDING'", pull.id, actor.id);
  }

  addIssueComment(ctx: Ctx, body: string, actor: Actor): CommentRow {
    if (!body.trim()) throw new HttpError(422, 'body cannot be blank');
    const ts = now();
    const id = this.db.insert('comments', { pull_id: ctx.pull.id, kind: 'issue', author_id: actor.id, body, created_at: ts, updated_at: ts });
    this.touch(ctx.pull, ts);
    this.emit(ctx.pull.id, 'comment', actor);
    return this.comment(id);
  }

  private touch(pull: PullRow, ts = now()): void {
    this.db.update('pulls', pull.id, { updated_at: ts });
  }

  /** The columns of a new review comment: where it points, and its priority. */
  private async anchor(ctx: Ctx, input: CommentInput): Promise<Record<string, string | number | null>> {
    return { ...(await this.anchorAt(ctx, input)), priority: checkPriority(input.priority) };
  }

  /** Validate where a new review comment points and build the columns that anchor it. */
  private async anchorAt(ctx: Ctx, input: CommentInput): Promise<Record<string, string | number | null>> {
    const { pull, git } = ctx;
    const subject: SubjectType = input.subject_type ?? (input.path ? (input.line ? 'line' : 'file') : 'commit');
    if (subject === 'commit') {
      const sha = input.commit_id && (await git.resolve(input.commit_id));
      const commits = await this.commits(ctx);
      if (!sha || !commits.some((c) => c.sha === sha)) throw new HttpError(422, `commit ${input.commit_id ?? '(none)'} is not part of this pull request`);
      return { subject_type: 'commit', commit_id: sha, base_commit_id: pull.base_sha, path: null, line: null, side: null, start_line: null, start_side: null, diff_hunk: null };
    }
    if (!input.path) throw new HttpError(422, 'path is required for a review comment');
    // Comments may be made on a single commit or an older revision; otherwise on the whole pull request.
    let head = pull.head_sha;
    let base = pull.base_sha;
    if (input.commit_id && input.commit_id !== pull.head_sha) {
      const sha = await git.resolve(input.commit_id);
      if (!sha) throw new HttpError(422, `commit_id ${input.commit_id} does not exist`);
      head = sha;
      const rev = this.db.get<RevisionRow>('SELECT * FROM revisions WHERE pull_id = ? AND head_sha = ? ORDER BY seq DESC', pull.id, sha);
      base = rev ? rev.base_sha : ((await git.resolve(`${sha}^`)) ?? pull.base_sha);
    }
    if (input.base_commit_id) {
      const sha = await git.resolve(input.base_commit_id);
      if (!sha) throw new HttpError(422, `base_commit_id ${input.base_commit_id} does not exist`);
      base = sha;
    }
    const files = await git.diff(base, head);
    const file = files.find((f) => f.path === input.path || f.oldPath === input.path);
    if (!file) throw new HttpError(422, `path ${input.path} is not part of the diff`);
    if (subject === 'file') {
      return { subject_type: 'file', commit_id: head, base_commit_id: base, path: file.path, line: null, side: null, start_line: null, start_side: null, diff_hunk: null };
    }
    const side: Side = input.side ?? 'RIGHT';
    const line = Number(input.line);
    if (!Number.isInteger(line) || !(await this.commentable(git, head, file, side, line))) {
      throw new HttpError(422, `line ${input.line} (${side}) of ${input.path} is not part of the diff`);
    }
    let startLine: number | null = input.start_line ? Number(input.start_line) : null;
    const startSide: Side | null = startLine ? (input.start_side ?? side) : null;
    if (startLine === line && startSide === side) startLine = null;
    if (startLine && !(await this.commentable(git, head, file, startSide!, startLine))) throw new HttpError(422, `start_line ${startLine} is not part of the diff`);
    // On lines a reviewer expanded, the stored hunk is the expanded one, so it shows the lines commented on.
    const span = { side, line, startSide, startLine };
    const shown = lineInDiff(file, side, line) && (!startLine || lineInDiff(file, startSide!, startLine)) ? file : withContext(file, (await git.lines(head, file.path)) ?? [], [span]);
    return {
      subject_type: 'line',
      commit_id: head,
      base_commit_id: base,
      path: file.path,
      line,
      side,
      start_line: startLine,
      start_side: startLine ? startSide : null,
      diff_hunk: diffHunkFor(shown, side, line, startLine ? { side: startSide!, line: startLine } : null),
    };
  }

  /**
   * Whether a line can carry a comment: a line of the diff, or an unchanged line around it that a
   * reviewer can expand to (GitHub's unfold arrows). Validation and placement both ask this, so a
   * comment on an expanded line is not outdated the moment it is made.
   */
  private async commentable(git: Repo, head: string, file: FileDiff, side: Side, line: number): Promise<boolean> {
    if (lineInDiff(file, side, line)) return true;
    if (!file.newPath || file.hunks.length === 0) return false;
    const total = (await git.lineCounts(head, [file.newPath])).get(file.newPath);
    return total !== undefined && expandedLine(file, side, line, total) !== null;
  }

  private insertReviewComment(pull: PullRow, actor: Actor, reviewId: number | null, body: string, anchor: Record<string, string | number | null>, inReplyTo: number | null = null): number {
    if (!body.trim()) throw new HttpError(422, 'body cannot be blank');
    const columns = { ...anchor };
    if (inReplyTo === null) {
      // From any reviewer: a "[P1] ..." prefix becomes the priority, unless one was given.
      const split = splitPriorityPrefix(body);
      if (split.priority) {
        body = split.body;
        columns.priority ??= split.priority;
      }
    }
    const ts = now();
    return this.db.insert('comments', { pull_id: pull.id, kind: 'review', review_id: reviewId, author_id: actor.id, body, created_at: ts, updated_at: ts, in_reply_to_id: inReplyTo, ...columns });
  }

  /** POST /pulls/:n/comments: a standalone comment wrapped in its own submitted review, as GitHub does. */
  async addReviewComment(ctx: Ctx, input: CommentInput & { in_reply_to?: number | null }, actor: Actor): Promise<CommentRow> {
    if (input.in_reply_to) return this.reply(ctx, Number(input.in_reply_to), input.body, actor);
    const anchor = await this.anchor(ctx, input);
    const id = this.db.transaction(() => {
      const ts = now();
      const reviewId = this.db.insert('reviews', { pull_id: ctx.pull.id, author_id: actor.id, state: 'COMMENTED', body: '', commit_id: String(anchor.commit_id), created_at: ts, submitted_at: ts });
      return this.insertReviewComment(ctx.pull, actor, reviewId, input.body, anchor);
    });
    this.touch(ctx.pull);
    this.emit(ctx.pull.id, 'review_comment', actor);
    return this.comment(id);
  }

  /** Add a comment to the actor's pending review, starting one if needed. */
  async addPendingComment(ctx: Ctx, input: CommentInput, actor: Actor): Promise<CommentRow> {
    const anchor = await this.anchor(ctx, input);
    const id = this.db.transaction(() => {
      let review = this.pendingReview(ctx.pull, actor);
      const reviewId = review
        ? review.id
        : this.db.insert('reviews', { pull_id: ctx.pull.id, author_id: actor.id, state: 'PENDING', body: '', commit_id: ctx.pull.head_sha, created_at: now(), submitted_at: null });
      return this.insertReviewComment(ctx.pull, actor, reviewId, input.body, anchor);
    });
    this.emit(ctx.pull.id, 'pending_comment', actor);
    return this.comment(id);
  }

  reply(ctx: Ctx, toId: number, body: string, actor: Actor): CommentRow {
    let root = this.comment(toId);
    if (root.pull_id !== ctx.pull.id || root.kind !== 'review') throw new HttpError(404, `review comment ${toId} not found on this pull request`);
    if (root.in_reply_to_id) root = this.comment(root.in_reply_to_id);
    if (root.review_id && this.review(root.review_id).state === 'PENDING') {
      throw new HttpError(422, 'this comment is part of a pending review; submit the review before replying');
    }
    const { subject_type, path, line, side, start_line, start_side, commit_id, base_commit_id, diff_hunk } = root;
    const id = this.insertReviewComment(ctx.pull, actor, null, body, { subject_type, path, line, side, start_line, start_side, commit_id, base_commit_id, diff_hunk }, root.id);
    this.touch(ctx.pull);
    this.emit(ctx.pull.id, 'reply', actor);
    return this.comment(id);
  }

  updateComment(id: number, body: string, actor: Actor): CommentRow {
    const c = this.comment(id);
    if (c.author_id !== actor.id) throw new HttpError(403, 'only the author can edit a comment');
    if (!body.trim()) throw new HttpError(422, 'body cannot be blank');
    this.db.update('comments', id, { body, updated_at: now() });
    this.emit(c.pull_id, 'comment_edited', actor);
    return this.comment(id);
  }

  deleteComment(id: number, actor: Actor): void {
    const c = this.comment(id);
    if (c.author_id !== actor.id) throw new HttpError(403, 'only the author can delete a comment');
    this.db.run('DELETE FROM comments WHERE id = ?', id);
    // A review that only wrapped this comment is gone with it.
    if (c.review_id) {
      this.db.run(
        "DELETE FROM reviews WHERE id = ? AND state IN ('PENDING', 'COMMENTED') AND body = '' AND NOT EXISTS (SELECT 1 FROM comments WHERE review_id = ?)",
        c.review_id,
        c.review_id,
      );
    }
    this.emit(c.pull_id, 'comment_deleted', actor);
  }

  setResolved(ctx: Ctx, id: number, resolved: boolean, actor: Actor): CommentRow {
    let c = this.comment(id);
    if (c.pull_id !== ctx.pull.id || c.kind !== 'review') throw new HttpError(404, `review thread ${id} not found on this pull request`);
    if (c.in_reply_to_id) c = this.comment(c.in_reply_to_id);
    this.db.update('comments', c.id, resolved ? { resolved_at: now(), resolved_by_id: actor.id } : { resolved_at: null, resolved_by_id: null });
    this.emit(ctx.pull.id, resolved ? 'resolved' : 'unresolved', actor);
    return this.comment(c.id);
  }

  // --------------------------------------------------------------- reviews

  /** `stored`, given, runs in the transaction that stores the review, and can refuse it by throwing. */
  async createReview(
    ctx: Ctx,
    input: { body?: string; event?: ReviewEvent | ''; commit_id?: string; comments?: CommentInput[] },
    actor: Actor,
    stored?: (reviewId: number) => void,
  ): Promise<ReviewRow> {
    const { pull } = ctx;
    const event = input.event || undefined;
    if (event && !(event in EVENT_STATE)) throw new HttpError(422, `event must be one of ${Object.keys(EVENT_STATE).join(', ')}`);
    if (!event && this.pendingReview(pull, actor)) throw new HttpError(422, 'you can only have one pending review per pull request');
    if (event === 'REQUEST_CHANGES' && !input.body?.trim() && !input.comments?.length) {
      throw new HttpError(422, 'a review requesting changes needs a body or comments');
    }
    if (event && actor.id === pull.author_id && event !== 'COMMENT') {
      throw new HttpError(422, `can not ${event === 'APPROVE' ? 'approve' : 'request changes on'} your own pull request`);
    }
    const commitId = input.commit_id ?? pull.head_sha;
    const anchors: { body: string; anchor: Record<string, string | number | null> }[] = [];
    for (const c of input.comments ?? []) anchors.push({ body: c.body, anchor: await this.anchor(ctx, { ...c, commit_id: c.commit_id ?? commitId }) });
    const id = this.db.transaction(() => {
      const ts = now();
      const reviewId = this.db.insert('reviews', {
        pull_id: pull.id,
        author_id: actor.id,
        state: event ? EVENT_STATE[event] : 'PENDING',
        body: input.body ?? '',
        commit_id: commitId,
        created_at: ts,
        submitted_at: event ? ts : null,
      });
      for (const a of anchors) this.insertReviewComment(pull, actor, reviewId, a.body, a.anchor);
      if (event === 'REQUEST_CHANGES' && actor.type === 'User') this.autoPublishOff(pull, actor, 'changes_requested', ts);
      stored?.(reviewId);
      return reviewId;
    });
    if (event) this.touch(pull);
    this.emit(pull.id, event ? 'review' : 'pending_review', actor);
    return this.review(id);
  }

  submitReview(ctx: Ctx, reviewId: number, event: ReviewEvent, body: string | undefined, actor: Actor): ReviewRow {
    const review = this.review(reviewId);
    if (review.pull_id !== ctx.pull.id || review.author_id !== actor.id) throw new HttpError(404, `review ${reviewId} not found`);
    if (review.state !== 'PENDING') throw new HttpError(422, 'review has already been submitted');
    if (!(event in EVENT_STATE)) throw new HttpError(422, `event must be one of ${Object.keys(EVENT_STATE).join(', ')}`);
    if (actor.id === ctx.pull.author_id && event !== 'COMMENT') throw new HttpError(422, 'can not approve or request changes on your own pull request');
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE review_id = ?', review.id)!.n;
    if (event === 'REQUEST_CHANGES' && !body?.trim() && !count) throw new HttpError(422, 'a review requesting changes needs a body or comments');
    if (event === 'COMMENT' && !body?.trim() && !count) throw new HttpError(422, 'a review needs a body or comments');
    const ts = now();
    this.db.update('reviews', review.id, { state: EVENT_STATE[event], body: body ?? review.body, submitted_at: ts, commit_id: ctx.pull.head_sha });
    // Comments written while the review was pending count as made now.
    this.db.run('UPDATE comments SET created_at = ?, updated_at = ? WHERE review_id = ?', ts, ts, review.id);
    if (event === 'REQUEST_CHANGES' && actor.type === 'User') this.autoPublishOff(ctx.pull, actor, 'changes_requested', ts);
    this.touch(ctx.pull, ts);
    this.emit(ctx.pull.id, 'review', actor);
    return this.review(review.id);
  }

  deletePendingReview(ctx: Ctx, reviewId: number, actor: Actor): void {
    const review = this.review(reviewId);
    if (review.pull_id !== ctx.pull.id || review.author_id !== actor.id || review.state !== 'PENDING') {
      throw new HttpError(422, 'only a pending review can be deleted');
    }
    this.db.run('DELETE FROM reviews WHERE id = ?', review.id);
    this.emit(ctx.pull.id, 'pending_review_deleted', actor);
  }

  // ----------------------------------------------------- threads & placing

  /** Where a thread lands in the pull request's current diff, or that it is outdated. */
  async place(ctx: Ctx, root: CommentRow, files?: FileDiff[], commits?: Commit[]): Promise<Placement> {
    const { pull, git } = ctx;
    if (root.subject_type === 'commit') {
      const list = commits ?? (await this.commits(ctx));
      return { line: null, startLine: null, outdated: !list.some((c) => c.sha === root.commit_id) };
    }
    const diff = files ?? (await this.files(ctx));
    const file = diff.find((f) => f.path === root.path);
    if (!file) return { line: null, startLine: null, outdated: true };
    if (root.subject_type === 'file') return { line: null, startLine: null, outdated: false };
    // Carry the commented lines to the current diff. If any of them changed, the thread is outdated.
    const carry = async (side: Side, first: number, last: number): Promise<[number, number] | null> => {
      const from = side === 'RIGHT' ? root.commit_id! : root.base_commit_id!;
      const to = side === 'RIGHT' ? pull.head_sha : pull.base_sha;
      if (from === to) return [first, last];
      const path = side === 'RIGHT' ? root.path! : (file.oldPath ?? root.path!);
      const ranges = await git.hunkRanges(from, to, path).catch(() => 'deleted' as const);
      if (ranges === 'deleted' || rangeTouched(ranges, first, last)) return null;
      const a = mapLine(ranges, first);
      const b = mapLine(ranges, last);
      return a === null || b === null ? null : [a, b];
    };
    const side = root.side!;
    let line: number | null = null;
    let startLine: number | null = null;
    if (root.start_line === null || root.start_side === side) {
      const r = await carry(side, root.start_line ?? root.line!, root.line!);
      if (r) [startLine, line] = root.start_line === null ? [null, r[1]] : r;
    } else {
      // A range that starts on the old side and ends on the new side.
      const a = await carry(root.start_side!, root.start_line!, root.start_line!);
      const b = await carry(side, root.line!, root.line!);
      if (a && b) [startLine, line] = [a[0], b[0]];
    }
    const outdated =
      line === null ||
      !(await this.commentable(git, pull.head_sha, file, side, line)) ||
      (root.start_line !== null && (startLine === null || !(await this.commentable(git, pull.head_sha, file, root.start_side!, startLine))));
    return outdated ? { line: null, startLine: null, outdated: true } : { line, startLine, outdated: false };
  }

  async threads(ctx: Ctx, viewer: Actor, files?: FileDiff[], commits?: Commit[]): Promise<Thread[]> {
    const all = this.reviewComments(ctx.pull, viewer);
    const pendingReviews = new Set(this.db.all<{ id: number }>("SELECT id FROM reviews WHERE pull_id = ? AND state = 'PENDING'", ctx.pull.id).map((r) => r.id));
    files ??= await this.files(ctx);
    commits ??= await this.commits(ctx);
    const out: Thread[] = [];
    for (const root of all.filter((c) => !c.in_reply_to_id)) {
      out.push({
        root,
        replies: all.filter((c) => c.in_reply_to_id === root.id),
        placement: await this.place(ctx, root, files, commits),
        resolved: !!root.resolved_at,
        pending: root.review_id !== null && pendingReviews.has(root.review_id),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ viewed files

  viewed(pull: PullRow): Map<string, string> {
    return new Map(this.db.all<{ path: string; blob: string }>('SELECT path, blob FROM viewed WHERE pull_id = ?', pull.id).map((r) => [r.path, r.blob]));
  }

  setViewed(pull: PullRow, path: string, blob: string, viewed: boolean): void {
    if (viewed) this.db.run('INSERT INTO viewed (pull_id, path, blob) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET blob = excluded.blob', pull.id, path, blob);
    else this.db.run('DELETE FROM viewed WHERE pull_id = ? AND path = ?', pull.id, path);
  }

  // ---------------------------------------------------------------- pinning

  /**
   * Pin a pull request to the top of the front page, or unpin it. It stays pinned through
   * publishing, the merge and a close, until the reviewer unpins it. The front page is the
   * reviewer's, so agents can not pin. Pinning is not activity: updated_at stays.
   */
  setPinned(pull: PullRow, pinned: boolean, actor: Actor): void {
    this.requireHuman(actor, 'only the user can pin a pull request to the top of their front page');
    // Pinned again, it keeps its place.
    const changed = pinned
      ? this.db.run('UPDATE pulls SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL', this.nextPinAt(), pull.id).changes
      : this.db.run('UPDATE pulls SET pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL', pull.id).changes;
    if (changed) this.emit(pull.id, pinned ? 'pinned' : 'unpinned', actor);
  }

  /** Now, or a millisecond after the newest pin when two pins land in the same millisecond, so the newest pin is always first. */
  private nextPinAt(): string {
    const at = now();
    const newest = this.db.get<{ at: string | null }>('SELECT MAX(pinned_at) AS at FROM pulls')!.at;
    return newest && newest >= at ? new Date(Date.parse(newest) + 1).toISOString() : at;
  }

  // ------------------------------------------------------------ the agent loop

  /**
   * Record that the author has been shown everything up to `at` (taken before reading the
   * feedback), that the reviewer agents are done with `agentsDone`, and that `conflicts`
   * conflicts with its base, when it was told so.
   */
  markSeen(pull: PullRow, at: string, agentsDone?: string, conflicts?: string): void {
    const moved = this.db.transaction(() => {
      const { seen: before, told } = this.db.get<{ seen: string; told: string | null }>('SELECT author_seen_at AS seen, conflicts_told_sha AS told FROM pulls WHERE id = ?', pull.id)!;
      // Only forward: a late confirmation must not bring back feedback seen since, nor take back
      // that the reviewer agents are done with a later commit.
      if (before >= at) return false;
      // Among it, feedback that asks something of the author, or a conflict it was told of for
      // the first time: from now, its turn (see turn).
      const asked = askedAt(this.db, pull, at);
      const handed = (asked !== null && asked > before) || (!!conflicts && conflicts !== told);
      this.db.update('pulls', pull.id, {
        author_seen_at: at,
        ...(handed ? { author_handed_at: at } : {}),
        ...(agentsDone ? { agents_done_sha: agentsDone } : {}),
        ...(conflicts ? { conflicts_told_sha: conflicts } : {}),
      });
      return true;
    });
    if (moved) this.emit(pull.id, 'seen', this.db.actorById(pull.author_id));
  }

  /** When each author's `pr wait` began, kept across its re-polls; for "waiting 12 min". */
  private waitingSince = new Map<number, string>();
  /** How many waits each author started, re-polls included: one push of a head is tried per wait (pushReady). */
  private waitsStarted = new Map<number, number>();

  /**
   * `pr wait` re-polls every few minutes. Announce that the author started waiting at once,
   * but that it stopped only if it does not come straight back, so open pages do not flicker.
   */
  private waitingStopped = new Map<number, ReturnType<typeof setTimeout>>();
  private setWaiting(id: number, delta: 1 | -1, author: Actor): void {
    // Reviewer agents start when the author says it is ready, every time it does.
    if (delta === 1) {
      this.waitsStarted.set(id, (this.waitsStarted.get(id) ?? 0) + 1);
      this.bus.emit('author-waiting', id);
    }
    const before = this.waiters.get(id) ?? 0;
    const n = before + delta;
    if (n > 0) this.waiters.set(id, n);
    else this.waiters.delete(id);
    if (before === 0 && n > 0) {
      const stopping = this.waitingStopped.get(id);
      if (stopping) {
        clearTimeout(stopping);
        this.waitingStopped.delete(id);
      } else {
        this.waitingSince.set(id, now());
        this.emit(id, 'waiting', author);
      }
    } else if (before > 0 && n === 0) {
      const t = setTimeout(() => {
        this.waitingStopped.delete(id);
        this.waitingSince.delete(id);
        this.emit(id, 'waiting', author);
      }, this.waitGraceMs);
      t.unref();
      this.waitingStopped.set(id, t);
    }
  }

  /**
   * Whether the author's `pr wait` is blocked now. With `grace`, also for waitGraceMs after one
   * ended, until another starts (setWaiting): turn() counts that, so the author's state does not
   * flip between re-polls. The rest asks without it: the sidebar, the merge box and the JSON say
   * "not waiting" then, and the reviewer agents, auto-publish and pushes go only on a wait.
   */
  authorWaiting(id: number, opts: { grace?: boolean } = {}): boolean {
    return this.waiters.has(id) || (opts.grace === true && this.waitingStopped.has(id));
  }

  /** The pull requests whose author's `pr wait` is blocked now (authorWaiting, without the grace). */
  waitingPulls(): number[] {
    return [...this.waiters.keys()];
  }

  /**
   * The reviewer agents of the pull request (those `filter` keeps) decide again whether to review,
   * if its author is waiting now: after a change that may let them, the author need not wait again.
   */
  reconsider(pull: PullRow, filter: (r: Reviewer) => boolean = () => true): void {
    if (this.authorWaiting(pull.id)) for (const r of this.reviewersFor(pull)) if (filter(r)) r.consider(pull.id);
  }

  /** What a `pr wait` on the pull request returns now, or null while there is nothing new. */
  private waitResult(id: number): WaitResult | null {
    const checkedAt = now();
    const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id);
    if (!pull) return { status: 'closed', reviews: [], comments: [] };
    // Feedback always comes back, also when it arrives together with a close, a publish or a merge.
    const fb = unseenFeedback(this.db, pull);
    const published = lastEvent(this.db, pull, 'published', pull.author_seen_at);
    // What came of pushing the head it waited with, the latest push it has not been told of. A
    // failure that is tried again is the reviewer's to see; the author waits on.
    const push = this.lastPush(pull, pull.author_seen_at);
    // And of publishing its edits of the title and description, which go before the push
    // (pushUpdate). A failure that is tried again is the reviewer's to see; the author waits on.
    const latestEdit = this.lastEdit(pull, pull.author_seen_at);
    const edit = latestEdit && !(latestEdit.retry && !latestEdit.published.length && !latestEdit.edited_on_github.length) ? latestEdit : null;
    // Closed here, or merged or closed on GitHub: nothing more is coming, so every wait says so.
    const ended = pull.state === 'closed' ? 'closed' : pull.github_state === 'merged' ? 'merged' : pull.github_state === 'closed' ? 'closed_on_github' : null;
    const unseen = fb.reviews.length > 0 || fb.comments.length > 0;
    // Reviews from reviewer agents still at work are held, to come together (agentsStillReviewing).
    const held = unseen && this.agentsStillReviewing(pull, fb);
    // A head that conflicts with its base is the author's to rebase, published or not: said once per
    // commit, with any other news, but not ahead of held reviews, which a wait that returned would mark as seen.
    const conflicts = this.baseConflicts(pull)?.clean === false ? pull.head_sha : undefined;
    const fresh = conflicts !== undefined && conflicts !== pull.conflicts_told_sha;
    const pushed = push && (push.result === 'pushed' ? 'pushed' : push.retry ? null : 'push_failed');
    const edited = edit && (edit.failed.length || edit.edited_on_github.length ? 'edit_failed' : 'edited');
    // While the head the author waits with is pushed and its edits published (pushUpdate), what came
    // of either so far waits for the rest. Not when something else comes meanwhile: it comes at once,
    // with what came of them so far, and the rest comes with the next wait.
    const updating = this.updating.has(pull.id) && !unseen && !fresh;
    const status = ended ?? (published ? 'published' : held || updating ? null : (pushed ?? edited ?? (unseen ? 'feedback' : fresh ? 'conflicts' : null)));
    if (!status) return null;
    // Not marked as seen here: the author confirms once it has shown the feedback, so a
    // response lost on the way (a restart) delivers it again instead of losing it.
    return { status, reviews: fb.reviews, comments: fb.comments, seenAt: checkedAt, conflicts, push: push ?? undefined, edit: edit ?? undefined, ...this.leftToAddress(pull, fb) };
  }

  /** What is left for the author once it has read the feedback, and for the reviewer agents (WaitResult.asksAuthor, stillToReview). */
  private leftToAddress(pull: PullRow, fb: Feedback): Pick<WaitResult, 'asksAuthor' | 'stillToReview'> {
    const author = this.db.actorById(pull.author_id).login;
    const reviewers = this.reviewersFor(pull).map((r) => ({ login: r.actor().login, status: r.headStatus(pull) }));
    return {
      asksAuthor: fb.asks || unansweredThreads(this.db, pull) > 0 || reviewers.some((r) => r.status.state === 'findings'),
      stillToReview: reviewers.flatMap((r) => (toReview(r.status.state) ? (reviewerAgentText(r.login, r.status, pull, author, true, false) ?? []) : [])),
    };
  }

  async wait(ctx: Ctx, actor: Actor, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const id = ctx.pull.id;
    const author = this.db.actorById(ctx.pull.author_id);
    // Waiting says the author is ready for review, which starts reviewer agents and lets auto-publish go ahead.
    if (actor.id !== author.id) {
      throw new HttpError(403, `only the author of this pull request (${author.login}) can wait for its feedback, not ${actor.login}. An agent carrying on the author's work sets GALLEY_ACTOR=${author.login}.`);
    }
    // A pull request that is closed or merged is not ready for review: answer without saying the author waits.
    const already = this.waitResult(id);
    if (already && ENDED.includes(already.status)) return already;
    this.setWaiting(id, 1, author);
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const checkedAt = now();
        const result = this.waitResult(id);
        if (result) {
          // What asks nothing of the author (an approval, a review that found nothing, a publish)
          // hands it no turn, so the wait that returns it is its latest action all the same. A
          // conflict it has not been told of does, whatever comes with it: recorded, the wait would
          // count as acting on it (markSeen hands it over at about the same moment).
          const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id);
          const asked = pull ? askedAt(this.db, pull) : null;
          const conflict = result.conflicts !== undefined && result.conflicts !== pull?.conflicts_told_sha;
          if (pull && !conflict && (asked === null || asked <= pull.author_seen_at)) this.recordWait(pull, checkedAt, author);
          return result;
        }
        const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) return { status: 'timeout', reviews: [], comments: [] };
        this.recordWait(pull, checkedAt, author);
        // The reviewer's turn with a commit the author has not handed over yet: it asks the reviewer.
        const agentsDone = this.agentsDone(pull);
        if (agentsDone) return { status: 'agents_done', reviews: [], comments: [], seenAt: checkedAt, agentsDone };
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.bus.off('change', onChange);
            signal?.removeEventListener('abort', done);
            resolve();
          };
          // Anything but the author's own changes; one from GitHub or git has no actor (emitSystem).
          const onChange = (e: ChangeEvent) => {
            if (e.pullId === id && e.actor !== author.login) done();
          };
          const timer = setTimeout(done, remaining);
          this.bus.on('change', onChange);
          signal?.addEventListener('abort', done);
        });
      }
    } finally {
      this.setWaiting(id, -1, author);
    }
  }

  /**
   * Record that the author waited at `at`, with nothing new to read that asks something of it:
   * it is done with the feedback so far (see turn). When that ends the author's turn, pages hear
   * of it: a wait started within seconds of the last one announces nothing (setWaiting).
   * Renewals that change nothing stay quiet.
   */
  private recordWait(pull: PullRow, at: string, author: Actor): void {
    const working = pull.author_handed_at !== null && pull.author_handed_at > this.authorActedAt(pull);
    this.db.update('pulls', pull.id, { author_waited_at: at });
    if (working) this.emit(pull.id, 'waiting', author);
  }

  /** Codex and Claude as reviewer agents, those of them the server runs. */
  builtInReviewers(): Reviewer[] {
    return [this.codex, this.claude].filter((r) => r !== null);
  }

  /** The reviewer agents this server runs, Codex, Claude and the custom ones: each one actor that reviews on its own. */
  reviewerAgents(): Reviewer[] {
    return [...this.builtInReviewers(), ...(this.custom?.list() ?? [])];
  }

  /** The reviewer agents that review the pull request: custom reviewers review the repositories they name. */
  reviewersFor(pull: PullRow): Reviewer[] {
    return this.reviewerAgents().filter((r) => r.appliesToPull(pull));
  }

  /** How many reviews the reviewer agents are running, on all pull requests. */
  reviewsRunning(): number {
    return this.reviewerAgents().reduce((n, r) => n + r.runningCount(), 0);
  }

  /**
   * The reviewers of the description have a new version of it to review: an author waiting now
   * need not wait again for them. (Those of the code review what a push brings when the author waits.)
   */
  private reconsiderDescription(pull: PullRow): void {
    this.reconsider(pull, (r) => r.reviews === 'description');
  }

  /** Cancel the reviewer agents' reviews of the pull request, for what just happened to it (see Reviewer.cancel). Before the change is announced, so nobody hears they are still at work. */
  private cancelReviews(pull: PullRow, reason: CancelReason): void {
    for (const r of this.reviewerAgents()) r.cancel(pull, reason);
  }

  /**
   * Whether the feedback waits for more of its kind: it is all reviews from reviewer agents (also
   * one whose file is gone), and another reviewer agent is still at work on the pull request. The
   * author then gets the reviews of a commit together and answers them in one round. Anything from
   * anyone else comes back at once, with what the reviewer agents posted so far.
   */
  private agentsStillReviewing(pull: PullRow, fb: Feedback): boolean {
    if (fb.comments.length || !this.reviewersAtWork(pull).length) return false;
    return fb.reviews.every((r) => fb.byAgent.has(r.id));
  }

  /** The reviewer agents reviewing the pull request or about to, and what each is at. */
  reviewersAtWork(pull: PullRow): { reviewer: Reviewer; work: ReviewAtWork }[] {
    return this.reviewerAgents().flatMap((reviewer) => {
      const work = reviewer.atWork(pull);
      return work ? [{ reviewer, work }] : [];
    });
  }

  /**
   * For a waiting author with all feedback seen: none of the reviewer agents reviews the head or
   * is about to, so it is the reviewer's turn with a commit the author has not handed over yet.
   * They found nothing in it, used up their automatic reviews, are off, or have nothing more to
   * say (the author answered their findings without a new commit, or a review failed). `pr wait`
   * says so once per commit, so the author asks the reviewer to review it. Not under
   * auto-publish, which publishes then instead, nor once it is published (its wait pushes each
   * commit then: pushUpdate), nor before it is known whether the commit conflicts with its base,
   * which the author hears of first.
   */
  private agentsDone(pull: PullRow): AgentsDone | null {
    if (pull.state !== 'staged' || pull.auto_publish || pull.agents_done_sha === pull.head_sha || this.conflictsPending(pull)) return null;
    const author = this.db.actorById(pull.author_id).login;
    const reviewers = this.reviewersFor(pull).map((r) => ({ login: r.actor().login, status: r.headStatus(pull) }));
    // Findings the author has not answered hold them up too (Reviewer.answered); a failed review does not.
    if (!reviewers.every((r) => doneForHandover(r.status.state))) return null;
    const stopped = this.stoppedText(pull);
    const texts = reviewers.flatMap((r) => reviewerAgentText(r.login, r.status, pull, author, true, !!stopped) ?? []);
    // Once, whatever each reviewer agent made of the commit.
    return { sha: pull.head_sha, reviewers: stopped ? [...texts, stopped] : texts };
  }

  /**
   * Where the agents are with the pull request: what each reviewer agent made of the head, whether
   * the author is waiting with all feedback seen, and the threads the reviewer started that are
   * open. Auto-publish waits for all of it (autoPublishChecklist).
   */
  readiness(pull: PullRow): Readiness {
    const reviewers = this.reviewersFor(pull).map((r) => ({ login: r.actor().login, engine: r.engineId, reviewer: r.key, status: r.headStatus(pull) }));
    const authorWaiting = this.authorWaiting(pull.id);
    const fb = unseenFeedback(this.db, pull);
    const unseen = fb.reviews.length + fb.comments.length;
    const openThreads = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments c JOIN actors a ON a.id = c.author_id
       WHERE c.pull_id = ? AND c.kind = 'review' AND c.in_reply_to_id IS NULL AND c.resolved_at IS NULL AND a.type = 'User'
         AND (c.review_id IS NULL OR c.review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))`,
      pull.id,
    )!.n;
    return { reviewers, authorWaiting, unseen, openThreads };
  }

  /**
   * The review decision, as GitHub's reviewDecision: from the reviews of anyone but the reviewer
   * agents, whose approvals are theirs and stand in for nobody's (also once a custom reviewer's
   * file is gone).
   */
  reviewDecision(pull: PullRow, reviews: ReviewRow[]): string {
    const agents = agentReviews(this.db, pull);
    return reviewDecision(reviews.filter((r) => !agents.has(r.id)));
  }

  /** Whose move the pull request waits for, and why (see Turn), from its readiness when the caller has it already. */
  turn(pull: PullRow, ready?: Readiness): Turn {
    // Closed here, or merged or closed on GitHub: nothing more is coming.
    if (stagingState(pull) === 'done') return { whose: 'none', reasons: [] };
    const r = ready ?? this.readiness(pull);
    const author = this.db.actorById(pull.author_id).login;
    const acted = this.authorActedAt(pull);
    // Away from `pr wait` for that long since its last action, its session has probably ended.
    const quiet = Date.now() - Date.parse(acted) >= this.stallMs;
    // The author's turn: from `pr wait` or `pr view --comments` handing it feedback that asks
    // something of it (markSeen) to its next action.
    const handed = pull.author_handed_at !== null && pull.author_handed_at > acted;
    // Such feedback it has not been handed yet. Not waiting, it hears of it only when the reviewer says so.
    const asked = askedAt(this.db, pull);
    const unseen = asked !== null && asked > pull.author_seen_at;
    // Unless it acted on the pull request since the feedback came (pushed, replied, edited): it has
    // it all the same, as from a wait a restart cut off before it was confirmed, and works on it,
    // until it stalls.
    const actedSince = unseen && acted > asked;
    const workingUnseen = actedSince && !quiet;
    const working = handed || workingUnseen;
    // A wait that just ended counts for a few seconds more (authorWaiting's grace), long enough for
    // the author to confirm the feedback it was handed.
    const waiting = this.authorWaiting(pull.id, { grace: true });
    // Published, a commit GitHub does not have is pushed when the author waits (pushUpdate), unless
    // pushing it failed: then the reviewer decides. Not while its signing, which failed for now, is
    // tried again when its time comes with nothing from anyone: the author waits, or waited since it
    // was last handed feedback, and has none to read, not even an approval (mayPush). Nobody's to do.
    const published = stagingState(pull) === 'published';
    const unpushed = published && this.headUnpublished(pull);
    const pushFailed = unpushed ? this.pushFailed(pull) : null;
    const signingAgain = !!pushFailed?.retry && !!pushFailed.signing?.next_at && (waiting || this.waitedSinceHanded(pull)) && r.unseen === 0;
    // A head that conflicts with its base as galley worked it out, published or not: the author's to
    // rebase once `pr wait` tells it (markSeen), and until then, or if it does not, the reviewer's.
    const found = this.baseConflicts(pull);
    const conflicting = found?.clean === false ? found : null;
    // Auto-publish, while it is on: what it waits for, and what of that is the reviewer's to see to.
    // So is a conflict galley found, also while it is checked again for a base that moved since.
    const checklist = pull.state === 'staged' && pull.auto_publish ? this.autoPublishChecklist(pull, r) : null;
    const forUser = checklist?.filter(waitsForUser) ?? [];
    const userHolds = forUser.length > 0 || !!conflicting;
    // Nothing of the reviewer's: it publishes once the author waits with all feedback seen.
    const awaitsAuthor = !!checklist && !userHolds && checklist.some((i) => i.key === 'author' && !i.ok);
    // So are its edits of the title and description (publishEdits), except those publishing left:
    // it failed, or they were edited on GitHub. Then, too, the reviewer decides.
    const edits = published ? this.authorEdits(pull) : [];
    const left = this.editsLeft(pull, edits);
    const toEdit = edits.filter((f) => !left.has(f));
    // A reviewer agent still has the head to review and starts when the author waits, auto-publish
    // publishes it when the author waits, or, published, the head is pushed and the edits published
    // when it waits: until then the author has to wait. Not for a head GitHub has, which is the
    // reviewer's to follow.
    const sending = published && ((unpushed && !pushFailed) || toEdit.length > 0);
    const toStart = !waiting && (published ? sending : (this.headUnpublished(pull) && r.reviewers.some((x) => x.status.state === 'unreviewed')) || awaitsAuthor);
    // Stalled: quiet while it has to wait, or after acting on feedback it was not handed.
    const stalled = (toStart || (actedSince && !waiting)) && !working && quiet;
    const last = unpushed && !pushFailed ? 'commit' : 'edit';
    const state: AuthorState = working ? 'working' : unseen ? 'unseen' : waiting ? 'waiting' : stalled ? 'stalled' : 'stopped';

    const reasons: TurnReason[] = [];
    if (working) reasons.push({ kind: 'author', state, text: `${author} is working on the feedback`, since: handed ? pull.author_handed_at : asked });
    if (unseen && !workingUnseen) reasons.push({ kind: 'author', state: 'unseen', text: `${author} has not seen the latest feedback` });
    if (state === 'waiting') reasons.push({ kind: 'author', state, text: `${author} is waiting for review`, since: this.waitingSince.get(pull.id) ?? null });
    // Not waiting, it does not hear of anything new: the reviewer has to tell it. Nor do the reviewer agents start, nor is its commit pushed.
    if (!working && !waiting) {
      const text = stalled
        ? `${author} stopped without ${unpushed ? 'waiting since its last commit' : toEdit.length ? 'waiting since its last edit' : toStart ? 'asking for review' : 'waiting'}`
        : toStart
          ? sending
            ? `${author} has not waited since its last ${last}`
            : `${author} has not asked for review yet (pr wait)`
          : `${author} is not waiting`;
      reasons.push({ kind: 'author', state: stalled ? 'stalled' : 'stopped', text, since: acted });
    }

    // At work, about to be, or to run again after a restart, whether the author waits or not.
    const atWork = r.reviewers.some((x) => busy(x.status.state));
    // A waiting author starts the reviewer agents that have not reviewed its head.
    const next = state === 'waiting' && r.reviewers.some((x) => x.status.state === 'unreviewed');
    const unpublished = this.unpublishedChanges(pull);
    // A review that failed after publishing (asked for by hand) needs the reviewer all the same.
    const failed = r.reviewers.some((x) => x.status.state === 'failed' && !!x.status.failedAt && x.status.failedAt > (pull.published_at ?? ''));
    // So does what GitHub has once it is published: failed checks, changes requested, threads, a
    // conflict, the merge. It is for the reviewer to act on (or hand to an agent), not feedback for the author.
    const onGithub = githubStatus(pull);
    // Of a commit a push replaces, GitHub's checks and merge ask nothing: the author has a commit
    // GitHub does not, or galley pushed one since following last asked. Asked since, another commit
    // is GitHub's latest all the same: one made there (Update branch, a suggestion), or a force-push back.
    const pushedOver = !!onGithub && onGithub.head !== pull.published_head_sha && onGithub.checkedAt < (pull.published_at ?? '');
    // Auto-merge galley turned on after following last asked is on, whatever GitHub said then: asked
    // while publishing turned it on, GitHub has it off and the pull request ready to merge. Once
    // GitHub says it is off after that, it is (turned off there, or by a push).
    const merge = onGithub?.autoMerge === false ? this.autoMerge(pull) : null;
    const merging = !!merge && merge.state !== 'failed' && merge.at > onGithub!.checkedAt;
    // GitHub's conflict is said only while galley's own check has not found it (yet): once it has,
    // its reason says it, with the files.
    const github = githubAsks(onGithub && { ...onGithub, ...(conflicting ? { conflicting: false } : {}), ...(merging ? { autoMerge: true } : {}) }, pull.base_ref, unpushed || pushedOver);
    // Published, what GitHub does not have is the reviewer's to publish, except commits about to be
    // pushed and edits about to be published: the author waits with them, and that has not failed,
    // or the commits' signing is tried again.
    const toPublish = unpublished.filter((c) => (c === 'commits' ? !signingAgain && (!waiting || !!pushFailed) : !waiting || !toEdit.includes(c)));
    // Feedback being handed over (the author waits) makes it the author's turn; feedback it is not
    // waiting for is the reviewer's to pass on, published or not, and so is a stalled author.
    const whose: Whose = atWork
      ? 'reviewer_agents'
      : working || (unseen && waiting)
        ? 'author'
        : next
          ? 'reviewer_agents'
          : toStart && !unseen && !stalled
            ? 'author'
            : pull.state === 'published' && !toPublish.length && !failed && !unseen && !conflicting && !github.length
              ? 'none'
              : 'reviewer';
    // Waiting on the retry of signing the head, and on GitHub: for whom, when it says.
    if (whose === 'none') {
      const retry: TurnReason[] = signingAgain ? [{ kind: 'unpublished', text: `the push of ${pull.head_sha.slice(0, 7)} waits to try signing again`, since: pushFailed!.at }] : [];
      return { whose, reasons: [...retry, ...githubWaits(onGithub).map((text): TurnReason => ({ kind: 'github', text }))] };
    }
    // Waiting on auto-publish, which publishes it with nothing more from the reviewer, though the
    // reviewer agents are done with it. Not when the author has feedback it is not waiting for, or stalled.
    if (whose === 'reviewer' && checklist && !userHolds && !unseen && !stalled) return { whose: 'none', reasons: [autoPublishNext(checklist, pull, author)] };

    if (whose === 'reviewer') reasons.push(...this.sinceReview(pull, author));
    // Automatic reviews end at the first publish: once published, there are none to stop.
    const stopped = pull.state === 'staged' ? this.stoppedText(pull) : null;
    for (const { login, engine, reviewer, status } of r.reviewers) {
      const text = reviewerAgentText(login, status, pull, author, state === 'waiting', !!stopped);
      if (text) reasons.push({ kind: 'reviewer_agent', state: status.state, to_review: toReview(status.state), text, since: status.startedAt, engine, reviewer, ...(status.description ? { description: true } : {}) });
    }
    // Once, whatever each reviewer agent is at.
    if (stopped) reasons.push({ kind: 'reviewer_agent', state: 'capped', to_review: false, text: stopped });
    // The agents at work come first, since that is whose turn it is.
    if (whose === 'reviewer_agents') reasons.sort((a, b) => Number(b.kind === 'reviewer_agent') - Number(a.kind === 'reviewer_agent'));

    const reviews = this.db.all<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND state != 'PENDING' ORDER BY id", pull.id);
    const decision = this.reviewDecision(pull, reviews);
    if (decision === 'APPROVED') reasons.push({ kind: 'approved', text: 'approved' });
    if (decision === 'CHANGES_REQUESTED') reasons.push({ kind: 'changes_requested', text: 'changes requested' });
    const unresolved = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments WHERE pull_id = ? AND kind = 'review' AND in_reply_to_id IS NULL AND resolved_at IS NULL
         AND (review_id IS NULL OR review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))`,
      pull.id,
    )!.n;
    if (unresolved) reasons.push({ kind: 'threads', text: `${unresolved} unresolved thread${unresolved === 1 ? '' : 's'}` });
    if (unpublished.length) {
      const onGithub = edits.filter((f) => left.get(f)?.edited_on_github.includes(f));
      const failed = edits.filter((f) => left.get(f)?.failed.includes(f));
      const why = [
        pushFailed ? `pushing ${pull.head_sha.slice(0, 7)} failed` : null,
        onGithub.length ? `the ${andList(onGithub)} ${onGithub.length > 1 ? 'were' : 'was'} edited on GitHub` : null,
        failed.length ? `publishing the ${andList(failed)} failed` : null,
      ];
      reasons.push({ kind: 'unpublished', text: `update not published: ${unpublished.join(', ')}${why.map((w) => (w ? `; ${w}` : '')).join('')}` });
    }
    if (conflicting) {
      const { files, ref } = conflicting;
      const where = files.length === 1 ? ` in ${files[0]}` : files.length ? ` in ${files.length} files` : '';
      reasons.push({ kind: 'conflicts', text: `conflicts with ${ref}${where}` });
    }
    for (const text of github) reasons.push({ kind: 'github', text });
    // What holds auto-publish up for the reviewer that no reason above says.
    for (const i of forUser) {
      if (i.key === 'conflicts' && !conflicting) reasons.push({ kind: 'auto_publish', text: `auto-publish could not check for conflicts with ${pull.base_ref}` });
      if (i.key === 'merge_method' && 'text' in i) reasons.push({ kind: 'auto_publish', text: i.text });
    }
    return { whose, reasons };
  }

  /** The author action each pull request was last looked at for by noticeStalls. */
  private stallsNoticed = new Map<number, string>();

  /**
   * Tell pages about authors that just stalled (see turn). Time alone does that, with no change to
   * announce, so the server calls this when it polls: each author action is looked at once, when
   * it is stallMs old.
   */
  noticeStalls(): void {
    for (const pull of this.db.all<PullRow>(`SELECT * FROM pulls WHERE ${LISTED.get('open')}`)) {
      const acted = this.authorActedAt(pull);
      if (Date.now() - Date.parse(acted) < this.stallMs || this.stallsNoticed.get(pull.id) === acted) continue;
      this.stallsNoticed.set(pull.id, acted);
      if (this.turn(pull).reasons.some((r) => r.state === 'stalled')) this.emitSystem(pull.id, 'stalled', 'galley');
    }
  }

  /** What changed since the reviewer last reviewed: pushes, and threads the author answered. */
  private sinceReview(pull: PullRow, author: string): TurnReason[] {
    const viewer = this.viewer();
    const last = this.db.get<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND author_id = ? AND state != 'PENDING' ORDER BY submitted_at DESC", pull.id, viewer.id);
    const out: TurnReason[] = [];
    if (last) {
      const pushes = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM revisions WHERE pull_id = ? AND created_at > ?', pull.id, last.submitted_at)!.n;
      if (pushes) out.push({ kind: 'changes', text: `${pushes} ${pushes === 1 ? 'push' : 'pushes'} since ${viewer.login}'s review` });
    } else out.push({ kind: 'changes', text: `no review from ${viewer.login} yet` });
    const answered = this.db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT in_reply_to_id) AS n FROM comments WHERE pull_id = ? AND author_id = ? AND in_reply_to_id IS NOT NULL AND created_at > ?',
      pull.id,
      pull.author_id,
      last?.submitted_at ?? '',
    )!.n;
    if (answered) out.push({ kind: 'changes', text: `${author} answered ${answered} thread${answered === 1 ? '' : 's'}` });
    return out;
  }

  /**
   * When the author last did something: staged, pushed, edited, commented (or edited a comment),
   * resolved a thread, or waited with nothing new to read. Not a move of the merge base alone (a
   * new base, say), which sync records as the author's push.
   */
  private authorActedAt(pull: PullRow): string {
    const at = this.db.get<{ at: string }>(
      `SELECT MAX(at) AS at FROM (
         SELECT created_at AS at FROM pulls WHERE id = ?1
         UNION ALL SELECT author_waited_at FROM pulls WHERE id = ?1
         UNION ALL SELECT created_at FROM events WHERE pull_id = ?1 AND actor_id = ?2
           AND NOT (type = 'pushed' AND json_extract(data, '$.before') = json_extract(data, '$.after'))
         UNION ALL SELECT updated_at FROM comments WHERE pull_id = ?1 AND author_id = ?2
         UNION ALL SELECT resolved_at FROM comments WHERE pull_id = ?1 AND resolved_by_id = ?2)`,
      pull.id,
      pull.author_id,
    )!.at;
    return at;
  }

  /** What a published pull request has that GitHub does not yet: commits, title, description. Empty before the first publish. */
  unpublishedChanges(pull: PullRow): ('commits' | 'title' | 'description')[] {
    if (!pull.published_url) return [];
    // What was published, in terms of the staged commits (GitHub may have signed copies of them).
    const source = pull.published_source_sha ?? pull.published_head_sha;
    const changed: ('commits' | 'title' | 'description')[] = [];
    if (source !== pull.head_sha) changed.push('commits');
    if (pull.published_title !== pull.title) changed.push('title');
    if (pull.published_body !== pull.body) changed.push('description');
    return changed;
  }

  /**
   * The title and description GitHub does not have that the author's waits publish, as its commits
   * are pushed (publishEdits): each that only the author edited since it was last published. One
   * the user edited since is the user's to publish, also when the author edited it after the user:
   * a wait never publishes over the user's text. Once the user publishes it, the author's later
   * edits are its waits' again. Which edits the text it published included goes by the events'
   * order, not their time: an edit made while it was being published, after the text was read,
   * counts as one since, whenever its request began.
   */
  authorEdits(pull: PullRow): EditField[] {
    const fields = this.unpublishedChanges(pull).filter((c) => c !== 'commits');
    if (stagingState(pull) !== 'published' || !fields.length) return [];
    // Since it was last published, by the user or by a wait: the edits after those the text it
    // published included (read_upto; for a publish from before galley recorded that, after it).
    const published = lastEvent(this.db, pull, 'published');
    const publish = published?.data.read_upto ?? published?.id ?? 0;
    const edits = eventsAfter(this.db, pull, 'github_edit', published?.id ?? 0);
    return fields.filter((c) => {
      const since = edits.findLast((e) => e.data.published.includes(c))?.data.read_upto ?? publish;
      const by = this.db.all<{ actor_id: number }>('SELECT actor_id FROM events WHERE pull_id = ? AND type = ? AND id > ?', pull.id, c === 'title' ? 'renamed' : 'body_edited', since);
      return by.length > 0 && by.every((e) => e.actor_id === pull.author_id);
    });
  }

  /**
   * The author's edits (authorEdits, unless the caller has them) that publishing left as they are
   * now, each with the try that left it: it failed, or the field was edited on GitHub. Not tried
   * again until its text changes, unless the failure is one tried again (`retry`); meanwhile the
   * reviewer decides.
   */
  editsLeft(pull: PullRow, fields = this.authorEdits(pull)): Map<EditField, GithubEdit> {
    const left = new Map<EditField, GithubEdit>();
    if (!fields.length) return left;
    const edits = eventsAfter(this.db, pull, 'github_edit', lastEvent(this.db, pull, 'published')?.id ?? 0);
    for (const f of fields) {
      // The latest try of this field.
      const e = edits.findLast(({ data: d }) => [...d.published, ...d.edited_on_github, ...d.failed].includes(f));
      if (!e || e.data.published.includes(f)) continue;
      if (f === 'title' ? e.data.title === pull.title : e.data.body === pull.body) left.set(f, { ...e.data, at: e.created_at });
    }
    return left;
  }

  /**
   * What a merged pull request's branch has that GitHub did not merge: commits synced before galley
   * heard of the merge, so never pushed, or made after it, when galley no longer follows the branch.
   * Deleting the branch would lose them. None on a remote-tracking branch, such as the base's, but
   * copies a rebase made of published ones (Repo.notPushed). `head` is the branch's tip, or what
   * galley last saw of a branch deleted here (`deleted`). Null when there are none.
   */
  async leftOut(pull: PullRow): Promise<{ head: string; deleted: boolean; commits: Commit[] } | null> {
    const source = pull.published_source_sha ?? pull.published_head_sha;
    if (pull.github_state !== 'merged' || !source) return null;
    const repo = this.repoById(pull.repo_id);
    const git = this.git(repo);
    const tip = await git.resolve(`refs/heads/${pull.head_ref}`);
    const head = tip ?? pull.head_sha;
    const commits = head === source ? [] : await git.notPushed(source, head, repo.remote).catch(() => []);
    return commits.length ? { head, deleted: !tip, commits } : null;
  }

  // ------------------------------------------------------------ auto-publish

  /**
   * Auto-publish is on and may publish now: everything it waits for is ok (autoPublishChecklist).
   * It approves the first publish only, which turns it off: after that, each commit the author
   * waits with is pushed (pushUpdate).
   */
  autoPublishReady(pull: PullRow): boolean {
    if (!pull.auto_publish || pull.state !== 'staged') return false;
    return this.autoPublishChecklist(pull).every((i) => i.ok || !i.blocking);
  }

  /**
   * What auto-publish waits for, in the order the page lists it: the time to try again a signing
   * that failed for now, each reviewer agent done with the head (doneForAutoPublish: a failed
   * review holds it up, unlike for agentsDone), the author waiting with all feedback seen, none of
   * the threads the reviewer started open, and the head known not to conflict with its base as it
   * is now. Then what it does not wait for: GitHub no longer allows the auto-merge it was turned on
   * with, so publishing will fail. The signing, threads and the merge method are listed only when
   * there is something to say. Whose action each waits for: waitsForUser. `r`: the pull request's
   * readiness, when the caller has it already.
   */
  autoPublishChecklist(pull: PullRow, r = this.readiness(pull)): AutoPublishItem[] {
    const author = this.db.actorById(pull.author_id).login;
    const retry = this.autoPublishRetry(pull);
    const items: AutoPublishItem[] = [];
    if (retry) items.push({ key: 'signing', ok: Date.parse(retry.next_at) <= Date.now(), blocking: true, failed: false, signing: retry });
    for (const { login, reviewer, status } of r.reviewers) {
      items.push({ key: `reviewer:${reviewer}`, ok: doneForAutoPublish(status.state), blocking: true, failed: status.state === 'failed', reviewer: { login, status } });
    }
    const seen = r.authorWaiting && r.unseen === 0;
    // The author waited with this head, all feedback seen, when signing failed for now: the retry
    // goes ahead without it, since agents often stop waiting once their work is done. Not once it
    // was handed feedback since, until it waits again.
    const waited = !seen && !!retry && r.unseen === 0 && this.waitedSinceHanded(pull);
    const text = seen
      ? `${author} is waiting for review, with all feedback seen`
      : waited
        ? `${author} waited for review with this commit, with all feedback seen`
        : r.authorWaiting
          ? `${author} has feedback it has not seen yet`
          : `${author} is working (not waiting for review)`;
    items.push({ key: 'author', ok: seen || waited, blocking: true, failed: false, text });
    if (r.openThreads) {
      const threads = r.openThreads === 1 ? '1 conversation you started is' : `${r.openThreads} conversations you started are`;
      items.push({ key: 'threads', ok: false, blocking: true, failed: false, text: `${threads} unresolved` });
    }
    // Known to merge cleanly into the base as it is now: not while that is worked out, nor when git
    // could not tell. Auto-publish is for the first publish, so GitHub does not have the head to answer for.
    const conflicts = this.currentConflicts(pull);
    const conflict = { key: 'conflicts', blocking: true };
    if (!conflicts) items.push({ ...conflict, ok: false, failed: false, text: `Checking for conflicts with ${pull.base_ref}` });
    else if (conflicts.clean === null) items.push({ ...conflict, ok: false, failed: true, text: `Could not check for conflicts with ${conflicts.ref}: ${conflicts.error}` });
    else if (!conflicts.clean) items.push({ ...conflict, ok: false, failed: true, text: `Conflicts with ${conflicts.ref}: nothing is published until ${author} rebases it` });
    else items.push({ ...conflict, ok: true, failed: false, text: `No conflicts with ${conflicts.ref}` });
    // GitHub's settings may have changed since it was turned on; publishing refuses then (autoMergeMethod).
    // As GitHub last said, without asking again as githubRepo would: this runs on every change.
    const method = this.autoPublish(pull)?.autoMerge;
    const slug = this.repoById(pull.repo_id).github_slug;
    const merging = method && slug ? this.githubRepoCache.get(slug)?.value?.merging : null;
    const refused = method && merging && (!merging.autoMerge ? 'auto-merge' : !merging.methods.includes(method) ? `${method} merges` : null);
    if (refused) items.push({ key: 'merge_method', ok: false, blocking: false, failed: true, text: `${slug} does not allow ${refused}, so publishing will fail` });
    return items;
  }

  /** Auto-publish's options while it is on, or null. */
  autoPublish(pull: PullRow): AutoPublish | null {
    if (!pull.auto_publish) return null;
    const auto = JSON.parse(pull.auto_publish) as AutoPublish;
    // Approvals from before auto-merge was an option leave it out.
    return { ...auto, autoMerge: auto.autoMerge ?? null };
  }

  /**
   * Approve the first publish in advance: galley publishes on its own once the agents are done
   * (see readiness), even commits pushed after this. The options are fixed now, as the publish box
   * shows them: signing and draft as checked, force if it was checked and turns out to be needed,
   * and auto-merge with the merge method `autoMerge`. The user's to do, or the author agent's when
   * the user asked it to publish: galley then publishes as that agent.
   */
  async enableAutoPublish(ctx: Ctx, opts: { sign?: boolean; draft?: boolean; force?: boolean; autoMerge?: MergeMethod }, actor: Actor): Promise<AutoPublish> {
    const { pull, repo } = ctx;
    this.requireUserOrAuthor(actor, pull, 'turn on auto-publish');
    if (pull.state === 'closed') throw new HttpError(422, 'reopen the pull request before turning on auto-publish');
    if (pull.published_url) throw new HttpError(422, 'this pull request is published already; auto-publish is for the first publish, and each commit the author waits with is pushed to it');
    if (!repo.github_slug) throw new HttpError(422, `remote "${repo.remote}" is not a GitHub repository`);
    const autoMerge = opts.autoMerge ? await this.autoMergeMethod(repo, opts.autoMerge) : null;
    const auto: AutoPublish = {
      by: actor.id,
      at: now(),
      sign: opts.sign ?? (await this.signsByDefault(ctx)),
      draft: opts.draft ?? !!pull.draft,
      force: !!opts.force,
      autoMerge,
    };
    this.db.transaction(() => {
      this.db.update('pulls', pull.id, { auto_publish: JSON.stringify(auto) });
      this.addEvent(pull, actor, 'auto_publish_enabled', { sign: auto.sign, draft: auto.draft, force: auto.force, auto_merge: auto.autoMerge }, auto.at);
    });
    this.emit(pull.id, 'auto_publish', actor);
    return auto;
  }

  disableAutoPublish(ctx: Ctx, actor: Actor): void {
    this.requireUserOrAuthor(actor, ctx.pull, 'turn off auto-publish');
    if (this.db.transaction(() => this.autoPublishOff(ctx.pull, actor, 'cancelled'))) this.emit(ctx.pull.id, 'auto_publish', actor);
  }

  /**
   * Auto-publish could not publish under `approval` (pulls.auto_publish as the attempt read it):
   * record why, and turn it off. Not when that approval has been turned off or replaced since:
   * the failure belonged to it, and a newer approval makes its own attempt. `signing`: it could
   * not sign, and does not try again (autoPublishSigningFailed).
   */
  autoPublishFailed(pull: PullRow, actor: Actor, error: string, approval: string, signing?: SigningFailure): void {
    const failed = this.db.transaction(() => {
      if (this.db.run('UPDATE pulls SET auto_publish = NULL WHERE id = ? AND auto_publish = ?', pull.id, approval).changes === 0) return false;
      this.addEvent(pull, actor, 'auto_publish_failed', { error: error.slice(0, 4000), ...(signing ? { signing } : {}) });
      return true;
    });
    // Galley's doing, not the actor's: one that is the author still hears of it in its wait.
    if (failed) this.emitSystem(pull.id, 'auto_publish_failed', 'galley');
  }

  /**
   * Auto-publish could not sign the head under `approval`. When trying again may get past it
   * (SigningError.transient), it stays on and tries again when signingFailure says, without the
   * author having to wait again (autoPublishChecklist), up to the setting's number of retries;
   * after that, or for a failure trying again can not get past, it turns off (autoPublishFailed).
   * Counted for the approval and the head: a new commit, or turning auto-publish off and on again,
   * starts again. Not when the approval has been turned off or replaced since.
   */
  autoPublishSigningFailed(pull: PullRow, actor: Actor, e: SigningError, approval: string): void {
    const at = (JSON.parse(approval) as AutoPublish).at;
    const signing = this.signingFailure(e, (this.autoPublishRetry(pull)?.failures ?? 0) + 1);
    if (!signing.next_at) return this.autoPublishFailed(pull, actor, e.message, approval, signing);
    const recorded = this.db.transaction(() => {
      if (!this.db.get('SELECT 1 FROM pulls WHERE id = ? AND auto_publish = ?', pull.id, approval)) return false;
      this.addEvent(pull, actor, 'auto_publish_retry', { error: e.message.slice(0, 4000), head: pull.head_sha, approval: at, signing });
      return true;
    });
    if (recorded) this.emitSystem(pull.id, 'auto_publish_retry', 'galley');
  }

  /**
   * The signing auto-publish tries again (autoPublishSigningFailed): its latest failure under the
   * approval in force, while the head is the one it failed for. Null when there is none.
   */
  autoPublishRetry(pull: PullRow): AutoPublishRetry | null {
    const auto = this.autoPublish(pull);
    const e = auto && lastEvent(this.db, pull, 'auto_publish_retry', auto.at);
    if (!e || e.data.approval !== auto!.at || e.data.head !== pull.head_sha || !e.data.signing.next_at) return null;
    return { ...e.data.signing, next_at: e.data.signing.next_at, at: e.created_at, error: e.data.error };
  }

  /**
   * Whether the author waited since it was last handed feedback that asks something of it, or
   * told of a conflict (markSeen): done with it, as far as a retry of signing needs to know
   * (autoPublishChecklist, mayPush).
   */
  private waitedSinceHanded(pull: PullRow): boolean {
    return pull.author_handed_at === null || (pull.author_waited_at !== null && pull.author_waited_at > pull.author_handed_at);
  }

  /**
   * What to record of a signing that failed, the `failures`th time in a row (counted by the
   * caller). When trying again may get past it, it is tried again after signingRetryMs, and each
   * time after that three times as long after the last, while `failures` is at most the
   * setting's number of retries (signingRetries).
   */
  private signingFailure(e: SigningError, failures: number): SigningFailure {
    const retries = readSettings(this.db).publish.signingRetries;
    if (!e.transient) return { why: e.why, final: true, failures: 1, retries, next_at: null };
    const again = failures <= retries ? new Date(Date.now() + this.signingRetryMs * 3 ** (failures - 1)).toISOString() : null;
    return { why: e.why, failures, retries, next_at: again };
  }

  /** An auto-publish attempt under `approval` may go on: it is still the approval in force, and the agents are still done. */
  private stillApproved(pull: PullRow, approval: string): boolean {
    return pull.auto_publish === approval && this.autoPublishReady(pull);
  }

  /** Turn auto-publish off, saying why; the caller emits. False when it was not on. */
  private autoPublishOff(pull: PullRow, actor: Actor, reason: AutoPublishOff, ts = now()): boolean {
    const off = this.db.run('UPDATE pulls SET auto_publish = NULL WHERE id = ? AND auto_publish IS NOT NULL', pull.id).changes > 0;
    if (off) this.addEvent(pull, actor, 'auto_publish_disabled', { reason }, ts);
    return off;
  }

  // ------------------------------------------------------------ stop iterating

  /** Whether the reviewer stopped automatic reviews of the pull request (see stopIterating); null while they go on. */
  iterationsStopped(pull: PullRow): IterationsStopped | null {
    return pull.iterations_stopped ? (JSON.parse(pull.iterations_stopped) as IterationsStopped) : null;
  }

  /** The automatic review round a pull request is in or done with: the most automatic reviews any reviewer agent has done or is running. */
  automaticRound(pull: PullRow): number {
    return Math.max(0, ...this.reviewersFor(pull).map((r) => r.automaticReviewsStarted(pull)));
  }

  /**
   * The reviewer's call that the reviewer agents have reviewed enough. A running review finishes
   * and reaches the author; while stopped, no reviewer agent starts an automatic review and each
   * counts as done (capped), whatever its limit and runs say, so the author's next `pr wait`
   * hands its commit to the reviewer. Asking a reviewer agent by hand still works.
   */
  stopIterating(ctx: Ctx, actor: Actor): IterationsStopped {
    const { pull } = ctx;
    this.requireHuman(actor, 'only the user can stop automatic reviews');
    const stop: IterationsStopped = { by: actor.id, at: now(), round: this.automaticRound(pull) };
    // Decided in the database, not on ctx, which may be from before another stop: the first one stays.
    const stopped = this.db.transaction(() => {
      if (this.db.run('UPDATE pulls SET iterations_stopped = ? WHERE id = ? AND iterations_stopped IS NULL', JSON.stringify(stop), pull.id).changes === 0) return false;
      this.addEvent(pull, actor, 'iterations_stopped', { round: stop.round }, stop.at);
      return true;
    });
    if (!stopped) return this.iterationsStopped(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!)!;
    this.emit(pull.id, 'updated', actor);
    return stop;
  }

  /** Undo stopIterating: the limits apply again, and a waiting author's head is reviewed at once. False when they were not stopped. */
  resumeIterating(ctx: Ctx, actor: Actor): boolean {
    const { pull } = ctx;
    this.requireHuman(actor, 'only the user can resume automatic reviews');
    // Decided in the database, like stopIterating: ctx may be from before the stop.
    const resumed = this.db.transaction(() => {
      if (this.db.run('UPDATE pulls SET iterations_stopped = NULL WHERE id = ? AND iterations_stopped IS NOT NULL', pull.id).changes === 0) return false;
      this.addEvent(pull, actor, 'iterations_resumed', {});
      return true;
    });
    if (!resumed) return false;
    this.emit(pull.id, 'updated', actor);
    this.reconsider(pull);
    return true;
  }

  /** "laat stopped automatic reviews after round 2", while they are stopped: said once, beside what each reviewer agent is at. */
  private stoppedText(pull: PullRow): string | null {
    const stop = this.iterationsStopped(pull);
    return stop && `${this.db.actorById(stop.by).login} stopped automatic reviews ${afterRound(stop.round)}`;
  }

  // ---------------------------------------------------- publishing and signing

  /**
   * Whether publishing signs by default: when the user's git signs their own commits,
   * or when this pull request was published signed before.
   */
  async signsByDefault(ctx: Ctx): Promise<boolean> {
    const { pull, git } = ctx;
    if (pull.published_head_sha && pull.published_source_sha && pull.published_head_sha !== pull.published_source_sha) return true;
    return (await git.config('commit.gpgsign', 'bool')) === 'true';
  }

  /**
   * Whether publishing has to force-push: the push would drop the commit the branch has on
   * GitHub. Signing pushes copies, so it can need force where the agent's history did not change,
   * as when the agent's unsigned commits are on GitHub already. Before signing, the copies are
   * predicted from those made so far; publish decides again on the commit it actually pushes.
   */
  async forceNeeded(ctx: Ctx, sign: boolean): Promise<boolean> {
    const { pull, git } = ctx;
    const published = await this.onGitHub(ctx);
    if (!published) return false;
    // On top of the branch as last fetched, when the head has it in it, as preparePush pushes. So
    // is a head that brings back commits a rewrite there removed, once the user confirms them
    // (bringsBack): that needs no force either.
    const { onTop } = await this.fetchedBranch(ctx, pull, published);
    const theirs = onTop ?? published;
    if (!sign) return !(await git.isAncestor(theirs, pull.head_sha));
    const { shas, versions } = await this.signedVersions(ctx, pull, async () => null, onTop);
    const head = versions.get(pull.head_sha);
    if (head) return !(await git.isAncestor(theirs, head));
    // New copies go on top of the known ones and of the base: the push keeps GitHub's commit only if it is among or below them.
    if (await git.isAncestor(theirs, pull.base_sha)) return false;
    for (const sha of shas) {
      const known = versions.get(sha);
      if (known && (await git.isAncestor(theirs, known))) return false;
    }
    return true;
  }

  /**
   * The commit the branch has on GitHub, as far as galley knows: what it published last or,
   * before the first publish, the branch as last fetched or pushed. A force-push leases against it.
   */
  private async onGitHub(ctx: Ctx): Promise<string | null> {
    const { repo, pull, git } = ctx;
    return pull.published_head_sha ?? (await git.resolve(`refs/remotes/${repo.remote}/${pull.head_ref}`));
  }

  /**
   * The branch on GitHub as last fetched (its remote-tracking branch), when it moved on from
   * `published`, what galley pushed last, and the head has it in it: a push goes `onTop` of it,
   * with its commits as they are, overwriting nothing. When it no longer has all galley knew the
   * branch to have (goneFrom), it was rewritten on GitHub (a rebase or a force-push there), but
   * only as galley fetched it since it last pushed (fetchedRewritten): `rewritten` says from what
   * to what, and `removed` are the commits the rewrite removed, which a push must not bring back:
   * those of what galley knew the branch to have, and the staged ones it pushed signed copies of,
   * that the fetched branch does not have.
   */
  private async fetchedBranch(ctx: Ctx, pull: PullRow, published: string | null): Promise<{ onTop: string | null; rewritten?: { from: string; to: string; gone: string[]; removed: Set<string> } }> {
    const { repo, git } = ctx;
    const fetched = published ? await git.resolve(`refs/remotes/${repo.remote}/${pull.head_ref}`) : null;
    if (!published || !fetched || !(await git.isAncestor(fetched, pull.head_sha))) return { onTop: null };
    // Even back at what galley pushed, the branch may have lost a tip galley fetched since (reset there after a rewrite).
    const gone = await this.goneFrom(ctx, pull, published, fetched);
    // Commits added there (a suggestion committed, "Update branch"), or none.
    if (!gone.length) return { onTop: fetched === published ? null : fetched };
    // Otherwise it may only be behind what galley pushed: a remote-tracking branch git push does
    // not move (a single-branch clone), or one fetched before galley pushed.
    if (!this.fetchedRewritten(pull, fetched)) return { onTop: null };
    const tips = gone.includes(published) ? [...gone, pull.published_source_sha ?? published] : gone;
    const removed = (await git.out(['rev-list', ...tips, '--not', fetched])).split('\n').filter(Boolean);
    return { onTop: fetched, rewritten: { from: published, to: fetched, gone, removed: new Set(removed) } };
  }

  /** Of the commits a rewrite on GitHub removed (fetchedBranch), those `tips` have, which a push of them would bring back; newest first. */
  private async removedIn(ctx: Ctx, tips: string[], rewritten: { to: string; removed: Set<string> }): Promise<string[]> {
    return (await ctx.git.out(['rev-list', ...tips, '--not', rewritten.to])).split('\n').filter((sha) => rewritten.removed.has(sha));
  }

  /**
   * What publishing the head now would bring back of the commits a rewrite on GitHub removed, as
   * preparePush finds them, for the publish box to say before the click and to ask the user to
   * confirm. Signed or not: signing pushes the head's copies, reusing those made before
   * (signedVersions), so the commits under those count too, and the list covers both.
   */
  async bringsBack(ctx: Ctx): Promise<BringsBack | null> {
    const { repo, pull } = ctx;
    const { onTop, rewritten } = await this.fetchedBranch(ctx, pull, await this.onGitHub(ctx));
    if (!rewritten) return null;
    const { shas, versions } = await this.signedVersions(ctx, pull, async () => null, onTop);
    const copies = shas.flatMap((sha) => {
      const copy = versions.get(sha);
      return copy && copy !== sha ? [copy] : [];
    });
    const commits = await this.removedIn(ctx, [pull.head_sha, ...copies], rewritten);
    if (!commits.length) return null;
    // Back at what galley pushed (reset there after a rewrite), it is the tip galley fetched since that it no longer has.
    const from = rewritten.from !== rewritten.to ? rewritten.from : rewritten.gone.at(-1)!;
    return { from, to: rewritten.to, ref: `${repo.remote}/${pull.head_ref}`, commits };
  }

  /** The tips galley fetched of the branch on GitHub after refused pushes since it last pushed there (fetchHead), oldest first. */
  private fetchedTips(pull: PullRow): { sha: string; rewritten: boolean }[] {
    return eventsSince(this.db, pull, 'github_push', pull.published_at ?? '').flatMap(({ data: { fetched } }) => (fetched && 'sha' in fetched ? [{ sha: fetched.sha, rewritten: fetched.rewritten }] : []));
  }

  /** Whether galley fetched the branch on GitHub at `sha` since it last pushed there, and found it rewritten (fetchHead). */
  private fetchedRewritten(pull: PullRow, sha: string): boolean {
    return this.fetchedTips(pull).some((f) => f.sha === sha && f.rewritten);
  }

  /**
   * What galley knew the branch on GitHub to have since it last pushed there, and the branch at
   * `sha` no longer has: `published`, what it pushed last, and the tips it fetched since. Each a
   * rewrite on GitHub took out, the latest (`sha`) or one before it that galley could not push on
   * top of in time.
   */
  private async goneFrom(ctx: Ctx, pull: PullRow, published: string, sha: string): Promise<string[]> {
    const { git } = ctx;
    const gone: string[] = [];
    for (const tip of new Set([published, ...this.fetchedTips(pull).map((f) => f.sha)])) {
      if (tip !== sha && (await git.exists(tip)) && !(await git.isAncestor(tip, sha))) gone.push(tip);
    }
    return gone;
  }

  /**
   * Where the author's own commits start, for it to rebase them onto the branch as rewritten on
   * GitHub, fetched at `fetched` (GithubPush.fetched.since): the latest other tip galley fetched
   * since it last pushed that the head has in it (the author rebased onto it, and the branch was
   * rewritten again before galley could push), or else the staged head galley pushed last.
   */
  private async rebaseFrom(ctx: Ctx, pull: PullRow, fetched: string): Promise<string> {
    const { git } = ctx;
    for (const { sha } of this.fetchedTips(pull).reverse()) {
      if (sha !== fetched && (await git.exists(sha)) && (await git.isAncestor(sha, pull.head_sha))) return sha;
    }
    return pull.published_source_sha ?? pull.published_head_sha!;
  }

  /** Who signed commits are committed by: the user's git identity. */
  async signer(ctx: Ctx): Promise<{ name: string; email: string } | null> {
    const name = await ctx.git.config('user.name');
    const email = await ctx.git.config('user.email');
    return name && email ? { name, email } : null;
  }

  /** The commits of the pull request that carry no signature. */
  async unsignedCommits(ctx: Ctx, commits?: Commit[]): Promise<string[]> {
    const out: string[] = [];
    for (const c of commits ?? (await this.commits(ctx))) if (!(await ctx.git.rawCommit(c.sha)).signed) out.push(c.sha);
    return out;
  }

  /**
   * Make a signed copy of every commit in the pull request, with the user as committer
   * (GitHub only verifies a signature whose key belongs to the committer). Trees, messages
   * and authors stay as the agent made them. `keep` and the commits under it stay as they are
   * (signedVersions).
   */
  async signCommits(ctx: Ctx, pull: PullRow, timeoutMs?: number, keep?: string | null): Promise<{ head: string; signed: number }> {
    const { repo, git } = ctx;
    const signer = await this.signer(ctx);
    if (!signer) throw new SigningError('set user.name and user.email in git to sign commits', null, 422);
    let signed = 0;
    // Copies made again in place of others (signedVersions), whose rows go back when signing fails:
    // the published ref may point at one, and stays galley's to move only while its row is there (preparePush).
    const replaced: { sha: string; before: string; copy: string }[] = [];
    const signing = this.signedVersions(ctx, pull, async (sha, c, parents) => {
      const r = await git.run(['commit-tree', '-S', c.tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'], {
        input: c.message,
        env: {
          GIT_AUTHOR_NAME: c.author.name,
          GIT_AUTHOR_EMAIL: c.author.email,
          GIT_AUTHOR_DATE: c.author.date,
          GIT_COMMITTER_NAME: signer.name,
          GIT_COMMITTER_EMAIL: signer.email,
        },
        allowFail: true,
        timeoutMs,
      });
      if (r.code !== 0) throw new SigningError(`signing commit ${sha.slice(0, 7)} failed:\n${failure(r, 'a passphrase or a 1Password prompt nobody answered?')}`, signingCause(r));
      const copy = r.stdout.trim();
      const before = this.db.get<{ signed_sha: string }>('SELECT signed_sha FROM signed_commits WHERE repo_id = ? AND source_sha = ?', repo.id, sha)?.signed_sha;
      if (before && before !== copy) replaced.push({ sha, before, copy });
      this.db.run(
        'INSERT INTO signed_commits (repo_id, source_sha, signed_sha) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET signed_sha = excluded.signed_sha',
        repo.id,
        sha,
        copy,
      );
      signed++;
      return copy;
    }, keep);
    let versions: Map<string, string | null>;
    try {
      ({ versions } = await signing);
    } catch (e) {
      for (const { sha, before, copy } of replaced) {
        this.db.run('UPDATE signed_commits SET signed_sha = ? WHERE repo_id = ? AND source_sha = ? AND signed_sha = ?', before, repo.id, sha, copy);
      }
      throw e;
    }
    return { head: versions.get(pull.head_sha) ?? pull.head_sha, signed };
  }

  /**
   * What a signed publish pushes for each commit of the pull request: a copy made before, the
   * commit itself when it is signed and its parents stay, or a new copy from `copy`; `keep` and
   * the commits under it (on GitHub already) as they are. Copies are
   * remembered per source commit, so publishing again after the agent added commits reuses them
   * and GitHub sees a fast-forward. Not a copy of a commit that has `keep` in it, made when the
   * commits under `keep` were copied too: its push would not add to `keep`. To predict without
   * signing, `copy` returns null: a copy still to be made (and so is every copy on top of it).
   */
  private async signedVersions(
    ctx: Ctx,
    pull: PullRow,
    copy: (sha: string, c: RawCommit, parents: string[]) => Promise<string | null>,
    keep?: string | null,
  ): Promise<{ shas: string[]; versions: Map<string, string | null> }> {
    const { repo, git } = ctx;
    const versions = new Map<string, string | null>(
      this.db.all<{ source_sha: string; signed_sha: string }>('SELECT source_sha, signed_sha FROM signed_commits WHERE repo_id = ?', repo.id).map((r) => [r.source_sha, r.signed_sha]),
    );
    const shas = (await git.out(['rev-list', '--reverse', '--topo-order', `${pull.base_sha}..${pull.head_sha}`])).split('\n').filter(Boolean);
    // Commits GitHub has that the head was built on (`keep` and those under it): pushed as they are,
    // signed or not, so the push adds to them (preparePush).
    const kept = new Set(keep ? (await git.out(['rev-list', `${pull.base_sha}..${keep}`])).split('\n').filter(Boolean) : []);
    for (const sha of shas) {
      if (kept.has(sha)) {
        versions.set(sha, sha);
        continue;
      }
      const known = versions.get(sha);
      // Made again when it has a copy of `keep` in place of `keep`: the head brought in a branch
      // rewritten on GitHub before galley fetched it, and signing copied that branch's commits too.
      if (known && (await git.exists(known)) && !(keep && (await git.isAncestor(keep, sha)) && !(await git.isAncestor(keep, known)))) continue;
      const c = await git.rawCommit(sha);
      const parents = c.parents.map((p) => (versions.has(p) ? (versions.get(p) as string | null) : p));
      if (c.signed && parents.every((p, i) => p === c.parents[i])) versions.set(sha, sha);
      else versions.set(sha, parents.includes(null) ? null : await copy(sha, c, parents as string[]));
    }
    return { shas, versions };
  }

  /**
   * Get the head ready to push to the pull request's own branch on GitHub, and to nothing else:
   * publishing and pushUpdate both push this way, preparePush and then pushPrepared. Signed copies
   * when `sign`. A head built on the branch as last fetched goes on top of it (fetchedBranch), which
   * is then the commit the branch has on GitHub; otherwise that is what galley pushed last
   * (onGitHub). A push that would replace the commit the branch has on GitHub is
   * forced only when `force` allows it, and never plainly: with a lease on that commit, so commits
   * added there since are not overwritten. With `lease`, every push leases on it, so a branch that
   * moved on GitHub in any way, or that GitHub deleted after a merge, is refused rather than
   * overwritten or brought back. `auto` says in the refusal to force-push that auto-publish's
   * options did not allow it. `bringBack`: the commits a rewrite on GitHub removed that the user
   * confirmed bringing back (publish).
   */
  private async preparePush(ctx: Ctx, pull: PullRow, opts: { sign: boolean; force: boolean; lease?: boolean; auto?: boolean; timeoutMs?: number; bringBack?: string[] }): Promise<PushPlan> {
    const { repo, git } = ctx;
    const published = await this.onGitHub(ctx);
    // The branch on GitHub as last fetched, when it moved on from what galley pushed and the head
    // has it in it (the author rebased onto it): the push goes on top of it, with its commits as
    // they are, overwriting nothing. Rewritten there, a head that still has commits the rewrite
    // removed (the author merged the branch in rather than rebasing onto it) is refused: the push
    // would bring them back. So is one whose signed copies would: signing reuses a copy made
    // before, also one made on top of a removed commit for a push GitHub then refused. Unless the
    // user confirmed bringing back each of them (bringsBack lists them for the publish box).
    const { onTop, rewritten } = await this.fetchedBranch(ctx, pull, published);
    const broughtBack = new Set<string>();
    const bringsBack = async (commit: string, what: string) => {
      if (!rewritten) return;
      const back = await this.removedIn(ctx, [commit], rewritten);
      if (!back.length) return;
      if (back.every((sha) => opts.bringBack?.includes(sha))) {
        for (const sha of back) broughtBack.add(sha);
        return;
      }
      const ref = `${repo.remote}/${pull.head_ref}`;
      const shas = back.slice(0, 5).map((sha) => sha.slice(0, 7)).join(', ') + (back.length > 5 ? ', …' : '');
      throw new HttpError(
        409,
        `The branch on GitHub was rewritten there (galley fetched it into ${ref} at ${rewritten.to.slice(0, 7)}), and ${what} ${back.length === 1 ? 'a commit' : `${back.length} commits`} the rewrite removed, which pushing it would bring back: ${shas}.`,
        // For the author, what to rebase onto (pushNow). Extension: what it would bring back.
        { fetched: { ref, sha: rewritten.to, rewritten: true, since: await this.rebaseFrom(ctx, pull, rewritten.to) }, bring_back: back },
      );
    };
    await bringsBack(pull.head_sha, 'this head has');
    let pushed = pull.head_sha;
    let signed = 0;
    if (opts.sign) {
      // The signed copies exist only here and on GitHub; keep them from being garbage collected.
      const ref = this.ref(pull, 'published');
      const at = await git.resolve(ref);
      // It holds the copies an earlier publish pushed, if any: commits this server signed. Asked
      // before signing, which can make a copy again in place of the one it points at (signedVersions).
      const ours = !at || !!this.db.get('SELECT 1 FROM signed_commits WHERE repo_id = ? AND signed_sha = ?', repo.id, at);
      ({ head: pushed, signed } = await this.signCommits(ctx, pull, opts.timeoutMs, onTop));
      if (pushed !== pull.head_sha) {
        if (ours) await this.moveRef(git, ref, at, pushed);
        else console.error(`left ${ref} alone in ${git.gitDir}: it points at ${at}, which galley did not sign`);
      }
    }

    if (pushed !== pull.head_sha) await bringsBack(pushed, 'its signed copies have');

    // Force is decided on the commit actually pushed, signed copies and all, and used only when allowed.
    const before = onTop && (await git.isAncestor(onTop, pushed)) ? onTop : published;
    const force = !!before && !(await git.isAncestor(before, pushed));
    if (force && !opts.force) {
      throw new HttpError(
        409,
        `The branch on GitHub has commits this push would replace (a rewritten history, or the agent's unsigned commits that signing replaces with copies), and ${opts.auto ? 'force-pushing was not chosen when auto-publish was turned on' : 'force-pushing was not chosen'}.`,
      );
    }
    const branch = `refs/heads/${pull.head_ref}`;
    // The user's repository pushes to its remote as the user does; galley's clone to GitHub, with gh's credentials.
    const clone = this.isClone(repo);
    const args = clone ? [...ghCredentials(this.ghBin), 'push'] : ['push'];
    // Overwrite only the commit seen on GitHub, never commits added there since. (Without one, a
    // lease asks that there be no branch.)
    if (force || opts.lease) args.push(`--force-with-lease=${branch}:${before ?? ''}`);
    args.push(clone ? this.githubUrl(repo.github_slug!) : repo.remote, `${pushed}:${branch}`);
    // Said when it replaced what galley pushed last: not when the branch is back at it.
    const over = rewritten && before === onTop && rewritten.to !== rewritten.from;
    return { pushed, signed, force, before, ...(over ? { rewritten: { from: rewritten.from, to: rewritten.to } } : {}), ...(broughtBack.size ? { broughtBack: [...broughtBack] } : {}), args };
  }

  /**
   * Push what preparePush got ready. `ready`, when given, is the last check, after every await
   * before the push (signing can wait minutes for a prompt): it throws to stop the push. Nothing is
   * pushed to a pull request merged on GitHub.
   */
  private async pushPrepared(ctx: Ctx, pull: PullRow, plan: PushPlan, opts: { timeoutMs?: number; ready?: () => Promise<void> }): Promise<void> {
    const { repo, git } = ctx;
    await opts.ready?.();
    // Merged on GitHub while this push signed or looked things up (following found it meanwhile):
    // pushing now would add to a merged pull request, or bring back a branch GitHub deleted.
    if (this.db.get<Pick<PullRow, 'github_state'>>('SELECT github_state FROM pulls WHERE id = ?', pull.id)?.github_state === 'merged') {
      throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
    }
    // No await may come between the checks above and this call, which starts the push at once.
    const push = await git.run(plan.args, { cwd: repo.work_dir ?? tmpdir(), env: this.isClone(repo) ? { ...UNPROMPTED, ...FETCH_ENV } : UNPROMPTED, allowFail: true, timeoutMs: opts.timeoutMs });
    if (push.code !== 0) {
      const stale = /stale info/.test(push.stderr);
      const declined = /\[remote rejected\]/.test(push.stderr);
      const rejected = stale || declined || /\[rejected\]|non-fast-forward|fetch first/.test(push.stderr);
      const why = stale
        ? ' (the branch on GitHub changed since it was last published, for example by "Commit suggestion" or "Update branch"; bring those commits into the branch first)'
        : declined
          ? ' (GitHub declined it, for example for a secret in it, or a rule on the branch)'
          : rejected
            ? ' (the remote branch has commits that are not in this pull request)'
            : '';
      throw new HttpError(rejected ? 409 : 502, `git push failed${why}:\n${failure(push)}`);
    }
  }

  /**
   * Push the head and open (or update) the pull request on GitHub: the user's to do, or the author
   * agent's when the user asked it to. `approval` is auto-publish doing it, under that approval
   * (pulls.auto_publish as the attempt read it): the attempt only goes ahead while that exact
   * approval is in force. Then, or for an agent, nobody may be there to answer a prompt, so each
   * step gets UNATTENDED_TIMEOUT_MS. `autoMerge` turns on auto-merge on GitHub afterwards,
   * with that merge method: auto-publish's, fixed when it was turned on, or the one in settings
   * when the request came in. Publishing while a reviewer agent is at work, or a head that conflicts
   * with its base, needs `duringReview` or `duringConflict`. A head that brings back commits a
   * rewrite on GitHub removed needs each of them in `bringBack`, which only the user may give, from
   * the publish box (`page`): never an agent, not even one that claims to be the user, nor auto-publish.
   */
  async publish(
    ctx: Ctx,
    opts: { draft?: boolean; force?: boolean; expected?: string; sign?: boolean; duringReview?: boolean; duringConflict?: boolean; approval?: string; autoMerge?: MergeMethod; bringBack?: string[]; page?: boolean },
    actor: Actor,
  ): Promise<PullRow> {
    const release = await this.pushLock(ctx.pull.id);
    try {
      return await this.publishNow(ctx, opts, actor);
    } finally {
      release();
    }
  }

  private async publishNow(
    ctx: Ctx,
    opts: { draft?: boolean; force?: boolean; expected?: string; sign?: boolean; duringReview?: boolean; duringConflict?: boolean; approval?: string; autoMerge?: MergeMethod; bringBack?: string[]; page?: boolean },
    actor: Actor,
  ): Promise<PullRow> {
    const { repo } = ctx;
    this.requireUserOrAuthor(actor, ctx.pull, 'publish it');
    // Refused before any work: bringing back what a rewrite on GitHub removed is the user's call,
    // made at the publish box. A CLI caller can claim to be the user (GALLEY_ACTOR), so the API
    // says whether the request came from the page, as far as its headers tell.
    if (opts.bringBack?.length) {
      if (opts.approval !== undefined) throw new HttpError(403, 'auto-publish never brings back commits a rewrite on GitHub removed');
      if (!opts.page) throw new HttpError(403, "only the user can bring back commits a rewrite on GitHub removed, from the publish box on the pull request's page");
    }
    // The base as it is on the remote now, for the checks for conflicts below and auto-publish's.
    await this.fetchBases(repo, { base: ctx.pull.base_ref });
    await this.sync(ctx.pull);
    // What it publishes, with the edits its title and description include (authorEdits).
    const { pull, upto } = this.snapshot(ctx.pull.id);
    const auto = opts.approval !== undefined;
    // Turned off or replaced, or new feedback, since auto-publish decided to go ahead.
    if (auto && !this.stillApproved(pull, opts.approval!)) throw new HttpError(412, 'auto-publish was turned off or replaced, or the agents are no longer done');
    if (opts.expected && opts.expected !== publishFingerprint(pull)) {
      throw new HttpError(412, 'The pull request changed after this page was loaded (new commits, title, description or base). Refresh and review the latest version before publishing.');
    }
    if (pull.state === 'closed') throw new HttpError(422, 'reopen the pull request before publishing it');
    if (pull.github_state === 'merged') throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
    if (!repo.github_slug) throw new HttpError(422, `remote "${repo.remote}" is not a GitHub repository`);
    // Decided here, not by the page: a page loaded before the review started, or before the base
    // moved, does not know of it. The 428 lists what the body must acknowledge (an extension).
    // Auto-publish publishes only a head known to merge cleanly into the base as it is now (stillApproved).
    const conflicts = auto || opts.duringConflict ? null : await this.conflictsNow(pull);
    const asks = this.publishAsks(pull, conflicts).filter((a) => !(a.field === 'during_review' && opts.duringReview));
    if (asks.length) throw new HttpError(428, asks.map((a) => a.text).join(' '), { acknowledge: asks.map((a) => a.field) });
    // Refused before anything is pushed, rather than published without the auto-merge asked for.
    const mergeMethod = opts.autoMerge ? await this.autoMergeMethod(repo, opts.autoMerge) : null;
    const cwd = repo.work_dir ?? tmpdir();
    // An agent publishing is unattended too: a signing prompt nobody answers fails, as one
    // auto-publish tries again (SigningError.transient), rather than holding the agent up.
    const timeoutMs = auto || actor.type === 'Bot' ? UNATTENDED_TIMEOUT_MS : undefined;
    const sign = opts.sign ?? (await this.signsByDefault(ctx));
    // Every await before the push (signing can wait minutes for a prompt) lets a cancel, a replaced
    // approval, new feedback or a starting review come in. So auto-publish's last check comes after
    // all of them: the approval is the same, the agents are still done, the pull request is unchanged.
    const ready = auto
      ? async () => {
          const latest = await this.sync(pull);
          if (publishFingerprint(latest) !== publishFingerprint(pull) || !this.stillApproved(latest, opts.approval!)) {
            throw new HttpError(412, 'the pull request or auto-publish changed before the push');
          }
        }
      : undefined;
    const plan = await this.preparePush(ctx, pull, { sign, force: !!opts.force, auto, timeoutMs, bringBack: opts.bringBack });
    await this.pushPrepared(ctx, pull, plan, { timeoutMs, ready });
    const { pushed, signed, force, rewritten, broughtBack } = plan;

    let url = pull.published_url;
    // An earlier publish, or a pull request someone opened on GitHub for the same branch, gets updated in place.
    let update = url !== null;
    if (!url) {
      const args = ['pr', 'create', '--repo', repo.github_slug, '--base', pull.base_ref, '--head', pull.head_ref, '--title', pull.title, '--body-file', '-'];
      if (opts.draft ?? pull.draft) args.push('--draft');
      const r = await run(this.ghBin, args, { cwd, env: UNPROMPTED, input: pull.body, allowFail: true, timeoutMs });
      const existing = r.stderr.match(/already exists:?\s*(https:\/\/\S+)/);
      if (r.code === 0) url = r.stdout.trim().split('\n').pop()!.trim();
      else if (existing) {
        url = existing[1];
        update = true;
      } else throw new HttpError(502, `gh pr create failed:\n${failure(r)}`);
    }
    if (update) {
      const r = await run(this.ghBin, ['pr', 'edit', url, '--title', pull.title, '--body-file', '-', '--base', pull.base_ref], { cwd, env: UNPROMPTED, input: pull.body, allowFail: true, timeoutMs });
      if (r.code !== 0) throw new HttpError(502, `gh pr edit failed:\n${failure(r)}`);
    }

    const ts = now();
    const first = !pull.published_url;
    this.db.transaction(() => {
      this.db.update('pulls', pull.id, {
        state: 'published',
        published_url: url,
        published_at: ts,
        published_head_sha: pushed,
        published_source_sha: pull.head_sha,
        published_title: pull.title,
        published_body: pull.body,
        updated_at: ts,
        // Auto-publish approves the first publish, whoever publishes: later commits are pushed when the author waits (pushUpdate).
        auto_publish: null,
        // Closed on GitHub and published again: follow it again, in case it was reopened there.
        ...(pull.github_state === 'closed' ? { github_state: null } : {}),
      });
      // `sign`, whether it signed: what the pushes after it do (signsUpdates).
      this.addEvent(pull, actor, 'published', { url, head: pushed, source: pull.head_sha, signed, sign, first, force, auto, ...(rewritten ? { rewritten } : {}), ...(broughtBack ? { brought_back: broughtBack } : {}), read_upto: upto }, ts);
    });
    // Published during a review (a second click): its findings would come too late.
    this.cancelReviews(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!, 'published');
    // Auto-publish's publish is galley's doing: an author that turned it on hears of it in its wait.
    if (auto) this.emitSystem(pull.id, 'auto_published', 'galley');
    else this.emit(pull.id, 'published', actor);
    if (mergeMethod) await this.enableAutoMerge(ctx, url!, pushed, mergeMethod, actor, timeoutMs);
    return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
  }

  /**
   * What publishing the pull request now asks the user to acknowledge, with a second click on the
   * page: a reviewer agent at work, whose review may ask for changes and which publishing cancels,
   * and a head GitHub does not have that conflicts with its base (one GitHub has conflicts there
   * whether it is published again or not). `conflicts`: what was found for the base as it was last
   * seen, unless given; publishing works it out for the base as it is now first (conflictsNow).
   */
  publishAsks(pull: PullRow, conflicts = this.currentConflicts(pull)): PublishAsk[] {
    const asks: PublishAsk[] = [];
    const busy = this.reviewersAtWork(pull);
    if (busy.length) {
      const what = (sha: string) => (sha === pull.head_sha ? 'this commit' : `an earlier commit (${sha.slice(0, 7)})`);
      const doing = busy.map(({ reviewer, work }) => `${reviewer.actor().login} is ${work.status === 'QUEUED' ? 'about to review' : 'still reviewing'} ${what(work.head_sha)}`);
      asks.push({ field: 'during_review', text: `${doing.join(', and ')}, and ${busy.length > 1 ? 'their reviews' : 'its review'} may ask for changes. Publishing now cancels ${busy.length > 1 ? 'them' : 'it'}.` });
    }
    if (conflicts?.clean === false && this.headUnpublished(pull)) {
      const where = conflicts.files.length ? ` in ${conflicts.files.join(', ')}` : '';
      asks.push({ field: 'during_conflict', text: `This branch conflicts with ${conflicts.ref}${where}: GitHub can not merge it until the conflicts are resolved.` });
    }
    return asks;
  }

  /**
   * Turn on auto-merge for the pull request just published: GitHub merges it with `method`
   * once its requirements (such as required checks) are met. `--match-head-commit` makes GitHub
   * refuse when the branch there is no longer the commit galley pushed, but it does not pin the
   * merge to that commit: a later push by someone without write access turns auto-merge off,
   * and one by someone with write access is merged too. The pull request is published whatever
   * happens here, so a failure is recorded on it rather than thrown.
   */
  private async enableAutoMerge(ctx: Ctx, url: string, head: string, method: MergeMethod, actor: Actor, timeoutMs?: number): Promise<void> {
    const { repo, pull } = ctx;
    const opts = { cwd: repo.work_dir ?? tmpdir(), env: UNPROMPTED, allowFail: true, timeoutMs };
    const merge = () => run(this.ghBin, ['pr', 'merge', url, '--auto', `--${method}`, '--match-head-commit', head], opts);
    // Unknown until GitHub says.
    let merged: boolean | null = null;
    let view: GithubPull | null = null;
    let error: string | null = null;
    try {
      let r = await merge();
      // gh merges at once when GitHub has nothing left to wait for, and asks for auto-merge
      // otherwise. Right after `gh pr create` GitHub may not have worked that out yet: gh asks for
      // auto-merge, and GitHub refuses it for a pull request in "clean status". Asked again, gh
      // sees the clean status itself and merges, as it would have in the first place.
      if (r.code !== 0 && /clean status/.test(r.stderr)) r = await merge();
      if (r.code !== 0) throw new Error(failure(r));
      // Without a terminal gh says nothing either way, so ask GitHub which it was. gh accepted
      // the request, so a lookup that fails in any way leaves it unknown, not failed.
      try {
        const r = await run(this.ghBin, ['pr', 'view', url, '--json', 'state,mergedAt,mergedBy,mergeCommit'], opts);
        if (r.code === 0) {
          view = JSON.parse(r.stdout) as GithubPull;
          merged = view.state === 'MERGED';
        }
      } catch {}
    } catch (e) {
      error = (e as Error).message.slice(0, 4000);
    }
    const type = error === null ? 'auto_merge_enabled' : 'auto_merge_failed';
    this.addEvent(pull, actor, type, error === null ? { url, method, merged } : { url, method, error });
    this.emit(pull.id, type, actor);
    // Merged at once: record it as following would, before anything else can be published over it
    // (the merge guard before a push, the pull request freezing).
    if (merged && view) this.recordGithubEnd(pull.id, view);
  }

  // ------------------------------------------------------ pushing after publishing

  /**
   * Whether to push the published pull request's head now (pushUpdate): it may be pushed
   * (mayPush), and has not been tried yet while the author waits this time. A push that failed for
   * want of GitHub is tried again when the author next waits, at least as often as `pr wait` asks
   * again; one whose signing failed for now when its retry is due (signingFailure), whether the
   * author waits or not. One GitHub refused is not tried again for the same commit, nor one whose
   * signing failed otherwise or too often: the reviewer decides, and the author's next commit is
   * pushed when it waits.
   */
  pushReady(pull: PullRow): boolean {
    return this.mayPush(pull) && this.pushTries.get(pull.id) !== this.pushTry(pull);
  }

  /**
   * Whether to publish the author's edits of the published pull request's title and description
   * now (publishEdits): it has some to try (editsToTry), and it waits with all feedback seen, as
   * for a push (mayPush).
   */
  editsReady(pull: PullRow): boolean {
    if (!this.authorWaiting(pull.id) || !this.editsToTry(pull).length) return false;
    const fb = unseenFeedback(this.db, pull);
    return !fb.reviews.length && !fb.comments.length;
  }

  /**
   * The author's edits its wait publishes: those publishing has not left as they are (editsLeft),
   * and those a failure that is tried again left, once per wait, at least as often as `pr wait`
   * asks again.
   */
  private editsToTry(pull: PullRow): EditField[] {
    const edits = this.authorEdits(pull);
    const left = this.editsLeft(pull, edits);
    const again = this.editTries.get(pull.id) !== this.editTry(pull);
    return edits.filter((f) => !left.has(f) || (left.get(f)!.retry && left.get(f)!.failed.includes(f) && again));
  }

  /** The text and the wait each publishing of edits was last tried for (editsToTry). */
  private editTries = new Map<number, string>();
  private editTry(pull: PullRow): string {
    return `${pull.title}\0${pull.body}\0${this.waitsStarted.get(pull.id) ?? 0}`;
  }

  /** The latest try to publish the author's edits of the title and description (publishEdits), or the latest after `since`. */
  lastEdit(pull: PullRow, since = ''): GithubEdit | null {
    const e = lastEvent(this.db, pull, 'github_edit', since);
    return e ? { ...e.data, at: e.created_at } : null;
  }

  /**
   * Pushes to each pull request's branch under way, publishing's and pushUpdate's, one after the
   * other: neither finds the branch moved under it by the other, nor takes the other's push for
   * someone else's. Resolves when those before it are done, with the function that ends this one.
   */
  private pushLocks = new Map<number, Promise<void>>();
  private async pushLock(pullId: number): Promise<() => void> {
    const before = this.pushLocks.get(pullId);
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const mine = (before ?? Promise.resolve()).then(() => done);
    this.pushLocks.set(pullId, mine);
    await before;
    return () => {
      release();
      if (this.pushLocks.get(pullId) === mine) this.pushLocks.delete(pullId);
    };
  }

  /** The head and the wait each push was last tried for, or the retry of its signing (pushReady). */
  private pushTries = new Map<number, string>();
  private pushTry(pull: PullRow): string {
    const signing = this.pushFailed(pull)?.signing;
    return signing?.next_at ? `${pull.head_sha} signing ${signing.failures}` : `${pull.head_sha} ${this.waitsStarted.get(pull.id) ?? 0}`;
  }

  /**
   * Whether the published pull request's head may be pushed: GitHub does not have it, the pull
   * request is open there as far as galley knows, the author waits with all feedback seen, and
   * GitHub has not refused this head before. After signing it failed for now, the retry must be
   * due, and the author need not wait: it waited with this head when it failed, and agents often
   * stop waiting once their work is done. Not once it was handed feedback since, until it waits again.
   */
  private mayPush(pull: PullRow): boolean {
    if (stagingState(pull) !== 'published' || !this.headUnpublished(pull)) return false;
    const failed = this.pushFailed(pull);
    if (failed && !failed.retry) return false;
    const again = failed?.signing?.next_at;
    const waiting = this.authorWaiting(pull.id);
    if (again ? Date.parse(again) > Date.now() || !(waiting || this.waitedSinceHanded(pull)) : !waiting) return false;
    const fb = unseenFeedback(this.db, pull);
    return !fb.reviews.length && !fb.comments.length;
  }

  /**
   * How many times in a row signing the head failed for now when pushing it, since GitHub last got
   * a commit of the pull request (signingFailure).
   */
  private signingFailures(pull: PullRow): number {
    const pushes = eventsSince(this.db, pull, 'github_push', pull.published_at ?? '');
    return Math.max(0, ...pushes.map((e) => (e.data.source === pull.head_sha && e.data.signing?.why && !e.data.signing.final ? e.data.signing.failures : 0)));
  }

  /** The latest push of the pull request made when its author waited (pushUpdate), or the latest after `since`. */
  lastPush(pull: PullRow, since = ''): GithubPush | null {
    const e = lastEvent(this.db, pull, 'github_push', since);
    return e ? { ...e.data, at: e.created_at } : null;
  }

  /** The push of the head that failed, when the latest try to push it failed. */
  pushFailed(pull: PullRow): GithubPush | null {
    const push = this.lastPush(pull);
    return push?.result === 'failed' && push.source === pull.head_sha ? push : null;
  }

  /**
   * Whether pushes after publishing sign: as the last publish did. One published before galley
   * recorded that signed if GitHub got signed copies of the commits, or the commit it has is signed.
   */
  private async signsUpdates(ctx: Ctx): Promise<boolean> {
    const { pull, git } = ctx;
    const sign = lastEvent(this.db, pull, 'published')?.data.sign;
    if (typeof sign === 'boolean') return sign;
    if (!pull.published_head_sha) return false;
    if (pull.published_head_sha !== pull.published_source_sha) return true;
    return (await git.rawCommit(pull.published_head_sha).catch(() => null))?.signed === true;
  }

  /**
   * Push the head the author waits with to the published pull request when pushReady says so,
   * unattended (each step gets UNATTENDED_TIMEOUT_MS). Only its head branch, as publishing pushes
   * (preparePush): signed as the last publish was (signsUpdates), and with a lease on the commit
   * galley pushed last, so a branch that moved on GitHub is refused, not overwritten, also when
   * the push is forced, until the head has the commits added there. GitHub is asked right before
   * the push whether the pull request is still open there: nothing is pushed once it is merged or
   * closed, nor without an answer. The author's edits of the title and description go first, when
   * editsReady says so (publishEdits); the user's are left to publishing by hand.
   * Auto-merge, when galley turned it on and GitHub has not said it is off since, is asked for
   * again. The timeline says what came of it. The author's wait hears of a push, and of one that
   * is not tried again (GitHub refused it, or signing failed for good); one that failed otherwise
   * is tried again when the author next waits, or when the retry of its signing is due (pushReady).
   */
  async pushUpdate(ctx: Ctx): Promise<void> {
    // After a publish by hand under way, which may push the head itself.
    const release = await this.pushLock(ctx.pull.id);
    this.updating.add(ctx.pull.id);
    let done = false;
    try {
      done = await this.publishEdits(ctx);
      done = (await this.pushNow(ctx)) || done;
    } finally {
      this.updating.delete(ctx.pull.id);
      release();
      // The author's wait held what came of it until all of it was done (waitResult): it may tell it now.
      if (done) this.emit(ctx.pull.id, 'github_updated', this.viewer());
    }
  }

  /**
   * The pull request as it is now, with its latest event, read together: the edits its title and
   * description include are the events up to it (authorEdits).
   */
  private snapshot(id: number): { pull: PullRow; upto: number } {
    const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
    return { pull, upto: this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events WHERE pull_id = ?', id)!.id ?? 0 };
  }

  /** The pull requests whose update pushUpdate is publishing: their author's wait tells what came of it once all of it is done (waitResult). */
  private updating = new Set<number>();

  /**
   * Publish the author's edits of the title and description that editsReady says to (editsToTry)
   * to the published pull request, as publishing sets them (`gh pr edit`), unattended. GitHub is
   * asked first, as before a push: nothing is published once the pull request is merged or closed
   * there, nor without an answer. A field someone edited on GitHub since galley last published it
   * is left alone, for the reviewer to publish over or not. The timeline says what came of it, and
   * the author's wait hears of it, but not of a failure that is tried again: GitHub could not be
   * reached or asked, tried again when the author next waits. One left otherwise, or refused, is
   * not tried again with the same text (editsLeft). Returns whether it recorded anything.
   */
  private async publishEdits(ctx: Ctx): Promise<boolean> {
    const { pull, upto: start } = this.snapshot(ctx.pull.id);
    if (!this.editsReady(pull)) return false;
    const fields = this.editsToTry(pull);
    this.editTries.set(pull.id, this.editTry(pull));
    const url = pull.published_url!;
    const viewer = this.viewer();
    const record = (data: Omit<GithubEdit, 'at' | 'url' | 'title' | 'body'>, published: Partial<Pick<PullRow, 'published_title' | 'published_body'>> = {}) => {
      // The same failure again, tried again: the timeline has it already.
      const last = this.lastEdit(pull);
      if (data.retry && last?.retry && last.error === data.error && last.title === pull.title && last.body === pull.body) return false;
      this.db.transaction(() => {
        if (Object.keys(published).length) this.db.update('pulls', pull.id, published);
        this.addEvent(pull, viewer, 'github_edit', { url, ...data, title: pull.title, body: pull.body });
      });
      this.emit(pull.id, data.failed.length || data.edited_on_github.length ? 'github_edit_failed' : 'github_edited', viewer);
      return true;
    };
    let github: (GithubPull & { title?: string; body?: string }) | null;
    try {
      github = await this.viewOnGithub(ctx, url, ['title', 'body']);
    } catch (e) {
      return record({ read_upto: this.snapshot(pull.id).upto, published: [], edited_on_github: [], failed: fields, error: (e as Error).message.slice(0, 4000), retry: true });
    }
    // Merged or closed on GitHub, which the author hears of; or changed here meanwhile (an edit, by
    // anyone, even one back to the same text; new feedback; the author no longer waiting), which
    // brings another try, with whose edits they are worked out again.
    // What it publishes is the text as it is now, with the edits it includes: one after them, while gh runs too, is one since.
    const { pull: latest, upto } = this.snapshot(pull.id);
    const edited = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE pull_id = ? AND type IN ('renamed', 'body_edited') AND id > ?", pull.id, start)!.n > 0;
    const fb = unseenFeedback(this.db, latest);
    if (!github || edited || !this.authorWaiting(pull.id) || fb.reviews.length || fb.comments.length) {
      this.editTries.delete(pull.id);
      return false;
    }
    // As GitHub has it: someone edited it there since galley published it. Whitespace in a body can
    // matter (an indented line is code), but not a browser's line ends, nor a title's ends.
    const lines = (text: string | null | undefined) => (text ?? '').replace(/\r\n/g, '\n');
    const onGithub = fields.filter((f) => (f === 'title' ? (github.title ?? '').trim() !== (pull.published_title ?? '').trim() : lines(github.body) !== lines(pull.published_body)));
    const send = fields.filter((f) => !onGithub.includes(f));
    if (!send.length) return record({ read_upto: upto, published: [], edited_on_github: onGithub, failed: [] });
    const args = ['pr', 'edit', url, ...(send.includes('title') ? ['--title', pull.title] : []), ...(send.includes('description') ? ['--body-file', '-'] : [])];
    let error: string | null = null;
    // GitHub out of reach, or busy, rather than refusing the edit: tried again.
    let retry = true;
    try {
      const r = await run(this.ghBin, args, { cwd: ctx.repo.work_dir ?? tmpdir(), env: UNPROMPTED, input: send.includes('description') ? pull.body : undefined, allowFail: true, timeoutMs: UNATTENDED_TIMEOUT_MS });
      if (r.code !== 0) {
        error = `gh pr edit failed:\n${failure(r)}`;
        retry = r.timedOut || /error connecting to|dial tcp|no such host|TLS handshake|connection (reset|refused)|i\/o timeout|context deadline exceeded|HTTP 5\d\d/i.test(r.stderr);
      }
    } catch (e) {
      error = `gh pr edit failed: ${(e as Error).message}`;
    }
    if (error !== null) return record({ read_upto: upto, published: [], edited_on_github: onGithub, failed: send, error: error.slice(0, 4000), ...(retry ? { retry } : {}) });
    return record({ read_upto: upto, published: send, edited_on_github: onGithub, failed: [] }, {
      ...(send.includes('title') ? { published_title: pull.title } : {}),
      ...(send.includes('description') ? { published_body: pull.body } : {}),
    });
  }

  /** pushUpdate's push; whether it recorded anything. */
  private async pushNow(ctx: Ctx): Promise<boolean> {
    const pull = await this.sync(ctx.pull);
    if (!this.pushReady(pull)) return false;
    this.pushTries.set(pull.id, this.pushTry(pull));
    const url = pull.published_url!;
    const viewer = this.viewer();
    const timeoutMs = UNATTENDED_TIMEOUT_MS;
    const sign = await this.signsUpdates(ctx);
    // After every await before the push: open on GitHub, and nothing changed here (a commit,
    // feedback, the author no longer waiting).
    const ready = async () => {
      if (!(await this.openOnGithub(ctx, url))) throw new HttpError(412, 'merged or closed on GitHub');
      const latest = await this.sync(pull);
      if (latest.head_sha !== pull.head_sha || !this.mayPush(latest)) throw new HttpError(412, 'the pull request changed before the push');
    };
    let plan: PushPlan | null = null;
    try {
      plan = await this.preparePush(ctx, pull, { sign, force: true, lease: true, timeoutMs });
      await this.pushPrepared(ctx, pull, plan, { timeoutMs, ready });
    } catch (e) {
      // What changed brings another try, or ends it: a merge or close on GitHub, which the author
      // hears of. Not tried, so it may be tried again: a retry of signing would keep its try
      // (pushTry) until it fails again, which it never would.
      if (e instanceof HttpError && e.status === 412) {
        this.pushTries.delete(pull.id);
        return false;
      }
      // Refused because the branch on GitHub has commits galley does not have (the lease): fetch it,
      // as galley fetches base branches, for the author to rebase onto, which it may not be able to
      // fetch itself from its sandbox. Its next commit then goes on top of them (preparePush).
      const moved = e instanceof HttpError && e.status === 409 && /stale info|fetch first/.test(e.message);
      // Refused before the push for commits a rewrite on GitHub removed, which only the user may bring
      // back, by publishing: what galley fetched before (preparePush).
      const fetched = moved ? await this.fetchHead(ctx, pull) : e instanceof HttpError ? (e.fields.fetched as GithubPush['fetched']) : undefined;
      const signing = e instanceof SigningError ? this.signingFailure(e, this.signingFailures(pull) + 1) : undefined;
      const failed: Omit<GithubPush, 'at'> = {
        url,
        source: pull.head_sha,
        head: null,
        before: plan?.before ?? pull.published_head_sha,
        sign,
        signed: plan?.signed ?? 0,
        force: plan?.force ?? false,
        result: 'failed',
        error: (e instanceof Error ? e.message : String(e)).slice(0, 4000),
        // GitHub refused it (409): final for this commit. Signing is tried again while
        // signingFailure says so, and is final after that. Anything else is tried again.
        retry: signing ? signing.next_at !== null : !(e instanceof HttpError && e.status === 409),
        ...(fetched ? { fetched } : {}),
        ...(signing ? { signing } : {}),
      };
      // The same failure again, tried again: the timeline has it already. Each try of signing is
      // said, since it says which try it was and when the next is.
      const last = this.pushFailed(pull);
      if (!signing && last?.retry && failed.retry && last.error === failed.error) return false;
      this.addEvent(pull, viewer, 'github_push', failed);
      this.emit(pull.id, 'github_push_failed', viewer);
      return true;
    }
    const ts = now();
    const pushed: Omit<GithubPush, 'at'> = {
      url,
      source: pull.head_sha,
      head: plan.pushed,
      before: plan.before,
      sign,
      signed: plan.signed,
      force: plan.force,
      result: 'pushed',
      ...(plan.rewritten ? { rewritten: plan.rewritten } : {}),
    };
    this.db.transaction(() => {
      this.db.update('pulls', pull.id, { published_head_sha: plan.pushed, published_source_sha: pull.head_sha, published_at: ts, updated_at: ts });
      this.addEvent(pull, viewer, 'github_push', pushed, ts);
    });
    this.emit(pull.id, 'github_pushed', viewer);
    // Turned on by galley (also when asking for it again failed since), and not turned off on
    // GitHub since, as far as following saw: asked for again, for the commit pushed.
    const merge = lastEvent(this.db, pull, 'auto_merge_enabled');
    const github = githubStatus(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!);
    const off = github?.autoMerge === false && !!merge && github.checkedAt > merge.created_at;
    if (merge && !off) await this.enableAutoMerge(ctx, url, plan.pushed, merge.data.method, viewer, timeoutMs);
    return true;
  }

  /**
   * Fetch the pull request's branch from GitHub into its remote-tracking branch, as fetchRepo
   * fetches base branches, and nothing else: the ref preparePush pushes on top of, once the head
   * has it in it. Stopped when the server stops (stopFetching).
   */
  private async fetchHead(ctx: Ctx, pull: PullRow): Promise<NonNullable<GithubPush['fetched']>> {
    const { repo, git } = ctx;
    const signal = this.fetchAbort.signal;
    const ref = `${repo.remote}/${pull.head_ref}`;
    const url = this.githubUrl(repo.github_slug!);
    const error = await git.fetchBranch(url, pull.head_ref, `refs/remotes/${ref}`, { gh: this.ghBin, cwd: repo.work_dir ?? tmpdir(), timeoutMs: FETCH_TIMEOUT_MS, signal });
    if (signal.aborted) return { ref, error: 'galley stopped before the fetch was done' };
    const sha = error ? null : await git.resolve(`refs/remotes/${ref}`);
    if (!sha) return { ref, error: error ?? `git fetch left no ${ref}` };
    const published = pull.published_head_sha;
    if (!published || !(await this.goneFrom(ctx, pull, published, sha)).length) return { ref, sha, rewritten: false };
    return { ref, sha, rewritten: true, since: await this.rebaseFrom(ctx, pull, sha) };
  }

  /**
   * Whether the published pull request is open on GitHub, asked now: following asks only every
   * minute or so. A merge or close it finds is recorded as following records it. When GitHub can
   * not be asked, or does not say, it throws: nothing is pushed without an answer.
   */
  private async openOnGithub(ctx: Ctx, url: string): Promise<boolean> {
    return (await this.viewOnGithub(ctx, url)) !== null;
  }

  /**
   * The published pull request as GitHub has it now, as openOnGithub asks, and its title and body
   * when `fields` asks for them: null once it is merged or closed there.
   */
  private async viewOnGithub(ctx: Ctx, url: string, fields: ('title' | 'body')[] = []): Promise<(GithubPull & { title?: string; body?: string }) | null> {
    let view: (GithubPull & { title?: string; body?: string }) | undefined;
    let why = 'gh answered with something other than a pull request';
    try {
      const r = await run(this.ghBin, ['pr', 'view', url, '--json', ['state,mergedAt,mergedBy,mergeCommit,closedAt', ...fields].join(',')], { cwd: ctx.repo.work_dir ?? tmpdir(), env: UNPROMPTED, allowFail: true, timeoutMs: UNATTENDED_TIMEOUT_MS });
      if (r.code !== 0) why = failure(r);
      else {
        view = JSON.parse(r.stdout) as GithubPull;
        if (view.state === 'MERGED' || view.state === 'CLOSED') this.recordGithubEnd(ctx.pull.id, view);
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) why = (e as Error).message;
    }
    if (view?.state === 'OPEN') return view;
    if (view?.state === 'MERGED' || view?.state === 'CLOSED') return null;
    throw new HttpError(503, `could not ask GitHub whether ${url} is still open:\n${why}`);
  }

  /**
   * Whether publishing offers to turn on auto-merge in this repository: only when GitHub allows
   * auto-merge there. Unknown (not asked yet, or gh failed) counts as not allowed. Never waits on
   * the network.
   */
  autoMergeOption(repo: RepoRow): AutoMergeOption | null {
    const merging = repo.github_slug ? this.githubRepo(repo.github_slug)?.merging : null;
    if (!merging?.autoMerge) return null;
    const method = readSettings(this.db).publish.mergeMethod;
    return { method, methodAllowed: merging.methods.includes(method), methods: merging.methods };
  }

  /**
   * Check that the repository allows auto-merge with `method`, refusing with a reason when it
   * does not. It asks GitHub first: an answer from before the repository's settings changed must
   * not let a publish through that `gh pr merge` refuses.
   */
  async autoMergeMethod(repo: RepoRow, method: MergeMethod): Promise<MergeMethod> {
    const slug = repo.github_slug;
    if (!slug) throw new HttpError(422, `remote "${repo.remote}" is not a GitHub repository`);
    // A lookup already under way may have asked before the change; ask after it.
    await this.githubRepoCache.get(slug)?.loading;
    await this.refreshGithubRepo(slug);
    const merging = this.githubRepo(slug)?.merging;
    if (!merging) throw new HttpError(502, `could not ask GitHub whether ${slug} allows auto-merge`);
    if (!merging.autoMerge) throw new HttpError(422, `${slug} does not allow auto-merge. Turn on "Allow auto-merge" in the repository's settings on GitHub.`);
    if (!merging.methods.includes(method)) {
      // The CLI may name another than the one in settings (`--auto-merge rebase`).
      const setting = method === readSettings(this.db).publish.mergeMethod;
      throw new HttpError(
        422,
        `${slug} does not allow ${method} merges${setting ? ", the merge method in galley's settings" : ''} (it allows ${merging.methods.join(', ')}).${setting ? ' Change it under Settings → Publishing.' : ''}`,
      );
    }
    return method;
  }

  /** What came of the last time galley turned on auto-merge for this pull request on GitHub; null if it never did. */
  autoMerge(pull: PullRow): AutoMerge | null {
    const e = lastEvent(this.db, pull, ['auto_merge_enabled', 'auto_merge_failed']);
    if (!e) return null;
    const { url, method } = e.data;
    if (e.type === 'auto_merge_failed') return { state: 'failed', by: e.actor_id, at: e.created_at, url, method, error: e.data.error };
    const state = e.data.merged === true ? 'merged' : e.data.merged === false ? 'enabled' : 'requested';
    return { state, by: e.actor_id, at: e.created_at, url, method };
  }
}

/** Environment for git and gh when nobody can answer a prompt. */
const UNPROMPTED = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

/** Why a reviewer agent's review was cancelled, as the sidebar and timeline say it: "cancelled: merged on GitHub". */
export const CANCELLED: Record<CancelReason, string> = {
  closed: 'closed here',
  merged: 'merged on GitHub',
  closed_on_github: 'closed on GitHub',
  published: 'published',
  pushed: 'new commits pushed',
  edited: 'title or description edited',
  base_moved: 'the base moved',
};

/**
 * Whether an item of auto-publish's checklist that is not ok waits for the reviewer (Service.turn).
 * It does when someone has to act (failed): a review that failed, to ask for again; a conflict with
 * the base, for the author to rebase once told, and until then the reviewer's to pass on; a check
 * for conflicts that could not run; a merge method GitHub no longer allows. So do findings the
 * author left unanswered, which the author is not working on once it acted on them, and the
 * threads the reviewer started, to resolve. It gets past the rest with no help from the reviewer:
 * a reviewer agent with the head to review (at it, or starting when the author waits), the author
 * waiting with all feedback seen (a turn of its own), the time to try signing again, the check for
 * conflicts under way.
 */
function waitsForUser(i: AutoPublishItem): boolean {
  if (i.ok) return false;
  if (i.failed) return true;
  if ('reviewer' in i) return !toReview(i.reviewer.status.state);
  return i.key !== 'signing' && i.key !== 'author' && i.key !== 'conflicts';
}

/**
 * What auto-publish waits for once nothing it waits for is the reviewer's, as nobody's turn reason
 * (Service.turn): the time to try signing again, the check for conflicts, the author coming back to
 * wait; or nothing, and it publishes now.
 */
function autoPublishNext(checklist: AutoPublishItem[], pull: PullRow, author: string): TurnReason {
  const left = checklist.filter((i) => !i.ok && i.blocking);
  const signing = left.flatMap((i) => ('signing' in i ? [i.signing] : []))[0];
  if (signing) return { kind: 'auto_publish', text: 'auto-publish waits to try signing again', since: signing.at };
  if (left.some((i) => i.key === 'conflicts')) return { kind: 'auto_publish', text: `auto-publish is checking for conflicts with ${pull.base_ref}` };
  if (left.some((i) => i.key === 'author')) return { kind: 'auto_publish', text: `auto-publish publishes it once ${author} waits with all feedback seen` };
  return { kind: 'auto_publish', text: 'auto-publish is publishing it' };
}

/**
 * A reviewer agent's progress with the head, as a reason in Turn; null when it has nothing to do
 * with the pull request, or no automatic reviews left because the reviewer stopped them (`stopped`),
 * which stoppedText says once for all of them.
 */
function reviewerAgentText(login: string, status: HeadStatus, pull: PullRow, author: string, authorWaiting: boolean, stopped: boolean): string | null {
  const sha = status.commit.slice(0, 7);
  // A reviewer of the description reviews the title, description and commit messages the head has.
  const what = status.description ? 'the description' : sha;
  switch (status.state) {
    case 'reviewing':
      return status.description || status.commit === pull.head_sha ? `${login} is reviewing ${what}` : `${login} is reviewing an earlier commit, ${sha}`;
    case 'queued':
      return `${login} is about to review ${what}`;
    case 'interrupted':
      return `${login}'s review of ${what} was interrupted by a restart; it will run again`;
    case 'unreviewed':
      return authorWaiting ? `${login} is about to review ${what}` : `${login} reviews ${what} when ${author} waits for review`;
    case 'findings':
      return `${login} commented on ${what}`;
    case 'answered':
      return `${login}'s findings in ${what} are answered`;
    case 'failed':
      return `${login}'s review of ${what} failed`;
    case 'cancelled':
      return `${login}'s review of ${what} was cancelled${status.cancelled ? ` (${CANCELLED[status.cancelled]})` : ''}`;
    case 'clean':
      return `${login} found nothing in ${what}`;
    case 'approved':
      return `${login} approved ${what}`;
    case 'capped':
      if (stopped) return null;
      return status.automatic ? `${login} used ${status.automatic.used} of ${status.automatic.limit} automatic reviews` : `${login} has used up its automatic reviews`;
    case 'off':
      return null;
  }
}

/** The commit messages of a pull request, oldest first, hashed (PullRow.messages_sha). */
function messagesSha(commits: Commit[]): string {
  return createHash('sha256').update(commits.map((c) => c.message).join('\0')).digest('hex');
}

/** Fields in words, in the order given: "title", "title and description". */
export function andList(fields: string[]): string {
  return fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : (fields[0] ?? '');
}

/** The round automatic reviews stopped after, in words. */
export function afterRound(round: number): string {
  return round ? `after round ${round}` : 'before the first round';
}

/** Why a command failed: its output, or that it ran out of time (and, given, what it may have waited for). */
function failure(r: RunResult, waitedFor?: string): string {
  if (r.timedOut) return `timed out after ${UNATTENDED_TIMEOUT_MS / 1000} seconds${waitedFor ? ` (${waitedFor})` : ''}`;
  return (r.stderr || r.stdout).trim();
}

/**
 * Signing failures that trying again later may get past, by what git passed on from the signing
 * program, with the few words the pages say each in: a prompt nobody answered in time, and an
 * agent that could not be reached. git's exit status is the same for every signing failure; only
 * an unattended step that ran out of time (UNATTENDED_TIMEOUT_MS) has none, and that is a prompt
 * nobody answered too.
 */
const TRANSIENT_SIGNING: [RegExp, string][] = [
  // 1Password's op-ssh-sign: the agent hung up before it signed, as when its prompt timed out or was closed.
  [/failed to fill whole buffer/, '1Password prompt not answered'],
  [/Could not connect to socket|communication with agent failed|agent not present|can't connect to the agent|No agent running/i, 'signing agent not reachable'],
  // gpg's pinentry.
  [/signing failed: Timeout/, 'passphrase prompt not answered'],
];

/**
 * Signing failures that are the user's answer to a prompt, which trying again would only ask
 * again: final, as any failure galley can not tell, but said in a few words, so the user knows
 * why auto-publish turned off and can turn it on again when they want it.
 */
const DENIED_SIGNING: [RegExp, string][] = [
  // 1Password's agent answered with a failure: its prompt was denied.
  [/1Password: agent returned an error/, '1Password prompt denied'],
  // gpg's pinentry, dismissed: as deliberate as a denial.
  [/signing failed: Operation cancelled/, 'passphrase prompt dismissed'],
  // OpenSSH's ssh-agent: its confirmation (ssh-add -c) was denied. It says the same when it is
  // locked (ssh-add -x), when nobody touched a security key (sk-* keys), and when it could not
  // show the confirmation (no askpass). galley can not tell those apart, so all of them are final.
  [/agent refused operation/, 'SSH agent refused to sign'],
];

/**
 * What went wrong when signing failed (TRANSIENT_SIGNING, DENIED_SIGNING); null for anything
 * else, which trying again can not get past: no signing key configured, a key that can not be
 * read or is not in the agent, a signing program that is not there, git's configuration.
 */
function signingCause(r: RunResult): SigningCause | null {
  if (r.timedOut) return { why: 'prompt not answered', transient: true };
  const said = `${r.stderr}\n${r.stdout}`;
  const denied = DENIED_SIGNING.find(([pattern]) => pattern.test(said));
  if (denied) return { why: denied[1], transient: false };
  const transient = TRANSIENT_SIGNING.find(([pattern]) => pattern.test(said));
  return transient ? { why: transient[1], transient: true } : null;
}

/**
 * What changes in a failure's message from one try to the next while the failure stays the same:
 * how long it took and how much came (git's "after 0 ms", "with 0 out of 0 bytes received"),
 * addresses and ports (gh's "read tcp 192.168.1.10:54321->140.82.121.6:443"), and SHAs and
 * GitHub's request IDs ("Please include `C0DE:2B1F:1A2B3C:4D5E6F:65F0A1B2`"). Other numbers, such
 * as an HTTP status or an exit code, say what failed, and stay.
 */
const VOLATILE = new RegExp(
  [
    String.raw`\b\d+(?:\.\d+)?(?: out of \d+)? ?(?:ms|milliseconds?|seconds?|bytes?)\b`,
    String.raw`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?`,
    String.raw`\[[\da-f:.]+\](?::\d+)?`,
    String.raw`\b[\da-f]+(?::[\da-f]+){2,}\b`,
    String.raw`\b(?=[a-f]*\d)[\da-f]{7,}\b`,
  ].join('|'),
  'gi',
);

/** A failure's message as galley tells failures apart, to log each once: without what changes from one try to the next (VOLATILE). */
function failureKey(message: string): string {
  return message.replace(VOLATILE, '#');
}

/** Title and body from the branch's commits, like `gh pr create --fill`. */
export function fillFromCommits(commits: Commit[], branch: string, mode: 'default' | 'first' | 'verbose'): { title: string; body: string } {
  const split = (c: Commit) => {
    const [subject, ...rest] = c.message.split('\n');
    return { subject, body: rest.join('\n').trim() };
  };
  if (mode === 'first' || commits.length === 1) {
    const { subject, body } = split(commits[0]);
    return { title: subject, body };
  }
  const humanized = branch.replace(/^.*\//, '').replace(/[-_]+/g, ' ');
  const title = humanized.charAt(0).toUpperCase() + humanized.slice(1);
  if (mode === 'verbose') {
    return { title, body: commits.map((c) => `- ${c.message.trim().replace(/\n/g, '\n  ')}`).join('\n') };
  }
  return { title, body: commits.map((c) => `- ${split(c).subject}`).join('\n') };
}

/** An issue or pull request on GitHub, as links to it show it on hover. */
export interface IssueSummary {
  title: string;
  /** "Open issue", "Merged pull request" and so on. */
  state: string;
}

/** An `issueOrPullRequest` from GitHub's GraphQL API as an `IssueSummary`; null when there is none. */
export function issueSummary(node: { __typename?: string; title?: string; state?: string; stateReason?: string | null; isDraft?: boolean } | null | undefined): IssueSummary | null {
  if (!node?.title || !node.state) return null;
  if (node.__typename === 'PullRequest') {
    const state = node.state === 'OPEN' ? (node.isDraft ? 'Draft' : 'Open') : node.state === 'MERGED' ? 'Merged' : 'Closed';
    return { title: node.title, state: `${state} pull request` };
  }
  if (node.state === 'OPEN') return { title: node.title, state: 'Open issue' };
  if (node.stateReason === 'NOT_PLANNED') return { title: node.title, state: 'Closed as not planned' };
  if (node.stateReason === 'DUPLICATE') return { title: node.title, state: 'Closed as duplicate' };
  return { title: node.title, state: 'Closed issue' };
}

export type StagingState = 'staged' | 'published' | 'done';

/**
 * Which one of three states a pull request is in, and the list's tab it shows under: staged (only
 * here, never published), published (and open on GitHub), or done (merged or closed on GitHub, or
 * closed here). LISTED says the same in SQL.
 */
export function stagingState(pull: Pick<PullRow, 'state' | 'github_state'>): StagingState {
  if (pull.state === 'closed' || pull.github_state === 'merged' || pull.github_state === 'closed') return 'done';
  return pull.state;
}

/** What galley last saw of a published pull request on GitHub, while it is open there. */
export function githubStatus(pull: PullRow): GithubStatus | null {
  return pull.github_state === 'open' && pull.github_status ? (JSON.parse(pull.github_status) as GithubStatus) : null;
}

/** Identifies what a publish would send, so the UI can refuse to publish something the reviewer has not seen. */
export function publishFingerprint(pull: PullRow): string {
  const text = createHash('sha256').update(`${pull.base_ref}\0${pull.title}\0${pull.body}`).digest('hex').slice(0, 16);
  return `${pull.head_sha}:${text}`;
}

export function checkPriority(value: unknown): Priority | null {
  if (value === null || value === undefined || value === '') return null;
  const p = String(value).toLowerCase();
  if (!(PRIORITIES as readonly string[]).includes(p)) throw new HttpError(422, `priority must be one of ${PRIORITIES.join(', ')}`);
  return p as Priority;
}

/**
 * Reviewers that put the priority in the text ("[P1] Title", Codex's habit) get it moved into
 * the field: P0 and P1 are high, P2 medium, P3 low.
 */
export function splitPriorityPrefix(body: string): { priority: Priority | null; body: string } {
  const m = body.match(/^\s*\[P([0-3])\]\s*/);
  if (!m) return { priority: null, body };
  const priority: Priority = m[1] === '2' ? 'medium' : m[1] === '3' ? 'low' : 'high';
  return { priority, body: body.slice(m[0].length) };
}
