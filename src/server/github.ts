// Serializers that shape laatsux records like GitHub's REST API (snake_case) and like
// `gh ... --json` output (camelCase, GraphQL-style), so tools that know GitHub feel at home.
import type { Commit, TreeEntry } from './git.ts';
import type { FileDiff } from './diff.ts';
import type { Actor, CommentRow, PullRow, RepoRow, ReviewRow } from './db.ts';
import { githubStatus, stagingState, type AutoMerge, type Ctx, type Placement, type Service, type Thread, type Turn, type TurnReason } from './service.ts';
import { duration } from './web/html.ts';

/**
 * The official logos of the agents we know: the avatar of each vendor's own GitHub App, as
 * GitHub shows it on the app's comments. Referenced, not bundled, because they are trademarks.
 * Pages fall back to the generated avatar when one can't load (public/app.js).
 */
const LOGOS = {
  claude: 'https://avatars.githubusercontent.com/in/1236702?s=80&v=4', // the Claude app, by anthropics
  codex: 'https://avatars.githubusercontent.com/in/1144995?s=80&v=4', // ChatGPT Codex Connector, by openai
  opencode: 'https://avatars.githubusercontent.com/in/1549082?s=80&v=4', // OpenCode Agent, by anomalyco
};
/** Author agents, by the login the CLI gives them (cliActor in src/config.ts). */
const AUTHOR_LOGOS = new Map([
  ['claude', LOGOS.claude],
  ['codex-agent', LOGOS.codex],
  ['opencode', LOGOS.opencode],
]);
/** Reviewer agents, by the meta key holding their actor's id: their logins are settings. */
const REVIEWER_LOGOS = new Map([['codex_actor_id', LOGOS.codex]]);

function agentLogo(s: Service, a: Actor): string | undefined {
  if (a.type !== 'Bot') return undefined;
  for (const [key, logo] of REVIEWER_LOGOS) if (s.db.getMeta(key) === String(a.id)) return logo;
  return AUTHOR_LOGOS.get(a.login);
}

export function avatarUrl(s: Service, a: Actor): string {
  if (a.type === 'User' && s.db.getMeta('viewer_login') === a.login) return `https://github.com/${a.login}.png?size=80`;
  return agentLogo(s, a) ?? `${s.baseUrl}/avatars/${encodeURIComponent(a.login)}.svg`;
}

export function userJson(s: Service, a: Actor) {
  return { login: a.login, id: a.id, type: a.type, avatar_url: avatarUrl(s, a) };
}

/** A GitHub user laatsux knows only by login, such as whoever merged a pull request there. */
function githubUserJson(login: string) {
  return { login, avatar_url: `https://github.com/${login}.png`, html_url: `https://github.com/${login}` };
}

function apiBase(s: Service, repo: RepoRow) {
  return `${s.baseUrl}/api/repos/${repo.owner}/${repo.name}`;
}

export function repoJson(s: Service, repo: RepoRow) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    html_url: `${s.baseUrl}/${repo.owner}/${repo.name}`,
    url: apiBase(s, repo),
    git_dir: repo.git_dir,
    work_dir: repo.work_dir,
    remote: repo.remote,
    github: repo.github_slug,
  };
}

/** When it was closed here, or on GitHub, while it is done: a pull request reopened on GitHub keeps the old close in github_closed_at. */
function closedAt(pull: PullRow) {
  return stagingState(pull) === 'done' ? (pull.closed_at ?? pull.github_closed_at) : null;
}

