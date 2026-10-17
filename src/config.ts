import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 7171;

/** A setting from the environment: GALLEY_<name>, or LAATSUX_<name> as it was called before the rename (#9). */
export function fromEnv(name: string): string | undefined {
  return process.env[`GALLEY_${name}`] || process.env[`LAATSUX_${name}`];
}

export function serverUrl(): string {
  const url = fromEnv('URL');
  if (url) return url.replace(/\/$/, '');
  return `http://localhost:${fromEnv('PORT') ?? DEFAULT_PORT}`;
}

export function dataDir(): string {
  const home = fromEnv('HOME');
  if (home) return home;
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'laatsux');
}

/** Where the user's own configuration lives: the custom reviewers' definitions, in reviewers/. */
export function configDir(): string {
  const dir = fromEnv('CONFIG_DIR');
  if (dir) return dir;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'laatsux');
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

export function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'you';
  }
}
