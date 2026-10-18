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
import { configDir, fromEnv, localUrl, META } from '../config.ts';
import { uploads } from './uploads.ts';
import { gitHttp } from './git-http.ts';
import { AutoPublisher } from './auto-publish.ts';
import type { ProgressEvent } from './reviewers/transcript.ts';
import { askingComputer, computerOf, requestComputer } from './computer.ts';
import type { IncomingMessage } from 'node:http';

const PUBLIC = join(import.meta.dirname, '..', '..', 'public');
const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp(s: Service, opts: { allowedHosts: string[]; uploadsDir: string }): Hono {
  const app = new Hono();

  // The API can push to GitHub, so only accept requests addressed to us (no DNS rebinding)
  // and refuse cross-site writes from other pages open in the browser. Our own pages may be served
  // over https by a proxy in front of us (`tailscale serve`).
  const hosts = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set([...hosts].flatMap((h) => [`http://${h}`, `https://${h}`]));
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!hosts.has(host.toLowerCase())) return c.text(`galley: unexpected Host header "${host}"`, 403);
    const origin = c.req.header('origin');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin && !origins.has(origin.toLowerCase())) {
      return c.text('galley: cross-origin request refused', 403);
    }
    // Which computer it comes from, for what is done only there (computer.ts).
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    await requestComputer.run(computerOf(incoming?.socket.remoteAddress, c.req.header('x-forwarded-for')), next);
  });

  // Before the API and the web routes, whose /:owner/:repo would take /uploads/<file> and /git/<owner>/<name>.git.
  app.use('/git/*', gitHttp(s));
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
  // { type, event }, which the shared worker passes on to the tabs whatever its type. The desktop
  // app's stream says it is the app's (?desktop=1), and whether the app opens galley links
  // (&open_links=1): pages opened in the browser on its computer hand off to it while it is open
  // (public/app.js).
  app.get('/events', (c) => {
    const pullId = c.req.query('pull') ? Number(c.req.query('pull')) : null;
    const desktop = c.req.query('desktop') === '1' ? { computer: askingComputer(), openLinks: c.req.query('open_links') === '1' } : null;
    return streamSSE(c, async (stream) => {
      if (desktop) s.desktopApps.add(desktop);
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
        if (desktop) s.desktopApps.delete(desktop);
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
  /**
   * Where the server is reached from other machines, as http(s)://host[:port] with no path, such
   * as the HTTPS URL `tailscale serve` gives it. Every link galley gives starts with it (by default
   * the URL it answers at on this machine), and requests addressed to its host are accepted.
   */
  publicUrl?: string;
  /** More Host values to accept besides localhost's and the public URL's, as host or host:port. */
  allowedHosts?: string[];
  dataDir: string;
  ghBin?: string;
  codexBin?: string;
  claudeBin?: string;
  /** Stands in for sandbox-exec on macOS or bwrap on Linux, which install dependencies for the Claude reviewer (in tests). */
  sandboxExec?: string;
  /** Where the custom reviewers' definitions are: by default reviewers/ in configDir(). */
  reviewersDir?: string;
  viewerLogin?: string;
  pollMs?: number;
  /** How often to see which repositories are due to be asked about their published pull requests (Service.followGithub), or to have their base branches fetched (Service.fetchAllBases). */
  followMs?: number;
  /** How long after fetching a repository's base branches they may be fetched again (Service.fetchBases). */
  fetchMs?: number;
  /** Where to fetch a GitHub repository from and push it to, for galley's clones, in place of GitHub (in tests). */
  githubUrl?: (slug: string) => string;
}

export interface CloseOptions {
  /** How long running reviews may take to post before they are interrupted (they run again on the next start). */
  graceMs?: number;
}

export async function startServer(opts: StartOptions): Promise<{
  url: string;
  port: number;
  /** The Host values it accepts. */
  allowedHosts: string[];
  service: Service;
  autoPublisher: AutoPublisher;
  close: (o?: CloseOptions) => Promise<void>;
}> {
  const host = opts.host ?? '127.0.0.1';

  let server: ServerType;
  let app: Hono | null = null;
  let inflight = 0;
  const drained = new EventEmitter();
  const port = await new Promise<number>((resolve, reject) => {
    const fetch = async (req: Request, env: unknown) => {
      // Starting, it says it is galley all the same, so the CLI waits for it instead of taking it for another program.
      if (!app) return new URL(req.url).pathname === '/api/meta' ? Response.json(META, { status: 503 }) : new Response('starting', { status: 503 });
      // Count handlers that are still running, so closing can let them finish with the database.
      inflight++;
      try {
        // The connection, which says where the request comes from.
        return await app.fetch(req, env);
      } finally {
        if (--inflight === 0) drained.emit('idle');
      }
    };
    // Idle connections stay open until the client closes them (fetch after 4 seconds, browsers
    // after minutes) or close() does. Node's default closes them after 6 seconds, and fetch, told
    // 5 in the Keep-Alive header, after 3. A client whose event loop is busy from before its 3
    // seconds until after the server's 6 (a test running git, a CLI under load) then sends a
    // request on a connection the server closes before reading it, and gets ECONNRESET, which
    // fetch does not retry.
    server = serve({ fetch, port: opts.port, hostname: host, serverOptions: { keepAliveTimeout: 0 } }, (info) => resolve(info.port));
    server.once('error', reject);
  });
  // The database opens once the port is ours: a second server on the port stops before it.
  let db: Db;
  const dataDir = opts.dataDir;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new Db(join(dataDir, 'galley.db'));
  } catch (e) {
    server!.close();
    throw e;
  }
  // Where it answers on this machine: localhost, unless it listens on one address that is not.
  const url = localUrl(host, port);
  const publicUrl = opts.publicUrl ? new URL(opts.publicUrl) : null;
  const service = new Service({
    db,
    baseUrl: publicUrl?.origin ?? url,
    ghBin: opts.ghBin ?? fromEnv('GH'),
    viewerLogin: opts.viewerLogin ?? fromEnv('USER'),
    fetchEveryMs: opts.fetchMs,
    dataDir,
    githubUrl: opts.githubUrl,
  });
  // Repositories registered by path, from before galley kept clones of its own, move into clones first.
  await service.migrateRepos();
  // A new instance id (a copied data directory, or a database from before namespaces) pins what it has first.
  await service.pinRevisions();
  // localhost's, the address it listens on when that is one, the public URL's, and those it is told.
  const allowedHosts = [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, new URL(url).host, ...(publicUrl ? [publicUrl.host] : []), ...(opts.allowedHosts ?? [])])];
  service.codex = new CodexReviewer(service, opts.codexBin ?? fromEnv('CODEX') ?? 'codex');
  service.claude = new ClaudeReviewer(service, opts.claudeBin ?? fromEnv('CLAUDE') ?? 'claude', opts.sandboxExec);
  // Custom reviewers run with Codex's and Claude's tools.
  service.custom = new CustomReviewers(service, opts.reviewersDir ?? join(configDir(), 'reviewers'), { codex: service.codex.engine, claude: service.claude.engine });
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
  // base branches of open ones are fetched, on the same schedule.
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
      service.emitSystem(null, 'stopping', 'galley');
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
    allowedHosts,
    service,
    autoPublisher,
    // Closing again while running reviews have time to post interrupts them.
    close: (o?: CloseOptions) => {
      if (closing) for (const r of service.reviewerAgents()) r.interrupt();
      return (closing ??= close(o));
    },
  };
}
