// The galley server the app is a window onto: the one the CLI uses, at the URL galley's config
// gives (src/config.ts). The app attaches to it, or starts it the way the CLI does
// (src/cli/client.ts), and never stops it: agents use it.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { identify } from '../src/cli/client.ts';
import { dataDir, DEFAULT_PORT, fromEnv } from '../src/config.ts';

/** What answers at the server's URL (identify). */
export type Found = Awaited<ReturnType<typeof identify>>;

/** Why no server may be started at `base`, as the CLI starts none (client.ts autostart): null when one may. */
export function noAutostart(base: string): string | null {
  if (fromEnv('NO_AUTOSTART')) return 'GALLEY_NO_AUTOSTART is set';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) return `${base} is not on this computer`;
  return null;
}

/** The user's Node, which runs the server: the first `node` on `path` that is version 24 or newer, as galley needs. */
export function findNode(path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const node = join(dir, 'node');
    try {
      const version = execFileSync(node, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (Number(version.match(/^v(\d+)\./)?.[1]) >= 24) return node;
    } catch {}
  }
  return null;
}

/**
 * Start `galley serve` for `base` with `node`, in the background, logging where the CLI's
 * servers log. It is detached, so it outlives the app. Gives the log's path.
 */
export function startServer(o: { base: string; node: string; root: string; env?: NodeJS.ProcessEnv }): string {
  const log = join(dataDir(), 'server.log');
  let out: 'ignore' | number = 'ignore';
  try {
    mkdirSync(dataDir(), { recursive: true });
    out = openSync(log, 'a');
  } catch {}
  const port = new URL(o.base).port || String(DEFAULT_PORT);
  // In the home directory, not the app's: opened from the Finder, that is /.
  spawn(o.node, [join(o.root, 'bin', 'galley.ts'), 'serve', '--port', port], { cwd: homedir(), env: o.env ?? process.env, detached: true, stdio: ['ignore', out, out] }).unref();
  if (out !== 'ignore') closeSync(out);
  return log;
}

/**
 * Attach to the galley server at `base`, as the CLI does before its first request (Client.check):
 * wait for one that is starting, or, when nothing answers, call `start`, which starts one or says
 * why it cannot, and wait for that. Gives what answers in the end, and why nothing was started.
 */
export async function attach(
  base: string,
  o: { start: () => string | null; identify?: (base: string) => Promise<Found>; everyMs?: number; tries?: number },
): Promise<{ found: Found; why?: string }> {
  const probe = (url: string) => (o.identify ?? identify)(url).catch((): Found => 'none');
  let found = await probe(base);
  let started = false;
  if (found === 'none') {
    const why = o.start();
    if (why) return { found, why };
    started = true;
  }
  // A server starting from scratch opens its database and reads its repositories first.
  for (let i = 0; (found === 'starting' || (found === 'none' && started)) && i < (o.tries ?? 150); i++) {
    await sleep(o.everyMs ?? 200);
    found = await probe(base);
  }
  return { found };
}

const MARK = '__galley_env__';

/**
 * The environment a terminal gets: what the user's shell startup files set, such as PATH (for
 * Node, git, gh and the agents) and the GALLEY_ variables. An app opened from the Finder, the
 * Dock or at login gets launchd's, without them. Null when the shell does not say.
 */
export async function loginShellEnv(shell = process.env.SHELL || '/bin/zsh'): Promise<Record<string, string> | null> {
  try {
    // Interactive too: many set PATH in .zshrc. Oh My Zsh asks nothing about updates with DISABLE_AUTO_UPDATE.
    const { stdout } = await promisify(execFile)(shell, ['-ilc', `printf ${MARK}; command env; printf ${MARK}`], {
      timeout: 10_000,
      maxBuffer: 16 << 20,
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
    });
    const inner = stdout.split(MARK)[1];
    return inner === undefined ? null : parseEnv(inner);
  } catch {
    return null;
  }
}

/** `env`'s output as variables; a line that does not start a variable continues the value before it. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  let last: string | null = null;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[(last = m[1])] = m[2];
    else if (last !== null) env[last] += '\n' + line;
  }
  return env;
}
