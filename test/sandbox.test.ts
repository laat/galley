// The sandbox galley installs dependencies in for the Claude reviewer: macOS's sandbox-exec, and
// bubblewrap on Linux.
import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeEngine } from '../src/server/reviewers/claude.ts';
import { noSandbox, sandboxed } from '../src/server/reviewers/sandbox.ts';

/**
 * Why the sandbox can not run here, if it can not: on macOS, inside another sandbox (a reviewer
 * agent's), which macOS refuses to nest; on Linux, without bwrap or unprivileged user namespaces
 * (in a container, in another sandbox, or under Ubuntu's AppArmor); elsewhere, there is none.
 */
async function cannotSandbox(): Promise<string | false> {
  if (process.platform === 'darwin') {
    const s = sandboxed(['/usr/bin/true'], { writable: [], readOnly: [] })!;
    const r = spawnSync(s.bin, s.args, { encoding: 'utf8' });
    return /sandbox_apply: Operation not permitted/.test(r.stderr) && 'already in a sandbox, and macOS does not nest them';
  }
  return (await noSandbox()) ?? false;
}
const skip = await cannotSandbox();
const none = { writable: [], readOnly: [] };

test('there is none to install in where galley has neither sandbox-exec nor bwrap, and a stand-in takes the place of either', async () => {
  assert.equal(sandboxed(['true'], none, undefined, 'darwin')?.bin, '/usr/bin/sandbox-exec');
  assert.equal(sandboxed(['true'], none, undefined, 'linux')?.bin, 'bwrap');
  assert.equal(sandboxed(['true'], none, undefined, 'win32'), null);
  assert.equal(await noSandbox(undefined, 'win32'), 'galley has no sandbox to install in on win32');
  assert.equal(sandboxed(['true'], none, '/bin/echo', 'darwin')?.bin, '/bin/echo');
  assert.equal(sandboxed(['true'], none, '/bin/echo', 'linux')?.bin, '/bin/echo');
  assert.equal(sandboxed(['true'], none, '/bin/echo', 'win32'), null);
});

test('without bwrap, the Claude reviewer installs nothing and says what is missing', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-sandbox-'));
  try {
    const bwrap = join(dir, 'bwrap');
    const install = new ClaudeEngine('claude', bwrap).install(['touch', 'installed'], { checkout: dir, tmp: dir, env: {}, timeoutMs: 10_000, signal: AbortSignal.timeout(10_000) });
    await assert.rejects(install, { message: `${bwrap} not found: install bubblewrap` });
    assert.equal(existsSync(join(dir, 'installed')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it writes only to the checkout and its TMPDIR: not to the checkout\'s .git, the repository, /tmp or $HOME', { skip }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'galley-sandbox-')));
  // Where it must not write, under names of its own, removed in case it did. On Linux, dir is in /tmp too.
  const inTmp = join('/tmp', `${basename(dir)}-beside`);
  const inHome = join(homedir(), basename(dir));
  try {
    const repo = join(dir, 'repo');
    const checkout = join(dir, 'checkout');
    const tmp = join(dir, 'tmp');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    mkdirSync(repo);
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
    git('worktree', 'add', '-q', '--detach', checkout);
    mkdirSync(tmp);
    const dotGit = readFileSync(join(checkout, '.git'), 'utf8');
    const gitDir = git('-C', checkout, 'rev-parse', '--absolute-git-dir');
    const script = [
      'touch node_modules-ok',
      `touch ${tmp}/cache-ok`,
      'git rev-parse -q --verify HEAD >/dev/null && echo git-reads',
      'echo changed >> .git || echo dot-git-refused',
      `touch ${gitDir}/x || echo git-dir-refused`,
      `touch ${repo}/x || echo repo-refused`,
      `touch ${inTmp} || echo tmp-refused`,
      `touch ${inHome} || echo home-refused`,
    ].join('; ');
    const s = sandboxed(['/bin/sh', '-c', script], { writable: [checkout, tmp], readOnly: [join(checkout, '.git')] })!;
    const r = spawnSync(s.bin, s.args, { cwd: checkout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'git-reads\ndot-git-refused\ngit-dir-refused\nrepo-refused\ntmp-refused\nhome-refused\n', r.stderr);
    assert.equal(readFileSync(join(checkout, '.git'), 'utf8'), dotGit);
    assert.equal(readFileSync(join(checkout, 'node_modules-ok'), 'utf8'), '');
    assert.equal(readFileSync(join(tmp, 'cache-ok'), 'utf8'), '');
    for (const p of [join(gitDir, 'x'), join(repo, 'x'), inTmp, inHome]) assert.equal(existsSync(p), false, p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inTmp, { force: true });
    rmSync(inHome, { force: true });
  }
});

test('it can connect to a server on localhost, as it can to a registry', { skip }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'galley-sandbox-')));
  const server = createServer((_, res) => res.end('reached'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const fetch = `fetch('http://127.0.0.1:${port}/').then((r) => r.text()).then(console.log)`;
    const s = sandboxed([process.execPath, '-e', fetch], { writable: [dir], readOnly: [] })!;
    const { stdout } = await promisify(execFile)(s.bin, s.args, { cwd: dir, encoding: 'utf8' });
    assert.equal(stdout, 'reached\n');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inside another sandbox, as a reviewer agent runs the tests, it skips what needs sandbox-exec and says why', { skip: process.platform !== 'darwin' ? 'macOS only' : skip }, () => {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath, '--test-reporter=tap', import.meta.filename], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok \d+ - it writes only to the checkout .* # SKIP already in a sandbox, and macOS does not nest them$/m);
});

test('without user namespaces, as in a container or another sandbox, it skips what needs bwrap and says why', { skip: process.platform !== 'linux' ? 'Linux only' : skip }, () => {
  const r = spawnSync('bwrap', ['--unshare-user', '--disable-userns', '--unshare-pid', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--', process.execPath, '--test-reporter=tap', import.meta.filename], {
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok \d+ - it writes only to the checkout .* # SKIP bwrap could not make a sandbox \(it needs unprivileged user namespaces\): bwrap: \S.*$/m);
});
