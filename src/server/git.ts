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
  /** Hears each line of stdout as it is printed, instead of keeping stdout for the result. */
  onLine?: (line: string) => void;
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
    // A line can arrive in pieces, and a piece can end inside a character: split the bytes.
    let partial = Buffer.alloc(0);
    // A listener that throws must not take the server down from inside a stream handler.
    const hear = (line: Buffer) => {
      try {
        opts.onLine!(line.toString('utf8'));
      } catch (e) {
        console.error(`${cmd}: reading its output:`, e);
      }
    };
    const lines = (d: Buffer) => {
      if (settled) return;
      let rest = partial.length ? Buffer.concat([partial, d]) : d;
      for (let nl = rest.indexOf(10); nl >= 0; nl = rest.indexOf(10)) {
        hear(rest.subarray(0, nl));
        rest = rest.subarray(nl + 1);
      }
      partial = Buffer.from(rest);
    };
    child.stdout.on('data', (d: Buffer) => (opts.onLine ? lines(d) : out.push(d)));
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
      if (opts.onLine && partial.length) hear(partial);
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

/**
 * For a fetch nobody is there to answer: git asks neither at the terminal nor through an askpass
 * program (an empty GIT_ASKPASS passes over core.askPass and SSH_ASKPASS), and Git Credential
 * Manager opens no window. It goes over https alone (and to local repositories): never ssh, whose
 * agent, such as 1Password's, may ask for approval in a window of its own. GIT_ALLOW_PROTOCOL wins
 * over any protocol.*.allow setting and over the one the server inherited; no ssh agent's socket
 * is in reach either.
 */
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'https:file', SSH_AUTH_SOCK: undefined };

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