export function pullJson(s: Service, repo: RepoRow, pull: PullRow, extra: { files?: FileDiff[]; commits?: Commit[] } = {}) {
  const author = s.db.actorById(pull.author_id);
  const merged = pull.github_state === 'merged';
  const github = githubStatus(pull);
  const staging = stagingState(pull);
  const json: Record<string, unknown> = {
    url: `${apiBase(s, repo)}/pulls/${pull.number}`,
    id: pull.id,
    number: pull.number,
    html_url: s.pullUrl(repo, pull),
    // As GitHub has it: closed once done (merged included), so gh's open takes in staged and published.
    state: staging === 'done' ? 'closed' : 'open',
    title: pull.title,
    body: pull.body,
    user: userJson(s, author),
    draft: !!pull.draft,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: closedAt(pull),
    // Merged on GitHub, once it was published there.
    merged,
    merged_at: merged ? pull.github_closed_at : null,
    merged_by: merged && pull.github_closed_by ? githubUserJson(pull.github_closed_by) : null,
    merge_commit_sha: pull.github_merge_sha,
    // GitHub's auto_merge, for the published pull request: on when laatsux last turned it on there.
    auto_merge: autoMergeJson(s, pull),
    // GitHub's mergeability, while it is open there.
    mergeable: github && github.mergeable !== 'UNKNOWN' ? github.mergeable === 'MERGEABLE' : null,
    mergeable_state: github ? github.mergeStateStatus.toLowerCase() : 'unknown',
    head: { label: `${repo.owner}:${pull.head_ref}`, ref: pull.head_ref, sha: pull.head_sha },
    base: { label: `${repo.owner}:${pull.base_ref}`, ref: pull.base_ref, sha: pull.base_sha },
    // laatsux extensions:
    // staged, published (and open on GitHub), or done (merged or closed on GitHub, or closed here).
    staging_state: staging,
    published_url: pull.published_url,
    published_at: pull.published_at,
    // The published pull request on GitHub: open, merged or closed there (null until laatsux has asked),
    // and when and by whom it was merged or closed.
    github_state: pull.github_state,
    github_closed_at: pull.github_closed_at,
    github_closed_by: pull.github_closed_by,
    author_waiting: (s.waiters.get(pull.id) ?? 0) > 0,
    auto_publish: autoPublishJson(s, pull),
    // Whose move it is (author, reviewer_agents, reviewer or none), and why.
    turn: s.turn(pull),
    // What a published pull request has that GitHub does not yet: commits, title, description.
    unpublished_changes: s.unpublishedChanges(pull),
  };
  if (extra.files) {
    json.additions = extra.files.reduce((n, f) => n + f.additions, 0);
    json.deletions = extra.files.reduce((n, f) => n + f.deletions, 0);
    json.changed_files = extra.files.length;
  }
  if (extra.commits) json.commits = extra.commits.length;
  return json;
}

/** Auto-publish while it is on (a laatsux extension, after GitHub's auto_merge), or null. */
function autoPublishJson(s: Service, pull: PullRow) {
  const auto = s.autoPublish(pull);
  return auto && { enabled_by: userJson(s, s.db.actorById(auto.by)), enabled_at: auto.at, sign: auto.sign, draft: auto.draft, force: auto.force, auto_merge: auto.autoMerge };
}

function autoMergeJson(s: Service, pull: PullRow) {
  const merge = s.autoMerge(pull);
  if (merge?.state !== 'enabled') return null;
  return { enabled_by: userJson(s, s.db.actorById(merge.by)), merge_method: merge.method, commit_title: null, commit_message: null };
}

/** What came of turning on auto-merge when publishing (a laatsux extension): `enabled`, `merged` at once, `requested` (which of the two could not be checked), or `failed` with gh's message. */
export function autoMergeResult(merge: AutoMerge | null) {
  return merge && { state: merge.state, merge_method: merge.method, error: merge.error ?? null };
}

/** A commit of a pull request, or with no pull request one of the repository (linking to its tree). */
export function commitJson(s: Service, repo: RepoRow, pull: PullRow | null, c: Commit) {
  return {
    sha: c.sha,
    commit: {
      message: c.message,
      author: { name: c.authorName, email: c.authorEmail, date: c.authorDate },
      committer: { name: c.committerName, email: c.committerEmail, date: c.committerDate },
    },
    parents: c.parents.map((sha) => ({ sha })),
    html_url: pull ? `${s.pullUrl(repo, pull)}/commits/${c.sha}` : `${s.baseUrl}/${repo.owner}/${repo.name}/tree/${c.sha}`,
  };
}

