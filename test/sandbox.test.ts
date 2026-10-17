// The sandbox laatsux installs dependencies in for the Claude reviewer: macOS's sandbox-exec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxed } from '../src/server/reviewers/sandbox.ts';

/**
 * Why sandbox-exec can not run here, if it can not: outside macOS, and inside another sandbox
 * (a reviewer agent's), which macOS refuses to nest.
 */
function noSandboxExec(): string | false {
  if (process.platform !== 'darwin') return 'macOS only';
  const s = sandboxed(['/usr/bin/true'], { writable: [], readOnly: [] })!;
  const r = spawnSync(s.bin, s.args, { encoding: 'utf8' });
  return /sandbox_apply: Operation not permitted/.test(r.stderr) && 'already in a sandbox, and macOS does not nest them';
}
const skip = noSandboxExec();

test('there is none to install in outside macOS, unless one stands in', () => {
  const none = sandboxed(['true'], { writable: [], readOnly: [] });
  assert.equal(none === null, process.platform !== 'darwin');
  assert.equal(sandboxed(['true'], { writable: [], readOnly: [] }, '/bin/echo')?.bin, '/bin/echo');
});

test('it writes only to the checkout and its TMPDIR, and never to the checkout\'s .git', { skip }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laatsux-sandbox-')));
  try {
    const checkout = join(dir, 'checkout');
    const tmp = join(dir, 'tmp');
    mkdirSync(checkout);
    mkdirSync(tmp);
    writeFileSync(join(checkout, '.git'), 'gitdir: elsewhere\n');
    const script = [
      'touch node_modules-ok',
      `touch ${tmp}/cache-ok`,
      'echo changed >> .git || echo git-refused',
      `touch ${dir}/beside || echo beside-refused`,
    ].join('; ');
    const s = sandboxed(['/bin/sh', '-c', script], { writable: [checkout, tmp], readOnly: [join(checkout, '.git')] })!;
    const r = spawnSync(s.bin, s.args, { cwd: checkout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /git-refused\nbeside-refused/);
    assert.equal(readFileSync(join(checkout, '.git'), 'utf8'), 'gitdir: elsewhere\n');
    assert.equal(readFileSync(join(checkout, 'node_modules-ok'), 'utf8'), '');
    assert.equal(readFileSync(join(tmp, 'cache-ok'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inside another sandbox, as a reviewer agent runs the tests, it skips what needs sandbox-exec and says why', { skip }, () => {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath, '--test-reporter=tap', import.meta.filename], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok \d+ - it writes only to the checkout .* # SKIP already in a sandbox, and macOS does not nest them$/m);
});
