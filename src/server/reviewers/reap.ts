// What a reviewer agent leaves running when its review is over: a server its tests started, a
// command it sent to the background. On Linux both tools run their commands in bubblewrap, in a
// PID namespace that dies with them, as galley's install sandbox does; on macOS Seatbelt has no
// such namespace, and what they start outlives them. Killing the tool's process group does not
// reach it either: Claude Code starts each command in a session of its own, and a command may do
// the same (setsid, a daemon). So a review's processes carry a variable of their own, which what
// they start inherits, and once the review is over galley kills every process that still has it.
// macOS shows no one the environment of its own programs (/bin/sleep, sh, zsh), so there galley
// also kills the processes whose working directory is in the review's directories.
import { randomUUID } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from '../git.ts';

/** The variable in the environment of a review's processes; its value is the review's mark. */
export const REVIEW_MARK = 'GALLEY_REVIEW_MARK';

/** A new review's mark. */
export function newMark(): string {
  return randomUUID();
}

/**
 * The processes started with `REVIEW_MARK=mark` in their environment, other than galley's own;
 * not other users', whose environment neither way below reads. On Linux, grep reads it whole
 * from /proc (`ps e` cuts a process's arguments and environment off at 128 KiB). A process stuck
 * in the kernel can hold that read up, so it runs in a command with a timeout, not in the server.
 * On macOS, `ps -E` prints it after the command, separated by spaces as the arguments are, but
 * not for Apple's own programs, whose environment it leaves out: there the processes whose
 * working directory is in `dirs` count too (inDirs).
 */
export async function marked(mark: string, dirs: string[] = [], platform = process.platform): Promise<number[]> {
  const entry = `${REVIEW_MARK}=${mark}`;
  let pids: number[];
  if (platform === 'linux') {
    const files = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((pid) => `/proc/${pid}/environ`);
    // Each variable whole (-x) between NULs (-z); no messages for processes that are gone or another user's (-s).
    // The paths go through xargs: as arguments, tens of thousands of them pass ARG_MAX.
    const r = await run('xargs', ['-0', 'grep', '-lsxzF', '-e', entry, '--'], { input: files.join('\0'), allowFail: true, timeoutMs: 30_000 });
    if (r.timedOut) throw new Error('grep timed out reading /proc');
    pids = r.stdout.split('\n').filter(Boolean).map((file) => Number(file.split('/')[2]));
  } else if (platform === 'darwin') {
    const r = await run('ps', ['-A', '-ww', '-E', '-o', 'pid=,command='], { allowFail: true, timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`ps ${r.timedOut ? 'timed out' : `exited with ${r.code}`}: ${r.stderr.trim()}`);
    pids = r.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter(([, ...words]) => words.includes(entry))
      .map(([pid]) => Number(pid));
    pids = [...new Set([...pids, ...(await inDirs(dirs))])];
  } else return [];
  return pids.filter((pid) => pid !== process.pid);
}

/**
 * The user's processes whose working directory is in one of `dirs`, as lsof reads it on macOS,
 * also for Apple's programs. lsof prints the real path (/private/var, not /var).
 */
async function inDirs(dirs: string[]): Promise<number[]> {
  const real = dirs.flatMap((dir) => {
    try {
      return [realpathSync(dir)];
    } catch {
      return [];
    }
  });
  if (!real.length) return [];
  // -F: one field a line, `p<pid>` and then `n<path>` for its working directory (-d cwd).
  const r = await run('/usr/sbin/lsof', ['-nPw', '-a', '-u', String(process.getuid!()), '-d', 'cwd', '-Fn'], { allowFail: true, timeoutMs: 30_000 });
  if (r.code !== 0 && !r.stdout) throw new Error(`lsof ${r.timedOut ? 'timed out' : `exited with ${r.code}`}: ${r.stderr.trim()}`);
  const pids: number[] = [];
  let pid = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && real.some((dir) => line.slice(1) === dir || line.slice(1).startsWith(`${dir}/`))) pids.push(pid);
  }
  return pids;
}

/**
 * Kill what a review left running, until nothing with its mark (or, on macOS, in its `dirs`) is
 * left, since a process may start another while the others are killed. Gives the processes it
 * killed.
 */
export async function reap(mark: string, dirs: string[] = [], platform = process.platform): Promise<number[]> {
  const killed = new Set<number>();
  for (let round = 0; round < 10; round++) {
    const pids = (await marked(mark, dirs, platform)).filter((pid) => {
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    });
    if (!pids.length) break;
    for (const pid of pids) killed.add(pid);
    await sleep(50);
  }
  return [...killed];
}
