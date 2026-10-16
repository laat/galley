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
  /** stdout as bytes, for output that is not text (blobs). */
  bytes: Buffer;
  stderr: string;
  /** Exit code; null when the process was killed (by a signal, a timeout or an abort). */
  code: number | null;
  /** The process ran past `timeoutMs` and was killed. */
  timedOut?: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFail?: boolean;
  /** Kill the process (and everything it started) after this long. */
  timeoutMs?: number;
  /** Kill the process (and everything it started) when this aborts. */
  signal?: AbortSignal;
  /** How long a killed process gets after SIGTERM before SIGKILL. */
  graceMs?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Commands we may have to kill get their own process group, so their children go too.
    const killable = opts.timeoutMs !== undefined || opts.signal !== undefined;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: killable,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));

    let timedOut = false;
    let killed = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const kill = () => {
      if (killed) return;
      killed = true;
      // The whole group, even when the command itself is gone: its children may still be running.
      signalGroup('SIGTERM');
      // Not cleared when the command exits: descendants that ignored SIGTERM still get SIGKILL.
      setTimeout(() => signalGroup('SIGKILL'), opts.graceMs ?? 3000).unref();
      // If the command already exited, a child holding the pipes would keep 'close' from firing.
      if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
    };
    const onAbort = () => kill();
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
      const bytes = Buffer.concat(out);
      const res: RunResult = {
        stdout: bytes.toString('utf8'),
        bytes,
        stderr: Buffer.concat(err).toString('utf8'),
        // Whatever a killed process exits with, it did not finish its work.
        code: killed ? null : code,
        timedOut,
      };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new GitError(`${cmd} ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${code}`}`, res.stderr, res.code));
      } else {
        resolve(res);
      }
    };

    if (opts.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener('abort', onAbort);
    }
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => finish(code));
    // Once we killed it, do not wait for stray descendants to close the pipes.
    child.on('exit', (code) => {
      if (killed) finish(code);
    });
    // A command that exits without reading all its input closes the pipe (EPIPE). Its exit
    // code tells the caller what happened; the write error must not escape and crash us.
    child.stdin.on('error', () => {});
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

/** Line counts of files at full commit SHAs, which never change. */
const lineCountCache = new Map<string, number>();

export interface TreeEntry {
  mode: string;
  /** "commit" is a submodule. */
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  /** Bytes, for blobs. */
  size: number | null;
  name: string;
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

/** A commit object as stored, for recreating it exactly (apart from its signature). */
export interface RawCommit {
  tree: string;
  parents: string[];
  /** "Name <email> <unix time> <tz>", the format GIT_AUTHOR_* accept back. */
  author: { name: string; email: string; date: string };
  signed: boolean;
  /** The message bytes as stored, including the trailing newline. */
  message: string;
}

export function parseRawCommit(text: string): RawCommit {
  const sep = text.indexOf('\n\n');
  const headers = (sep === -1 ? text : text.slice(0, sep)).split('\n');
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  const parents: string[] = [];
  let author = { name: '', email: '', date: '' };
  let signed = false;
  for (const h of headers) {
    if (h.startsWith('tree ')) tree = h.slice(5);
    else if (h.startsWith('parent ')) parents.push(h.slice(7));
    else if (h.startsWith('gpgsig ') || h.startsWith('gpgsig-sha256 ')) signed = true;
    else if (h.startsWith('author ')) {
      const m = h.slice(7).match(/^(.*) <(.*)> (\d+ [+-]\d{4})$/);
      if (m) author = { name: m[1], email: m[2], date: m[3] };
    }
  }
  return { tree, parents, author, signed, message };
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

  async rawCommit(sha: string): Promise<RawCommit> {
    return parseRawCommit(await this.cached(['cat-file', 'commit', sha]));
  }

  async exists(sha: string): Promise<boolean> {
    return (await this.run(['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })).code === 0;
  }

  /** The full SHA of each name that names exactly one commit; other names are left out. One process for all. */
  async resolveCommits(names: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!names.length) return found;
    const r = await this.run(['cat-file', '--batch-check=%(objectname)'], { input: names.map((n) => `${n}^{commit}\n`).join(''), allowFail: true });
    // One line per name, in order: the SHA, or "<name> missing" (also when it abbreviates several commits).
    r.stdout.split('\n').forEach((line, i) => {
      if (i < names.length && SHA_RE.test(line)) found.set(names[i], line);
    });
    return found;
  }

  /** Those of `shas` (full commit SHAs) that no remote-tracking branch of `remote` contains. */
  async notOnRemote(shas: string[], remote: string): Promise<Set<string>> {
    if (!shas.length) return new Set();
    const r = await this.run(['rev-list', '--no-walk', ...shas, '--not', `--remotes=${remote}`], { allowFail: true });
    return new Set(r.code === 0 ? r.stdout.split('\n').filter(Boolean) : shas);
  }

  /** A config value as git resolves it for this repository (repository, global and system files). */
  async config(key: string, type?: 'bool'): Promise<string | null> {
    const r = await this.run(['config', ...(type ? [`--type=${type}`] : []), '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async show(sha: string, path: string): Promise<string | null> {
    const r = await this.run(['cat-file', 'blob', `${sha}:${path}`], { allowFail: true });
    if (r.code !== 0) return null;
    const key = `${this.gitDir}\0blob\0${sha}\0${path}`;
    return remember(key, r.stdout);
  }

  /**
   * The entries of the directory at `path` ("" for the root) in a commit, or null when there is
   * no directory there. Paths are only ever looked up in git's objects, never on disk.
   */
  async tree(sha: string, path: string): Promise<TreeEntry[] | null> {
    const r = await this.run(['ls-tree', '-z', '-l', `${sha}:${path}`], { allowFail: true });
    if (r.code !== 0) return null;
    return r.stdout
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const tab = rec.indexOf('\t');
        const [mode, type, oid, size] = rec.slice(0, tab).split(/ +/);
        return { mode, type: type as TreeEntry['type'], oid, size: size === '-' ? null : Number(size), name: rec.slice(tab + 1) };
      });
  }

  /** The entry for `path` in a commit's tree, or null when nothing is there. */
  async entry(sha: string, path: string): Promise<TreeEntry | null> {
    if (path === '') return { mode: '040000', type: 'tree', oid: '', size: null, name: '' };
    const slash = path.lastIndexOf('/');
    const entries = await this.tree(sha, slash === -1 ? '' : path.slice(0, slash));
    return entries?.find((e) => e.name === path.slice(slash + 1)) ?? null;
  }

  /** The bytes of the file at `path` in a commit, or null when there is no file there. */
  async blob(sha: string, path: string): Promise<Buffer | null> {
    const r = await this.run(['cat-file', 'blob', `${sha}:${path}`], { allowFail: true });
    return r.code === 0 ? r.bytes : null;
  }

  /** The lines of a text file at `path` in a commit, numbered from 1 as in diffs (index 0 is line 1). */
  async lines(sha: string, path: string): Promise<string[] | null> {
    const bytes = await this.blob(sha, path);
    if (!bytes) return null;
    const lines = bytes.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** How many lines each file has in a commit, read with one `git cat-file --batch`. Paths with no file are left out. */
  async lineCounts(sha: string, paths: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const key = (p: string) => `${this.gitDir}\0${sha}\0${p}`;
    const todo: string[] = [];
    for (const p of paths) {
      const hit = SHA_RE.test(sha) ? lineCountCache.get(key(p)) : undefined;
      if (hit !== undefined) counts.set(p, hit);
      // --batch reads one object name per line.
      else if (!p.includes('\n')) todo.push(p);
    }
    if (todo.length === 0) return counts;
    const r = await this.run(['cat-file', '--batch'], { input: todo.map((p) => `${sha}:${p}\n`).join(''), allowFail: true });
    let at = 0;
    for (const p of todo) {
      const eol = r.bytes.indexOf(10, at);
      if (eol === -1) break;
      // "<oid> <type> <size>", then the content; or "<name> missing".
      const m = r.bytes.subarray(at, eol).toString('utf8').match(/^[0-9a-f]+ (\w+) (\d+)$/);
      at = eol + 1;
      if (!m) continue;
      const body = r.bytes.subarray(at, at + Number(m[2]));
      at += body.length + 1;
      if (m[1] !== 'blob') continue;
      let n = 0;
      for (let i = body.indexOf(10); i !== -1; i = body.indexOf(10, i + 1)) n++;
      if (body.length > 0 && body[body.length - 1] !== 10) n++;
      counts.set(p, n);
      if (SHA_RE.test(sha)) {
        if (lineCountCache.size >= 5000) lineCountCache.delete(lineCountCache.keys().next().value!);
        lineCountCache.set(key(p), n);
      }
    }
    return counts;
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
