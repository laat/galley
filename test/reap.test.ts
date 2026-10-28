// Killing what a review left running: processes that carry its mark, in the background, in a
// session of their own, whose parent has exited; on macOS also those in the review's directory.
import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marked, newMark, reap, REVIEW_MARK } from '../src/server/reviewers/reap.ts';
import { until } from './helpers/until.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Leaves two `sleep`s running in `cwd` from a shell that exits: one in its background, one in a
 * session of its own (as Claude Code starts each command) from a parent that exits too. Gives
 * their pids.
 */
function leave(env: NodeJS.ProcessEnv, cwd: string): number[] {
  const script = "const c = require('child_process').spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);";
  const r = spawnSync('sh', ['-c', `sleep 300 >/dev/null 2>&1 & echo $!; ${JSON.stringify(process.execPath)} -e "$0"`, script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pids = r.stdout.trim().split('\n').map(Number);
  assert.equal(pids.length, 2, r.stdout);
  return pids;
}

test('kills what carries the mark, wherever it went, and nothing else', { skip: !['linux', 'darwin'].includes(process.platform) && 'no way to read the environment of a process here' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-review-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'galley-review-'));
  const mark = newMark();
  // `sleep` is one of Apple's programs on macOS, whose environment ps does not show: there it is
  // found by its working directory.
  const left = leave({ [REVIEW_MARK]: mark }, dir);
  // One whose arguments are longer than what `ps e` prints of a process on Linux (128 KiB) with its environment.
  const long = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300_000)', 'x'.repeat(100_000), 'x'.repeat(100_000)], { detached: true, stdio: 'ignore', env: { ...process.env, [REVIEW_MARK]: mark } });
  long.unref();
  left.push(long.pid!);
  // One in the review's directory without the mark: only macOS looks for it there.
  const stray = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' });
  if (process.platform === 'darwin') left.push(stray.pid!);
  const other = newMark();
  const unrelated = leave({ [REVIEW_MARK]: other }, otherDir);
  const unmarked = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  try {
    for (const pid of left) assert.ok(alive(pid), `${pid} runs`);
    assert.deepEqual((await marked(mark, [dir])).sort(), [...left].sort());

    assert.deepEqual((await reap(mark, [dir])).sort(), [...left].sort());
    await until(() => left.every((pid) => !alive(pid)), 'what the review left is gone');
    assert.deepEqual(await marked(mark, [dir]), []);
    for (const pid of [...unrelated, unmarked.pid!]) assert.ok(alive(pid), `${pid} still runs`);
    if (process.platform !== 'darwin') assert.ok(alive(stray.pid!), 'what has no mark still runs');
    assert.deepEqual(await reap(mark, [dir]), []);
  } finally {
    await reap(other, [otherDir]);
    unmarked.kill('SIGKILL');
    stray.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});
