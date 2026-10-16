import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Repo, run, githubSlug, type Commit } from './git.ts';
import { diffHunkFor, lineInDiff, mapLine, rangeTouched, type FileDiff } from './diff.ts';
import type { CodexReviewer } from './reviewers/codex.ts';
import {
  Db,
  now,
  type Actor,
  type CommentRow,
  type EventRow,
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

const EVENT_STATE: Record<ReviewEvent, ReviewState> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

export interface WaitResult {
  status: 'feedback' | 'published' | 'closed' | 'timeout';
  reviews: ReviewRow[];
  comments: CommentRow[];
}

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
  /** Codex as a reviewer agent, when the server runs one. */
  codex: CodexReviewer | null = null;
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
    this.codex?.releaseName(this.viewerLogin);
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
      if (filter.state === 'open') where.push("state IN ('open', 'published')");
      else {
        where.push('state = ?');
        params.push(filter.state);
      }
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

  async createPull(
    repo: RepoRow,
    input: { title?: string; body?: string; head?: string; base?: string; draft?: boolean; fill?: 'default' | 'first' | 'verbose' },
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
    const existing = this.db.get<PullRow>("SELECT * FROM pulls WHERE repo_id = ? AND head_ref = ? AND state != 'closed'", repo.id, head);
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
        state: 'open',
        draft: input.draft ? 1 : 0,
        base_ref: base,
        head_ref: head,
        head_sha: headSha,
        base_sha: mergeBase,
        author_id: actor.id,
        created_at: ts,
        updated_at: ts,
        author_seen_at: ts,
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
    await git.updateRef(`refs/laatsux/pull/${pull.number}/${seq}`, sha).catch(() => {});
  }

  /** Detect pushes to the head branch (and moves of the merge base) and record them as revisions. */
  sync(pull: PullRow): Promise<PullRow> {
    if (pull.state === 'closed') return Promise.resolve(pull);
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
    const head = await git.resolve(`refs/heads/${pull.head_ref}`);
    if (!head) return pull; // Branch deleted locally; keep showing the last known state.
    const baseTip = await this.baseCommit(repo, pull.base_ref);
    const mergeBase = (baseTip && (await git.mergeBase(baseTip, head))) ?? pull.base_sha;
    if (head === pull.head_sha && mergeBase === pull.base_sha) return pull;

    const forced = !(await git.isAncestor(pull.head_sha, head));
    const newCommits = forced ? [] : (await git.log(pull.head_sha, head)).map((c) => c.sha);
    const author = this.db.actorById(pull.author_id);
    const ts = now();
    const seq = this.db.transaction(() => {
      const seq = this.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM revisions WHERE pull_id = ?', pull.id)!.n;
      this.db.insert('revisions', { pull_id: pull.id, seq, head_sha: head, base_sha: mergeBase, before_sha: pull.head_sha, forced: forced ? 1 : 0, actor_id: author.id, created_at: ts });
      this.db.update('pulls', pull.id, { head_sha: head, base_sha: mergeBase, updated_at: ts });
      this.addEvent(pull, author, 'pushed', { before: pull.head_sha, after: head, forced, commits: newCommits, base_before: pull.base_sha, base_after: mergeBase }, ts);
      return seq;
    });
    await this.pin(git, pull, seq, head);
    this.emit(pull.id, 'pushed', author);
    return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
  }

  /** Check every open pull request for pushes. Called on an interval by the server. */
  async pollAll(): Promise<void> {
    const open = this.db.all<PullRow>("SELECT * FROM pulls WHERE state != 'closed'");
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
      }
    }
  }
  private lastPolled = new Map<number, string>();

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
      }
      if (input.draft !== undefined && (input.draft ? 1 : 0) !== pull.draft) {
        changes.draft = input.draft ? 1 : 0;
        this.addEvent(pull, actor, input.draft ? 'convert_to_draft' : 'ready_for_review', {}, ts);
      }
      if (input.state === 'closed' && pull.state !== 'closed') {
        changes.state = 'closed';
        changes.closed_at = ts;
        this.addEvent(pull, actor, 'closed', {}, ts);
      } else if (input.state === 'open' && pull.state === 'closed') {
        changes.state = pull.published_url ? 'published' : 'open';
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
      if (changes.base_ref || changes.state) updated = await this.sync(updated);
      this.emit(pull.id, 'updated', actor);
    }
    return updated;
  }

  async deletePull(ctx: Ctx, actor: Actor): Promise<void> {
    const { pull, git } = ctx;
    if (actor.type === 'Bot') throw new HttpError(403, 'only the reviewer can delete a staged pull request; close it instead');
    for (const rev of this.revisions(pull)) {
      await git.run(['update-ref', '-d', `refs/laatsux/pull/${pull.number}/${rev.seq}`], { allowFail: true });
    }
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

  /** Validate where a new review comment points and build the columns that anchor it. */
  private async anchor(ctx: Ctx, input: CommentInput): Promise<Record<string, string | number | null>> {
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
    if (!Number.isInteger(line) || !lineInDiff(file, side, line)) {
      throw new HttpError(422, `line ${input.line} (${side}) of ${input.path} is not part of the diff`);
    }
    let startLine: number | null = input.start_line ? Number(input.start_line) : null;
    const startSide: Side | null = startLine ? (input.start_side ?? side) : null;
    if (startLine === line && startSide === side) startLine = null;
    if (startLine && !lineInDiff(file, startSide!, startLine)) throw new HttpError(422, `start_line ${startLine} is not part of the diff`);
    return {
      subject_type: 'line',
      commit_id: head,
      base_commit_id: base,
      path: file.path,
      line,
      side,
      start_line: startLine,
      start_side: startLine ? startSide : null,
      diff_hunk: diffHunkFor(file, side, line, startLine ? { side: startSide!, line: startLine } : null),
    };
  }

  private insertReviewComment(pull: PullRow, actor: Actor, reviewId: number | null, body: string, anchor: Record<string, string | number | null>, inReplyTo: number | null = null): number {
    if (!body.trim()) throw new HttpError(422, 'body cannot be blank');
    const ts = now();
    return this.db.insert('comments', { pull_id: pull.id, kind: 'review', review_id: reviewId, author_id: actor.id, body, created_at: ts, updated_at: ts, in_reply_to_id: inReplyTo, ...anchor });
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

  async createReview(
    ctx: Ctx,
    input: { body?: string; event?: ReviewEvent | ''; commit_id?: string; comments?: CommentInput[] },
    actor: Actor,
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
      line === null || !lineInDiff(file, side, line) || (root.start_line !== null && (startLine === null || !lineInDiff(file, root.start_side!, startLine)));
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

  /** Record that the author has been shown everything up to `at` (taken before reading the feedback). */
  markSeen(pull: PullRow, at: string): void {
    this.db.update('pulls', pull.id, { author_seen_at: at });
  }

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
      } else this.emit(id, 'waiting', author);
    } else if (before > 0 && n === 0) {
      const t = setTimeout(() => {
        this.waitingStopped.delete(id);
        this.emit(id, 'waiting', author);
      }, 3000);
      t.unref();
      this.waitingStopped.set(id, t);
    }
  }

  async wait(ctx: Ctx, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const id = ctx.pull.id;
    const author = this.db.actorById(ctx.pull.author_id);
    this.setWaiting(id, 1, author);
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const checkedAt = now();
        const pull = this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id);
        if (!pull) return { status: 'closed', reviews: [], comments: [] };
        // Feedback always comes back, also when it arrives together with a close or a publish.
        const fb = this.unseenFeedback(pull);
        const published = this.db.get<EventRow>("SELECT * FROM events WHERE pull_id = ? AND type = 'published' AND created_at > ?", id, pull.author_seen_at);
        if (pull.state === 'closed' || fb.reviews.length || fb.comments.length || published) {
          this.markSeen(pull, checkedAt);
          const status = pull.state === 'closed' ? 'closed' : published ? 'published' : 'feedback';
          return { status, ...fb };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || signal?.aborted) return { status: 'timeout', reviews: [], comments: [] };
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
   * and authors stay as the agent made them. Copies are remembered per source commit, so
   * publishing again after the agent added commits reuses them and GitHub sees a fast-forward.
   */
  async signCommits(ctx: Ctx, pull: PullRow): Promise<{ head: string; signed: number }> {
    const { repo, git } = ctx;
    const signer = await this.signer(ctx);
    if (!signer) throw new HttpError(422, 'set user.name and user.email in git to sign commits');
    const memo = new Map(
      this.db.all<{ source_sha: string; signed_sha: string }>('SELECT source_sha, signed_sha FROM signed_commits WHERE repo_id = ?', repo.id).map((r) => [r.source_sha, r.signed_sha]),
    );
    const shas = (await git.out(['rev-list', '--reverse', '--topo-order', `${pull.base_sha}..${pull.head_sha}`])).split('\n').filter(Boolean);
    let signed = 0;
    for (const sha of shas) {
      const known = memo.get(sha);
      if (known && (await git.exists(known))) continue;
      const c = await git.rawCommit(sha);
      const parents = c.parents.map((p) => memo.get(p) ?? p);
      if (c.signed && parents.every((p, i) => p === c.parents[i])) {
        memo.set(sha, sha);
        continue;
      }
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
      });
      if (r.code !== 0) throw new HttpError(502, `signing commit ${sha.slice(0, 7)} failed:\n${r.stderr.trim()}`);
      const copy = r.stdout.trim();
      memo.set(sha, copy);
      this.db.run(
        'INSERT INTO signed_commits (repo_id, source_sha, signed_sha) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET signed_sha = excluded.signed_sha',
        repo.id,
        sha,
        copy,
      );
      signed++;
    }
    return { head: memo.get(pull.head_sha) ?? pull.head_sha, signed };
  }

  async publish(ctx: Ctx, opts: { draft?: boolean; force?: boolean; expected?: string; sign?: boolean }, actor: Actor): Promise<PullRow> {
    const { repo, git } = ctx;
    if (actor.type === 'Bot') throw new HttpError(403, 'publishing is for the reviewer; ask the user to publish from laatsux');
    const pull = await this.sync(ctx.pull);
    if (opts.expected && opts.expected !== publishFingerprint(pull)) {
      throw new HttpError(412, 'The pull request changed after this page was loaded (new commits, title, description or base). Refresh and review the latest version before publishing.');
    }
    if (pull.state === 'closed') throw new HttpError(422, 'reopen the pull request before publishing it');
    if (!repo.github_slug) throw new HttpError(422, `remote "${repo.remote}" is not a GitHub repository`);
    const cwd = repo.work_dir ?? tmpdir();
    const env = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

    let pushed = pull.head_sha;
    let signed = 0;
    if (opts.sign ?? (await this.signsByDefault(ctx))) {
      ({ head: pushed, signed } = await this.signCommits(ctx, pull));
      // The signed copies exist only here and on GitHub; keep them from being garbage collected.
      if (pushed !== pull.head_sha) await git.updateRef(`refs/laatsux/pull/${pull.number}/published`, pushed);
    }

    const branch = `refs/heads/${pull.head_ref}`;
    const args = ['push'];
    if (opts.force) {
      // Overwrite only what we published last (or what we last fetched), never commits added on GitHub since.
      const expect = pull.published_head_sha ?? (await git.resolve(`refs/remotes/${repo.remote}/${pull.head_ref}`)) ?? '';
      args.push(`--force-with-lease=${branch}:${expect}`);
    }
    args.push(repo.remote, `${pushed}:${branch}`);
    const push = await git.run(args, { cwd, env, allowFail: true });
    if (push.code !== 0) {
      const stale = /stale info/.test(push.stderr);
      const rejected = stale || /\[rejected\]|non-fast-forward|fetch first/.test(push.stderr);
      const why = stale
        ? ' (the branch on GitHub changed since it was last published, for example by "Commit suggestion" or "Update branch"; bring those commits into the branch first)'
        : rejected
          ? ' (the remote branch has commits that are not in this pull request)'
          : '';
      throw new HttpError(rejected ? 409 : 502, `git push failed${why}:\n${push.stderr.trim()}`);
    }

    let url = pull.published_url;
    // An earlier publish, or a pull request someone opened on GitHub for the same branch, gets updated in place.
    let update = url !== null;
    if (!url) {
      const args = ['pr', 'create', '--repo', repo.github_slug, '--base', pull.base_ref, '--head', pull.head_ref, '--title', pull.title, '--body-file', '-'];
      if (opts.draft ?? pull.draft) args.push('--draft');
      const r = await run(this.ghBin, args, { cwd, env, input: pull.body, allowFail: true });
      const existing = r.stderr.match(/already exists:?\s*(https:\/\/\S+)/);
      if (r.code === 0) url = r.stdout.trim().split('\n').pop()!.trim();
      else if (existing) {
        url = existing[1];
        update = true;
      } else throw new HttpError(502, `gh pr create failed:\n${(r.stderr || r.stdout).trim()}`);
    }
    if (update) {
      const r = await run(this.ghBin, ['pr', 'edit', url, '--title', pull.title, '--body-file', '-', '--base', pull.base_ref], { cwd, env, input: pull.body, allowFail: true });
      if (r.code !== 0) throw new HttpError(502, `gh pr edit failed:\n${(r.stderr || r.stdout).trim()}`);
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
      });
      this.addEvent(pull, actor, 'published', { url, head: pushed, source: pull.head_sha, signed, first, force: !!opts.force }, ts);
    });
    this.emit(pull.id, 'published', actor);
    return this.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!;
  }
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

/** Identifies what a publish would send, so the UI can refuse to publish something the reviewer has not seen. */
export function publishFingerprint(pull: PullRow): string {
  const text = createHash('sha256').update(`${pull.base_ref}\0${pull.title}\0${pull.body}`).digest('hex').slice(0, 16);
  return `${pull.head_sha}:${text}`;
}
