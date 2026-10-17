import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo, run } from '../src/server/git.ts';

test('run survives a command that exits without reading its input', async () => {
  // Writing to a closed pipe raises EPIPE on stdin; it must not escape and crash the server.
  const r = await run('true', [], { input: 'x'.repeat(4 << 20), allowFail: true });
  assert.equal(r.code, 0);
});

test('run kills a command that outlives its timeout', async () => {
  const r = await run('sleep', ['5'], { allowFail: true, timeoutMs: 100 });
  assert.equal(r.code, null);
});

test('a timed-out command is killed even if it ignores SIGTERM, and reports the timeout', async () => {
  const started = Date.now();
  // The shell ignores SIGTERM and its child keeps the output pipe open.
  const r = await run('sh', ['-c', 'trap "" TERM; sleep 5; exit 0'], { allowFail: true, timeoutMs: 100, graceMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('aborting kills the command and its children', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started = Date.now();
  const r = await run('sh', ['-c', 'sleep 5 & wait'], { allowFail: true, signal: ac.signal, graceMs: 200 });
  assert.equal(r.code, null);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('descendants that ignore SIGTERM are killed even after the command itself exits', async () => {
  // The shell dies on SIGTERM; the background subshell (and its sleep) ignore it.
  // The timeout leaves a slow machine time to print the pid before the shell is killed.
  const r = await run('sh', ['-c', '(trap "" TERM; sleep 3) & echo $!; wait'], { allowFail: true, timeoutMs: 1000, graceMs: 200 });
  assert.equal(r.timedOut, true);
  const pid = Number(r.stdout.trim());
  // Number('') is 0, and process.kill(0, 0) would signal our own process group.
  assert.ok(Number.isInteger(pid) && pid > 0, `no pid in the output: ${JSON.stringify(r.stdout)}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `process ${pid} survived the timeout`);
});

test('a timeout still applies when the command exited but a child keeps its output open', async () => {
  const started = Date.now();
  const r = await run('sh', ['-c', 'sleep 2 &'], { allowFail: true, timeoutMs: 100, graceMs: 100 });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null, 'a timed-out run is not a success');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('run hears stdout line by line, also lines split inside a character', async () => {
  const lines: string[] = [];
  // "æ" is two bytes; the first chunk ends between them.
  const script = "process.stdout.write(Buffer.from([0x61, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa6, 0x0a, 0x62, 0x0a, 0x63])), 50);";
  const r = await run(process.execPath, ['-e', script], { onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ['aæ', 'b', 'c']);
  assert.equal(r.stdout, '', 'kept nowhere else');
});

test('notPushed: commits the remote was never given, copies a rebase made included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-git-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
  const commit = (file: string, text: string | null, message: string) => {
    if (text === null) git('rm', '-q', file);
    else {
      writeFileSync(join(dir, file), text);
      git('add', file);
    }
    git('commit', '-qm', message);
  };
  try {
    git('init', '-q', '-b', 'main');
    commit('a.txt', 'a\n', 'Start');
    git('checkout', '-qb', 'feature');
    // Pushed: an addition and its revert.
    commit('x.txt', 'x\n', 'Add x');
    commit('x.txt', null, 'Revert "Add x"');
    const pushed = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/feature', pushed);
    // The base moves on the remote, and the branch is rebased onto it: copies of both, which count.
    git('checkout', '-q', 'main');
    commit('b.txt', 'b\n', 'Move the base');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('checkout', '-q', 'feature');
    git('rebase', '-q', 'main');
    const copies = git('rev-parse', 'HEAD');
    // The addition once more, though its patch is the pushed one's.
    commit('x.txt', 'x\n', 'Add x again');
    const repo = new Repo(join(dir, '.git'));
    const notPushed = async () => (await repo.notPushed(pushed, git('rev-parse', 'HEAD'), 'origin')).map((c) => c.message);
    assert.deepEqual(await notPushed(), ['Add x', 'Revert "Add x"', 'Add x again']);
    // The copies on another branch of the remote: only the addition is left.
    git('update-ref', 'refs/remotes/origin/other', copies);
    assert.deepEqual(await notPushed(), ['Add x again']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
