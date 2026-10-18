import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import http from 'node:http';
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

/**
 * Send the CLI's requests through the proxy that HTTP_PROXY or HTTPS_PROXY name, as curl and git
 * do; fetch ignores them on its own. A sandbox such as Claude Code's lets the CLI out to a galley
 * on another machine only through its proxy. A URL on this machine goes direct, as before, unless
 * NO_PROXY says otherwise.
 */
export function proxyFromEnv(env = process.env): void {
  if (!env.HTTP_PROXY && !env.HTTPS_PROXY && !env.http_proxy && !env.https_proxy) return;
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? 'localhost,127.0.0.1,[::1]';
  // Node 24.14 and later: a named import would keep the CLI from loading on an earlier one.
  http.setGlobalProxyFromEnv?.({ ...env, NO_PROXY: noProxy, no_proxy: noProxy });
}

const unreachable = (e: unknown) => {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  // Refused, or reset, here; on the way to another machine, also a name that does not resolve
  // (off the tailnet, or no DNS in a sandbox) or a host that does not answer.
  return ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code!);
};

/** Whether `base` is on this machine, where the CLI may start a server. */
const isLocal = (base: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);

/**
 * Whether a galley server has run on this machine: it leaves its database in the data directory.
 * Only then does the CLI start one. On another machine GALLEY_URL was likely forgotten, and a
 * galley of its own there would hold pull requests the user never sees.
 */
const ranHere = () => existsSync(join(dataDir(), 'galley.db'));

/** Why nothing answers at `base`, after the CLI started no server there or one that did not answer. */
function away(base: string): string {
  if (!isLocal(base)) return `galley does not answer at ${base}. Is the server running there, and can this machine reach it (is it on the tailnet)?`;
  if (!fromEnv('NO_AUTOSTART') && !ranHere()) {
    return `the galley server is not running at ${base}, and none was started: no galley server has run on this machine with its data in ${dataDir()}. Set GALLEY_URL to your galley server's URL, or run \`galley serve\` to start one here.`;
  }
  return `the galley server is not running at ${base}, and it could not be started. Run \`galley serve\` to see why.`;
}
const silent = (base: string, ms: number) =>
  `nothing answered at ${base} within ${ms / 1000} seconds: galley may be stuck there, or another program holds the port.` +
  (isLocal(base) ? ' If it is another program, run galley on another port with GALLEY_PORT=<port>, and set GALLEY_PORT for your agents too.' : '');
const other = (base: string) =>
  isLocal(base)
    ? `something other than galley answers at ${base}. Stop it, or run galley on another port with GALLEY_PORT=<port>, and set GALLEY_PORT for your agents too.`
    : `something other than galley answers at ${base}. Is GALLEY_URL right?`;

/** What made a request fail, from the innermost cause: a proxy's refusal, say. */
function reason(e: unknown): string {
  let at = e as { message?: string; cause?: unknown };
  while (at.cause && typeof at.cause === 'object') at = at.cause as typeof at;
  return at.message ?? String(e);
}

/** What a proxy answers for a server behind it that is down or restarting: Bad Gateway, Service Unavailable, Gateway Timeout. */
export const GATEWAY_DOWN = [502, 503, 504];

/** How long whatever answers at the server's URL has to say what it is (identify). */
const PROBE_MS = 5000;

/**
 * What answers at `base`: galley, galley still starting, another program, one that takes the
 * connection but does not answer within `ms`, or nothing. On another machine, a proxy in front of
 * galley (`tailscale serve`) that answers 502, 503 or 504 for it counts as nothing: galley is down
 * behind it.
 */
export async function identify(base: string, ms = PROBE_MS): Promise<'galley' | 'starting' | 'other' | 'silent' | 'none'> {
  return (await probe(base, ms)).found;
}

/** What answers at `base` (identify), and what galley says of itself there: GET /api/meta. */
async function probe(base: string, ms: number): Promise<{ found: 'galley' | 'starting' | 'other' | 'silent' | 'none'; meta?: { url?: string } }> {
  const signal = AbortSignal.timeout(ms);
  let res: Response;
  try {
    res = await fetch(`${base}/api/meta`, { signal });
  } catch (e) {
    if (unreachable(e)) return { found: 'none' };
    if (signal.aborted) return { found: 'silent' };
    throw e;
  }
  const meta = await res.json().catch(() => null);
  if (meta?.name !== 'galley') return { found: !isLocal(base) && GATEWAY_DOWN.includes(res.status) ? 'none' : 'other' };
  return { found: res.ok ? 'galley' : 'starting', meta };
}

/**
 * Start `galley serve` in the background for a local server URL that nothing answers on, on a
 * machine that has run one before. The server is detached, so it outlives this command and the
 * agent that ran it.
 */
async function autostart(base: string): Promise<boolean> {
  if (fromEnv('NO_AUTOSTART')) return false;
  if (!isLocal(base)) return false;
  if (!ranHere()) return false;
  const url = new URL(base);
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
  /** How long it has to say that it is galley (identify; tests shorten it). */
  private probeMs: number;
  /** Where the server's links point, as it says (its public URL), once it answered. */
  private linksBase: string | null = null;
  constructor(base = serverUrl(), { probeMs = PROBE_MS } = {}) {
    this.base = base;
    this.probeMs = probeMs;
  }

  /**
   * Make sure galley answers at `base`, so that no request goes to another program on its port.
   * When nothing answers there, one is started.
   */
  private async check(): Promise<void> {
    let found = await this.identify();
    if (found === 'none') {
      // Once per command: a wait that asks again while the server is away starts no more.
      if (!this.triedAutostart) {
        this.triedAutostart = true;
        if (await autostart(this.base)) {
          // Asked again, for where its links point.
          await this.identify();
          return;
        }
      }
      throw new CliError(away(this.base));
    }
    for (let i = 0; found === 'starting' && i < 150; i++) {
      await new Promise((r) => setTimeout(r, 200));
      found = await this.identify();
    }
    if (found === 'none') throw new CliError(away(this.base));
    if (found === 'silent') throw new CliError(silent(this.base, this.probeMs));
    if (found === 'other') throw new CliError(other(this.base));
  }

  /**
   * What answers at `base` (identify), with a request that fails otherwise, such as one a proxy
   * refuses, as an error that says why. A connection dropped on the way (galley restarting) stays
   * fetch's error, which `pr wait` waits through.
   */
  private async identify() {
    try {
      const { found, meta } = await probe(this.base, this.probeMs);
      if (meta?.url) this.linksBase = meta.url;
      return found;
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === 'UND_ERR_SOCKET') throw e;
      throw new CliError(`could not reach galley at ${this.base}: ${reason(e)}`);
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

  /**
   * A link to `path` in the web UI, on the server that answers (check), as some commands make no
   * request first. It starts with the server's public URL, as the links the server gives do.
   */
  async url(path = ''): Promise<string> {
    await this.ready();
    return (this.linksBase ?? this.base) + path;
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
      throw new CliError(away(this.base));
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
