import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from '../src/server/git.ts';
import { installCommand } from '../src/server/reviewers/install.ts';

/** The install command for a commit holding these files; `{ symlink }` commits a symlink. */
async function install(files: Record<string, string | { symlink: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'galley-install-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string') writeFileSync(join(dir, name), content);
      else symlinkSync(content.symlink, join(dir, name));
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'files');
    return await installCommand(new Repo(join(dir, '.git')), git('rev-parse', 'HEAD'), '/review/tmp');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('each lockfile installs with its package manager, running nothing from the repository', async () => {
  assert.deepEqual(await install({ 'pnpm-lock.yaml': '' }), {
    lockfile: 'pnpm-lock.yaml',
    command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false'],
    env: {},
  });
  assert.deepEqual((await install({ 'package-lock.json': '{}' }))?.command, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual((await install({ 'npm-shrinkwrap.json': '{}' }))?.command, ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(await install({ 'bun.lock': '' }), { lockfile: 'bun.lock', command: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], env: { BUN_INSTALL_CACHE_DIR: '/review/tmp/bun' } });
  assert.deepEqual(await install({ 'yarn.lock': '# generated\n\n__metadata:\n  version: 8\n' }), {
    lockfile: 'yarn.lock',
    command: ['yarn', 'install', '--immutable', '--mode=skip-build'],
    env: { YARN_IGNORE_PATH: '1', YARN_ENABLE_SCRIPTS: '0', YARN_GLOBAL_FOLDER: '/review/tmp/yarn' },
  });
  assert.deepEqual(await install({ 'yarn.lock': '# yarn lockfile v1\n' }), {
    lockfile: 'yarn.lock',
    command: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
    env: { YARN_IGNORE_PATH: '1', YARN_ENABLE_SCRIPTS: '0', YARN_CACHE_FOLDER: '/review/tmp/yarn' },
  });
});

test('package.json picks among several lockfiles; without one nothing is installed', async () => {
  assert.equal((await install({ 'yarn.lock': '# yarn lockfile v1\n', 'package-lock.json': '{}' }))?.lockfile, 'yarn.lock');
  assert.equal((await install({ 'yarn.lock': '# yarn lockfile v1\n', 'package-lock.json': '{}', 'package.json': '{"packageManager":"npm@11.0.0"}' }))?.lockfile, 'package-lock.json');
  assert.equal(await install({ 'package.json': '{"packageManager":"pnpm@10.0.0"}' }), null);
  assert.equal(await install({}), null);
});

test('symlinks count as no file, so the server never reads through them', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'galley-outside-')), 'package.json');
  writeFileSync(outside, '{"packageManager":"yarn@4.0.0"}');
  try {
    // A package.json pointing at /dev/zero, or outside the checkout, does not choose; a symlinked lockfile is no lockfile.
    assert.equal((await install({ 'package.json': { symlink: '/dev/zero' }, 'yarn.lock': '# yarn lockfile v1\n', 'package-lock.json': '{}' }))?.lockfile, 'yarn.lock');
    assert.equal((await install({ 'package.json': { symlink: outside }, 'pnpm-lock.yaml': '', 'yarn.lock': '# yarn lockfile v1\n' }))?.lockfile, 'pnpm-lock.yaml');
    assert.equal(await install({ 'pnpm-lock.yaml': { symlink: '/dev/zero' }, 'yarn.lock': { symlink: outside } }), null);
    assert.equal((await install({ 'yarn.lock': { symlink: '/dev/zero' }, 'package-lock.json': '{}' }))?.lockfile, 'package-lock.json');
    // An oversized package.json is not read either.
    assert.equal((await install({ 'package.json': JSON.stringify({ packageManager: 'npm@11.0.0', pad: 'x'.repeat(1024 * 1024) }), 'yarn.lock': '', 'package-lock.json': '{}' }))?.lockfile, 'yarn.lock');
  } finally {
    rmSync(join(outside, '..'), { recursive: true, force: true });
  }
});
