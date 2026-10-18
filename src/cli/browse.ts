import { parseArgs } from 'node:util';
import { isAbsolute, posix, relative } from 'node:path';
import { ApiError, CliError, git, repoPath, type Client, type RepoRef } from './client.ts';
import { isTTY, out, stagedRef, stagedNumber } from './output.ts';
import { openPage } from './open.ts';
import { rendersByDefault } from '../rendered.ts';
import { sendCommit } from './send.ts';

export const BROWSE_USAGE = `Print the web UI's URL for a staged pull request, a file or a directory, and open it
in the browser when run at a terminal, or in the desktop app while it runs and opens
galley links. Like \`gh browse\`, but the URLs name a commit, so
they keep pointing at the code you mean. s4 (or 4, as in gh) is staged pull request s#4;
when there is none, 4 can be a commit SHA.

USAGE
  galley browse [<s-number> | <path>[:<line>[-<line>]] | <commit-SHA>] [flags]

FLAGS
  -c, --commit <sha>   The commit to show the path at (default: HEAD, also for a bare --commit)
  -b, --branch <name>  The commit at the tip of a branch
  -n, --no-browser     Only print the URL
  -R, --repo <owner/repo>  Another repository in galley. Commits and paths are looked up
                           there (default commit: HEAD of its checkout), paths from its root
  -s, --settings       Open the settings

EXAMPLES
  galley browse                          # this repository's staged pull requests
  galley browse s12                      # staged pull request s#12
  galley browse src/x.ts:12 --commit 3f2a1c9
  galley browse src/x.ts:12-20           # lines 12 to 20, at HEAD
  galley browse src/                     # a directory
`;

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function browse(client: Client, cwd: string, args: string[]): Promise<number> {
  // A bare --commit means the last commit, as in gh.
  const fixed = args.map((a, i) => ((a === '--commit' || a === '-c') && (i === args.length - 1 || args[i + 1].startsWith('-')) ? '--commit=HEAD' : a));
  let parsed;
  try {
    parsed = parseArgs({
      args: fixed,
      allowPositionals: true,
      options: {
        commit: { type: 'string', short: 'c' },
        branch: { type: 'string', short: 'b' },
        'no-browser': { type: 'boolean', short: 'n' },
        repo: { type: 'string', short: 'R' },
        settings: { type: 'boolean', short: 's' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    out(BROWSE_USAGE);
    return 0;
  }
  if (positionals.length > 1) throw new CliError(`accepts at most 1 arg, received ${positionals.length}`);
  const url = await client.url(await target(client, cwd, positionals[0], v));
  out(url);
  if (isTTY && !v['no-browser']) await openPage(client, url);
  return 0;
}

/** Where commits and paths are looked up. */
interface Lookup {
  /** The full SHA of a commit, or null. */
  commit(rev: string): Promise<string | null>;
  /** What a path is at a commit: "tree", "blob" or "commit" (a submodule); null for nothing. */
  type(sha: string, path: string): Promise<string | null>;
  /** A path from the command line, relative to the repository's root. */
  path(arg: string): string;
}

/** The repository here, with git. Paths are relative to the current directory, as in gh. */
function here(cwd: string): Lookup {
  const tryGit = (args: string[]) => {
    try {
      return git(cwd, args);
    } catch {
      return null;
    }
  };
  return {
    commit: async (rev) => tryGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]),
    type: async (sha, path) => tryGit(['cat-file', '-t', `${sha}:${path}`]),
    path: (arg) => (isAbsolute(arg) ? relative(git(cwd, ['rev-parse', '--show-toplevel']), arg) : posix.join(git(cwd, ['rev-parse', '--show-prefix']), arg)),
  };
}

/** The repository here (here), sending a commit the link names to galley's clone when it does not have it (sendCommit). */
function sending(client: Client, cwd: string, repo: RepoRef, look: Lookup): Lookup {
  return {
    ...look,
    commit: async (rev) => {
      const sha = await look.commit(rev);
      if (sha) await sendCommit(client, cwd, repo, sha);
      return sha;
    },
  };
}

/** Another repository (--repo), through the server's GitHub-shaped API: the CLI never reads its git directory. */
function there(client: Client, repo: RepoRef): Lookup {
  const api = repoPath(repo);
  const get = async (path: string, missing: number) => {
    try {
      return await client.get(path);
    } catch (e) {
      if (e instanceof ApiError && e.status === missing) return null;
      throw e;
    }
  };
  return {
    commit: async (rev) => (await get(`${api}/commits/${encodeURIComponent(rev)}`, 422))?.sha ?? null,
    type: async (sha, path) => {
      const c = await get(`${api}/contents/${encodePath(path)}?ref=${sha}`, 404);
      return c === null ? null : Array.isArray(c) ? 'tree' : c.type === 'submodule' ? 'commit' : 'blob';
    },
    path: (arg) => arg.replace(/^\/+/, ''),
  };
}

/** The path (under the server URL) that the arguments point at. */
async function target(client: Client, cwd: string, arg: string | undefined, v: { commit?: string; branch?: string; repo?: string; settings?: boolean }): Promise<string> {
  if (v.settings) return '/settings';
  const inRepo = (() => {
    try {
      git(cwd, ['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  })();
  if (!inRepo && !v.repo) {
    if (arg !== undefined || v.commit || v.branch) throw new CliError('not a git repository (or any of the parent directories)');
    return '/';
  }
  const repo = await client.repoFor(cwd, v.repo);
  const base = `/${repo.owner}/${repo.name}`;
  const look = v.repo ? there(client, repo) : sending(client, cwd, repo, here(cwd));
  const commitOf = async (rev: string) => {
    const sha = await look.commit(rev);
    if (!sha) throw new CliError(`no commit "${rev}" in ${repo.owner}/${repo.name}`);
    return sha;
  };
  const rev = v.commit ?? v.branch;
  if (arg === undefined) return rev ? `${base}/tree/${await commitOf(rev)}` : base;
  // A number (s4, or 4 as in gh) is a pull request when there is one. Otherwise all digits can be a
  // commit SHA. A file named so is ./s4.
  const number = stagedNumber(arg);
  if (number !== null) {
    try {
      await client.get(`${repoPath(repo)}/gh/pulls/${number}?fields=number`);
      return `${base}/pull/${number}`;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  // A commit SHA, unless a file has that name.
  const shaLike = /^[0-9a-f]{7,40}$/.test(arg) && !rev;
  if (shaLike) {
    const sha = await look.commit(arg);
    if (sha) return `${base}/tree/${sha}`;
  }
  if (number !== null) throw new CliError(`no pull request ${shaLike ? `or commit "${arg}"` : stagedRef(number)} in ${repo.owner}/${repo.name}`);

  const m = arg.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/)!;
  const sha = await commitOf(rev ?? 'HEAD');
  const path = posix.normalize(look.path(m[1])).replace(/^\.\/?$/, '').replace(/\/$/, '');
  if (path === '..' || path.startsWith('../')) throw new CliError(`${m[1]} is outside the repository`);
  const type = path === '' ? 'tree' : await look.type(sha, path);
  if (!type) throw new CliError(`${path} does not exist at ${sha.slice(0, 7)}`);
  if (type === 'tree') return `${base}/tree/${sha}${path ? '/' + encodePath(path) : ''}`;
  if (type !== 'blob') throw new CliError(`${path} is a submodule`);
  const lines = m[2] ? `#L${m[2]}${m[3] ? `-L${m[3]}` : ''}` : '';
  // Rendered Markdown and SVG have no line numbers; the source does.
  const plain = lines && rendersByDefault(path) ? '?plain=1' : '';
  return `${base}/blob/${sha}/${encodePath(path)}${plain}${lines}`;
}
