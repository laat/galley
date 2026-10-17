import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliActor, dataDir, DEFAULT_PORT, serverUrl } from '../config.ts';

export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export class ApiError extends CliError {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    let message = body;
    try {
      message = JSON.parse(body).message ?? body;
    } catch {}
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface RepoRef {
  owner: string;
  name: string;
}

const unreachable = (e: unknown) => {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET';
};

/**
 * Start `laatsux serve` in the background for a local server URL that nothing answers on.
 * The server is detached, so it outlives this command and the agent that ran it.
 */
async function autostart(base: string): Promise<boolean> {
  if (process.env.LAATSUX_NO_AUTOSTART) return false;
  const url = new URL(base);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  const bin = fileURLToPath(new URL('../../bin/laatsux.ts', import.meta.url));
  let out: 'ignore' | number = 'ignore';
  const logFile = join(dataDir(), 'server.log');
  try {
    mkdirSync(dataDir(), { recursive: true });
    out = openSync(logFile, 'a');
  } catch {}
  spawn(process.execPath, [bin, 'serve', '--port', url.port || String(DEFAULT_PORT)], { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        process.stderr.write(`Started the laatsux server at ${base} (log: ${logFile})\n`);
        return true;
      }
    } catch {}
  }
  return false;
}

export class Client {
  base: string;
  private triedAutostart = false;
  constructor(base = serverUrl()) {
    this.base = base;
  }

  async raw(method: string, path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    const actor = cliActor();
    if (actor) {
      headers['x-laatsux-actor'] = actor.login;
      headers['x-laatsux-actor-type'] = actor.type;
    }
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) body = JSON.stringify(opts.body);
    if (body !== undefined) headers['content-type'] = 'application/json';
    const send = () => fetch(this.base + path, { method, headers, body, signal: opts.signal });
    try {
      return await send();
    } catch (e) {
      if (!unreachable(e)) throw e;
      if (!this.triedAutostart) {
        this.triedAutostart = true;
        if (await autostart(this.base)) return send();
      }
      throw new CliError(`the laatsux server is not running at ${this.base}, and it could not be started. Run \`laatsux serve\` to see why.`);
    }
  }

  async json<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.raw(method, path, { body, signal });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T = any>(path: string, signal?: AbortSignal): Promise<T> {
    return this.json<T>('GET', path, undefined, signal);
  }

  /** Register the repository at `cwd` with the server and return its owner/name. */
  async repoFor(cwd: string, override?: string): Promise<RepoRef> {
    if (override) {
      const parts = override.replace(/^https?:\/\/[^/]+\//, '').split('/');
      const [owner, name] = parts.length >= 3 ? parts.slice(-2) : parts;
      if (!owner || !name) throw new CliError(`expected the "[HOST/]OWNER/REPO" format, got "${override}"`);
      return { owner, name };
    }
    let top: string;
    try {
      top = git(cwd, ['rev-parse', '--show-toplevel']);
    } catch {
      try {
        top = git(cwd, ['rev-parse', '--git-dir']);
      } catch {
        throw new CliError('not a git repository (or any of the parent directories)');
      }
    }
    const repo = await this.json<{ owner: { login: string }; name: string }>('POST', '/api/repos', { path: top });
    return { owner: repo.owner.login, name: repo.name };
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function currentBranch(cwd: string): string | null {
  try {
    const b = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return b || null;
  } catch {
    return null;
  }
}

export function repoPath(r: RepoRef): string {
  return `/api/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
}
