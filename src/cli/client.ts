import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliActor, dataDir, DEFAULT_PORT, fromEnv, serverUrl } from '../config.ts';

export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** `--help` on a command: its usage, which `main` prints instead of running the command. */
export class Help extends Error {}

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

const notRunning = (base: string) => `the galley server is not running at ${base}, and it could not be started. Run \`galley serve\` to see why.`;
const silent = (base: string) =>
  `nothing answered at ${base} within 5 seconds: galley may be stuck there, or another program holds the port. If it is another program, run galley on another port with GALLEY_PORT=<port>, and set GALLEY_PORT for your agents too.`;

/**
 * What answers at `base`: galley, galley still starting, another program, one that takes the
 * connection but does not answer in time, or nothing.
 */
export async function identify(base: string): Promise<'galley' | 'starting' | 'other' | 'silent' | 'none'> {
  const signal = AbortSignal.timeout(5000);
  let res: Response;
  try {
    res = await fetch(`${base}/api/meta`, { signal });
  } catch (e) {
    if (unreachable(e)) return 'none';
    if (signal.aborted) return 'silent';
    throw e;
  }
  const meta = await res.json().catch(() => null);
  if (meta?.name !== 'galley') return 'other';
  return res.ok ? 'galley' : 'starting';
}

/**
 * Start `galley serve` in the background for a local server URL that nothing answers on.
 * The server is detached, so it outlives this command and the agent that ran it.
 */
async function autostart(base: string): Promise<boolean> {
  if (fromEnv('NO_AUTOSTART')) return false;
  const url = new URL(base);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  const bin = fileURLToPath(new URL('../../bin/galley.ts', import.meta.url));
  let out: 'ignore' | number = 'ignore';
  const logFile = join(dataDir(), 'server.log');
  try {
    mkdirSync(dataDir(), { recursive: true });
    out = openSync(logFile, 'a');
  } catch {}
  spawn(process.execPath, [bin, 'serve', '--port', url.port || String(DEFAULT_PORT)], { detached: true, stdio: ['ignore', out, out] }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if ((await identify(base).catch(() => 'none')) === 'galley') {
      process.stderr.write(`Started the galley server at ${base} (log: ${logFile})\n`);
      return true;
    }
  }
  return false;
}

export class Client {
  base: string;
  private triedAutostart = false;
  /** Making sure that galley answers at `base`, before the first request (check). */
  private checking: Promise<void> | null = null;
  constructor(base = serverUrl()) {
    this.base = base;
  }

  /**
   * Make sure galley answers at `base`, so that no request goes to another program on its port.
   * When nothing answers there, one is started.
   */
  private async check(): Promise<void> {
    let found = await identify(this.base);
    if (found === 'none') {
      // Once per command: a wait that asks again while the server is away starts no more.
      if (!this.triedAutostart) {
        this.triedAutostart = true;
        if (await autostart(this.base)) return;
      }
      throw new CliError(notRunning(this.base));
    }
    for (let i = 0; found === 'starting' && i < 150; i++) {
      await new Promise((r) => setTimeout(r, 200));
      found = await identify(this.base);
    }
    if (found === 'none') throw new CliError(notRunning(this.base));
    if (found === 'silent') throw new CliError(silent(this.base));
    if (found === 'other') {
      throw new CliError(`something other than galley answers at ${this.base}. Stop it, or run galley on another port with GALLEY_PORT=<port>, and set GALLEY_PORT for your agents too.`);
    }
  }

  /** Once galley answers (check): where it is. */
  private ready(): Promise<void> {
    this.checking ??= this.check().catch((e) => {
      this.checking = null;
      throw e;
    });
    return this.checking;
  }

  /** A link to `path` in the web UI, on the server that answers (check), as some commands make no request first. */
  async url(path = ''): Promise<string> {
    await this.ready();
    return this.base + path;
  }

  async raw(method: string, path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    await this.ready();
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    const actor = cliActor();
    if (actor) {
      headers['x-galley-actor'] = actor.login;
      headers['x-galley-actor-type'] = actor.type;
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
      throw new CliError(notRunning(this.base));
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
