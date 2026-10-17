import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Repo, run, githubSlug, type Commit, type RawCommit, type RunResult } from './git.ts';
import { diffHunkFor, expandedLine, lineInDiff, mapLine, rangeTouched, withContext, type FileDiff } from './diff.ts';
import type { CodexReviewer } from './reviewers/codex.ts';
import type { ClaudeReviewer } from './reviewers/claude.ts';
import type { ReviewAtWork, Reviewer } from './reviewers/reviewer.ts';
import { MERGE_METHODS, readSettings, type MergeMethod } from './settings.ts';
import { reviewDecision } from './github.ts';
import { earlierThreads, earlierThreadsQuery, githubAsks, githubBusy, prependThreads, present, readGithub, PULL_FIELDS, type GithubPull, type GithubStatus } from './github-follow.ts';
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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ChangeEvent {
  pullId: number | null;
  type: string;
  actor: string;
}

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
  /** laatsux extension: high, medium or low. */
  priority?: string | null;
  commit_id?: string | null;
  /** laatsux extension: the left side of the diff the comment was made on (for commit and interdiff views). */
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
export type ReviewColumns = Partial<Pick<PullRow, 'codex_enabled' | 'codex_max_iterations' | 'claude_enabled' | 'claude_max_iterations'>>;

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
   * see Service.agentsDone; `conflicts`, the head conflicts with its base (Service.baseConflicts).
   */
  status: 'feedback' | 'published' | 'closed' | 'merged' | 'closed_on_github' | 'agents_done' | 'conflicts' | 'timeout';
  reviews: ReviewRow[];
  comments: CommentRow[];
  /** What the author confirms with markSeen once it has shown this feedback. */
  seenAt?: string;
  /** With `agents_done`: the head the reviewer agents are done with, and what each made of it. */
  agentsDone?: AgentsDone;
  /** The head, when it conflicts with its base: the author confirms with markSeen that it was told. */
  conflicts?: string;
}

/**
 * Whether a pull request's head merges cleanly into the tip of its base branch, as laatsux worked
 * it out with `git merge-tree` (see Service.baseConflicts).
 */
export interface BaseConflicts {
  /** The base branch it is about (pulls.base_ref). */
  branch: string;
  /** The branch it was merged into: the remote-tracking one (origin/main) when there is one, else the local one. */
  ref: string;
  /** That branch's tip, as this repository has it (laatsux does not fetch); null when there is no such branch. */
  base: string | null;
  head: string;
  /** Whether the head merges cleanly: false when it conflicts, null when git could not tell (see error). */
  clean: boolean | null;
  /** The files that conflict. A conflict can be in no file, such as a directory renamed two ways (see messages). */
  files: string[];
  /** git's message for each conflict in none of those files. */
  messages: string[];
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

/** Where a reviewer agent stands with a pull request's head commit. */
export interface HeadStatus {
  state: 'reviewing' | 'queued' | 'interrupted' | 'unreviewed' | 'findings' | 'failed' | 'cancelled' | 'clean' | 'capped' | 'off';
  /** Nothing more is coming from the reviewer for this commit. */
  done: boolean;
  /** The commit this is about: the head, or the earlier commit a running review started on. */
  commit: string;
  /** When the running review started. */
  startedAt?: string | null;
  /** When the failed review ended. */
  failedAt?: string | null;
  /** Why the review of the head was cancelled. */
  cancelled?: CancelReason | null;
  /** Automatic reviews of the pull request so far, and how many it gets. */
  automatic?: { used: number; limit: number };
}

/** Whether the agents are done with a pull request, so the reviewer can take it from here. */
export interface Readiness {
  reviewers: { login: string; engine: string; status: HeadStatus }[];
  /** The author is running `pr wait`. */
  authorWaiting: boolean;
  /** Reviews and comments the author has not been shown. */
  unseen: number;
  /** Unresolved threads a person started (agents' threads do not count). */
  openThreads: number;
  /** Every reviewer agent is done with the head, and the author is waiting with all feedback seen. */
  agentsDone: boolean;
}

/** Whose move a pull request waits for: the author agent's, the reviewer agents', the reviewer's, or nobody's. */
export type Whose = 'author' | 'reviewer_agents' | 'reviewer' | 'none';

/**
 * Where the author agent is: working on feedback it was handed (until its next action), not yet
 * handed feedback that asks something of it, waiting in `pr wait`, or stopped.
 */
export type AuthorState = 'waiting' | 'unseen' | 'working' | 'stopped';

/** One reason for whose turn it is, as the list row and `pr view` say it. */
export interface TurnReason {
  /**
   * The author agent, a reviewer agent, what changed since the reviewer's last review, the decision,
   * unresolved threads, an update not on GitHub yet, conflicts with the base, or what GitHub has for the reviewer.
   */
  kind: 'author' | 'reviewer_agent' | 'changes' | 'approved' | 'changes_requested' | 'threads' | 'unpublished' | 'conflicts' | 'github';
  /** A few words. The reviewer is named by login, so it reads the same to the reviewer and to agents. */
  text: string;
  /** Since when it has been so: waiting, reviewing, working on feedback, or stopped. */
  since?: string | null;
  /** The author's AuthorState, or a reviewer agent's HeadStatus state. */
  state?: AuthorState | HeadStatus['state'];
  /** A reviewer agent's engine, for asking it to review again. */
  engine?: string;
}

/**
 * Whose move a pull request waits for (#6). The author agent's from being handed feedback that
 * asks something of it until its next action (a push, an edit, a reply, a wait); a reviewer
 * agent's while one reviews the pull request or is about to; then the reviewer's: the author has
 * answered and waits or has stopped, and the reviewer agents are done with the head. Nobody's once
 * it is closed (here, or merged or closed on GitHub), or published with nothing new and no
 * feedback the author has yet to be handed.
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

/** Automatic reviews, once the reviewer stopped them: who did, when, and after which round (see Service.automaticRound). */
export interface IterationsStopped {
  by: number;
  at: string;
  round: number;
}

/**
 * The last time laatsux turned on auto-merge for the published pull request, and what came of
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

export type AutoPublishOff = 'cancelled' | 'closed' | 'changes_requested' | 'base_changed' | 'merged' | 'closed_on_github';

/** A repository on GitHub, as laatsux shows it: the counts on the repo tabs, and what merging there allows. */
export interface GithubRepo {
  issues: number;
  pulls: number;
  /** Null when the last attempt to ask GitHub failed: the counts may be old, but what merging allows is unknown. */
  merging: {
    /** "Allow auto-merge" in the repository's settings. */
    autoMerge: boolean;
    methods: MergeMethod[];
  } | null;
}

/** Whether publishing can turn on auto-merge in a repository: GitHub allows auto-merge there, and maybe not the method from settings. */
export interface AutoMergeOption {
  method: MergeMethod;
  methodAllowed: boolean;
  methods: MergeMethod[];
}

/** How often laatsux asks GitHub about published pull requests: while something runs there, and otherwise. */
export const FOLLOW_BUSY_MS = 20_000;
export const FOLLOW_IDLE_MS = 60_000;

/** How long each step of an unattended publish (signing a commit, the push, each gh call) may take. */
export const UNATTENDED_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Where laatsux keeps refs in the repositories it stages from. Each server has a namespace of its
 * own under it (Db.instance), so servers staging from one repository never touch each other's.
 * A database pins its revisions in its namespace when it gets its id (Service.pinRevisions). Refs
 * from before namespaces (`refs/laatsux/pull/<n>/...`) stay where they are, since a copy of the
 * database from before may count on them.
 */
export const REFS = 'refs/laatsux';

export interface ServiceOptions {
  db: Db;
  baseUrl: string;
  ghBin?: string;
  viewerLogin?: string;
}

export class Service {
  db: Db;
  baseUrl: string;
  ghBin: string;
  bus = new EventEmitter();
  /** Codex and Claude as reviewer agents, when the server runs them. */
  codex: CodexReviewer | null = null;
  claude: ClaudeReviewer | null = null;
  /** The server is stopping, once the reviews running now have posted (see startServer's close). */
  stopping = false;
  /** Number of `pr wait` calls currently blocked, per pull id. */
  waiters = new Map<number, number>();
  private syncing = new Map<number, Promise<PullRow>>();
  private viewerLogin: string;

