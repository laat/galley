import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.0';
/** Unassigned with IANA, below the ports macOS and Linux hand out for outgoing connections, and no dev server's default (#41). */
export const DEFAULT_PORT = 24823;
/**
 * What GET /api/meta answers (an extension), so the CLI knows galley from another program on its
 * port. `features` names what this server can do that an older one could not, so a newer CLI can
 * ask the user to update the server instead of failing on it; none yet.
 */
export const META = { name: 'galley', version: VERSION, features: [] as string[] };

/** A setting from the environment: GALLEY_<name>, unset when empty. */
export function fromEnv(name: string): string | undefined {
  return process.env[`GALLEY_${name}`] || undefined;
}

export function serverUrl(): string {
  const url = fromEnv('URL');
  if (url) return url.replace(/\/$/, '');
  return `http://localhost:${fromEnv('PORT') ?? DEFAULT_PORT}`;
}

/** Where a server listening on `host` (galley serve --host) answers on this machine. */
export function localUrl(host: string, port: number): string {
  if (['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(host)) return `http://localhost:${port}`;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function dataDir(): string {
  return fromEnv('HOME') || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'galley');
}

/**
 * owner/name from a GitHub remote URL, or null when the remote is not on github.com: the GitHub
 * repository the CLI registers a checkout by, which galley keeps a clone of.
 */
export function githubSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where the user's own configuration lives: the custom reviewers' definitions, in reviewers/. */
export function configDir(): string {
  return fromEnv('CONFIG_DIR') || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'galley');
}

/**
 * Who the CLI acts as. Agents get their own identity so the UI can tell their comments
 * from yours, and so their own comments do not count as feedback in `pr wait`.
 */
export function cliActor(): { login: string; type: 'User' | 'Bot' } | null {
  const login = fromEnv('ACTOR');
  if (login) return { login, type: fromEnv('ACTOR_TYPE') === 'User' ? 'User' : 'Bot' };
  const env = process.env;
  // An agent started from another inherits the other's variables too, so the agents that run
  // inside Claude Code are checked before it.
  // Codex sets CODEX_THREAD_ID for every command it runs, CODEX_SANDBOX only with its own sandbox on.
  // Not "codex": that is how `--reviewer codex` asks for the Codex reviewer, and was its name.
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM) return { login: 'codex-agent', type: 'Bot' };
  if (env.OPENCODE) return { login: 'opencode', type: 'Bot' };
  if (env.CLAUDECODE) return { login: 'claude', type: 'Bot' };
  if (env.AI_AGENT) return { login: env.AI_AGENT.split('_')[0].replace(/-code$/, ''), type: 'Bot' };
  // A person at a terminal acts as the reviewer; anything else driving the CLI is an agent.
  return process.stdin.isTTY ? null : { login: 'agent', type: 'Bot' };
}
