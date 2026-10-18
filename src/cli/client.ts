import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import http from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliActor, dataDir, DEFAULT_PORT, fromEnv, githubSlug, serverUrl } from '../config.ts';

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

/** The repository checked out where the CLI runs, as registered with galley (Client.repoFor). */
export interface Checkout extends RepoRef {
  /** Its top directory, or its git directory when it has no working tree. */
  top: string;
  /**
   * galley's git URL for its clone of the repository, at the URL the CLI reaches galley at; unset
   * for one registered by path before galley kept clones, which galley could not move into one.
   */
  gitUrl?: string;
  /** The remote that names the GitHub repository. */
  remote?: string;
}

/**
 * Send the CLI's requests through the proxy that HTTP_PROXY or HTTPS_PROXY name, as curl and git
 * do; fetch ignores them on its own. A sandbox such as Claude Code's lets the CLI out to a galley
 * on another machine only through its proxy. A URL on this machine goes direct, as before, unless
 * NO_PROXY says otherwise.
 */
export function proxyFromEnv(env = process.env): void {
  if (!env.HTTP_PROXY && !env.HTTPS_PROXY && !env.http_proxy && !env.https_proxy) return;
  const noProxy = noProxyFromEnv(env);
  // Node 24.14 and later: a named import would keep the CLI from loading on an earlier one.
  http.setGlobalProxyFromEnv?.({ ...env, NO_PROXY: noProxy, no_proxy: noProxy });
}

/** The hosts the CLI reaches directly when a proxy is set (proxyFromEnv): NO_PROXY, or this machine's. */
export const noProxyFromEnv = (env = process.env) => env.NO_PROXY ?? env.no_proxy ?? 'localhost,127.0.0.1,[::1]';

/**
 * Why a sandbox keeps galley out of reach, when the CLI can tell, so that the agent tells the user
 * rather than work around it; empty otherwise.
 */
export function sandboxed(): string {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    return ' Codex runs this command in its sandbox without network access (CODEX_SANDBOX_NETWORK_DISABLED), which keeps galley out of reach: tell the user, rather than work around it.';
  }
  return '';
}

const unreachable = (e: unknown) => {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  // Refused, or reset, here; on the way to another machine, also a name that does not resolve
  // (off the tailnet, or no DNS in a sandbox) or a host that does not answer.
  return ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code!);
};

/** Whether `base` is on this machine, where the CLI may start a server. */
export const isLocal = (base: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);

/**
 * Whether a galley server has run on this machine: it leaves its database in the data directory.
 * Only then does the CLI start one. On another machine GALLEY_URL was likely forgotten, and a
 * galley of its own there would hold pull requests the user never sees.
 */
export const ranHere = () => existsSync(join(dataDir(), 'galley.db'));

