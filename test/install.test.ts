import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo } from '../src/server/git.ts';
import { cacheEnv, installCommand } from '../src/server/reviewers/install.ts';

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
    env: { XDG_RUNTIME_DIR: '/review/tmp' },
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

test("the install reads the user's npm settings for reviews (GALLEY_NPMRC) in place of ~/.npmrc, when there are some", () => {
  const before = process.env.GALLEY_NPMRC;
  try {
    delete process.env.GALLEY_NPMRC;
    assert.deepEqual(cacheEnv('/review/tmp'), {
      TMPDIR: '/review/tmp',
      XDG_CACHE_HOME: '/review/tmp/cache',
      npm_config_cache: '/review/tmp/npm',
      TURBO_CACHE_DIR: '/review/tmp/turbo',
      npm_config_store_dir: '/review/tmp/pnpm-store',
      pnpm_config_store_dir: '/review/tmp/pnpm-store',
      npm_config_manage_package_manager_versions: 'false',
      pnpm_config_manage_package_manager_versions: 'false',
      pnpm_config_pm_on_fail: 'ignore',
    });
    process.env.GALLEY_NPMRC = '/home/u/.config/agents/npmrc';
    assert.equal(cacheEnv('/review/tmp').npm_config_userconfig, '/home/u/.config/agents/npmrc');
  } finally {
    if (before === undefined) delete process.env.GALLEY_NPMRC;
    else process.env.GALLEY_NPMRC = before;
  }
});

test('pnpm commands in the review run the installed pnpm, not the one package.json names', (t) => {
  if (spawnSync('pnpm', ['--version']).status !== 0) return t.skip('no pnpm');
  const dir = mkdtempSync(join(tmpdir(), 'galley-pnpm-'));
  // A fetch of pnpm 1.0.0 fails at once, as one in the sandbox does.
  const offline = { HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', pnpm_config_fetch_retries: '0', npm_config_fetch_retries: '0' };
  const pins = [{ packageManager: 'pnpm@1.0.0' }, { devEngines: { packageManager: { name: 'pnpm', version: '1.0.0', onFail: 'download' } } }];
  try {
    for (const pin of pins) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, ...pin, scripts: { check: 'echo checked' } }));
      const r = spawnSync('pnpm', ['run', 'check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...cacheEnv(join(dir, 'tmp')), ...offline } });
      assert.equal(r.status, 0, `${JSON.stringify(pin)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /checked/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
