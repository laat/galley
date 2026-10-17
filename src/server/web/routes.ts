import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, type Service } from '../service.ts';
import { commitsPage, conversationPage, filesPage, loadPull, notFoundPage, pullList } from './pages.ts';
import { publishingSettingsPage, settingsPage } from './settings.ts';
import { browseUrl, type DiffMode } from './diffview.ts';
import { blobPage, excerpt, locate, rawFile, treePage } from './browse.ts';

export function web(s: Service): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError && err.status === 404) return c.html(notFoundPage(s, err.message), 404);
    console.error(err);
    return c.html(notFoundPage(s, `Something went wrong: ${(err as Error).message}`), 500);
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
  app.get('/:owner/:repo/blob_excerpt/:sha', async (c) => {
    const loc = await locate(s, c.req.param('owner'), c.req.param('repo'), c.req.param('sha'), c.req.query('path') ?? '');
    const [from, to, delta] = ['from', 'to', 'delta'].map((k) => Number(c.req.query(k)));
    if (![from, to, delta].every(Number.isInteger)) return c.text('from, to and delta must be whole numbers', 400);
    return c.html(await excerpt(loc, { from, to, delta, mode: c.req.query('diff') === 'split' ? 'split' : 'unified' }));
  });
  return app;
}
