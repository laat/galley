import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, type Service } from '../service.ts';
import { commitsPage, conversationPage, filesPage, loadPull, notFoundPage, progressPart, pullList, transcriptPage } from './pages.ts';
import { customReviewerPage, customReviewersPage, desktopSettingsPage, publishingSettingsPage, settingsPage } from './settings.ts';
import { browseUrl, type DiffMode } from './diffview.ts';
import { blobPage, excerpt, locate, rawFile, treeItemsHtml, treePage } from './browse.ts';

export function web(s: Service): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError && err.status === 404) return c.html(notFoundPage(s, err.message), 404);
    console.error(err);
    return c.html(notFoundPage(s, `Something went wrong: ${(err as Error).message}`), 500);
  });

  // A repository whose key followed its GitHub slug (Service.followSlug): its old URLs lead to the
  // new ones. Browsers do not keep the redirect, since the key may change back.
  app.use('/:owner/:repo/*', async (c, next) => {
    const moved = s.movedRepo(c.req.param('owner'), c.req.param('repo'));
    if (!moved) return next();
    const url = new URL(c.req.url);
    c.header('cache-control', 'no-store');
    return c.redirect(['', moved.owner, moved.name, ...url.pathname.split('/').slice(3)].join('/') + url.search, 301);
  });

  // /pull/s4, as people write a staged pull request (s#4), is /pull/4.
  app.use('/:owner/:repo/pull/*', async (c, next) => {
    const url = new URL(c.req.url);
    const parts = url.pathname.split('/');
    if (!/^[sS]\d+$/.test(parts[4] ?? '')) return next();
    parts[4] = parts[4].slice(1);
    return c.redirect(parts.join('/') + url.search, 301);
  });

  const load = (c: Context) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n)) throw new HttpError(404, 'Not found');
    return loadPull(s, c.req.param('owner')!, c.req.param('repo')!, n);
  };

  app.get('/', (c) => c.html(pullList(s, { repo: null, state: c.req.query('state') ?? 'staged' })));
  // Registered before /:owner/:repo, which would otherwise match "settings".
  app.get('/settings', async (c) => c.html(await settingsPage(s)));
  app.get('/settings/publishing', (c) => c.html(publishingSettingsPage(s)));
  app.get('/settings/desktop', (c) => c.html(desktopSettingsPage(s)));
  // The files are read again, for edits made while nothing followed the directory (made after the server started).
  app.get('/settings/reviewers', (c) => {
    s.custom?.load();
    return c.html(customReviewersPage(s));
  });
  // Not under /settings/reviewers/, where a reviewer could be called "new".
  app.get('/settings/new-reviewer', async (c) => c.html(await customReviewerPage(s, null)));
  app.get('/settings/reviewers/:name', async (c) => {
    s.custom?.load();
    return c.html(await customReviewerPage(s, c.req.param('name')));
  });
  app.get('/:owner/:repo', (c) => c.html(pullList(s, { repo: s.repo(c.req.param('owner'), c.req.param('repo')), state: c.req.query('state') ?? 'staged' })));
  app.get('/:owner/:repo/pulls', (c) => c.redirect(`/${c.req.param('owner')}/${c.req.param('repo')}`));
  app.get('/:owner/:repo/pull/:n', async (c) => c.html(await conversationPage(await load(c))));
  app.get('/:owner/:repo/pull/:n/commits', async (c) => c.html(commitsPage(await load(c))));
  app.get('/:owner/:repo/pull/:n/files', async (c) => {
    let mode = c.req.query('diff') as DiffMode | undefined;
    if (mode === 'split' || mode === 'unified') setCookie(c, 'diff', mode, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'Lax' });
    else mode = getCookie(c, 'diff') === 'split' ? 'split' : 'unified';
    return c.html(await filesPage(await load(c), { commit: c.req.query('commit'), range: c.req.query('range') }, mode));
  });
  // A reviewer agent's run (an extension): its transcript, and its progress while it runs.
  app.get('/:owner/:repo/pull/:n/runs/:id', async (c) => c.html(transcriptPage(await load(c), Number(c.req.param('id')))));
  app.get('/:owner/:repo/pull/:n/runs/:id/progress', async (c) => {
    const part = await progressPart(s, c.req.param('owner'), c.req.param('repo'), Number(c.req.param('n')), Number(c.req.param('id')));
    return part === null ? c.body(null, 204) : c.html(part);
  });
  app.get('/:owner/:repo/pull/:n/commits/:sha', (c) => c.redirect(`/${c.req.param('owner')}/${c.req.param('repo')}/pull/${c.req.param('n')}/files?commit=${c.req.param('sha')}`));

  // The repository at a commit, at GitHub's URLs. A directory at a /blob URL and a file at a
  // /tree URL redirect, so relative links in rendered Markdown work either way.
  const at = (c: Context) => locate(s, c.req.param('owner')!, c.req.param('repo')!, c.req.param('sha')!, c.req.param('path'));
  const notFound = (path: string) => new HttpError(404, `No ${path ? `path ${path}` : 'such path'} at this commit`);
  const tree = async (c: Context) => {
    const loc = await at(c);
    const entries = await loc.git.tree(loc.sha, loc.path);
    if (entries) return c.html(await treePage(s, loc, entries));
    if ((await loc.git.entry(loc.sha, loc.path))?.type === 'blob') return c.redirect(browseUrl(loc.base, 'blob', loc.sha, loc.path));
    throw notFound(loc.path);
  };
  app.get('/:owner/:repo/tree/:sha', tree);
  app.get('/:owner/:repo/tree/:sha/:path{.+}', tree);
  app.get('/:owner/:repo/blob/:sha', async (c) => {
    const loc = await at(c);
    return c.redirect(browseUrl(loc.base, 'tree', loc.sha, ''));
  });
  app.get('/:owner/:repo/blob/:sha/:path{.+}', async (c) => {
    const loc = await at(c);
    const entry = await loc.git.entry(loc.sha, loc.path);
    if (entry?.type === 'tree') return c.redirect(browseUrl(loc.base, 'tree', loc.sha, loc.path));
    if (entry?.type !== 'blob') throw notFound(loc.path);
    return c.html(await blobPage(s, loc, entry, { plain: c.req.query('plain') === '1' }));
  });
  app.get('/:owner/:repo/raw/:sha/:path{.+}', async (c) => rawFile(await at(c)));
  // For the file tree in public/app.js (an extension): the items of a directory it opens.
  const items = async (c: Context) => {
    const loc = await at(c);
    const htmlText = await treeItemsHtml(loc);
    if (htmlText === null) throw notFound(loc.path);
    return c.html(htmlText);
  };
  app.get('/:owner/:repo/file-tree/:sha', items);
  app.get('/:owner/:repo/file-tree/:sha/:path{.+}', items);
  // Every file's path, for "Go to file", as GitHub's /tree-list. The browser keeps it: a commit's
  // files never change.
  app.get('/:owner/:repo/tree-list/:sha', async (c) => {
    const loc = await at(c);
    const immutable = c.req.param('sha') === loc.sha;
    return c.json({ paths: await loc.git.files(loc.sha) }, 200, immutable ? { 'cache-control': 'private, max-age=31536000, immutable' } : {});
  });
  app.get('/:owner/:repo/blob_excerpt/:sha', async (c) => {
    const loc = await locate(s, c.req.param('owner'), c.req.param('repo'), c.req.param('sha'), c.req.query('path') ?? '');
    const [from, to, delta] = ['from', 'to', 'delta'].map((k) => Number(c.req.query(k)));
    if (![from, to, delta].every(Number.isInteger)) return c.text('from, to and delta must be whole numbers', 400);
    return c.html(await excerpt(loc, { from, to, delta, mode: c.req.query('diff') === 'split' ? 'split' : 'unified' }));
  });
  return app;
}