/** What merging two commits gives (Repo.mergeTree). */
export interface MergeTree {
  clean: boolean;
  /** The files with a conflict. A conflict can be in no file, such as a directory renamed two ways (see messages). */
  files: string[];
  /** git's message for each conflict in none of those files ("CONFLICT (directory rename split): …"). */
  messages: string[];
}

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

  async refs(prefixes = ['refs/heads', 'refs/remotes']): Promise<Map<string, string>> {
    const text = await this.out(['for-each-ref', '--format=%(refname) %(objectname)', ...prefixes]);
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

  /**
   * Merge `head` into `base` without a working tree or index (`git merge-tree --write-tree`), for
   * whether it conflicts and where. Throws when git could not merge the two at all. Cached when both
   * are full SHAs, since the answer never changes.
   */
  async mergeTree(base: string, head: string): Promise<MergeTree> {
    const args = ['merge-tree', '--write-tree', '--name-only', '-z', base, head];
    const key = `${this.gitDir}\0${args.join('\0')}`;
    const immutable = SHA_RE.test(base) && SHA_RE.test(head);
    let text = immutable ? cache.get(key) : undefined;
    if (text === undefined) {
      const r = await this.run(args, { allowFail: true });
      // 0 merges cleanly and 1 conflicts; anything else is an error, such as unrelated histories or a git without --write-tree.
      if (r.code !== 0 && r.code !== 1) throw new GitError(`git merge-tree failed: ${r.stderr.trim() || `exit ${r.code}`}`, r.stderr, r.code);
      // The exit status says whether it conflicts: some conflicts list no file.
      text = `${r.code}${r.stdout}`;
      if (immutable) remember(key, text);
    }
    // The merged tree, each file with a conflict, then an empty field and the messages: for each, the
    // number of paths it is about, the paths, its type and its text.
    const fields = text.slice(1).split('\0');
    let i = 1;
    const files: string[] = [];
    while (i < fields.length && fields[i] !== '') files.push(fields[i++]);
    const messages: string[] = [];
    for (i++; i < fields.length && /^\d+$/.test(fields[i]); ) {
      const n = Number(fields[i]);
      const paths = fields.slice(i + 1, i + 1 + n);
      const [type = '', message = ''] = fields.slice(i + 1 + n, i + 3 + n);
      i += n + 3;
      // Conflicts in none of the files, which the list of files can not show.
      if (type.startsWith('CONFLICT') && !paths.some((p) => files.includes(p))) messages.push(message.trim());
    }
    return { clean: text[0] === '0', files, messages };
  }

  /** How many commits `to` has that `from` does not (`git rev-list --count from..to`). Cached when both are full SHAs. */
  async countCommits(from: string, to: string): Promise<number> {
    const args = ['rev-list', '--count', `${from}..${to}`];
    return Number((SHA_RE.test(from) && SHA_RE.test(to) ? await this.cached(args) : await this.out(args)).trim());
  }

  /**
   * Fetch `branch` from the repository at `url`, an https URL, into the ref `into` (a remote-tracking
   * branch), and nothing else: no tags, no FETCH_HEAD, no submodules, no maintenance afterwards.
   * Local branches and the working tree are not touched. It signs in with gh's credentials
   * (`gh auth git-credential`, with `gh` the binary) in place of the user's credential helpers, and
   * never goes over ssh: an insteadOf that turns the URL into an ssh one is refused. Nothing asks for
   * anything (FETCH_ENV), and with a timeout run() starts git in a session of its own, without a
   * terminal. Returns git's message when it failed, and null when it worked or `signal` stopped it.
   */
  async fetchBranch(url: string, branch: string, into: string, opts: { gh: string; cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<string | null> {
    // An empty helper drops those configured before it; the shell runs the one after it.
    const helper = `!'${opts.gh.replace(/'/g, `'\\''`)}' auth git-credential`;
    const args = ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, '-c', 'credential.interactive=false', '-c', 'protocol.ssh.allow=never'];
    args.push('fetch', '--no-tags', '--no-write-fetch-head', '--no-prune', '--no-recurse-submodules', '--no-auto-maintenance', '--', url, `+refs/heads/${branch}:${into}`);
    const r = await this.run(args, { cwd: opts.cwd, env: FETCH_ENV, timeoutMs: opts.timeoutMs, signal: opts.signal, allowFail: true });
    if (r.code === 0 || opts.signal?.aborted) return null;
    return r.timedOut ? `git fetch timed out after ${opts.timeoutMs / 1000} seconds` : r.stderr.trim() || `git fetch exited with ${r.code}`;
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
   * no directory there. Paths are only ever looked up in git's objects, never on disk. Every
   * browser page lists the directories to its path, so a full SHA's listings are cached.
   */
  async tree(sha: string, path: string): Promise<TreeEntry[] | null> {
    const args = ['ls-tree', '-z', '-l', `${sha}:${path}`];
    const key = `${this.gitDir}\0${args.join('\0')}`;
    let text = SHA_RE.test(sha) ? cache.get(key) : undefined;
    if (text === undefined) {
      const r = await this.run(args, { allowFail: true });
      if (r.code !== 0) return null;
      text = SHA_RE.test(sha) ? remember(key, r.stdout) : r.stdout;
    }
    return text
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const tab = rec.indexOf('\t');
        const [mode, type, oid, size] = rec.slice(0, tab).split(/ +/);
        return { mode, type: type as TreeEntry['type'], oid, size: size === '-' ? null : Number(size), name: rec.slice(tab + 1) };
      });
  }

  /** The path of every file in a commit (blobs: no directories or submodules), in git's order. */
  async files(sha: string): Promise<string[]> {
    const args = ['ls-tree', '-r', '-z', sha];
    const text = SHA_RE.test(sha) ? await this.cached(args) : await this.out(args);
    return text
      .split('\0')
      .filter(Boolean)
      .flatMap((rec) => {
        const tab = rec.indexOf('\t');
        return rec.slice(0, tab).split(' ')[1] === 'blob' ? [rec.slice(tab + 1)] : [];
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

  /**
   * Move a ref from `from` to `to`, where null is no ref (create, update or delete it), only if
   * it is still at `from`. Returns why it did not, in git's words; a ref already at `to` is fine.
   */
  async moveRef(ref: string, from: string | null, to: string | null): Promise<string | null> {
    // `update-ref -d` with an empty old value deletes the ref wherever it points, so a delete always names one.
    const args = to ? ['update-ref', ref, to, from ?? ''] : from ? ['update-ref', '-d', ref, from] : null;
    if (!args) return null;
    const r = await this.run(args, { allowFail: true });
    if (r.code === 0 || (await this.resolve(ref)) === to) return null;
    return r.stderr.trim();
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