  constructor(opts: ServiceOptions) {
    this.db = opts.db;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.ghBin = opts.ghBin ?? 'gh';
    this.viewerLogin = opts.viewerLogin ?? this.db.getMeta('viewer_login') ?? process.env.USER ?? 'you';
    this.bus.setMaxListeners(0);
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
  }

  /** The human's login belongs to the human: a reviewer bot holding it moves to another name. */
  claimViewerLogin(): void {
    for (const r of this.reviewerAgents()) r.releaseName(this.viewerLogin);
    this.viewer();
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
    this.bus.emit('change', { pullId, type, actor: actor.login } satisfies ChangeEvent);
  }

  // --------------------------------------------------------- GitHub repos

  private githubRepoCache = new Map<string, { at: number; value: GithubRepo | null; loading?: Promise<void> }>();

  /**
   * The repository on GitHub: open issues and pull requests for the repo tabs, and what merging
   * allows. Never waits on the network: it answers from the cache (or with nothing) and
   * refreshes it in the background.
   */
  githubRepo(slug: string): GithubRepo | null {
    const hit = this.githubRepoCache.get(slug);
    if (!hit || (Date.now() - hit.at > 5 * 60_000 && !hit.loading)) this.refreshGithubRepo(slug);
    return hit?.value ?? null;
  }

