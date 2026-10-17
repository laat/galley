import { Hono, type Context } from 'hono';
import { GitError } from './git.ts';
import { HttpError, type ChangeEvent, type Ctx, type ReviewEvent, type Service } from './service.ts';
import { now, type Actor, type ActorType, type PullRow, type RepoRow } from './db.ts';
import {
  autoMergeResult,
  commitJson,
  contentJson,
  fileJson,
  ghPullJson,
  issueCommentJson,
  pullJson,
  repoJson,
  reviewCommentJson,
  reviewJson,
  threadCommentsJson,
  userJson,
} from './github.ts';
import { renderMarkdown } from './web/markdown.ts';
import { pullReferences } from './web/references.ts';
import { nextSettings, readSettings, REVIEWER_KINDS, saveSettings, type MergeMethod, type ReviewerKind } from './settings.ts';

/**
 * A GitHub-compatible subset of the REST API, plus a few laatsux extensions
 * (publish, wait, resolve, gh-shaped JSON). Mounted at /api.
 */
export function api(s: Service): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ message: err.message, status: String(err.status) }, err.status as 400);
    if (err instanceof GitError) return c.json({ message: err.message, status: '500' }, 500);
    console.error(err);
    return c.json({ message: String((err as Error)?.message ?? err), status: '500' }, 500);
  });
  app.notFound((c) => c.json({ message: 'Not Found', status: '404' }, 404));

  /** CLI callers name themselves; requests from the web UI act as the human viewer. */
  const actor = (c: Context): Actor => {
    const login = c.req.header('x-laatsux-actor');
    if (!login) return s.viewer();
    // A reviewer agent posts from inside the server; anyone else using its name would be mistaken for it.
    const reviewer = s.reviewerAgents().find((r) => r.actor().login === login);
    if (reviewer) throw new HttpError(409, `"${login}" is the name of the ${reviewer.label} reviewer. Set LAATSUX_ACTOR to another name.`);
    const type = (c.req.header('x-laatsux-actor-type') as ActorType) ?? (login === s.viewer().login ? 'User' : 'Bot');
    return s.db.actor(login, type === 'User' ? 'User' : 'Bot');
  };
  const body = async (c: Context): Promise<Record<string, any>> => {
    const text = await c.req.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Problems parsing JSON');
    }
  };
  const num = (v: string | undefined, what = 'number'): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, `invalid ${what}: ${v}`);
    return n;
  };
  const ctx = (c: Context, opts?: { sync?: boolean }): Promise<Ctx> => s.ctx(c.req.param('owner')!, c.req.param('repo')!, num(c.req.param('n')), opts);
  /** A comment addressed through /repos/:owner/:repo/..., checked to belong there and to be visible to the caller. */
  const commentIn = (c: Context, kind: 'issue' | 'review') => {
    const repo = s.repo(c.req.param('owner')!, c.req.param('repo')!);
    const comment = s.comment(num(c.req.param('id'), 'comment id'));
    const pull = s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', comment.pull_id)!;
    if (pull.repo_id !== repo.id || comment.kind !== kind || !s.canSee(comment, actor(c))) throw new HttpError(404, `comment ${comment.id} not found`);
    return { repo, pull, comment };
  };
  const fields = (c: Context) => (c.req.query('fields') ?? '').split(',').map((f) => f.trim()).filter(Boolean);

  // ------------------------------------------------- settings (extension)

  /** Settings and reviewer controls belong to the person reviewing, not to agents. */
  const human = (c: Context): Actor => {
    const a = actor(c);
    if (a.type === 'Bot') throw new HttpError(403, 'only the reviewer can do this');
    return a;
  };

  /** The reviewer agent of a kind (`codex`, `claude`) in the path. */
  const reviewerOf = (c: Context) => {
    const kind = c.req.param('kind');
    const reviewer = s.reviewerAgents().find((r) => r.engine === kind);
    if (!reviewer) throw new HttpError(REVIEWER_KINDS.includes(kind as ReviewerKind) ? 501 : 404, `this server has no ${kind} reviewer`);
    return reviewer;
  };

  app.get('/settings', async (c) => {
    const catalogs: Record<string, unknown> = {};
    for (const r of s.reviewerAgents()) Object.assign(catalogs, { [`${r.engine}Models`]: await r.models(), [`${r.engine}Defaults`]: r.defaults() });
    return c.json({ ...readSettings(s.db), ...catalogs });
  });

  app.put('/settings/:kind{codex|claude}', async (c) => {
    human(c);
    const reviewer = reviewerOf(c);
    const kind = reviewer.engine;
    const b = await body(c);
    await reviewer.models(); // so efforts can be checked against the model
    const settings = nextSettings(s.db, { [kind]: b }, (_, model) => reviewer.efforts(model));
    // Renaming is the one step that can still fail (the name may be taken), so it goes before saving.
    if (b.name !== undefined && settings[kind].name !== reviewer.actor().login) reviewer.rename(settings[kind].name);
    // The reviewer's actual name is the truth (it may have had to take another one).
    settings[kind].name = reviewer.actor().login;
    saveSettings(s.db, settings);
    // Turning reviews on or raising the limit should not wait for the author's next `pr wait`
    // cycle. Pull requests can turn reviews on for themselves, so each waiting one decides.
    for (const id of s.waiters.keys()) reviewer.consider(id);
    return c.json(settings);
  });

  app.put('/settings/publish', async (c) => {
    human(c);
    const settings = nextSettings(s.db, { publish: await body(c) });
    saveSettings(s.db, settings);
    // Open pull request pages show the merge method next to the auto-merge option.
    s.bus.emit('change', { pullId: null, type: 'settings', actor: 'settings' } satisfies ChangeEvent);
    return c.json(settings);
  });

  app.get('/health', (c) => c.json({ ok: true, pid: process.pid, viewer: s.viewer().login }));
  app.get('/user', (c) => c.json(userJson(s, actor(c))));

  app.post('/markdown', async (c) => {
    const { text, suggestion_lines, pull } = await body(c);
    const markdown = String(text ?? '');
    // Extension: `pull`, the pull request's API path, links references as its pages do.
    const m = typeof pull === 'string' ? pull.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/) : null;
    const x = m ? await s.ctx(m[1], m[2], Number(m[3]), { sync: false }) : null;
    // Issue titles only from the cache: when a lookup's answer came, the page would refresh under the preview.
    const references = x ? await pullReferences(s, x, await s.commits(x), [markdown], { lookUp: false }) : undefined;
    return c.html(renderMarkdown(markdown, { suggestionLines: Array.isArray(suggestion_lines) ? suggestion_lines.map(String) : undefined, references }));
  });

  // ------------------------------------------------------------------ repos

  app.post('/repos', async (c) => {
    const { path } = await body(c);
    if (!path) throw new HttpError(422, 'path is required');
    return c.json(repoJson(s, await s.registerRepo(String(path))));
  });
  app.get('/repos', (c) => c.json(s.repos().map((r) => repoJson(s, r))));
  app.get('/repos/:owner/:repo', (c) => c.json(repoJson(s, s.repo(c.req.param('owner'), c.req.param('repo')))));

  // GitHub's "get a commit" and "get repository content", used by `laatsux browse --repo`. A ref
  // is anything git resolves (a SHA, a branch, HEAD); contents default to HEAD, where GitHub
  // uses the default branch.
  const commitFor = async (repo: RepoRow, ref: string): Promise<string> => {
    const sha = ref.startsWith('-') ? null : await s.git(repo).resolve(ref);
    if (!sha) throw new HttpError(422, `No commit found for SHA: ${ref}`);
    return sha;
  };
  app.get('/repos/:owner/:repo/commits/:ref{.+}', async (c) => {
    const repo = s.repo(c.req.param('owner'), c.req.param('repo'));
    const sha = await commitFor(repo, c.req.param('ref'));
    return c.json(commitJson(s, repo, null, (await s.git(repo).commit(sha))!));
  });
  const contents = async (c: Context) => {
    const repo = s.repo(c.req.param('owner')!, c.req.param('repo')!);
    const git = s.git(repo);
    const sha = await commitFor(repo, c.req.query('ref') ?? 'HEAD');
    const path = (c.req.param('path') ?? '').replace(/\/$/, '');
    // Paths are looked up in git's objects only, never on disk.
    const entry = path && path.split('/').some((p) => p === '' || p === '.' || p === '..') ? null : await git.entry(sha, path);
    if (!entry) throw new HttpError(404, 'Not Found');
    if (entry.type === 'tree') return c.json((await git.tree(sha, path))!.map((e) => contentJson(s, repo, sha, path ? `${path}/${e.name}` : e.name, e)));
    const json = contentJson(s, repo, sha, path, entry);
    if (entry.type !== 'blob') return c.json(json);
    // As on GitHub, files over 1 MB come without their content.
    const bytes = (entry.size ?? 0) <= 1024 * 1024 ? await git.blob(sha, path) : null;
    return c.json({ ...json, encoding: bytes ? 'base64' : 'none', content: bytes ? bytes.toString('base64') : '' });
  };
  app.get('/repos/:owner/:repo/contents', contents);
  app.get('/repos/:owner/:repo/contents/:path{.+}', contents);

  // ------------------------------------------------------- gh-shaped (CLI)

  app.get('/repos/:owner/:repo/gh/pulls', async (c) => {
    const repo = s.repo(c.req.param('owner'), c.req.param('repo'));
    const viewer = actor(c);
    const list = s.pulls(repo, { state: c.req.query('state') ?? 'open', head: c.req.query('head'), base: c.req.query('base') });
    const limit = Number(c.req.query('limit') ?? 30);
    const out = [];
    for (const p of list.slice(0, limit)) {
      out.push(await ghPullJson(s, await s.ctx(repo.owner, repo.name, p.number), viewer, fields(c)));
    }
    return c.json(out);
  });
  app.get('/repos/:owner/:repo/gh/pulls/:n', async (c) => {
    const x = await ctx(c);
    const readAt = now();
    const json = await ghPullJson(s, x, actor(c), fields(c));
    if (c.req.query('seen') && actor(c).id === x.pull.author_id) s.markSeen(x.pull, readAt);
    return c.json(json);
  });

  // ------------------------------------------------------------------ pulls

  app.get('/repos/:owner/:repo/pulls', (c) => {
    const repo = s.repo(c.req.param('owner'), c.req.param('repo'));
    const list = s.pulls(repo, { state: c.req.query('state') ?? 'open', head: c.req.query('head'), base: c.req.query('base') });
    return c.json(list.map((p) => pullJson(s, repo, p)));
  });

  app.post('/repos/:owner/:repo/pulls', async (c) => {
    const repo = s.repo(c.req.param('owner'), c.req.param('repo'));
    const b = await body(c);
    // laatsux extension: `reviewers` and `automatic_reviews` decide the reviewer agents for this pull request.
    const review = s.reviewRequest(b.reviewers, b.automatic_reviews);
    const pull = await s.createPull(repo, { title: b.title, body: b.body, head: b.head, base: b.base, draft: !!b.draft, fill: b.fill, reviews: review.columns }, actor(c));
    return c.json({ ...pullJson(s, repo, pull), ...(review.ignored.length ? { ignored_reviewers: review.ignored } : {}) }, 201);
  });

  // Registered before /pulls/:n/... so "comments" is not taken for a number.
  app.get('/repos/:owner/:repo/pulls/comments/:id', async (c) => {
    const { repo, pull, comment } = commentIn(c, 'review');
    const x = await s.ctx(repo.owner, repo.name, pull.number);
    const root = comment.in_reply_to_id ? s.comment(comment.in_reply_to_id) : comment;
    return c.json(reviewCommentJson(s, repo, x.pull, comment, root, await s.place(x, root)));
  });
  app.patch('/repos/:owner/:repo/pulls/comments/:id', async (c) => {
    const { repo, pull, comment } = commentIn(c, 'review');
    const b = await body(c);
    const updated = s.updateComment(comment.id, String(b.body ?? ''), actor(c));
    const root = updated.in_reply_to_id ? s.comment(updated.in_reply_to_id) : updated;
    return c.json(reviewCommentJson(s, repo, pull, updated, root, null));
  });
  app.delete('/repos/:owner/:repo/pulls/comments/:id', (c) => {
    s.deleteComment(commentIn(c, 'review').comment.id, actor(c));
    return c.body(null, 204);
  });

  app.get('/repos/:owner/:repo/pulls/:n', async (c) => {
    const x = await ctx(c);
    const accept = c.req.header('accept') ?? '';
    const format = c.req.query('format');
    if (format === 'diff' || accept.includes('diff')) return c.text(await x.git.rawDiff(x.pull.base_sha, x.pull.head_sha));
    if (format === 'patch' || accept.includes('patch')) {
      return c.text(await x.git.out(['format-patch', '--stdout', `${x.pull.base_sha}..${x.pull.head_sha}`]));
    }
    return c.json(pullJson(s, x.repo, x.pull, { files: await s.files(x), commits: await s.commits(x) }));
  });

  app.patch('/repos/:owner/:repo/pulls/:n', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const pull = await s.updatePull(x, { title: b.title, body: b.body, base: b.base, state: b.state, draft: b.draft }, actor(c));
    return c.json(pullJson(s, x.repo, pull));
  });

  app.delete('/repos/:owner/:repo/pulls/:n', async (c) => {
    await s.deletePull(await ctx(c, { sync: false }), actor(c));
    return c.body(null, 204);
  });

  app.get('/repos/:owner/:repo/pulls/:n/commits', async (c) => {
    const x = await ctx(c);
    return c.json((await s.commits(x)).map((cm) => commitJson(s, x.repo, x.pull, cm)));
  });

  app.get('/repos/:owner/:repo/pulls/:n/files', async (c) => {
    const x = await ctx(c);
    return c.json((await s.files(x)).map(fileJson));
  });

  app.get('/repos/:owner/:repo/pulls/:n/comments', async (c) => {
    const x = await ctx(c);
    return c.json(threadCommentsJson(s, x, await s.threads(x, actor(c))));
  });

  app.post('/repos/:owner/:repo/pulls/:n/comments', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const comment = await s.addReviewComment(x, { ...b, body: String(b.body ?? '') }, actor(c));
    const root = comment.in_reply_to_id ? s.comment(comment.in_reply_to_id) : comment;
    return c.json(reviewCommentJson(s, x.repo, x.pull, comment, root, await s.place(x, root)), 201);
  });

  app.post('/repos/:owner/:repo/pulls/:n/comments/:id/replies', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const comment = s.reply(x, num(c.req.param('id'), 'comment id'), String(b.body ?? ''), actor(c));
    const root = s.comment(comment.in_reply_to_id!);
    return c.json(reviewCommentJson(s, x.repo, x.pull, comment, root, await s.place(x, root)), 201);
  });

  // laatsux extension: add a comment to the caller's pending review (starting one if needed).
  app.post('/repos/:owner/:repo/pulls/:n/pending-comments', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const comment = await s.addPendingComment(x, { ...b, body: String(b.body ?? '') }, actor(c));
    return c.json(reviewCommentJson(s, x.repo, x.pull, comment, comment, await s.place(x, comment)), 201);
  });

  // laatsux extension: resolve and unresolve review threads.
  app.put('/repos/:owner/:repo/pulls/:n/threads/:id/resolved', async (c) => {
    const x = await ctx(c);
    s.setResolved(x, num(c.req.param('id'), 'thread id'), true, actor(c));
    return c.body(null, 204);
  });
  app.delete('/repos/:owner/:repo/pulls/:n/threads/:id/resolved', async (c) => {
    const x = await ctx(c);
    s.setResolved(x, num(c.req.param('id'), 'thread id'), false, actor(c));
    return c.body(null, 204);
  });

  // laatsux extension: pin a pull request to the top of the reviewer's front page, and unpin it.
  app.put('/repos/:owner/:repo/pulls/:n/pinned', async (c) => {
    s.setPinned((await ctx(c, { sync: false })).pull, true, actor(c));
    return c.body(null, 204);
  });
  app.delete('/repos/:owner/:repo/pulls/:n/pinned', async (c) => {
    s.setPinned((await ctx(c, { sync: false })).pull, false, actor(c));
    return c.body(null, 204);
  });

  app.get('/repos/:owner/:repo/pulls/:n/reviews', async (c) => {
    const x = await ctx(c);
    return c.json(s.reviews(x.pull, actor(c)).map((r) => reviewJson(s, x.repo, x.pull, r)));
  });

  app.post('/repos/:owner/:repo/pulls/:n/reviews', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const review = await s.createReview(x, { body: b.body, event: b.event, commit_id: b.commit_id, comments: b.comments }, actor(c));
    return c.json(reviewJson(s, x.repo, x.pull, review), 200);
  });

  app.get('/repos/:owner/:repo/pulls/:n/reviews/:id', async (c) => {
    const x = await ctx(c);
    const r = s.review(num(c.req.param('id'), 'review id'));
    if (r.pull_id !== x.pull.id || (r.state === 'PENDING' && r.author_id !== actor(c).id)) throw new HttpError(404, 'review not found');
    return c.json(reviewJson(s, x.repo, x.pull, r));
  });

  app.get('/repos/:owner/:repo/pulls/:n/reviews/:id/comments', async (c) => {
    const x = await ctx(c);
    const id = num(c.req.param('id'), 'review id');
    const threads = await s.threads(x, actor(c));
    return c.json(threadCommentsJson(s, x, threads).filter((cm) => cm.pull_request_review_id === id));
  });

  app.post('/repos/:owner/:repo/pulls/:n/reviews/:id/events', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const r = s.submitReview(x, num(c.req.param('id'), 'review id'), b.event as ReviewEvent, b.body, actor(c));
    return c.json(reviewJson(s, x.repo, x.pull, r));
  });

  app.delete('/repos/:owner/:repo/pulls/:n/reviews/:id', async (c) => {
    const x = await ctx(c);
    s.deletePendingReview(x, num(c.req.param('id'), 'review id'), actor(c));
    return c.body(null, 204);
  });

  // laatsux extension: mark a file as viewed (keyed by its blob, so a change un-views it).
  app.put('/repos/:owner/:repo/pulls/:n/viewed', async (c) => {
    const x = await ctx(c, { sync: false });
    const b = await body(c);
    s.setViewed(x.pull, String(b.path), String(b.blob), !!b.viewed);
    return c.body(null, 204);
  });

  // laatsux extension: ask a reviewer agent (`codex`, `claude`) to review now, and list its runs.
  app.post('/repos/:owner/:repo/pulls/:n/reviewers/:kind', async (c) => {
    human(c);
    const reviewer = reviewerOf(c);
    const x = await ctx(c);
    return c.json({ run_id: reviewer.request(x) }, 202);
  });
  // laatsux extension: this pull request's own settings for a reviewer agent, `enabled` and `max_iterations` (null for the setting).
  app.patch('/repos/:owner/:repo/pulls/:n/reviewers/:kind', async (c) => {
    human(c);
    const reviewer = reviewerOf(c);
    const x = await ctx(c);
    const b = await body(c);
    return c.json(reviewer.configure(x, { enabled: b.enabled, max_iterations: b.max_iterations }));
  });
  // laatsux extension: stop iterating: no reviewer agent starts another automatic review. DELETE resumes.
  app.put('/repos/:owner/:repo/pulls/:n/stop-iterating', async (c) => {
    const who = human(c);
    const x = await ctx(c, { sync: false });
    s.stopIterating(x, who);
    return c.json(pullJson(s, x.repo, s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', x.pull.id)!));
  });
  app.delete('/repos/:owner/:repo/pulls/:n/stop-iterating', async (c) => {
    const who = human(c);
    s.resumeIterating(await ctx(c, { sync: false }), who);
    return c.body(null, 204);
  });
  app.get('/repos/:owner/:repo/pulls/:n/reviewers/:kind', async (c) => {
    const x = await ctx(c, { sync: false });
    const reviewer = s.reviewerAgents().find((r) => r.engine === c.req.param('kind'));
    if (!reviewer) return c.json({ running: false, runs: [] });
    // `usage`, what a run cost as its tool reported it (Claude does), is JSON in the database.
    const runs = reviewer.runs(x.pull).map((r) => ({ ...r, usage: r.usage ? JSON.parse(r.usage) : null }));
    return c.json({ running: reviewer.isRunning(x.pull.id), runs, ...reviewer.config(x.pull) });
  });

  /**
   * The merge method to turn on auto-merge with: the one in settings now. Extension: the page
   * sends the one it shows with the auto-merge option, which must still be that, or the one
   * auto-publish was approved with: the page offers that one while auto-publish is on.
   */
  const mergeMethod = (shown: unknown, pull: PullRow): MergeMethod => {
    const method = readSettings(s.db).publish.mergeMethod;
    const approved = s.autoPublish(pull)?.autoMerge;
    if (approved && shown === approved) return approved;
    if (shown !== undefined && shown !== method) {
      throw new HttpError(412, `The merge method in Settings changed to ${method} after this page was loaded. Refresh before publishing.`);
    }
    return method;
  };

  // laatsux extension: push the branch and open (or update) the pull request on GitHub.
  app.post('/repos/:owner/:repo/pulls/:n/publish', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const sign = typeof b.sign === 'boolean' ? b.sign : undefined;
    // Decided now: the setting may change while publishing awaits.
    const autoMerge = b.auto_merge ? mergeMethod(b.merge_method, x.pull) : undefined;
    const pull = await s.publish(x, { draft: b.draft, force: !!b.force, expected: b.expected, sign, duringReview: !!b.during_review, autoMerge }, actor(c));
    // Extension: what came of turning on auto-merge, which does not undo the publish when it fails.
    return c.json({ ...pullJson(s, x.repo, pull), auto_merge_result: autoMerge ? autoMergeResult(s.autoMerge(pull)) : undefined });
  });

  // laatsux extension: auto-publish, like GitHub's auto-merge: publish once the agents are done.
  app.put('/repos/:owner/:repo/pulls/:n/auto-publish', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const autoMerge = b.auto_merge ? mergeMethod(b.merge_method, x.pull) : undefined;
    await s.enableAutoPublish(x, { sign: flag(b.sign), draft: flag(b.draft), force: !!b.force, autoMerge }, actor(c));
    return c.json(pullJson(s, x.repo, s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', x.pull.id)!));
  });
  app.delete('/repos/:owner/:repo/pulls/:n/auto-publish', async (c) => {
    s.disableAutoPublish(await ctx(c, { sync: false }), actor(c));
    return c.body(null, 204);
  });

  // laatsux extension: long-poll until someone other than the author gives feedback.
  app.get('/repos/:owner/:repo/pulls/:n/wait', async (c) => {
    const x = await ctx(c);
    if (x.pull.author_id === s.viewer().id) {
      throw new HttpError(422, `${s.viewer().login} staged this pull request and is also the reviewer, so no feedback from anyone else will arrive. Agents should set LAATSUX_ACTOR.`);
    }
    const seconds = Number(c.req.query('timeout') ?? 240);
    const timeout = Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : 240, 3600) * 1000;
    const r = await s.wait(x, actor(c), timeout, c.req.raw.signal);
    const pull = s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', x.pull.id);
    return c.json({
      status: r.status,
      published_url: pull?.published_url ?? null,
      // Who merged or closed it on GitHub (gh's JSON has no field for who closed it).
      github_closed_by: pull?.github_closed_by ?? null,
      reviews: r.reviews.map((rv) => rv.id),
      comments: r.comments.map((cm) => ({ id: cm.id, kind: cm.kind, in_reply_to_id: cm.in_reply_to_id })),
      // Everything needed to show the feedback, so no second request can fail in between.
      pr: r.status !== 'timeout' && pull ? await ghPullJson(s, await s.ctx(x.repo.owner, x.repo.name, pull.number), actor(c), []) : undefined,
      seen_at: r.seenAt,
      // With status agents_done: the head the reviewer agents are done with, and what each made of it.
      agents_done: r.agentsDone ?? null,
    });
  });

  // laatsux extension: the author confirms it has shown the feedback a wait returned, and that
  // the reviewer agents are done with a commit (`agents_done`, the SHA), when it said so.
  app.put('/repos/:owner/:repo/pulls/:n/seen', async (c) => {
    const x = await ctx(c, { sync: false });
    if (actor(c).id !== x.pull.author_id) throw new HttpError(403, 'only the author marks feedback as seen');
    const b = await body(c);
    const at = String(b.at ?? '');
    if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(at)) throw new HttpError(422, 'at must be the seen_at of a wait response');
    const done = b.agents_done === undefined ? undefined : String(b.agents_done);
    if (done !== undefined && !/^[0-9a-f]{40}$/.test(done)) throw new HttpError(422, 'agents_done must be the SHA of a wait response');
    s.markSeen(x.pull, at, done);
    return c.body(null, 204);
  });

  // ----------------------------------------------------------------- issues

  app.get('/repos/:owner/:repo/issues/comments/:id', (c) => {
    const { repo, pull, comment } = commentIn(c, 'issue');
    return c.json(issueCommentJson(s, repo, pull, comment));
  });
  app.patch('/repos/:owner/:repo/issues/comments/:id', async (c) => {
    const { repo, pull, comment: existing } = commentIn(c, 'issue');
    const b = await body(c);
    const comment = s.updateComment(existing.id, String(b.body ?? ''), actor(c));
    return c.json(issueCommentJson(s, repo, pull, comment));
  });
  app.delete('/repos/:owner/:repo/issues/comments/:id', (c) => {
    s.deleteComment(commentIn(c, 'issue').comment.id, actor(c));
    return c.body(null, 204);
  });

  app.get('/repos/:owner/:repo/issues/:n', async (c) => {
    const x = await ctx(c);
    const json = pullJson(s, x.repo, x.pull);
    return c.json({ ...json, pull_request: { url: json.url, html_url: json.html_url } });
  });

  app.get('/repos/:owner/:repo/issues/:n/comments', async (c) => {
    const x = await ctx(c);
    return c.json(s.issueComments(x.pull).map((cm) => issueCommentJson(s, x.repo, x.pull, cm)));
  });

  app.post('/repos/:owner/:repo/issues/:n/comments', async (c) => {
    const x = await ctx(c);
    const b = await body(c);
    const comment = s.addIssueComment(x, String(b.body ?? ''), actor(c));
    return c.json(issueCommentJson(s, x.repo, x.pull, comment), 201);
  });

  app.get('/repos/:owner/:repo/issues/:n/timeline', async (c) => {
    const x = await ctx(c);
    const viewer = actor(c);
    const items: { at: string; item: Record<string, unknown> }[] = [];
    for (const e of s.events(x.pull)) {
      items.push({ at: e.created_at, item: { event: e.type, actor: userJson(s, s.db.actorById(e.actor_id)), created_at: e.created_at, ...JSON.parse(e.data) } });
    }
    for (const cm of s.issueComments(x.pull)) items.push({ at: cm.created_at, item: { event: 'commented', ...issueCommentJson(s, x.repo, x.pull, cm) } });
    for (const r of s.reviews(x.pull, viewer)) {
      if (r.submitted_at) items.push({ at: r.submitted_at, item: { event: 'reviewed', ...reviewJson(s, x.repo, x.pull, r) } });
    }
    items.sort((a, b) => a.at.localeCompare(b.at));
    return c.json(items.map((i) => i.item));
  });

  return app;
}
