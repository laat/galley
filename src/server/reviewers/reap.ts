// What a reviewer agent leaves running when its review is over: a server its tests started, a
// command it sent to the background. On Linux both tools run their commands in bubblewrap, in a
// PID namespace that dies with them, as galley's install sandbox does; on macOS Seatbelt has no
// such namespace, and what they start outlives them. Killing the tool's process group does not
// reach it either: Claude Code starts each command in a session of its own, and a command may do
// the same (setsid, a daemon). So a review's processes carry a variable of their own, which what
// they start inherits, and once the review is over galley kills every process that still has it.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
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
 * On macOS, `ps -E` prints it after the command, separated by spaces as the arguments are.
 */
export async function marked(mark: string, platform = process.platform): Promise<number[]> {
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
  } else return [];
  return pids.filter((pid) => pid !== process.pid);
}

/**
 * Kill what a review left running, until nothing with its mark is left, since a process may
 * start another while the others are killed. Gives the processes it killed.
 */
export async function reap(mark: string, platform = process.platform): Promise<number[]> {
  const killed = new Set<number>();
  for (let round = 0; round < 10; round++) {
    const pids = (await marked(mark, platform)).filter((pid) => {
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
