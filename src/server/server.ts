import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve, type ServerType } from '@hono/node-server';
import { Db } from './db.ts';
import { FOLLOW_BUSY_MS, Service, type ChangeEvent } from './service.ts';
import { api } from './api.ts';
import { web } from './web/routes.ts';
import { avatarSvg } from './web/html.ts';
import { CodexReviewer } from './reviewers/codex.ts';
import { ClaudeReviewer } from './reviewers/claude.ts';
import { CustomReviewers } from './reviewers/custom.ts';
import { configDir, fromEnv } from '../config.ts';
import { uploads } from './uploads.ts';
import { AutoPublisher } from './auto-publish.ts';
import { databaseFile, moveFromLaatsux } from './rename.ts';
import type { ProgressEvent } from './reviewers/transcript.ts';

const PUBLIC = join(import.meta.dirname, '..', '..', 'public');
const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp(s: Service, opts: { allowedHosts: string[]; uploadsDir: string }): Hono {
  const app = new Hono();

  // The API can push to GitHub, so only accept requests addressed to us (no DNS rebinding)
  // and refuse cross-site writes from other pages open in the browser.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!opts.allowedHosts.includes(host)) return c.text(`galley: unexpected Host header "${host}"`, 403);
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin && !opts.allowedHosts.some((h) => origin === `http://${h}`)) {
      return c.text('galley: cross-origin request refused', 403);
    }
    await next();
  });

  // Before the API and the web routes, whose /:owner/:repo would take /uploads/<file>.
  app.route('/', uploads(opts.uploadsDir));
  app.route('/api', api(s));

  app.get('/static/:file', (c) => {
    const file = c.req.param('file');
    if (!/^[\w.-]+$/.test(file)) return c.notFound();
    try {
      const body = readFileSync(join(PUBLIC, file));
      const ext = file.slice(file.lastIndexOf('.'));
      return c.body(body, 200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    } catch {
      return c.notFound();
    }
  });

  app.get('/avatars/:file', (c) => {
    const login = decodeURIComponent(c.req.param('file').replace(/\.svg$/, ''));
    const actor = s.db.get<{ type: 'User' | 'Bot' }>('SELECT type FROM actors WHERE login = ?', login);
    return c.body(avatarSvg(login, actor?.type ?? 'User'), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
  });

  // Live updates for open pages: every change to a pull request is pushed as an event, and so
  // is a reviewer agent's progress (throttled), for pages that show the run. Each is a message
  // { type, event }, which the shared worker passes on to the tabs whatever its type.
  app.get('/events', (c) => {
    const pullId = c.req.query('pull') ? Number(c.req.query('pull')) : null;
    return streamSSE(c, async (stream) => {
      const send = (type: 'change' | 'progress', event: ChangeEvent | ProgressEvent) => stream.writeSSE({ data: JSON.stringify({ type, event }) }).catch(() => {});
      const onChange = (e: ChangeEvent) => {
        if (pullId === null || e.pullId === pullId || e.pullId === null) send('change', e);
      };
      const onProgress = (e: ProgressEvent) => {
        if (pullId === null || e.pullId === pullId) send('progress', e);
      };
      const off = () => {
        s.bus.off('change', onChange);
        s.bus.off('progress', onProgress);
      };
      s.bus.on('change', onChange);
      s.bus.on('progress', onProgress);
      stream.onAbort(off);
      while (!stream.aborted) {
        await stream.sleep(20_000);
        await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
      }
      off();
    });
  });

  app.route('/', web(s));
  return app;
}

export interface StartOptions {
  port: number;
  host?: string;
  dataDir: string;
  /** Move the data and config directories from their names before the rename, as `galley serve` does (rename.ts). */
  moveFromLaatsux?: boolean;
  ghBin?: string;
  codexBin?: string;
  claudeBin?: string;
  /** Stands in for sandbox-exec, which installs dependencies for the Claude reviewer (in tests). */
  sandboxExec?: string;
  /** Where the custom reviewers' definitions are: by default reviewers/ in configDir(). */
  reviewersDir?: string;
  viewerLogin?: string;
  pollMs?: number;
  /** How often to see which repositories are due to be asked about their published pull requests (Service.followGithub), or to have their base branches fetched (Service.fetchAllBases). */
  followMs?: number;
  /** How long after fetching a repository's base branches they may be fetched again (Service.fetchBases). */
  fetchMs?: number;
}

export interface CloseOptions {
  /** How long running reviews may take to post before they are interrupted (they run again on the next start). */
  graceMs?: number;
}

export async function startServer(opts: StartOptions): Promise<{ url: string; port: number; service: Service; close: (o?: CloseOptions) => Promise<void> }> {
  const host = opts.host ?? '127.0.0.1';

  let server: ServerType;
  let app: Hono | null = null;
  let inflight = 0;
  const drained = new EventEmitter();
  const port = await new Promise<number>((resolve, reject) => {
    const fetch = async (req: Request) => {
      if (!app) return new Response('starting', { status: 503 });
      // Count handlers that are still running, so closing can let them finish with the database.
      inflight++;
      try {
        return await app.fetch(req);
      } finally {
        if (--inflight === 0) drained.emit('idle');
      }
    };
    server = serve({ fetch, port: opts.port, hostname: host }, (info) => resolve(info.port));
    server.once('error', reject);
  });
  // The database opens once the port is ours: a second server on the port stops before it, and
  // moving the directories from laatsux's names can not pull them from under the first.
  let db: Db;
  let dataDir = opts.dataDir;
  try {
    if (opts.moveFromLaatsux) dataDir = moveFromLaatsux(dataDir);
    mkdirSync(dataDir, { recursive: true });
    db = new Db(databaseFile(dataDir));
  } catch (e) {
    server!.close();
    throw e;
  }
  const url = `http://localhost:${port}`;
  const service = new Service({ db, baseUrl: url, ghBin: opts.ghBin ?? fromEnv('GH'), viewerLogin: opts.viewerLogin ?? fromEnv('USER'), fetchEveryMs: opts.fetchMs });
  // A new instance id (a copied database, or one from before namespaces) pins what it has first.
  await service.pinRevisions();
  // A repository whose remote names another GitHub repository now (renamed there) takes its name before the first page.
  await service.followRemotes();
  const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
  service.codex = new CodexReviewer(service, opts.codexBin ?? fromEnv('CODEX') ?? 'codex');
  service.claude = new ClaudeReviewer(service, opts.claudeBin ?? fromEnv('CLAUDE') ?? 'claude', opts.sandboxExec);
  // Custom reviewers run with Codex's and Claude's tools.
  service.custom = new CustomReviewers(service, opts.reviewersDir ?? join(configDir(), 'reviewers'), { codex: service.codex.tool, claude: service.claude.tool });
  service.custom.load();
  for (const reviewer of service.reviewerAgents()) reviewer.start();
  service.custom.start();
  const autoPublisher = new AutoPublisher(service);
  autoPublisher.start();
  app = createApp(service, { allowedHosts, uploadsDir: join(dataDir, 'uploads') });
  if (!opts.viewerLogin && !fromEnv('USER')) service.detectViewer();
  // Warm what the pages show about the repositories on GitHub, so the first page already has it.
  for (const repo of service.repos()) if (repo.github_slug) service.refreshGithubRepo(repo.github_slug);

  // The running poll, which closing waits for before the database closes.
  let polling: Promise<void> | null = null;
  const poll = async () => {
    try {
      await service.pollAll();
      service.noticeStalls();
      autoPublisher.considerAll();
    } catch (e) {
      console.error('poll failed:', e);
    }
  };
  const timer = setInterval(() => {
    polling ??= poll().finally(() => (polling = null));
  }, opts.pollMs ?? 2000);
  timer.unref();

  // Published pull requests are followed on GitHub until they are merged or closed there, and the
  // base branches of staged ones are fetched, on the same schedule.
  let following: Promise<void> | null = null;
  let fetching: Promise<void> | null = null;
  const followDue = () => {
    following ??= service.followGithub({ due: true }).finally(() => (following = null));
    fetching ??= service
      .fetchAllBases()
      .catch((e) => console.error('fetching base branches failed:', e))
      .finally(() => (fetching = null));
  };
  followDue();
  const follow = setInterval(followDue, opts.followMs ?? FOLLOW_BUSY_MS);
  follow.unref();

  let closing: Promise<void> | null = null;
  const close = async ({ graceMs = 0 }: CloseOptions = {}) => {
    // Auto-publish starts nothing from here on: a review the stop cuts off must not look done to it.
    const publishing = autoPublisher.stop();
    // Running reviews post first, while everything else carries on: pages say what the server
    // waits for, pushes and merges are still noticed, and the author's `pr wait` gets the review.
    if (graceMs > 0 && service.reviewsRunning()) {
      service.stopping = true;
      service.bus.emit('change', { pullId: null, type: 'stopping', actor: 'galley' } satisfies ChangeEvent);
    }
    // Changes to the definitions start and stop no more reviewers.
    service.custom?.stop();
    await Promise.all(service.reviewerAgents().map((r) => r.stop(graceMs)));
    clearInterval(timer);
    clearInterval(follow);
    await service.stopFetching();
    await polling;
    await following;
    await fetching;
    // Publishes write to the database when they end, so they go first.
    await publishing;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    // Dropped requests (an open `pr wait`) still finish their handlers; give them a moment.
    if (inflight > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        drained.once('idle', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    // Checks for conflicts with the base read the database too.
    await service.conflictChecks;
    db.sql.close();
  };

  return {
    url,
    port,
    service,
    // Closing again while running reviews have time to post interrupts them.
    close: (o?: CloseOptions) => {
      if (closing) for (const r of service.reviewerAgents()) r.interrupt();
      return (closing ??= close(o));
    },
  };
}