/** Why nothing answers at `base`, after the CLI started no server there or one that did not answer. */
function away(base: string): string {
  if (!isLocal(base)) return `galley does not answer at ${base}. Is the server running there, and can this machine reach it (is it on the tailnet)?${sandboxed()}`;
  if (!fromEnv('NO_AUTOSTART') && !ranHere()) {
    return `the galley server is not running at ${base}, and none was started: no galley server has run on this machine with its data in ${dataDir()}. Set GALLEY_URL to your galley server's URL, or run \`galley serve\` to start one here.${sandboxed()}`;
  }
  return `the galley server is not running at ${base}, and it could not be started. Run \`galley serve\` to see why.${sandboxed()}`;
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
async function probe(base: string, ms: number): Promise<{ found: 'galley' | 'starting' | 'other' | 'silent' | 'none'; meta?: { url?: string; desktop_app?: { open_links?: boolean } } }> {
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
  /** Whether the desktop app on this computer follows the server and opens galley links, as it said when it answered. */
  private appOpensLinks = false;
  /** The checkouts registered (repoFor, checkoutOf), by directory: each once per command. */
  private checkouts = new Map<string, Promise<Checkout>>();
  /** Where the CLI runs, for X-Galley-Client: this machine and the checkout's git directory, once it registered one. */
  private client: string | null = null;
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
      this.appOpensLinks = !!meta?.desktop_app?.open_links;
      return found;
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code === 'UND_ERR_SOCKET') throw e;
      // Not allowed to connect: a sandbox's doing, likely.
      const hint = code === 'EPERM' || code === 'EACCES' ? ' Connecting to it is not allowed here, as from a sandbox that keeps it out: tell the user, rather than work around it.' : sandboxed();
      throw new CliError(`could not reach galley at ${this.base}: ${reason(e)}${hint ? `.${hint}` : ''}`);
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

  /** Whether the desktop app on this computer follows the server and opens galley links (src/cli/open.ts). */
  async desktopAppOpensLinks(): Promise<boolean> {
    await this.ready();
    return this.appOpensLinks;
  }

  async raw(method: string, path: string, opts: { body?: unknown; rawBody?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    await this.ready();
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    const actor = cliActor();
    if (actor) {
      headers['x-galley-actor'] = actor.login;
      headers['x-galley-actor-type'] = actor.type;
    }
    if (this.client) headers['x-galley-client'] = this.client;
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

  /** Register the repository at `cwd` with the server (checkout) and return its owner/name; with `override` (--repo), that one's. */
  async repoFor(cwd: string, override?: string): Promise<RepoRef> {
    if (override) {
      const parts = override.replace(/^https?:\/\/[^/]+\//, '').split('/');
      const [owner, name] = parts.length >= 3 ? parts.slice(-2) : parts;
      if (!owner || !name) throw new CliError(`expected the "[HOST/]OWNER/REPO" format, got "${override}"`);
      await this.checkoutOf(cwd, { owner, name });
      return { owner, name };
    }
    let checkout = this.checkouts.get(cwd);
    if (!checkout) {
      checkout = this.register(cwd);
      this.checkouts.set(cwd, checkout);
      checkout.catch(() => this.checkouts.delete(cwd));
    }
    return checkout;
  }

  /**
   * Register the checkout at `cwd` when its remote names `repo`, for a command that names the
   * repository (--repo) or the pull request by its URL: its branch is sent from there all the same
   * (send.ts). Outside a checkout, or in one of another repository, nothing.
   */
  async checkoutOf(cwd: string, repo: RepoRef): Promise<void> {
    if (remoteOf(cwd).github?.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) return;
    await this.repoFor(cwd);
  }

  /** The checkout at `cwd`, when this command registered it (repoFor, checkoutOf); null otherwise. */
  async registered(cwd: string): Promise<Checkout | null> {
    return (await this.checkouts.get(cwd)?.catch(() => null)) ?? null;
  }

  /**
   * Register the repository at `cwd` by the GitHub repository its remote names (origin, else its
   * first): galley answers with its clone's git URL, which the CLI sends branches to (send.ts).
   * galley stages pull requests of GitHub repositories only.
   */
  private async register(cwd: string): Promise<Checkout> {
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
    const { remote, github } = remoteOf(cwd);
    if (!github) {
      throw new CliError(`galley stages pull requests of GitHub repositories only, and ${remote ? `the remote ${remote} of this checkout is not on github.com: ${tryGit(cwd, ['remote', 'get-url', remote])}` : 'this checkout has no remote'}`);
    }
    // One per checkout: worktrees of one repository share its branches, and so its id. A header
    // takes ASCII only.
    const gitDir = tryGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (gitDir) this.client = `${hostname()}:${gitDir}`.replace(/[^\x20-\x7e]/gu, encodeURIComponent);
    // The path, for a server older than the CLI, which registers repositories by path; this one goes by the name.
    const repo = await this.json<{ owner: { login: string }; name: string; git_url?: string }>('POST', '/api/repos', { github, path: top });
    // At the URL the CLI reaches galley at, which its public URL may not be from here (on the server's machine, or from a sandbox).
    const gitUrl = repo.git_url ? this.base + new URL(repo.git_url).pathname : undefined;
    return { owner: repo.owner.login, name: repo.name, top, gitUrl, remote };
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** git's output, or empty when it failed. */
function tryGit(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch {
    return '';
  }
}

/**
 * The remote of the checkout at `cwd` that names its GitHub repository, origin or else its first
 * that is not galley's (the CLI keeps one: send.ts), and that repository's owner/name (githubSlug).
 */
function remoteOf(cwd: string): { remote: string | undefined; github: string | null } {
  const remotes = tryGit(cwd, ['remote']).split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes.find((r) => !isGalleyGitUrl(tryGit(cwd, ['remote', 'get-url', r])));
  return { remote, github: remote ? githubSlug(tryGit(cwd, ['remote', 'get-url', remote])) : null };
}

/** Whether `url` is one of galley's git URLs, /git/<owner>/<name>.git on any server, at any address. */
export function isGalleyGitUrl(url: string): boolean {
  try {
    const { protocol, pathname } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && /\/git\/[^/]+\/[^/]+\.git\/?$/.test(pathname);
  } catch {
    return false;
  }
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
