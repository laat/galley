// Installing a pull request's dependencies before a reviewer agent looks at it. Only from a
// lockfile, and without running anything the repository provides: no lifecycle scripts, no
// pnpmfile, no yarnPath, and no package manager version the repository asks for.
import { join } from 'node:path';
import { reviewNpmrc } from '../../config.ts';
import type { Repo, TreeEntry } from '../git.ts';

export interface Install {
  /** The lockfile it installs from. */
  lockfile: string;
  command: string[];
  /** Variables the command needs besides the review's environment. */
  env: Record<string, string>;
}

/** Lockfiles and their package managers, in the order they are tried when package.json names none. */
const LOCKFILES: [file: string, manager: string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** A larger package.json is not read. */
const MAX_PACKAGE_JSON = 1024 * 1024;
const GREP_TIMEOUT_MS = 30_000;

/**
 * What the review's environment sets so tools cache in `tmp` (the sandbox keeps the home directory
 * read-only, and npm fails there), and npm's settings for reviews when the user has some
 * (reviewNpmrc), so that the install reads those and not ~/.npmrc. pnpm 12 reads a
 * setting of pnpm's own, such as its store, from pnpm_config_ and no longer from npm_config_.
 * Turborepo caches in the main worktree's .turbo when it runs in a linked worktree, as the
 * review's checkout is; for galley's bare clone (repos/<id>.git) that is repos/.turbo, which the
 * sandbox keeps read-only. A cache directory of its own turns that off. zsh writes heredocs to
 * $TMPPREFIX, /tmp/zsh unless set, and not to $TMPDIR.
 *
 * Every pnpm command the reviewer agent runs uses the pnpm that is installed, as the install
 * does (installCommand), and not the version package.json names in packageManager or
 * devEngines.packageManager. pnpm would otherwise fetch that version when another is installed,
 * and lock its store of pnpm versions for it, which the sandbox keeps read-only: the command
 * fails with ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK. pnpm 12 skips the switch for either field
 * with pmOnFail, which pnpm 10 does not have; it reads manage-package-manager-versions from
 * npm_config_.
 */
export function cacheEnv(tmp: string): Record<string, string> {
  const npmrc = reviewNpmrc();
  const store = join(tmp, 'pnpm-store');
  return {
    TMPDIR: tmp,
    XDG_CACHE_HOME: join(tmp, 'cache'),
    npm_config_cache: join(tmp, 'npm'),
    TURBO_CACHE_DIR: join(tmp, 'turbo'),
    TMPPREFIX: join(tmp, 'zsh'),
    npm_config_store_dir: store,
    pnpm_config_store_dir: store,
    npm_config_manage_package_manager_versions: 'false',
    pnpm_config_manage_package_manager_versions: 'false',
    pnpm_config_pm_on_fail: 'ignore',
    ...(npmrc ? { npm_config_userconfig: npmrc } : {}),
  };
}

/**
 * How to install the dependencies of commit `sha`, caching in `tmp`; null when its root has no
 * lockfile. The files are read from git, not from the checkout: there a pull request's
 * package.json could be a symlink to /dev/zero or to a file outside it, read by the server
 * itself. In git a symlink is its own kind of entry, and counts as no file.
 */
export async function installCommand(git: Repo, sha: string, tmp: string): Promise<Install | null> {
  const files = new Map<string, TreeEntry>();
  for (const e of (await git.tree(sha, '')) ?? []) if (e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')) files.set(e.name, e);
  const found = LOCKFILES.filter(([file]) => files.has(file));
  if (!found.length) return null;
  // With more than one lockfile, package.json's packageManager ("pnpm@10.4.1") decides.
  let named = '';
  const pkg = files.get('package.json');
  if (pkg && pkg.size !== null && pkg.size <= MAX_PACKAGE_JSON) {
    try {
      named = String(JSON.parse((await git.blob(sha, 'package.json'))?.toString('utf8') ?? '').packageManager ?? '').split('@')[0];
    } catch {}
  }
  const [lockfile, manager] = found.find(([, m]) => m === named) ?? found[0];
  switch (manager) {
    case 'pnpm':
      // pnpm 12 locks its store in $XDG_RUNTIME_DIR, or in /tmp when that is unset or others may
      // write to it; the sandbox keeps both read-only. tmp is the user's own (Reviewer.review).
      return { lockfile, command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false'], env: { XDG_RUNTIME_DIR: tmp } };
    case 'bun':
      return { lockfile, command: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'], env: { BUN_INSTALL_CACHE_DIR: join(tmp, 'bun') } };
    case 'yarn': {
      // YARN_IGNORE_PATH: both Yarns would otherwise run the yarnPath the repository names.
      const env = { YARN_IGNORE_PATH: '1', YARN_ENABLE_SCRIPTS: '0' };
      // Yarn 2 and later write __metadata into the lockfile; Yarn 1 does not. git searches it, so it is never read in here.
      const berry = await git.run(['grep', '-q', '-F', '-e', '__metadata:', sha, '--', lockfile], { allowFail: true, timeoutMs: GREP_TIMEOUT_MS });
      if (berry.code === 0) {
        return { lockfile, command: ['yarn', 'install', '--immutable', '--mode=skip-build'], env: { ...env, YARN_GLOBAL_FOLDER: join(tmp, 'yarn') } };
      }
      return { lockfile, command: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'], env: { ...env, YARN_CACHE_FOLDER: join(tmp, 'yarn') } };
    }
    default:
      return { lockfile, command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], env: {} };
  }
}
