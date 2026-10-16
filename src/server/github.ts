// Serializers that shape laatsux records like GitHub's REST API (snake_case) and like
// `gh ... --json` output (camelCase, GraphQL-style), so tools that know GitHub feel at home.
import type { Commit } from './git.ts';
import type { FileDiff } from './diff.ts';
import type { Actor, CommentRow, PullRow, RepoRow, ReviewRow } from './db.ts';
import type { Ctx, Placement, Service, Thread } from './service.ts';

export function avatarUrl(s: Service, a: Actor): string {
  if (a.type === 'User' && s.db.getMeta('viewer_login') === a.login) return `https://github.com/${a.login}.png?size=80`;
  return `${s.baseUrl}/avatars/${encodeURIComponent(a.login)}.svg`;
}

export function userJson(s: Service, a: Actor) {
  return { login: a.login, id: a.id, type: a.type, avatar_url: avatarUrl(s, a) };
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

export function pullJson(s: Service, repo: RepoRow, pull: PullRow, extra: { files?: FileDiff[]; commits?: Commit[] } = {}) {
  const author = s.db.actorById(pull.author_id);
  const json: Record<string, unknown> = {
    url: `${apiBase(s, repo)}/pulls/${pull.number}`,
    id: pull.id,
    number: pull.number,
    html_url: s.pullUrl(repo, pull),
    state: pull.state === 'closed' ? 'closed' : 'open',
    title: pull.title,
    body: pull.body,
    user: userJson(s, author),
    draft: !!pull.draft,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: null,
    head: { label: `${repo.owner}:${pull.head_ref}`, ref: pull.head_ref, sha: pull.head_sha },
    base: { label: `${repo.owner}:${pull.base_ref}`, ref: pull.base_ref, sha: pull.base_sha },
    // laatsux extensions:
    staging_state: pull.state,
    published_url: pull.published_url,
    published_at: pull.published_at,
    author_waiting: (s.waiters.get(pull.id) ?? 0) > 0,
  };
  if (extra.files) {
    json.additions = extra.files.reduce((n, f) => n + f.additions, 0);
    json.deletions = extra.files.reduce((n, f) => n + f.deletions, 0);
    json.changed_files = extra.files.length;
  }
  if (extra.commits) json.commits = extra.commits.length;
  return json;
}

export function commitJson(s: Service, repo: RepoRow, pull: PullRow, c: Commit) {
  return {
    sha: c.sha,
    commit: {
      message: c.message,
      author: { name: c.authorName, email: c.authorEmail, date: c.authorDate },
      committer: { name: c.committerName, email: c.committerEmail, date: c.committerDate },
    },
    parents: c.parents.map((sha) => ({ sha })),
    html_url: `${s.pullUrl(repo, pull)}/commits/${c.sha}`,
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

function ghAuthor(s: Service, id: number) {
  const a = s.db.actorById(id);
  return { login: a.login, is_bot: a.type === 'Bot' };
}

function ghState(pull: PullRow) {
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
  'latestReviews',
  'number',
  'publishedUrl',
  'reviewDecision',
  'reviewThreads',
  'reviews',
  'state',
  'title',
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
  set('closed', () => pull.state === 'closed');
  set('url', () => s.pullUrl(repo, pull));
  set('isDraft', () => !!pull.draft);
  set('createdAt', () => pull.created_at);
  set('updatedAt', () => pull.updated_at);
  set('closedAt', () => pull.closed_at);
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
  if (want.has('reviewThreads')) {
    const threads = await s.threads(ctx, viewer, files, commits);
    out.reviewThreads = threads
      .filter((t) => !t.pending)
      .map((t) => ({
        id: `PRRT_${t.root.id}`,
        databaseId: t.root.id,
        reviewDatabaseId: t.root.review_id,
        isResolved: t.resolved,
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
