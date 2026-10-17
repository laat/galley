import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 7171;

export function serverUrl(): string {
  if (process.env.LAATSUX_URL) return process.env.LAATSUX_URL.replace(/\/$/, '');
  return `http://localhost:${process.env.LAATSUX_PORT ?? DEFAULT_PORT}`;
}

export function dataDir(): string {
  if (process.env.LAATSUX_HOME) return process.env.LAATSUX_HOME;
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'laatsux');
}

/** Where the user's own configuration lives: the custom reviewers' definitions, in reviewers/. */
export function configDir(): string {
  if (process.env.LAATSUX_CONFIG_DIR) return process.env.LAATSUX_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'laatsux');
}

/**
 * Who the CLI acts as. Agents get their own identity so the UI can tell their comments
 * from yours, and so their own comments do not count as feedback in `pr wait`.
 */
export function cliActor(): { login: string; type: 'User' | 'Bot' } | null {
  const env = process.env;
  if (env.LAATSUX_ACTOR) return { login: env.LAATSUX_ACTOR, type: env.LAATSUX_ACTOR_TYPE === 'User' ? 'User' : 'Bot' };
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
