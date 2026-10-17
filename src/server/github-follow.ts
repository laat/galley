// What galley reads about a published pull request on GitHub while it follows it, to show the
// reviewer how it stands there: whether it is merged or closed, its checks and the workflow runs
// on its head, a pending Copilot review, the review decision and who is asked to review,
// unresolved review threads, whether it conflicts with its base, and whether auto-merge is on. It
// is information for the reviewer, not feedback for the author agent. One GraphQL query per
// repository asks for all of the repository's followed pull requests (PULL_FIELDS, aliased by
// staged pull id); one with more review threads than that holds gets earlier pages (earlierThreads).

const PAGE = 'pageInfo{hasPreviousPage startCursor}';
const THREAD_FIELDS = 'id isResolved isOutdated path line originalLine startLine diffSide comments(last:20){nodes{databaseId author{login} body createdAt url diffHunk}}';

/** A requested team's name. It needs the read:org scope: without it, GitHub refuses the whole query. */
const TEAM = ' ...on Team{combinedSlug}';

/** What is asked about each followed pull request. Costs about one rate-limit point per pull request. */
export const PULL_FIELDS = `state headRefOid mergeable mergeStateStatus reviewDecision mergedAt closedAt mergedBy{login} mergeCommit{oid} autoMergeRequest{enabledAt}
  reviewRequests(first:20){totalCount nodes{requestedReviewer{...on User{login} ...on Bot{login} ...on Mannequin{login}${TEAM}}}}
  commits(last:1){nodes{commit{
    statusCheckRollup{state contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{databaseId name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
      ...on StatusContext{context state targetUrl}}}}
    checkSuites(first:50){nodes{status workflowRun{databaseId url workflow{name}}}}}}}
  reviewThreads(last:50){${PAGE} nodes{${THREAD_FIELDS}}}
  timelineItems(last:30,itemTypes:[CLOSED_EVENT,REVIEW_REQUESTED_EVENT,PULL_REQUEST_REVIEW]){nodes{__typename
    ...on ClosedEvent{actor{login}}
    ...on ReviewRequestedEvent{requestedReviewer{...on Bot{login} ...on User{login}}}
    ...on PullRequestReview{author{login}}}}`.replace(/\s+/g, ' ');

/** PULL_FIELDS for a token without the read:org scope: requested teams are counted, not named. */
export const PULL_FIELDS_WITHOUT_TEAMS = PULL_FIELDS.replace(TEAM, '');

/** The query for the page of a pull request's review threads before `$cursor`. */
export function earlierThreadsQuery(number: number): string {
  return `query($owner:String!,$name:String!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:${number}){reviewThreads(last:100,before:$cursor){${PAGE} nodes{${THREAD_FIELDS}}}}}}`;
}

type Login = { login: string } | null;
type PageInfo = { hasPreviousPage: boolean; startCursor: string | null };
type Nodes<T> = { nodes?: (T | null)[] | null; pageInfo?: PageInfo } | null;

type RawThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  comments: Nodes<{ databaseId: number; author: Login; body: string; createdAt: string; url: string; diffHunk: string | null }>;
};

/** A pull request as GitHub's GraphQL API answers PULL_FIELDS. Everything but `state` may be missing. */
export interface GithubPull {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid?: string;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergedBy?: Login;
  mergeCommit?: { oid: string } | null;
  /** Null while auto-merge is off. */
  autoMergeRequest?: { enabledAt: string | null } | null;
  /** Users, bots and teams asked to review who have not yet. */
  reviewRequests?: Nodes<{ requestedReviewer: { login?: string; combinedSlug?: string } | null }> & { totalCount?: number };
  commits?: Nodes<{
    commit: {
      /** `state` sums up every check, also those past the first page of `contexts`. */
      statusCheckRollup?: { state?: string; contexts: Nodes<RawCheck> & { totalCount?: number } } | null;
      checkSuites?: Nodes<{ status: string; workflowRun: { databaseId: number; url: string; workflow: { name: string } | null } | null }>;
    };
  }>;
  reviewThreads?: Nodes<RawThread>;
  timelineItems?: Nodes<{ __typename: string; actor?: Login; requestedReviewer?: Login; author?: Login }>;
}

type RawCheck =
  | { __typename: 'CheckRun'; databaseId: number; name: string; status: string; conclusion: string | null; detailsUrl: string | null; checkSuite?: { workflowRun: { workflow: { name: string } | null } | null } | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null };

export interface GithubCheck {
  /** A check run (an Actions job, or another app's check) or a commit status. */
  kind: 'CheckRun' | 'StatusContext';
  name: string;
  workflow: string | null;
  /** As GitHub says it: a check run's status and conclusion, or a commit status's state. */
  status: string;
  conclusion: string | null;
  /** How the check stands now, as GitHub last said it; a job run again shows its new result. */
  result: 'pending' | 'passed' | 'failed' | 'skipped';
  url: string | null;
  /** The Actions job. */
  job: number | null;
}