/** An entry of GET /repos/{owner}/{repo}/contents/{path} at commit `sha`. */
export function contentJson(s: Service, repo: RepoRow, sha: string, path: string, e: TreeEntry) {
  const type = e.type === 'tree' ? 'dir' : e.type === 'commit' ? 'submodule' : e.mode === '120000' ? 'symlink' : 'file';
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const web = `${s.baseUrl}/${repo.owner}/${repo.name}`;
  return {
    type,
    name: e.name,
    path,
    sha: e.oid,
    size: e.size ?? 0,
    url: `${apiBase(s, repo)}/contents/${encoded}?ref=${sha}`,
    html_url: `${web}/${type === 'dir' ? 'tree' : 'blob'}/${sha}/${encoded}`,
    download_url: type === 'file' || type === 'symlink' ? `${web}/raw/${sha}/${encoded}` : null,
  };
}

export function fileJson(f: FileDiff) {
  return {
    sha: f.newBlob ?? f.oldBlob ?? null,
    filename: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    patch: f.binary ? undefined : f.patch,
    previous_filename: f.status === 'renamed' || f.status === 'copied' ? f.oldPath : undefined,
  };
}

export function issueCommentJson(s: Service, repo: RepoRow, pull: PullRow, c: CommentRow) {
  return {
    id: c.id,
    html_url: `${s.pullUrl(repo, pull)}#issuecomment-${c.id}`,
    issue_url: `${apiBase(s, repo)}/issues/${pull.number}`,
    user: userJson(s, s.db.actorById(c.author_id)),
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export function reviewCommentJson(s: Service, repo: RepoRow, pull: PullRow, c: CommentRow, root: CommentRow, placement: Placement | null) {
  return {
    id: c.id,
    pull_request_review_id: c.review_id,
    in_reply_to_id: c.in_reply_to_id ?? undefined,
    subject_type: c.subject_type,
    path: c.path,
    commit_id: placement && !placement.outdated ? pull.head_sha : c.commit_id,
    original_commit_id: c.commit_id,
    line: placement?.line ?? null,
    original_line: c.line,
    start_line: placement?.startLine ?? null,
    original_start_line: c.start_line,
    side: c.side,
    start_side: c.start_side,
    diff_hunk: c.diff_hunk,
    user: userJson(s, s.db.actorById(c.author_id)),
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: `${s.pullUrl(repo, pull)}#discussion_r${c.id}`,
    pull_request_url: `${apiBase(s, repo)}/pulls/${pull.number}`,
    // laatsux extensions:
    priority: c.priority,
    outdated: placement?.outdated ?? null,
    resolved: !!root.resolved_at,
  };
}

export function threadCommentsJson(s: Service, ctx: Ctx, threads: Thread[]) {
  const out = [];
  for (const t of threads) {
    for (const c of [t.root, ...t.replies]) out.push(reviewCommentJson(s, ctx.repo, ctx.pull, c, t.root, t.placement));
  }
  return out.sort((a, b) => a.id - b.id);
}

export function reviewJson(s: Service, repo: RepoRow, pull: PullRow, r: ReviewRow) {
  return {
    id: r.id,
    user: userJson(s, s.db.actorById(r.author_id)),
    body: r.body,
    state: r.state,
    commit_id: r.commit_id,
    submitted_at: r.submitted_at ?? undefined,
    html_url: `${s.pullUrl(repo, pull)}#pullrequestreview-${r.id}`,
    pull_request_url: `${apiBase(s, repo)}/pulls/${pull.number}`,
  };
}

// ------------------------------------------------------------------ gh --json

/** Turn as gh JSON: whose move it is (AUTHOR, REVIEWER_AGENTS, REVIEWER or NONE), and the reasons as text. */
function ghTurn(t: Turn) {
  return { whose: t.whose.toUpperCase(), reasons: t.reasons.map(reasonText) };
}

/** A reason in words, with how long it has been so: "codex is reviewing 8c64534, 3 min". */
export function reasonText(r: TurnReason): string {
  return r.since ? `${r.text}, ${duration(r.since)}` : r.text;
}

function ghAuthor(s: Service, id: number) {
  const a = s.db.actorById(id);
  return { login: a.login, is_bot: a.type === 'Bot' };
}

/** As gh says it, with laatsux's STAGED and PUBLISHED for gh's OPEN: PUBLISHED until the pull request is merged or closed on GitHub. */
function ghState(pull: PullRow) {
  if (pull.github_state === 'merged') return 'MERGED';
  if (pull.github_state === 'closed') return 'CLOSED';
  return pull.state.toUpperCase();
}

export function reviewDecision(reviews: ReviewRow[]): string {
  const latest = new Map<number, ReviewRow>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(r.author_id, r);
  }
  const states = [...latest.values()].map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return 'REVIEW_REQUIRED';
}

export const GH_FIELDS = [
  'additions',
  'author',
  'autoMergeRequest',
  'autoPublishRequest',
  'baseRefName',
  'baseRefOid',
  'body',
  'changedFiles',
  'closed',
  'closedAt',
  'comments',
  'commits',
  'createdAt',
  'deletions',
  'files',
  'headRefName',
  'headRefOid',
  'id',
  'isDraft',
  'githubStatus',
  'latestReviews',
  'mergeCommit',
  'mergeStateStatus',
  'mergeable',
  'mergedAt',
  'mergedBy',
  'number',
  'publishedUrl',
  'reviewDecision',
  'reviewRequests',
  'reviewThreads',
  'reviews',
  'state',
  'statusCheckRollup',
  'title',
  'turn',
  'unpublishedChanges',
  'updatedAt',
  'url',
  'waiting',
] as const;

const HEAVY = new Set(['additions', 'deletions', 'changedFiles', 'commits', 'files', 'reviewThreads']);

/** The object `gh pr view --json` would print, limited to `fields` (all when empty). */
export async function ghPullJson(s: Service, ctx: Ctx, viewer: Actor, fields: string[]) {
  const { repo, pull } = ctx;
  const want = new Set(fields.length ? fields : GH_FIELDS);
  const heavy = [...want].some((f) => HEAVY.has(f));
  const files = heavy ? await s.files(ctx) : [];
  const commits = heavy ? await s.commits(ctx) : [];
  const reviews = s.reviews(pull, viewer).filter((r) => r.state !== 'PENDING');
  const out: Record<string, unknown> = {};
  const set = (k: string, v: () => unknown) => {
    if (want.has(k)) out[k] = v();
  };
  set('id', () => `PR_${pull.id}`);
  set('number', () => pull.number);
  set('title', () => pull.title);
  set('body', () => pull.body);
  set('state', () => ghState(pull));
  set('closed', () => stagingState(pull) === 'done');
  set('url', () => s.pullUrl(repo, pull));
  set('isDraft', () => !!pull.draft);
  set('createdAt', () => pull.created_at);
  set('updatedAt', () => pull.updated_at);
  set('closedAt', () => closedAt(pull));
  const merged = pull.github_state === 'merged';
  set('mergedAt', () => (merged ? pull.github_closed_at : null));
  set('mergedBy', () => (merged && pull.github_closed_by ? { login: pull.github_closed_by, is_bot: false } : null));
  set('mergeCommit', () => (merged && pull.github_merge_sha ? { oid: pull.github_merge_sha } : null));
  // As gh has them for the pull request on GitHub, while it is open there.
  const github = githubStatus(pull);
  set('mergeable', () => github?.mergeable ?? 'UNKNOWN');
  set('mergeStateStatus', () => github?.mergeStateStatus ?? 'UNKNOWN');
  set('statusCheckRollup', () =>
    (github?.checks ?? []).map((c) =>
      c.kind === 'CheckRun'
        ? { __typename: c.kind, name: c.name, workflowName: c.workflow ?? '', status: c.status, conclusion: c.conclusion ?? '', detailsUrl: c.url ?? '' }
        : { __typename: c.kind, context: c.name, state: c.status, targetUrl: c.url ?? '' },
    ),
  );
  // laatsux extension: all it saw on GitHub, when it last asked (null before publishing, and once merged or closed there).
  set('githubStatus', () => github);
  set('author', () => ghAuthor(s, pull.author_id));
  set('headRefName', () => pull.head_ref);
  set('baseRefName', () => pull.base_ref);
  set('headRefOid', () => pull.head_sha);
  set('baseRefOid', () => pull.base_sha);
  set('additions', () => files.reduce((n, f) => n + f.additions, 0));
  set('deletions', () => files.reduce((n, f) => n + f.deletions, 0));
  set('changedFiles', () => files.length);
  set('publishedUrl', () => pull.published_url);
  set('waiting', () => (s.waiters.get(pull.id) ?? 0) > 0);
  // Auto-merge on the published pull request, as laatsux last turned it on there.
  set('autoMergeRequest', () => {
    const merge = s.autoMerge(pull);
    if (merge?.state !== 'enabled') return null;
    return { authorEmail: null, commitBody: null, commitHeadline: null, enabledAt: merge.at, enabledBy: ghAuthor(s, merge.by), mergeMethod: merge.method.toUpperCase() };
  });
  // laatsux extension, after gh's autoMergeRequest: auto-publish while it is on.
  set('autoPublishRequest', () => {
    const auto = s.autoPublish(pull);
    return auto && { enabledAt: auto.at, enabledBy: ghAuthor(s, auto.by), sign: auto.sign, draft: auto.draft, force: auto.force, autoMerge: auto.autoMerge };
  });
  set('commits', () =>
    commits.map((c) => {
      const [headline, ...rest] = c.message.split('\n');
      return {
        oid: c.sha,
        messageHeadline: headline,
        messageBody: rest.join('\n').trim(),
        authoredDate: c.authorDate,
        committedDate: c.committerDate,
        authors: [{ name: c.authorName, email: c.authorEmail }],
      };
    }),
  );
  set('files', () => files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })));
  set('comments', () =>
    s.issueComments(pull).map((c) => ({
      id: `IC_${c.id}`,
      databaseId: c.id,
      author: ghAuthor(s, c.author_id),
      body: c.body,
      createdAt: c.created_at,
      url: `${s.pullUrl(repo, pull)}#issuecomment-${c.id}`,
    })),
  );
  const review = (r: ReviewRow) => ({
    id: `PRR_${r.id}`,
    databaseId: r.id,
    author: ghAuthor(s, r.author_id),
    body: r.body,
    state: r.state,
    submittedAt: r.submitted_at,
    commit: { oid: r.commit_id },
  });
  set('reviews', () => reviews.map(review));
  set('latestReviews', () => {
    const latest = new Map<number, ReviewRow>();
    for (const r of reviews) latest.set(r.author_id, r);
    return [...latest.values()].map(review);
  });
  set('reviewDecision', () => reviewDecision(reviews));
  // laatsux extensions: whose move it is, and what GitHub does not have yet (#6, #29). `state`
  // stays PUBLISHED when an update is not published, as gh would show it.
  set('turn', () => ghTurn(s.turn(pull)));
  set('unpublishedChanges', () => s.unpublishedChanges(pull).map((c) => (c === 'description' ? 'BODY' : c.toUpperCase())));
  // Reviewers still to be heard from: one that is reviewing now, or about to start.
  set('reviewRequests', () => {
    const work = s.codex?.atWork(pull);
    if (!work) return [];
    const a = s.codex!.actor();
    // laatsux extensions: status (as in GitHub's check runs), the commit, and when it started.
    return [{ __typename: a.type, login: a.login, status: work.status, commit: { oid: work.head_sha }, startedAt: work.started_at }];
  });
  if (want.has('reviewThreads')) {
    const threads = await s.threads(ctx, viewer, files, commits);
    out.reviewThreads = threads
      .filter((t) => !t.pending)
      .map((t) => ({
        id: `PRRT_${t.root.id}`,
        databaseId: t.root.id,
        reviewDatabaseId: t.root.review_id,
        isResolved: t.resolved,
        priority: t.root.priority,
        isOutdated: t.placement.outdated,
        subjectType: (t.root.subject_type ?? 'line').toUpperCase(),
        path: t.root.path,
        line: t.placement.line,
        startLine: t.placement.startLine,
        originalLine: t.root.line,
        originalStartLine: t.root.start_line,
        diffSide: t.root.side,
        commit: { oid: t.root.commit_id },
        diffHunk: t.root.diff_hunk,
        comments: [t.root, ...t.replies].map((c) => ({
          id: `PRRC_${c.id}`,
          databaseId: c.id,
          author: ghAuthor(s, c.author_id),
          body: c.body,
          createdAt: c.created_at,
          url: `${s.pullUrl(repo, pull)}#discussion_r${c.id}`,
        })),
      }));
  }
  return out;
}
