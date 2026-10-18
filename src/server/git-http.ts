// git's smart HTTP for galley's clones (Service.registerGithub), at /git/<owner>/<name>.git: the
// CLI pushes the author's branches there, and fetches what galley fetched from GitHub. `git
// http-backend` serves it as a CGI program, streamed both ways, except the answer to a push, which
// comes once the repository's pull requests are synced with it (Service.received). Pushes go
// through galley's pre-receive hook (receive-hook.ts). Repositories registered by path have no git
// endpoint: galley reads them where they are.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { MiddlewareHandler } from 'hono';
import type { RepoRow } from './db.ts';
import { REFS, type Service } from './service.ts';

/** A path under a repository's git URL; anything else under /git/ is a page of a GitHub owner called "git". */
const GIT_PATH = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export function gitHttp(s: Service): MiddlewareHandler {
  let hooks: string | null = null;
  /** The pre-receive hook runs receive-hook.ts with this server's node, written once each time the server starts, so it is the running code's. */
  const hooksDir = (): string => {
    if (hooks) return hooks;
    const dir = join(s.dataDir!, 'hooks');
    const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pre-receive'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dirname, 'receive-hook.ts'))}\n`);
    chmodSync(join(dir, 'pre-receive'), 0o755);
    return (hooks = dir);
  };

  return async (c, next) => {
    const m = c.req.path.match(GIT_PATH);
    if (!m) return next();
    const [, owner, name, rest = ''] = m;
    const url = new URL(c.req.url);
    // Only git's smart protocol: refs for a fetch or a push, then the fetch or the push.
    const service = rest === '/info/refs' ? url.searchParams.get('service') : rest.slice(1);
    const smart = c.req.method === (rest === '/info/refs' ? 'GET' : 'POST') && (service === 'git-upload-pack' || service === 'git-receive-pack');
    const repo = smart ? (s.db.get<RepoRow>('SELECT * FROM repos WHERE owner = ? AND name = ?', owner, name) ?? s.movedRepo(owner, name)) : undefined;
    if (!repo || !s.isClone(repo)) return c.text('Not Found', 404);

    const root = join(s.dataDir!, 'repos');
    const config: [string, string][] = [
      ['core.hooksPath', hooksDir()],
      // For the lease (receive-hook.ts).
      ['receive.advertisePushOptions', 'true'],
      // galley's pins and signed copies stay out of what pushes and fetches are told of.
      ['receive.hideRefs', REFS],
      ['uploadpack.hideRefs', REFS],
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      PATH_INFO: `/${relative(root, s.gitDir(repo))}${rest}`,
      GIT_HTTP_EXPORT_ALL: '1',
      // http-backend takes pushes only from a user the web server signed in.
      REMOTE_USER: 'galley',
      REQUEST_METHOD: c.req.method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: c.req.header('content-type') ?? '',
      // Protocol v2 for fetches.
      GIT_PROTOCOL: c.req.header('git-protocol') ?? '',
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(config.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
    };
    // Without a length (a chunked push), http-backend reads to the end. git gzips large requests.
    const length = c.req.header('content-length');
    if (length) env.CONTENT_LENGTH = length;
    const encoding = c.req.header('content-encoding');
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding;

    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const logFailure = (code: number | null) => {
      if (code !== 0) console.error(`git http-backend for ${c.req.method} ${c.req.path} exited with ${code}: ${stderr.trim()}`);
    };
    const body = c.req.raw.body;
    if (body) pipeline(Readable.fromWeb(body as NodeReadableStream), child.stdin).catch(() => child.stdin.destroy());
    else child.stdin.end();
    child.stdin.on('error', () => {});

    let head: { status: number; headers: Headers };
    try {
      head = await cgiHead(child);
    } catch (e) {
      logFailure(await exited);
      return c.text(`galley: ${(e as Error).message}`, 500);
    }
    if (service === 'git-receive-pack' && rest !== '/info/refs') {
      // A push's report is short: it comes once the pull requests are synced, so the CLI's next call sees what it pushed.
      const out: Buffer[] = [];
      for await (const d of child.stdout) out.push(d as Buffer);
      logFailure(await exited);
      await s.received(repo);
      return new Response(new Uint8Array(Buffer.concat(out)), head);
    }
    exited.then(logFailure);
    return new Response(Readable.toWeb(child.stdout) as unknown as ReadableStream, head);
  };
}

/**
 * The CGI header block http-backend prints first, as a status and headers; its stdout is left
 * paused at the body. Rejects when it ends or fails before the block does.
 */
function cgiHead(child: ChildProcessByStdio<Writable, Readable, Readable>): Promise<{ status: number; headers: Headers }> {
  const out = child.stdout;
  return new Promise((resolve, reject) => {
    let read = Buffer.alloc(0);
    const done = () => {
      out.off('data', onData);
      out.off('end', onEnd);
      child.off('error', reject);
    };
    const onData = (d: Buffer) => {
      read = Buffer.concat([read, d]);
      const end = read.indexOf('\r\n\r\n');
      if (end === -1) return;
      done();
      out.pause();
      if (end + 4 < read.length) out.unshift(read.subarray(end + 4));
      let status = 200;
      const headers = new Headers();
      for (const line of read.subarray(0, end).toString('latin1').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = parseInt(value, 10) || 500;
        else headers.append(key, value);
      }
      resolve({ status, headers });
    };
    const onEnd = () => {
      done();
      reject(new Error('git http-backend gave no answer'));
    };
    out.on('data', onData);
    out.on('end', onEnd);
    child.on('error', reject);
  });
}
