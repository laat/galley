import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { HttpError, type Service } from '../service.ts';
import { commitsPage, conversationPage, filesPage, loadPull, notFoundPage, pullList } from './pages.ts';
import { settingsPage } from './settings.ts';
import type { DiffMode } from './diffview.ts';

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

  app.get('/', (c) => c.html(pullList(s, { repo: null, state: c.req.query('state') ?? 'open' })));
  // Registered before /:owner/:repo, which would otherwise match "settings".
  app.get('/settings', async (c) => c.html(await settingsPage(s)));
  app.get('/:owner/:repo', (c) => c.html(pullList(s, { repo: s.repo(c.req.param('owner'), c.req.param('repo')), state: c.req.query('state') ?? 'open' })));
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
  return app;
}
