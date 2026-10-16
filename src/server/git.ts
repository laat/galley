import { spawn } from 'node:child_process';
import { parseDiff, type FileDiff, type HunkRange, parseHunkRanges } from './diff.ts';

export class GitError extends Error {
  stderr: string;
  code: number | null;
  constructor(message: string, stderr: string, code: number | null) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFail?: boolean;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const res = { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code };
      if (code !== 0 && !opts.allowFail) {
        reject(new GitError(`${cmd} ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${code}`}`, res.stderr, code));
      } else {
        resolve(res);
      }
    });
    child.stdin.end(opts.input ?? '');
  });
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** Override user settings that change the output we parse. */
const GIT_CONFIG = [
  '-c', 'core.quotepath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.relative=false',
  '-c', 'diff.interHunkContext=0',
  '-c', 'log.showSignature=false',
];

/** Results for commands whose inputs are all full SHAs never change, so they are safe to cache. */
const cache = new Map<string, string>();
const CACHE_MAX = 500;
function remember(key: string, value: string): string {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  message: string;
}

/** Git operations on one repository, addressed by its (common) git dir so worktrees share it. */
export class Repo {
  gitDir: string;
  constructor(gitDir: string) {
    this.gitDir = gitDir;
  }

  run(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    return run('git', ['--git-dir', this.gitDir, ...GIT_CONFIG, ...args], opts);
  }

  async out(args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.run(args, opts)).stdout;
  }

  private async cached(args: string[]): Promise<string> {
    const key = `${this.gitDir}\0${args.join('\0')}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    return remember(key, await this.out(args));
  }

  async resolve(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async refs(): Promise<Map<string, string>> {
    const text = await this.out(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes']);
    const map = new Map<string, string>();
    for (const line of text.split('\n')) {
      const i = line.indexOf(' ');
      if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
    }
    return map;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', a, b], { allowFail: true });
    return r.code === 0;
  }

  async log(from: string, to: string): Promise<Commit[]> {
    const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%B'].join('%x00') + '%x1e';
    const args = ['log', '--reverse', `--format=${fmt}`, `${from}..${to}`];
    const text = SHA_RE.test(from) && SHA_RE.test(to) ? await this.cached(args) : await this.out(args);
    return text
      .split('\x1e')
      .map((s) => s.replace(/^\n/, ''))
      .filter((s) => s.length > 0)
      .map((rec) => {
        const [sha, parents, an, ae, ad, cn, ce, cd, message] = rec.split('\x00');
        return {
          sha,
          parents: parents ? parents.split(' ') : [],
          authorName: an,
          authorEmail: ae,
          authorDate: ad,
          committerName: cn,
          committerEmail: ce,
          committerDate: cd,
          message: message.replace(/\n+$/, ''),
        };
      });
  }

  async commit(sha: string): Promise<Commit | null> {
    const full = await this.resolve(sha);
    if (!full) return null;
    const parent = await this.resolve(`${full}^`);
    const commits = parent ? await this.log(parent, full) : await this.logRoot(full);
    return commits[commits.length - 1] ?? null;
  }

  private async logRoot(sha: string): Promise<Commit[]> {
    const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%B'].join('%x00');
    const text = await this.cached(['log', '-1', `--format=${fmt}`, sha]);
    const [s, parents, an, ae, ad, cn, ce, cd, message] = text.split('\x00');
    return [{ sha: s, parents: parents ? parents.split(' ') : [], authorName: an, authorEmail: ae, authorDate: ad, committerName: cn, committerEmail: ce, committerDate: cd, message: message.replace(/\n+$/, '') }];
  }

  /** Raw unified diff between two commits. `from` may be null for a root commit. */
  async rawDiff(from: string | null, to: string, opts: { context?: number; paths?: string[] } = {}): Promise<string> {
    const flags = ['--no-color', '--no-ext-diff', '--find-renames', `-U${opts.context ?? 3}`];
    const args = from ? ['diff', ...flags, from, to] : ['diff-tree', '-p', '--root', '--no-commit-id', ...flags, to];
    if (opts.paths) args.push('--', ...opts.paths);
    const immutable = SHA_RE.test(to) && (from === null || SHA_RE.test(from));
    return immutable ? this.cached(args) : this.out(args);
  }

  async diff(from: string | null, to: string): Promise<FileDiff[]> {
    return parseDiff(await this.rawDiff(from, to));
  }

  /** Hunk ranges of a zero-context diff for one file, used to carry line numbers across revisions. */
  async hunkRanges(from: string, to: string, path: string): Promise<HunkRange[] | 'deleted'> {
    const text = await this.cached(['diff', '--no-color', '--no-ext-diff', '-U0', from, to, '--', path]);
    if (/^deleted file mode/m.test(text) || /^\+\+\+ \/dev\/null/m.test(text)) return 'deleted';
    return parseHunkRanges(text);
  }

  async show(sha: string, path: string): Promise<string | null> {
    const r = await this.run(['cat-file', 'blob', `${sha}:${path}`], { allowFail: true });
    if (r.code !== 0) return null;
    const key = `${this.gitDir}\0blob\0${sha}\0${path}`;
    return remember(key, r.stdout);
  }

  async updateRef(ref: string, sha: string): Promise<void> {
    await this.run(['update-ref', ref, sha]);
  }

  async remoteUrl(remote: string): Promise<string | null> {
    const r = await this.run(['remote', 'get-url', remote], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async remotes(): Promise<string[]> {
    return (await this.out(['remote'])).split('\n').filter(Boolean);
  }
}

/** owner/name from a GitHub remote URL, or null when the remote is not on github.com. */
export function githubSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}