  refreshGithubRepo(slug: string): Promise<void> {
    const current = this.githubRepoCache.get(slug);
    if (current?.loading) return current.loading;
    const [owner, name] = slug.split('/');
    const query =
      'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount} ' +
      'autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed}}';
    // -f, not -F: -F would turn a repository named "123" or "true" into a number or boolean.
    const loading = run(this.ghBin, ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`], { allowFail: true, timeoutMs: 15_000 })
      .then((r): GithubRepo => {
        const repo = JSON.parse(r.stdout).data.repository;
        const allowed = { squash: repo.squashMergeAllowed, merge: repo.mergeCommitAllowed, rebase: repo.rebaseMergeAllowed };
        return {
          issues: repo.issues.totalCount,
          pulls: repo.pullRequests.totalCount,
          merging: { autoMerge: repo.autoMergeAllowed === true, methods: MERGE_METHODS.filter((m) => allowed[m] === true) },
        };
      })
      // Old counts are better than none, but what merging allows is not known now.
      .catch(() => (current?.value ? { ...current.value, merging: null } : null))
      .then((value) => {
        this.githubRepoCache.set(slug, { at: Date.now(), value });
        // Pages rendered before this answer came show old or no counts and options; let them refresh.
        if (JSON.stringify(value) !== JSON.stringify(current?.value ?? null)) {
          this.bus.emit('change', { pullId: null, type: 'github_repo', actor: 'github' } satisfies ChangeEvent);
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
    const [owner, name] = slug.split('/');
    // Numbers are digits (references.ts), so they can go into the query itself.
    const fields = numbers.map((n) => `i${n}:issueOrPullRequest(number:${n}){__typename ...on Issue{title state stateReason} ...on PullRequest{title state isDraft}}`);
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(' ')}}}`;
    // An unknown number fails the query but still answers for the others.
    const found = await run(this.ghBin, ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`], { allowFail: true, timeoutMs: 15_000 })
      .then((r) => JSON.parse(r.stdout).data.repository as Record<string, any>)
      .catch(() => null);
    let changed = false;
    for (const n of numbers) {
      const key = `${slug}#${n}`;
      const before = this.githubIssueCache.get(key)?.value ?? null;
      const value = found ? issueSummary(found[`i${n}`]) : before;
      this.githubIssueCache.set(key, { at: Date.now(), value });
      if (JSON.stringify(value) !== JSON.stringify(before)) changed = true;
    }
    // Pages rendered before the answer came link without titles; let them refresh.
    if (changed) this.bus.emit('change', { pullId: null, type: 'github_issues', actor: 'github' } satisfies ChangeEvent);
  }

  // ------------------------------------------------------ following GitHub

  /** Published pull requests that laatsux follows on GitHub: not known to be merged or closed there, and not closed here. */
  followed(): PullRow[] {
    return this.db.all<PullRow>("SELECT * FROM pulls WHERE state = 'published' AND COALESCE(github_state, 'open') = 'open'");
  }

  private following: Promise<void> = Promise.resolve();
  /** When laatsux last asked GitHub about each repository's pull requests. */
  private githubAskedAt = new Map<string, number>();

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
      const [owner, name] = slug.split('/');
      // Aliased by pull id: one GitHub pull request can have been published from several staged ones.
      const fields = items.map(({ pull, number }) => `p${pull.id}:pullRequest(number:${number}){${PULL_FIELDS}}`);
      const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(' ')}}}`;
      const found = await run(this.ghBin, ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`], { allowFail: true, timeoutMs: 15_000 })
        .then((r) => JSON.parse(r.stdout).data.repository as Record<string, GithubPull | null>)
        .catch(() => null);
      // Those without an answer (gh failed, or the pull request is gone) are asked again next time.
      for (const { pull, number } of items) {
        const node = found?.[`p${pull.id}`];
        if (node?.state) await this.recordGithub(pull.id, node, slug, number);
      }
    }
  }

  /** Record what GitHub says about a published pull request: merged or closed there, or how it stands while open. */
  async recordGithub(pullId: number, node: GithubPull, slug: string, number: number): Promise<void> {
    if (node.state !== 'OPEN') return this.recordGithubEnd(pullId, node);
    const complete = await this.readEarlierThreads(slug, number, node);
    const type = this.db.transaction(() => {
      const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
      // Closed here, or merged or closed on GitHub, while gh answered: no longer followed.
      if (!pull || pull.state !== 'published' || (pull.github_state ?? 'open') !== 'open') return null;
      // What was seen before, also when a publish followed it again after a close on GitHub.
      const previous = pull.github_status ? (JSON.parse(pull.github_status) as GithubStatus) : null;
      // Threads on pages it could not read stay as they were.
      const status = readGithub(node, previous, now(), complete);
      this.db.update('pulls', pull.id, { github_state: 'open', github_status: JSON.stringify(status) });
      // Pages show the status; tell them when it changed, not each time laatsux asked.
      const same = previous && JSON.stringify({ ...previous, checkedAt: null }) === JSON.stringify({ ...status, checkedAt: null });
      return pull.github_state === 'open' && same ? null : 'github_status';
    });
    // From GitHub, like the counts: pages refresh. It is for the reviewer; the author's `pr wait` hears only of a merge or close.
    if (type) this.bus.emit('change', { pullId, type, actor: 'github' } satisfies ChangeEvent);
  }

  /**
   * The review threads before the first page, for a pull request with more of them than it holds
   * (up to 20 pages more). False when some could not be read.
   */
  private async readEarlierThreads(slug: string, number: number, node: GithubPull): Promise<boolean> {
    const [owner, name] = slug.split('/');
    for (let i = 0; i < 20; i++) {
      const cursor = earlierThreads(node);
      if (!cursor) return true;
      const args = ['api', 'graphql', '-f', `query=${earlierThreadsQuery(number)}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `cursor=${cursor}`];
      const page = await run(this.ghBin, args, { allowFail: true, timeoutMs: 15_000 })
        .then((r) => JSON.parse(r.stdout).data.repository.pullRequest.reviewThreads)
        .catch(() => null);
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
      // Approved for a pull request open on GitHub, also when this close is one seen before.
      this.autoPublishOff(pull, viewer, merged ? 'merged' : 'closed_on_github', ts);
      // Published again after it was closed on GitHub, and still closed there: that close is in the timeline already.
      if (!merged && pull.github_closed_at === at) return 'github_state';
      // The event says when laatsux learned of it, so `pr wait` delivers it like any news; `at` says when it happened.
      this.addEvent(pull, viewer, merged ? 'merged' : 'closed_on_github', { url: pull.published_url, by, at, commit }, ts);
      return merged ? 'merged' : 'closed_on_github';
    });
    if (!type) return;
    this.cancelReviews(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId)!, state === 'merged' ? 'merged' : 'closed_on_github');
    this.bus.emit('change', { pullId, type, actor: 'github' } satisfies ChangeEvent);
  }

  // ----------------------------------------------------------------- repos

  async registerRepo(path: string): Promise<RepoRow> {
    const r = await run('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
    if (r.code !== 0) throw new HttpError(422, `not a git repository: ${path}`);
    const gitDir = r.stdout.trim();
    const workDir = basename(gitDir) === '.git' ? dirname(gitDir) : null;
    const git = new Repo(gitDir);
    const remotes = await git.remotes();
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
    const slug = githubSlug(await git.remoteUrl(remote));

    const existing = this.db.get<RepoRow>('SELECT * FROM repos WHERE git_dir = ?', gitDir);
    if (existing) {
      if (existing.github_slug !== slug || existing.remote !== remote || existing.work_dir !== workDir) {
        this.db.update('repos', existing.id, { github_slug: slug, remote, work_dir: workDir });
      }
      return this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', existing.id)!;
    }

    const [owner, baseName] = slug ? slug.split('/') : ['local', basename(workDir ?? gitDir.replace(/\.git$/, ''))];
    let name = baseName;
    for (let i = 2; this.db.get('SELECT 1 FROM repos WHERE owner = ? AND name = ?', owner, name); i++) name = `${baseName}-${i}`;
    const id = this.db.insert('repos', { git_dir: gitDir, work_dir: workDir, owner, name, remote, github_slug: slug, created_at: now() });
    return this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)!;
  }

  repo(owner: string, name: string): RepoRow {
    const repo = this.db.get<RepoRow>('SELECT * FROM repos WHERE owner = ? AND name = ?', owner, name);
    if (!repo) throw new HttpError(404, `repository ${owner}/${name} is not known to laatsux`);
    return repo;
  }

  repos(): RepoRow[] {
    return this.db.all<RepoRow>('SELECT * FROM repos ORDER BY owner, name');
  }

  git(repo: RepoRow): Repo {
    return new Repo(repo.git_dir);
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
   * The commit a base branch points at. The remote-tracking branch wins over the local one,
   * because that is what the pull request will be compared against once it is on GitHub.
   */
  async baseCommit(repo: RepoRow, baseRef: string): Promise<string | null> {
    const git = this.git(repo);
    return (await git.resolve(`refs/remotes/${repo.remote}/${baseRef}`)) ?? (await git.resolve(`refs/heads/${baseRef}`));
  }

  // ----------------------------------------------------------------- pulls

  pullUrl(repo: RepoRow, pull: Pick<PullRow, 'number'>): string {
    return `${this.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
  }

  async ctx(owner: string, name: string, number: number, opts: { sync?: boolean } = {}): Promise<Ctx> {
    const repo = this.repo(owner, name);
    let pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE repo_id = ? AND number = ?', repo.id, number);
    if (!pull) throw new HttpError(404, `no pull request found for #${number} in ${owner}/${name}`);
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
   * What staging asks of the reviewer agents (a laatsux extension to POST /pulls), as the
   * pull request's own settings. `reviewers` turns the named ones on, with their own limit
   * when one is given; `automatic_reviews` turns all of them on or off. Logins that no reviewer
   * agent answers to are ignored, like gh's other reviewers, and returned so the caller can say so.
   */
  reviewRequest(reviewers: unknown, automatic: unknown): { columns: ReviewColumns; ignored: string[] } {
    if (automatic !== undefined && typeof automatic !== 'boolean') throw new HttpError(422, 'automatic_reviews must be true or false');
    if (reviewers !== undefined && !Array.isArray(reviewers)) throw new HttpError(422, 'reviewers must be an array');
    const agents = this.reviewerAgents();
    const columns: ReviewColumns = {};
    if (automatic !== undefined) for (const agent of agents) Object.assign(columns, agent.columns({ enabled: automatic }));
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
      Object.assign(columns, agent.columns({ enabled: true, max_iterations }));
    }
    return { columns, ignored };
  }

  async createPull(
    repo: RepoRow,
    input: { title?: string; body?: string; head?: string; base?: string; draft?: boolean; fill?: 'default' | 'first' | 'verbose'; reviews?: ReviewColumns },
    actor: Actor,
  ): Promise<PullRow> {
    const git = this.git(repo);
    const head = input.head?.replace(/^[^:]+:/, '');
    if (!head) throw new HttpError(422, 'head branch is required');
    const base = input.base || (await this.defaultBranch(repo));
    if (head === base) throw new HttpError(422, `head branch "${head}" is the same as base branch "${base}"`);
    const headSha = await git.resolve(`refs/heads/${head}`);
    if (!headSha) throw new HttpError(422, `head branch "${head}" does not exist in ${repo.git_dir}`);
    const baseTip = await this.baseCommit(repo, base);
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
        ...input.reviews,
      });
      this.db.insert('revisions', { pull_id: id, seq: 1, head_sha: headSha, base_sha: mergeBase, before_sha: null, forced: 0, actor_id: actor.id, created_at: ts });
      return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
    });
    await this.pin(git, pull, 1, headSha);
    this.emit(pull.id, 'created', actor);
    return pull;
  }

  /** Keep every reviewed head reachable, so old revisions survive the agent rewriting history. */
  private async pin(git: Repo, pull: PullRow, seq: number, sha: string): Promise<void> {
    await this.moveRef(git, this.ref(pull, seq), null, sha);
  }

  /**
   * Pin every revision, and the signed copies each pull request was last published as, in this
   * server's namespace, once for each instance id: a copy of the database, or one from before
   * namespaces, must not count on refs that another server may delete. Until every pin is in
   * place, each start tries again.
   */
  async pinRevisions(): Promise<void> {
    if (this.db.getMeta('pinned_instance') === this.db.instance) return;
    let done = true;
    for (const repo of this.repos()) {
      if (!existsSync(repo.git_dir)) continue; // Repository moved or deleted: nothing to pin.
      const git = this.git(repo);
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
    if (done) this.db.setMeta('pinned_instance', this.db.instance);
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
    const baseTip = await this.baseCommit(repo, pull.base_ref);
    this.observeBase(pull.id, baseTip);
    const mergeBase = (baseTip && (await git.mergeBase(baseTip, head))) ?? pull.base_sha;
    if (head === pull.head_sha && mergeBase === pull.base_sha) return current();

    const forced = !(await git.isAncestor(pull.head_sha, head));
    const newCommits = forced ? [] : (await git.log(pull.head_sha, head)).map((c) => c.sha);
    const author = this.db.actorById(pull.author_id);
    const ts = now();
    const seq = this.db.transaction(() => {
      // Merged on GitHub while this looked at the branch: its commits stay as they were merged.
      if (current().github_state === 'merged') return null;
      const seq = this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM revisions WHERE pull_id = ?', pull.id)!.n;
      this.db.insert('revisions', { pull_id: pull.id, seq, head_sha: head, base_sha: mergeBase, before_sha: pull.head_sha, forced: forced ? 1 : 0, actor_id: author.id, created_at: ts });
      this.db.update('pulls', pull.id, { head_sha: head, base_sha: mergeBase, updated_at: ts });
      this.addEvent(pull, author, 'pushed', { before: pull.head_sha, after: head, forced, commits: newCommits, base_before: pull.base_sha, base_after: mergeBase }, ts);
      return seq;
    });
    if (seq === null) return current();
    if (head !== pull.head_sha) this.cancelReviews(current(), 'pushed');
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
        const base = refs.get(`refs/remotes/${repo.remote}/${pull.base_ref}`) ?? refs.get(`refs/heads/${pull.base_ref}`);
        const key = `${head} ${base}`;
        if (head && this.lastPolled.get(pull.id) !== key) {
          this.lastPolled.set(pull.id, key);
          await this.sync(pull).catch(() => {});
        }
        this.observeBase(pull.id, base ?? null);
      }
    }
  }
  private lastPolled = new Map<number, string>();

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
   * Whether the head merges cleanly into the tip of its base branch, for a head GitHub does not
   * have (GitHub's own answer covers the one it has: githubStatus); null otherwise. Never waits on
   * git: it answers from what was found (or with null) and works it out in the background, as it
   * does when the base moves (observeBase). Until then, the answer is for the base as it was.
   */
  baseConflicts(pull: PullRow): BaseConflicts | null {
    if (!this.headUnpublished(pull)) return null;
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

  /** The head is one GitHub does not have, of a pull request that is not done: whether it merges cleanly is for laatsux to work out. */
  headUnpublished(pull: PullRow): boolean {
    return stagingState(pull) !== 'done' && pull.head_sha !== (pull.published_source_sha ?? pull.published_head_sha);
  }

  /** Whether the head's conflicts with the base as it is now are still being worked out. */
  private conflictsPending(pull: PullRow): boolean {
    return this.headUnpublished(pull) && this.currentConflicts(pull) === null;
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
        // The base as baseCommit has it: the remote-tracking branch wins.
        const tracking = await git.resolve(`refs/remotes/${repo.remote}/${pull.base_ref}`);
        const base = tracking ?? (await git.resolve(`refs/heads/${pull.base_ref}`));
        // Seen just now, so the answer for it counts once it comes (currentConflicts), without
        // waiting for the next poll to see the same tip; a later look overwrites it.
        this.baseTips.set(id, base);
        const before = this.conflictsFound.get(id);
        if (before && before.head === pull.head_sha && before.branch === pull.base_ref && before.base === base && before.clean !== null) return;
        const found: BaseConflicts = {
          branch: pull.base_ref,
          ref: tracking ? `${repo.remote}/${pull.base_ref}` : pull.base_ref,
          base,
          head: pull.head_sha,
          clean: null,
          files: [],
          messages: [],
          error: null,
        };
        if (!base) found.error = `there is no ${repo.remote}/${pull.base_ref} or ${pull.base_ref} branch in this repository`;
        else {
          try {
            Object.assign(found, await git.mergeTree(base, pull.head_sha));
          } catch (e) {
            found.error = (e as Error).message;
          }
        }
        this.conflictsFound.set(id, found);
        if (JSON.stringify(found) !== JSON.stringify(before)) this.bus.emit('change', { pullId: id, type: 'base_conflicts', actor: 'git' } satisfies ChangeEvent);
      })
      .catch((e) => console.error('checking for conflicts with the base failed:', e));
  }

  addEvent(pull: PullRow, actor: Actor, type: string, data: object = {}, ts = now()): void {
    this.db.insert('events', { pull_id: pull.id, actor_id: actor.id, type, data: JSON.stringify(data), created_at: ts });
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
      if (!(await this.baseCommit(repo, input.base))) throw new HttpError(422, `base branch "${input.base}" does not exist`);
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
      if (changes.base_ref || changes.state) updated = await this.sync(updated);
      this.emit(pull.id, 'updated', actor);
    }
    return updated;
  }

  async deletePull(ctx: Ctx, actor: Actor): Promise<void> {
    const { pull, git } = ctx;
    if (actor.type === 'Bot') throw new HttpError(403, 'only the reviewer can delete a staged pull request; close it instead');
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
    if (actor.type === 'Bot') throw new HttpError(403, 'only the reviewer can pin a pull request to the top of their front page');
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

  /** Feedback from anyone but the author that the author has not been shown yet. */
  unseenFeedback(pull: PullRow): { reviews: ReviewRow[]; comments: CommentRow[] } {
    const since = pull.author_seen_at;
    const reviews = this.db.all<ReviewRow>(
      "SELECT * FROM reviews WHERE pull_id = ? AND author_id != ? AND state != 'PENDING' AND submitted_at > ? ORDER BY submitted_at",
      pull.id,
      pull.author_id,
      since,
    );
    const comments = this.db.all<CommentRow>(
      'SELECT * FROM comments WHERE pull_id = ? AND author_id != ? AND created_at > ? AND (review_id IS NULL) ORDER BY id',
      pull.id,
      pull.author_id,
      since,
    );
    return { reviews, comments };
  }

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
      const asked = this.askedAt(pull, at);
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

  /**
   * `pr wait` re-polls every few minutes. Announce that the author started waiting at once,
   * but that it stopped only if it does not come straight back, so open pages do not flicker.
   */
  private waitingStopped = new Map<number, ReturnType<typeof setTimeout>>();
  private setWaiting(id: number, delta: 1 | -1, author: Actor): void {
    // Reviewer agents start when the author says it is ready, every time it does.
    if (delta === 1) this.bus.emit('author-waiting', id);
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
      }, 3000);
      t.unref();
      this.waitingStopped.set(id, t);
    }
  }

  /** What a `pr wait` on the pull request returns now, or null while there is nothing new. */
  private waitResult(id: number): WaitResult | null {
    const checkedAt = now();
    const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id);
    if (!pull) return { status: 'closed', reviews: [], comments: [] };
    // Feedback always comes back, also when it arrives together with a close, a publish or a merge.
    const fb = this.unseenFeedback(pull);
    const published = this.db.get<EventRow>("SELECT * FROM events WHERE pull_id = ? AND type = 'published' AND created_at > ?", id, pull.author_seen_at);
    // Closed here, or merged or closed on GitHub: nothing more is coming, so every wait says so.
    const ended = pull.state === 'closed' ? 'closed' : pull.github_state === 'merged' ? 'merged' : pull.github_state === 'closed' ? 'closed_on_github' : null;
    const unseen = fb.reviews.length > 0 || fb.comments.length > 0;
    // Reviews from reviewer agents still at work are held, to come together (agentsStillReviewing).
    const held = unseen && this.agentsStillReviewing(pull, fb);
    // A head that conflicts with its base is the author's to rebase: said once per commit, with any
    // other news, but not ahead of held reviews, which a wait that returned would mark as seen.
    const conflicts = this.baseConflicts(pull)?.clean === false ? pull.head_sha : undefined;
    const fresh = conflicts !== undefined && conflicts !== pull.conflicts_told_sha;
    const status = ended ?? (published ? 'published' : held ? null : unseen ? 'feedback' : fresh ? 'conflicts' : null);
    // Not marked as seen here: the author confirms once it has shown the feedback, so a
    // response lost on the way (a restart) delivers it again instead of losing it.
    return status && { status, ...fb, seenAt: checkedAt, conflicts };
  }

  async wait(ctx: Ctx, actor: Actor, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const id = ctx.pull.id;
    const author = this.db.actorById(ctx.pull.author_id);
    // Waiting says the author is ready for review, which starts reviewer agents and lets auto-publish go ahead.
    if (actor.id !== author.id) {
      throw new HttpError(403, `only the author of this pull request (${author.login}) can wait for its feedback, not ${actor.login}. An agent carrying on the author's work sets LAATSUX_ACTOR=${author.login}.`);
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
          const asked = pull ? this.askedAt(pull) : null;
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

  /** The reviewer agents this server runs: each one actor that reviews on its own. */
  reviewerAgents(): Reviewer[] {
    return [this.codex, this.claude].filter((r) => r !== null);
  }

  /** How many reviews the reviewer agents are running, on all pull requests. */
  reviewsRunning(): number {
    return this.reviewerAgents().reduce((n, r) => n + r.runningCount(), 0);
  }

  /** Cancel the reviewer agents' reviews of the pull request, for what just happened to it (see Reviewer.cancel). Before the change is announced, so nobody hears they are still at work. */
  private cancelReviews(pull: PullRow, reason: CancelReason): void {
    for (const r of this.reviewerAgents()) r.cancel(pull, reason);
  }

  /**
   * Whether the feedback waits for more of its kind: it is all reviews from reviewer agents, and
   * another reviewer agent is still at work on the pull request. The author then gets the
   * reviews of a commit together and answers them in one round. Anything from anyone else comes
   * back at once, with what the reviewer agents posted so far.
   */
  private agentsStillReviewing(pull: PullRow, fb: { reviews: ReviewRow[]; comments: CommentRow[] }): boolean {
    if (fb.comments.length || !this.reviewersAtWork(pull).length) return false;
    const agents = new Set(this.reviewerAgents().map((r) => r.actor().id));
    return fb.reviews.every((r) => agents.has(r.author_id));
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
   * say (the author answered their comments without a new commit, or a review failed). `pr wait`
   * says so once per commit, so the author asks the reviewer to review it. Not under
   * auto-publish, which publishes then instead, nor for a commit that is published already, nor
   * before it is known whether the commit conflicts with its base, which the author hears of first.
   */
  private agentsDone(pull: PullRow): AgentsDone | null {
    if (pull.state === 'closed' || pull.auto_publish || pull.agents_done_sha === pull.head_sha) return null;
    if (pull.head_sha === (pull.published_source_sha ?? pull.published_head_sha) || this.conflictsPending(pull)) return null;
    const author = this.db.actorById(pull.author_id).login;
    const reviewers = this.reviewerAgents().map((r) => ({ login: r.actor().login, status: r.headStatus(pull) }));
    if (reviewers.some((r) => ['reviewing', 'queued', 'interrupted', 'unreviewed'].includes(r.status.state))) return null;
    const stopped = this.stoppedText(pull);
    const texts = reviewers.flatMap((r) => reviewerAgentText(r.login, r.status, pull, author, true, !!stopped) ?? []);
    // Once, whatever each reviewer agent made of the commit.
    return { sha: pull.head_sha, reviewers: stopped ? [...texts, stopped] : texts };
  }

  /**
   * Whether the agents are done with the pull request: every reviewer agent is done with the
   * head, and the author is waiting with all feedback seen. Auto-publish also needs none of
   * the threads the reviewer started to be open.
   */
  readiness(pull: PullRow): Readiness {
    const reviewers = this.reviewerAgents().map((r) => ({ login: r.actor().login, engine: r.engine, status: r.headStatus(pull) }));
    const authorWaiting = (this.waiters.get(pull.id) ?? 0) > 0;
    const fb = this.unseenFeedback(pull);
    const unseen = fb.reviews.length + fb.comments.length;
    const openThreads = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments c JOIN actors a ON a.id = c.author_id
       WHERE c.pull_id = ? AND c.kind = 'review' AND c.in_reply_to_id IS NULL AND c.resolved_at IS NULL AND a.type = 'User'
         AND (c.review_id IS NULL OR c.review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))`,
      pull.id,
    )!.n;
    const agentsDone = reviewers.every((r) => r.status.done) && authorWaiting && unseen === 0;
    return { reviewers, authorWaiting, unseen, openThreads, agentsDone };
  }

  /** Whose move the pull request waits for, and why (see Turn). */
  turn(pull: PullRow): Turn {
    // Closed here, or merged or closed on GitHub: nothing more is coming.
    if (stagingState(pull) === 'done') return { whose: 'none', reasons: [] };
    const r = this.readiness(pull);
    const author = this.db.actorById(pull.author_id).login;
    const acted = this.authorActedAt(pull);
    // The author's turn: from `pr wait` or `pr view --comments` handing it feedback that asks
    // something of it (markSeen) to its next action.
    const working = pull.author_handed_at !== null && pull.author_handed_at > acted;
    // Such feedback it has not been handed yet. Not waiting, it hears of it only when the reviewer says so.
    const asked = this.askedAt(pull);
    const unseen = asked !== null && asked > pull.author_seen_at;
    // A wait that just ended counts for a few seconds more (see setWaiting), long enough for the
    // author to confirm the feedback it was handed.
    const waiting = r.authorWaiting || this.waitingStopped.has(pull.id);
    const state: AuthorState = working ? 'working' : unseen ? 'unseen' : waiting ? 'waiting' : 'stopped';

    const reasons: TurnReason[] = [];
    if (working) reasons.push({ kind: 'author', state, text: `${author} is working on the feedback`, since: pull.author_handed_at });
    if (unseen) reasons.push({ kind: 'author', state: 'unseen', text: `${author} has not seen the latest feedback` });
    if (state === 'waiting') reasons.push({ kind: 'author', state, text: `${author} is waiting for review`, since: this.waitingSince.get(pull.id) ?? null });
    // Not waiting, it does not hear of anything new: the reviewer has to tell it.
    if (state === 'stopped' || (state === 'unseen' && !waiting)) reasons.push({ kind: 'author', state: 'stopped', text: `${author} is not waiting`, since: acted });

    const atWork = r.reviewers.some((x) => x.status.state === 'reviewing' || x.status.state === 'queued');
    // A waiting author starts the reviewer agents that have not reviewed its head.
    const next = state === 'waiting' && r.reviewers.some((x) => x.status.state === 'unreviewed');
    const unpublished = this.unpublishedChanges(pull);
    // A review that failed after publishing (asked for by hand) needs the reviewer all the same.
    const failed = r.reviewers.some((x) => x.status.state === 'failed' && !!x.status.failedAt && x.status.failedAt > (pull.published_at ?? ''));
    // So does what GitHub has once it is published: failed checks, changes requested, threads, a
    // conflict. It is for the reviewer to act on (or hand to an agent), not feedback for the author.
    const github = githubAsks(githubStatus(pull), pull.base_ref);
    // Feedback being handed over (the author waits) makes it the author's turn; feedback it is not
    // waiting for is the reviewer's to pass on, published or not.
    const whose: Whose = atWork
      ? 'reviewer_agents'
      : working || (unseen && waiting)
        ? 'author'
        : next
          ? 'reviewer_agents'
          : pull.state === 'published' && !unpublished.length && !failed && !unseen && !github.length
            ? 'none'
            : 'reviewer';
    if (whose === 'none') return { whose, reasons: [] };

    if (whose === 'reviewer') reasons.push(...this.sinceReview(pull, author));
    const stopped = this.stoppedText(pull);
    for (const { login, engine, status } of r.reviewers) {
      const text = reviewerAgentText(login, status, pull, author, state === 'waiting', !!stopped);
      if (text) reasons.push({ kind: 'reviewer_agent', state: status.state, text, since: status.startedAt, engine });
    }
    // Once, whatever each reviewer agent is at.
    if (stopped) reasons.push({ kind: 'reviewer_agent', state: 'capped', text: stopped });
    // The agents at work come first, since that is whose turn it is.
    if (whose === 'reviewer_agents') reasons.sort((a, b) => Number(b.kind === 'reviewer_agent') - Number(a.kind === 'reviewer_agent'));

    const reviews = this.db.all<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND state != 'PENDING' ORDER BY id", pull.id);
    const decision = reviewDecision(reviews);
    if (decision === 'APPROVED') reasons.push({ kind: 'approved', text: 'approved' });
    if (decision === 'CHANGES_REQUESTED') reasons.push({ kind: 'changes_requested', text: 'changes requested' });
    const unresolved = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comments WHERE pull_id = ? AND kind = 'review' AND in_reply_to_id IS NULL AND resolved_at IS NULL
         AND (review_id IS NULL OR review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))`,
      pull.id,
    )!.n;
    if (unresolved) reasons.push({ kind: 'threads', text: `${unresolved} unresolved thread${unresolved === 1 ? '' : 's'}` });
    if (unpublished.length) reasons.push({ kind: 'unpublished', text: `update not published: ${unpublished.join(', ')}` });
    const conflicts = this.baseConflicts(pull);
    if (conflicts?.clean === false) {
      const { files } = conflicts;
      const where = files.length === 1 ? ` in ${files[0]}` : files.length ? ` in ${files.length} files` : '';
      reasons.push({ kind: 'conflicts', text: `conflicts with ${conflicts.ref}${where}` });
    }
    for (const text of github) reasons.push({ kind: 'github', text });
    return { whose, reasons };
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

  /** When the author last did something: staged, pushed, edited, commented (or edited a comment), resolved a thread, or waited with nothing new to read. */
  private authorActedAt(pull: PullRow): string {
    const at = this.db.get<{ at: string }>(
      `SELECT MAX(at) AS at FROM (
         SELECT created_at AS at FROM pulls WHERE id = ?1
         UNION ALL SELECT author_waited_at FROM pulls WHERE id = ?1
         UNION ALL SELECT created_at FROM events WHERE pull_id = ?1 AND actor_id = ?2
         UNION ALL SELECT updated_at FROM comments WHERE pull_id = ?1 AND author_id = ?2
         UNION ALL SELECT resolved_at FROM comments WHERE pull_id = ?1 AND resolved_by_id = ?2)`,
      pull.id,
      pull.author_id,
    )!.at;
    return at;
  }

  /**
   * When someone last asked something of the author (up to `until`): a review or comment from
   * anyone else. An approval without comments asks nothing, nor does a reviewer agent's review
   * that found nothing.
   */
  private askedAt(pull: PullRow, until = '9999'): string | null {
    return this.db.get<{ at: string | null }>(
      `SELECT MAX(at) AS at FROM (
         SELECT r.submitted_at AS at FROM reviews r
          WHERE r.pull_id = ?1 AND r.author_id != ?2 AND r.state != 'PENDING'
            AND (r.state != 'APPROVED' OR EXISTS (SELECT 1 FROM comments c WHERE c.review_id = r.id))
            AND NOT EXISTS (SELECT 1 FROM review_runs x WHERE x.review_id = r.id AND x.findings = 0)
         UNION ALL SELECT created_at FROM comments WHERE pull_id = ?1 AND author_id != ?2 AND review_id IS NULL)
       WHERE at <= ?3`,
      pull.id,
      pull.author_id,
      until,
    )!.at;
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

  // ------------------------------------------------------------ auto-publish

  /**
   * Auto-publish is on and may publish now: there is something GitHub does not have yet, the agents
   * are done, none of the reviewer's threads is open, and the head is known not to conflict with
   * its base as it is now. It stays on after publishing, for the next update, until the pull
   * request is merged or closed (see AutoPublishOff).
   */
  autoPublishReady(pull: PullRow): boolean {
    if (!pull.auto_publish || pull.state === 'closed') return false;
    if (pull.published_url && !this.unpublishedChanges(pull).length) return false;
    // Known to merge cleanly into the base as it is now: not while that is worked out, nor when git could not tell.
    if (this.headUnpublished(pull)) {
      const conflicts = this.currentConflicts(pull);
      if (conflicts?.clean !== true) return false;
    }
    const r = this.readiness(pull);
    return r.agentsDone && r.openThreads === 0;
  }

  /** Auto-publish's options while it is on, or null. */
  autoPublish(pull: PullRow): AutoPublish | null {
    if (!pull.auto_publish) return null;
    const auto = JSON.parse(pull.auto_publish) as AutoPublish;
    // Approvals from before auto-merge was an option leave it out.
    return { ...auto, autoMerge: auto.autoMerge ?? null };
  }

  /**
   * Approve publishing in advance: laatsux publishes on its own once the agents are done (see
   * readiness), even commits pushed after this. The options are fixed now, as the publish box
   * shows them: signing and draft as checked, force if it was checked and turns out to be needed,
   * and auto-merge with the merge method `autoMerge`.
   */
  async enableAutoPublish(ctx: Ctx, opts: { sign?: boolean; draft?: boolean; force?: boolean; autoMerge?: MergeMethod }, actor: Actor): Promise<AutoPublish> {
    const { pull, repo } = ctx;
    if (actor.type === 'Bot') throw new HttpError(403, 'auto-publish is for the reviewer, like publishing; ask the user to turn it on from laatsux');
    if (pull.state === 'closed') throw new HttpError(422, 'reopen the pull request before turning on auto-publish');
    if (pull.github_state === 'merged') throw new HttpError(422, 'this pull request was merged on GitHub; there is nothing left to publish');
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
    if (actor.type === 'Bot') throw new HttpError(403, 'only the reviewer can turn off auto-publish');
    if (this.db.transaction(() => this.autoPublishOff(ctx.pull, actor, 'cancelled'))) this.emit(ctx.pull.id, 'auto_publish', actor);
  }

  /**
   * Auto-publish could not publish under `approval` (pulls.auto_publish as the attempt read it):
   * record why, and turn it off. Not when that approval has been turned off or replaced since:
   * the failure belonged to it, and a newer approval makes its own attempt.
   */
  autoPublishFailed(pull: PullRow, actor: Actor, error: string, approval: string): void {
    const failed = this.db.transaction(() => {
      if (this.db.run('UPDATE pulls SET auto_publish = NULL WHERE id = ? AND auto_publish = ?', pull.id, approval).changes === 0) return false;
      this.addEvent(pull, actor, 'auto_publish_failed', { error: error.slice(0, 4000) });
      return true;
    });
    if (failed) this.emit(pull.id, 'auto_publish_failed', actor);
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
    return Math.max(0, ...this.reviewerAgents().map((r) => r.automaticReviewsStarted(pull)));
  }

  /**
   * The reviewer's call that the reviewer agents have reviewed enough. A running review finishes
   * and reaches the author; while stopped, no reviewer agent starts an automatic review and each
   * counts as done (capped), whatever its limit and runs say, so the author's next `pr wait`
   * hands its commit to the reviewer. Asking a reviewer agent by hand still works.
   */
  stopIterating(ctx: Ctx, actor: Actor): IterationsStopped {
    const { pull } = ctx;
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
    // Decided in the database, like stopIterating: ctx may be from before the stop.
    const resumed = this.db.transaction(() => {
      if (this.db.run('UPDATE pulls SET iterations_stopped = NULL WHERE id = ? AND iterations_stopped IS NOT NULL', pull.id).changes === 0) return false;
      this.addEvent(pull, actor, 'iterations_resumed');
      return true;
    });
    if (!resumed) return false;
    this.emit(pull.id, 'updated', actor);
    if ((this.waiters.get(pull.id) ?? 0) > 0) for (const r of this.reviewerAgents()) r.consider(pull.id);
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
    const theirs = await this.onGitHub(ctx);
    if (!theirs) return false;
    if (!sign) return !(await git.isAncestor(theirs, pull.head_sha));
    const { shas, versions } = await this.signedVersions(ctx, pull, async () => null);
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
   * The commit the branch has on GitHub, as far as laatsux knows: what it published last or,
   * before the first publish, the branch as last fetched or pushed. A force-push leases against it.
   */
  private async onGitHub(ctx: Ctx): Promise<string | null> {
    const { repo, pull, git } = ctx;
    return pull.published_head_sha ?? (await git.resolve(`refs/remotes/${repo.remote}/${pull.head_ref}`));
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
   * and authors stay as the agent made them.
   */
  async signCommits(ctx: Ctx, pull: PullRow, timeoutMs?: number): Promise<{ head: string; signed: number }> {
    const { repo, git } = ctx;
    const signer = await this.signer(ctx);
    if (!signer) throw new HttpError(422, 'set user.name and user.email in git to sign commits');
    let signed = 0;
    const { versions } = await this.signedVersions(ctx, pull, async (sha, c, parents) => {
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
      if (r.code !== 0) throw new HttpError(502, `signing commit ${sha.slice(0, 7)} failed:\n${failure(r, 'a passphrase or a 1Password prompt nobody answered?')}`);
      const copy = r.stdout.trim();
      this.db.run(
        'INSERT INTO signed_commits (repo_id, source_sha, signed_sha) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET signed_sha = excluded.signed_sha',
        repo.id,
        sha,
        copy,
      );
      signed++;
      return copy;
    });
    return { head: versions.get(pull.head_sha) ?? pull.head_sha, signed };
  }

  /**
   * What a signed publish pushes for each commit of the pull request: a copy made before, the
   * commit itself when it is signed and its parents stay, or a new copy from `copy`. Copies are
   * remembered per source commit, so publishing again after the agent added commits reuses them
   * and GitHub sees a fast-forward. To predict without signing, `copy` returns null: a copy
   * still to be made (and so is every copy on top of it).
   */
  private async signedVersions(
    ctx: Ctx,
    pull: PullRow,
    copy: (sha: string, c: RawCommit, parents: string[]) => Promise<string | null>,
  ): Promise<{ shas: string[]; versions: Map<string, string | null> }> {
    const { repo, git } = ctx;
    const versions = new Map<string, string | null>(
      this.db.all<{ source_sha: string; signed_sha: string }>('SELECT source_sha, signed_sha FROM signed_commits WHERE repo_id = ?', repo.id).map((r) => [r.source_sha, r.signed_sha]),
    );
    const shas = (await git.out(['rev-list', '--reverse', '--topo-order', `${pull.base_sha}..${pull.head_sha}`])).split('\n').filter(Boolean);
    for (const sha of shas) {
      const known = versions.get(sha);
      if (known && (await git.exists(known))) continue;
      const c = await git.rawCommit(sha);
      const parents = c.parents.map((p) => (versions.has(p) ? (versions.get(p) as string | null) : p));
      if (c.signed && parents.every((p, i) => p === c.parents[i])) versions.set(sha, sha);
      else versions.set(sha, parents.includes(null) ? null : await copy(sha, c, parents as string[]));
    }
    return { shas, versions };
  }

  /**
   * Push the head and open (or update) the pull request on GitHub. `approval` is auto-publish
   * doing it, under that approval (pulls.auto_publish as the attempt read it): the attempt only
   * goes ahead while that exact approval is in force, and nobody is there to answer a prompt,
   * so each step gets UNATTENDED_TIMEOUT_MS. `autoMerge` turns on auto-merge on GitHub afterwards,
   * with that merge method: auto-publish's, fixed when it was turned on, or the one in settings
   * when the request came in.
   */
  async publish(
    ctx: Ctx,
    opts: { draft?: boolean; force?: boolean; expected?: string; sign?: boolean; duringReview?: boolean; approval?: string; autoMerge?: MergeMethod },
    actor: Actor,
  ): Promise<PullRow> {
    const { repo, git } = ctx;
    if (actor.type === 'Bot') throw new HttpError(403, 'publishing is for the reviewer; ask the user to publish from laatsux');
    const pull = await this.sync(ctx.pull);
    const auto = opts.approval !== undefined;
    // Turned off or replaced, or new feedback, since auto-publish decided to go ahead.
    if (auto && !this.stillApproved(pull, opts.approval!)) throw new HttpError(412, 'auto-publish was turned off or replaced, or the agents are no longer done');
    if (opts.expected && opts.expected !== publishFingerprint(pull)) {
      throw new HttpError(412, 'The pull request changed after this page was loaded (new commits, title, description or base). Refresh and review the latest version before publishing.');
    }
    if (pull.state === 'closed') throw new HttpError(422, 'reopen the pull request before publishing it');
    if (pull.github_state === 'merged') throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
    if (!repo.github_slug) throw new HttpError(422, `remote "${repo.remote}" is not a GitHub repository`);
    // Decided here, not by the page: a page loaded before the review started does not know of it.
    const busy = this.reviewersAtWork(pull);
    if (busy.length && !opts.duringReview) {
      const what = (sha: string) => (sha === pull.head_sha ? 'this commit' : `an earlier commit (${sha.slice(0, 7)})`);
      const doing = busy.map(({ reviewer, work }) => `${reviewer.actor().login} is ${work.status === 'QUEUED' ? 'about to review' : 'still reviewing'} ${what(work.head_sha)}`);
      throw new HttpError(428, `${doing.join(', and ')}, and ${busy.length > 1 ? 'their reviews' : 'its review'} may ask for changes. Publishing now cancels ${busy.length > 1 ? 'them' : 'it'}.`);
    }
    // Refused before anything is pushed, rather than published without the auto-merge asked for.
    const mergeMethod = opts.autoMerge ? await this.autoMergeMethod(repo, opts.autoMerge) : null;
    const cwd = repo.work_dir ?? tmpdir();
    const timeoutMs = auto ? UNATTENDED_TIMEOUT_MS : undefined;

    let pushed = pull.head_sha;
    let signed = 0;
    if (opts.sign ?? (await this.signsByDefault(ctx))) {
      ({ head: pushed, signed } = await this.signCommits(ctx, pull, timeoutMs));
      // The signed copies exist only here and on GitHub; keep them from being garbage collected.
      if (pushed !== pull.head_sha) {
        const ref = this.ref(pull, 'published');
        const at = await git.resolve(ref);
        // It holds the copies an earlier publish pushed, if any: commits this server signed.
        if (!at || this.db.get('SELECT 1 FROM signed_commits WHERE repo_id = ? AND signed_sha = ?', repo.id, at)) await this.moveRef(git, ref, at, pushed);
        else console.error(`left ${ref} alone in ${git.gitDir}: it points at ${at}, which laatsux did not sign`);
      }
    }

    // Force is decided on the commit actually pushed, signed copies and all, and used only when allowed.
    const theirs = await this.onGitHub(ctx);
    const force = !!theirs && !(await git.isAncestor(theirs, pushed));
    if (force && !opts.force) {
      throw new HttpError(
        409,
        `The branch on GitHub has commits this push would replace (a rewritten history, or the agent's unsigned commits that signing replaces with copies), and ${auto ? 'force-pushing was not chosen when auto-publish was turned on' : 'force-pushing was not chosen'}.`,
      );
    }
    const branch = `refs/heads/${pull.head_ref}`;
    const args = ['push'];
    // Overwrite only the commit seen on GitHub, never commits added there since.
    if (force) args.push(`--force-with-lease=${branch}:${theirs}`);
    args.push(repo.remote, `${pushed}:${branch}`);
    if (auto) {
      // Every await above (signing can wait minutes for a prompt) lets a cancel, a replaced
      // approval, new feedback or a starting review come in. So the last check comes after all
      // of them: the approval is the same, the agents are still done, the pull request is unchanged.
      const latest = await this.sync(pull);
      if (publishFingerprint(latest) !== publishFingerprint(pull) || !this.stillApproved(latest, opts.approval!)) {
        throw new HttpError(412, 'the pull request or auto-publish changed before the push');
      }
    }
    // Merged on GitHub while this publish signed or looked things up (following found it meanwhile):
    // pushing now would add to a merged pull request, or bring back a branch GitHub deleted.
    if (this.db.get<Pick<PullRow, 'github_state'>>('SELECT github_state FROM pulls WHERE id = ?', pull.id)?.github_state === 'merged') {
      throw new HttpError(422, 'this pull request was merged on GitHub; stage a new pull request for further changes');
    }
    // No await may come between the checks above and this call, which starts the push at once.
    const push = await git.run(args, { cwd, env: UNPROMPTED, allowFail: true, timeoutMs });
    if (push.code !== 0) {
      const stale = /stale info/.test(push.stderr);
      const rejected = stale || /\[rejected\]|non-fast-forward|fetch first/.test(push.stderr);
      const why = stale
        ? ' (the branch on GitHub changed since it was last published, for example by "Commit suggestion" or "Update branch"; bring those commits into the branch first)'
        : rejected
          ? ' (the remote branch has commits that are not in this pull request)'
          : '';
      throw new HttpError(rejected ? 409 : 502, `git push failed${why}:\n${failure(push)}`);
    }

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
        // Closed on GitHub and published again: follow it again, in case it was reopened there.
        ...(pull.github_state === 'closed' ? { github_state: null } : {}),
      });
      // Auto-publish stays on, whoever published: it publishes the next update too, until the merge.
      this.addEvent(pull, actor, 'published', { url, head: pushed, source: pull.head_sha, signed, first, force, auto }, ts);
    });
    // Published during a review (a second click): its findings would come too late.
    this.cancelReviews(this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!, 'published');
    this.emit(pull.id, auto ? 'auto_published' : 'published', actor);
    if (mergeMethod) await this.enableAutoMerge(ctx, url!, pushed, mergeMethod, actor, timeoutMs);
    return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
  }

  /**
   * Turn on auto-merge for the pull request just published: GitHub merges it with `method`
   * once its requirements (such as required checks) are met. `--match-head-commit` makes GitHub
   * refuse when the branch there is no longer the commit laatsux pushed, but it does not pin the
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
    // (the merge guard before a push, auto-publish turning off, the pull request freezing).
    if (merged && view) this.recordGithubEnd(pull.id, view);
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
      throw new HttpError(422, `${slug} does not allow ${method} merges, the merge method in laatsux's settings (it allows ${merging.methods.join(', ')}). Change it under Settings → Publishing.`);
    }
    return method;
  }

  /** What came of the last time laatsux turned on auto-merge for this pull request on GitHub; null if it never did. */
  autoMerge(pull: PullRow): AutoMerge | null {
    const e = this.db.get<EventRow>("SELECT * FROM events WHERE pull_id = ? AND type IN ('auto_merge_enabled', 'auto_merge_failed') ORDER BY id DESC LIMIT 1", pull.id);
    if (!e) return null;
    const data = JSON.parse(e.data);
    const state = e.type === 'auto_merge_failed' ? 'failed' : data.merged === true ? 'merged' : data.merged === false ? 'enabled' : 'requested';
    return { state, by: e.actor_id, at: e.created_at, url: data.url, method: data.method, error: data.error };
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
};

/**
 * A reviewer agent's progress with the head, as a reason in Turn; null when it has nothing to do
 * with the pull request, or no automatic reviews left because the reviewer stopped them (`stopped`),
 * which stoppedText says once for all of them.
 */
function reviewerAgentText(login: string, status: HeadStatus, pull: PullRow, author: string, authorWaiting: boolean, stopped: boolean): string | null {
  const sha = status.commit.slice(0, 7);
  switch (status.state) {
    case 'reviewing':
      return status.commit === pull.head_sha ? `${login} is reviewing ${sha}` : `${login} is reviewing an earlier commit, ${sha}`;
    case 'queued':
      return `${login} is about to review ${sha}`;
    case 'interrupted':
      return `${login}'s review of ${sha} was interrupted by a restart; it will run again`;
    case 'unreviewed':
      return authorWaiting ? `${login} is about to review ${sha}` : `${login} reviews ${sha} when ${author} waits for review`;
    case 'findings':
      return `${login} commented on ${sha}`;
    case 'failed':
      return `${login}'s review of ${sha} failed`;
    case 'cancelled':
      return `${login}'s review of ${sha} was cancelled${status.cancelled ? ` (${CANCELLED[status.cancelled]})` : ''}`;
    case 'clean':
      return `${login} found nothing in ${sha}`;
    case 'capped':
      if (stopped) return null;
      return status.automatic ? `${login} used ${status.automatic.used} of ${status.automatic.limit} automatic reviews` : `${login} has used up its automatic reviews`;
    case 'off':
      return null;
  }
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

/** What laatsux last saw of a published pull request on GitHub, while it is open there. */
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
