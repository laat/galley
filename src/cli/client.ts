import { execFileSync } from 'node:child_process';
import { cliActor, serverUrl } from '../config.ts';

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

export class Client {
  base: string;
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
    try {
      return await fetch(this.base + path, { method, headers, body, signal: opts.signal });
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND' || cause?.code === 'ECONNRESET') {
        throw new CliError(
          `the laatsux server is not running at ${this.base}.\n` +
            'Ask the user to start it with `laatsux serve` (it has to run outside any agent sandbox, since it pushes to GitHub).',
        );
      }
      throw e;
    }
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, { body });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text);
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T = any>(path: string): Promise<T> {
    return this.json<T>('GET', path);
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