export interface GithubThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  outdated: boolean;
  url: string;
  comments: { id: number; author: string; body: string; at: string; url: string }[];
}

/** What galley last saw of an open published pull request on GitHub (pulls.github_status). */
export interface GithubStatus {
  checkedAt: string;
  /** The head commit on GitHub, which the checks are about. */
  head: string | null;
  reviewDecision: string | null;
  /** Who GitHub asks to review and has not yet, on the first page: logins, and teams as org/team (reviewRequestsTotal counts them all). */
  reviewRequests?: string[];
  reviewRequestsTotal?: number;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  /** Auto-merge is on: GitHub merges it once it can. Null when GitHub did not say (missing in a status stored before galley asked). */
  autoMerge?: boolean | null;
  /** Conflicting with its base, as last known: GitHub says UNKNOWN for a while after each push. */
  conflicting: boolean;
  /** The first page of checks: there may be more (checksTotal). */
  checks: GithubCheck[];
  /** How all of the checks stand together, as GitHub sums them up; null without checks. */
  checksResult?: 'failed' | 'pending' | 'passed' | null;
  /** How many checks there are, also past the first page. */
  checksTotal?: number;
  /** Workflow runs on the head still queued or running, some of them outside the checks (automated reviewers). */
  runs: { id: number; name: string; url: string }[];
  /** Copilot was asked to review and has not yet. */
  copilotPending: boolean;
  /** Unresolved review threads, all of them (earlierThreads reads past the first page). */
  threads: GithubThread[];
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE', 'ERROR']);

function check(c: RawCheck): GithubCheck {
  if (c.__typename === 'StatusContext') {
    const result = c.state === 'SUCCESS' ? 'passed' : FAILED.has(c.state) ? 'failed' : 'pending';
    return { kind: c.__typename, name: c.context, workflow: null, status: c.state, conclusion: null, result, url: c.targetUrl, job: null };
  }
  const result = c.status !== 'COMPLETED' ? 'pending' : c.conclusion === 'SKIPPED' ? 'skipped' : c.conclusion && FAILED.has(c.conclusion) ? 'failed' : 'passed';
  const workflow = c.checkSuite?.workflowRun?.workflow?.name ?? null;
  return { kind: c.__typename, name: c.name, workflow, status: c.status, conclusion: c.conclusion, result, url: c.detailsUrl, job: workflow ? c.databaseId : null };
}

export const present = <T>(nodes: Nodes<T> | undefined): T[] => (nodes?.nodes ?? []).filter((n): n is T => n != null);

/** A check's name as GitHub's checks list shows it: "CI / test". */
export function checkName(c: GithubCheck): string {
  return c.workflow ? `${c.workflow} / ${c.name}` : c.name;
}

const ROLLUP: Record<string, GithubStatus['checksResult']> = { SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending' };

/**
 * Read GitHub's answer about an open pull request, given what galley saw before. Without
 * `complete`, some earlier pages of review threads could not be read: the threads on them stay as
 * they were last seen.
 */
export function readGithub(node: GithubPull, previous: GithubStatus | null, checkedAt: string, complete = true): GithubStatus {
  const commit = present(node.commits)[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  // Apps that never post a check leave a suite queued without a workflow run: only Actions runs count.
  const runs = present(commit?.checkSuites).flatMap((s) =>
    s.workflowRun && s.status !== 'COMPLETED' ? [{ id: s.workflowRun.databaseId, name: s.workflowRun.workflow?.name ?? 'workflow', url: s.workflowRun.url }] : [],
  );
  // babysit's rule: Copilot's review is pending when its last item on the timeline is a request.
  const copilot = present(node.timelineItems).findLast((i) => /copilot/i.test((i.requestedReviewer ?? i.author)?.login ?? ''));
  const read = present(node.reviewThreads);
  const onPagesRead = new Set(read.map((t) => t.id));
  const kept = complete ? [] : (previous?.threads ?? []).filter((t) => !onPagesRead.has(t.id));
  const threads = read
    .filter((t) => !t.isResolved)
    .map((t) => {
      const cs = present(t.comments);
      return {
        id: t.id,
        path: t.path,
        line: t.line,
        originalLine: t.originalLine,
        startLine: t.startLine,
        side: t.diffSide,
        outdated: t.isOutdated,
        url: cs[0]?.url ?? '',
        comments: cs.map((c) => ({ id: c.databaseId, author: c.author?.login ?? 'ghost', body: c.body, at: c.createdAt, url: c.url })),
      };
    });
  const mergeable = node.mergeable ?? 'UNKNOWN';
  const requested = present(node.reviewRequests).flatMap(({ requestedReviewer: r }) => {
    const name = r?.login ?? r?.combinedSlug;
    return name ? [name] : [];
  });
  return {
    checkedAt,
    head: node.headRefOid ?? null,
    reviewDecision: node.reviewDecision ?? null,
    reviewRequests: requested,
    reviewRequestsTotal: Math.max(node.reviewRequests?.totalCount ?? 0, requested.length),
    mergeable,
    mergeStateStatus: node.mergeStateStatus ?? 'UNKNOWN',
    autoMerge: node.autoMergeRequest === undefined ? null : node.autoMergeRequest !== null,
    conflicting: mergeable === 'CONFLICTING' || (mergeable === 'UNKNOWN' && !!previous?.conflicting),
    checks: present(rollup?.contexts).map(check),
    checksResult: rollup?.state ? (ROLLUP[rollup.state] ?? null) : null,
    checksTotal: rollup?.contexts?.totalCount ?? present(rollup?.contexts).length,
    runs,
    copilotPending: copilot?.__typename === 'ReviewRequestedEvent',
    threads: [...kept, ...threads],
  };
}

/** The cursor for the page of review threads before the ones `node` holds, while there are more. */
export function earlierThreads(node: GithubPull): string | null {
  const page = node.reviewThreads?.pageInfo;
  return page?.hasPreviousPage ? page.startCursor : null;
}

/** Put the page of threads before into `node`, so it reads as one longer page. */
export function prependThreads(node: GithubPull, page: { pageInfo?: PageInfo; nodes?: (RawThread | null)[] | null }): void {
  node.reviewThreads = { pageInfo: page.pageInfo, nodes: [...(page.nodes ?? []), ...(node.reviewThreads?.nodes ?? [])] };
}

/** Something on GitHub is still under way (checks, workflow runs, Copilot, the merge check), so galley asks more often. */
export function githubBusy(status: GithubStatus | null): boolean {
  return !status || checksSummary(status).result === 'pending' || status.runs.length > 0 || status.copilotPending || status.mergeable === 'UNKNOWN';
}

/**
 * How the checks stand: counts of those on the first page (`shown` of `total`), and the result of
 * all of them, as GitHub sums it up (worked out from the first page for a status stored before).
 */
export function checksSummary(status: Pick<GithubStatus, 'checks' | 'checksResult' | 'checksTotal'>): {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  shown: number;
  total: number;
  result: 'failed' | 'pending' | 'passed' | null;
} {
  const { checks } = status;
  const n = (r: GithubCheck['result']) => checks.filter((c) => c.result === r).length;
  const counts = { passed: n('passed'), failed: n('failed'), pending: n('pending'), skipped: n('skipped') };
  const listed = !checks.length ? null : counts.failed ? 'failed' : counts.pending ? 'pending' : 'passed';
  return { ...counts, shown: checks.length, total: Math.max(status.checksTotal ?? 0, checks.length), result: status.checksResult ?? listed };
}

/**
 * What on GitHub waits for the reviewer, as reasons for whose turn it is: failed checks, changes
 * requested, unresolved threads, a conflict, or the merge: GitHub would merge it now (CLEAN, or
 * HAS_HOOKS where pre-receive hooks run), and auto-merge is off. Running checks wait for GitHub, and passing ones for nobody.
 * `replaced`: the status is about a commit that a push replaces, so the checks and the merge, which
 * are about that commit, ask nothing; the conflict stays as last known, as readGithub keeps it.
 */
export function githubAsks(status: GithubStatus | null, base: string, replaced = false): string[] {
  if (!status) return [];
  const checks = checksSummary(status);
  const threads = status.threads.length;
  return [
    // A failure past the first page shows only in the sum.
    replaced ? null : checks.failed ? `${checks.failed} ${checks.failed === 1 ? 'check' : 'checks'} failed on GitHub` : checks.result === 'failed' ? 'checks failed on GitHub' : null,
    status.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested on GitHub' : null,
    threads ? `${threads} unresolved ${threads === 1 ? 'thread' : 'threads'} on GitHub` : null,
    status.conflicting ? `conflicts with ${base} on GitHub` : null,
    !replaced && (status.mergeStateStatus === 'CLEAN' || status.mergeStateStatus === 'HAS_HOOKS') && status.autoMerge === false ? 'ready to merge on GitHub' : null,
  ].filter((x) => x !== null);
}

/**
 * What GitHub waits for that is nobody's move here, as reasons while it waits on GitHub: a review
 * that branch protection requires, from those asked for one.
 */
export function githubWaits(status: GithubStatus | null): string[] {
  if (status?.reviewDecision !== 'REVIEW_REQUIRED') return [];
  const names = status.reviewRequests ?? [];
  if (!names.length) return ['waiting for a required review'];
  const more = (status.reviewRequestsTotal ?? 0) - names.length;
  return [`waiting for review from ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`];
}
