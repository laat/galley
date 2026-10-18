// Sending the author's branch to galley's clone of the repository (Service.registerGithub), and
// fetching back what galley fetched from GitHub, with git over HTTP at the clone's git URL
// (git-http.ts). Only for a repository galley keeps a clone of, from a checkout of it: galley reads
// one registered by path where it is, so nothing is sent or fetched for it.
//
// Only the pull request's author sends, as an agent (cliActor): a person at a terminal reviews, and
// may have the branch at something else. It sends a fast-forward of what galley has, or a rewrite
// of a commit galley has that the branch here had, with a lease on it (receive-hook.ts): never
// over commits the branch here never had, such as another checkout's on a branch of the same name,
// even once they are fetched.
import { execFile } from 'node:child_process';
import { cliActor } from '../config.ts';
import { ApiError, CliError, currentBranch, noProxyFromEnv, repoPath, sandboxed, type Checkout, type Client, type RepoRef } from './client.ts';
import { err } from './output.ts';

type CloneCheckout = Checkout & { gitUrl: string };

const short = (sha: string) => sha.slice(0, 7);

/** git in the checkout: its exit code and output, failing or not. */
function run(checkout: Checkout, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: checkout.top, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) => {
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (e && typeof e.code !== 'number' ? e.message : '') });
    });
  });
}

/**
 * git's settings for galley at `url`, so that git reaches it as the CLI's own requests do
 * (proxyFromEnv): through the proxy HTTP_PROXY or HTTPS_PROXY names, unless NO_PROXY names the
 * host, and otherwise directly, whatever git's own http.proxy says. A sandbox's proxy, as Claude
 * Code's, lets git out too.
 */
export function toGalley(url: string, env = process.env): { args: string[]; env: NodeJS.ProcessEnv } {
  // As Node picks it: lowercase first, and for https, the http proxy when there is no other.
  const http = env.http_proxy || env.HTTP_PROXY;
  const proxy = (url.startsWith('https:') ? env.https_proxy || env.HTTPS_PROXY || http : http) ?? '';
  const noProxy = noProxyFromEnv(env);
  // An empty http.proxy turns git's proxy off; one set has it go by NO_PROXY.
  return { args: ['-c', `http.proxy=${proxy}`], env: { ...env, NO_PROXY: noProxy, no_proxy: noProxy, GIT_TERMINAL_PROMPT: '0' } };
}

/** What git said last, for a message. */
const lastLine = (text: string) => text.trim().split('\n').filter((l) => !/^(To |Done$)/.test(l)).pop()?.trim() ?? '';

/** The checkout this command registered, when it is `repo`'s and galley keeps a clone of it; null otherwise. */
async function cloneCheckout(client: Client, cwd: string, repo: RepoRef): Promise<CloneCheckout | null> {
  const checkout = await client.registered(cwd);
  if (!checkout?.gitUrl) return null;
  const same = checkout.owner.toLowerCase() === repo.owner.toLowerCase() && checkout.name.toLowerCase() === repo.name.toLowerCase();
  return same ? (checkout as CloneCheckout) : null;
}

/** Whether galley's clone has the commit `rev` names. */
async function galleyCommit(client: Client, repo: RepoRef, rev: string): Promise<string | null> {
  try {
    return (await client.get(`${repoPath(repo)}/commits/${rev.split('/').map(encodeURIComponent).join('/')}`)).sha;
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) return null;
    throw e;
  }
}

/**
 * Whether the branch here had commit `sha` in it: in a tip its reflog remembers, such as one from
 * before an amend, a rebase or a reset. Not when the commit was only fetched.
 */
async function had(checkout: Checkout, branch: string, sha: string): Promise<boolean> {
  const tips = new Set((await run(checkout, ['rev-list', '--walk-reflogs', `refs/heads/${branch}`])).stdout.split('\n').filter(Boolean));
  if (!tips.size) return false;
  // Reachable from one of them: nothing of it is left once they are left out.
  const r = await run(checkout, ['rev-list', '--count', sha, '--not', ...tips]);
  return r.code === 0 && r.stdout.trim() === '0';
}

/**
 * Send `branch` to galley when this checkout has it at a commit galley does not: as a fast-forward
 * of what galley has, or as a rewrite of it with a lease on it, when the branch here had that
 * commit (it was rewritten here), or with `replace`, whatever galley has (the branch of a merged
 * pull request, its name used again). With `kept`, why galley's may not be rewritten at all.
 * Throws, saying what to do, when galley has a commit there the branch here never had, or its
 * branch moved while this was sent.
 */
async function sendBranch(client: Client, checkout: CloneCheckout, branch: string, { replace = false, kept = '' } = {}): Promise<void> {
  const tip = (await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).stdout.trim();
  // Not here: another checkout's branch, or one deleted here.
  if (!tip) return;
  const there = await galleyCommit(client, checkout, `refs/heads/${branch}`);
  if (there === tip) return;
  const url = checkout.gitUrl;
  const fastForward = !there || (await run(checkout, ['merge-base', '--is-ancestor', there, tip])).code === 0;
  if (there && !fastForward && kept) {
    throw new CliError(`galley has ${branch} at ${short(there)}, and ${kept}: it is replaced only by a fast-forward. Nothing was sent. Stage this on a branch of another name.`);
  }
  // Also when the branch here is behind galley's, which another checkout added to: winding it back
  // would drop their commits.
  if (there && !fastForward && !replace && !(await had(checkout, branch, there))) {
    throw new CliError(
      `galley has ${branch} at ${short(there)}, which ${branch} here never had: another checkout sent it. Nothing was sent. ` +
        `Fetch it with \`git fetch ${url} ${branch}\`, rebase onto FETCH_HEAD, and run this again.`,
    );
  }
  // A rewrite replaces the commit galley has only while galley still has it there. git checks
  // --force-with-lease itself and tells galley nothing of it, so the push option says it to galley.
  const lease = fastForward ? [] : [`--force-with-lease=refs/heads/${branch}:${there}`, '--push-option', `lease=${branch}:${there}`];
  const { args, env } = toGalley(url);
  // No hooks (git-lfs would upload to galley), tags or submodules: only the branch goes.
  const push = ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', ...lease, url, `${tip}:refs/heads/${branch}`];
  const r = await run(checkout, [...args, '-c', 'push.gpgSign=false', ...push], env);
  if (r.code === 0) {
    err(`Sent ${branch} at ${short(tip)} to galley.`);
    return;
  }
  const refused = r.stdout.match(/^!\t[^\t]*\t\[([^\]]+)\](?: \(([^)]*)\))?/m);
  if (refused) {
    const said = [...r.stderr.matchAll(/^remote: galley: (.*)$/gm)].map((m) => m[1].trim());
    const why = said.length ? said.join('; ') : (refused[2] ?? refused[1]);
    throw new CliError(`galley did not take ${branch} at ${short(tip)} (${why}): its ${branch} moved while this was sent. Nothing was sent. Run this again.`);
  }
  throw new CliError(`could not send ${branch} to galley at ${url}: ${lastLine(r.stderr) || `git exited with ${r.code}`}. Nothing was sent.${sandboxed()}`);
}

/** sendBranch, with what kept it from sending said, not thrown, unless `strict`. */
async function send(client: Client, checkout: CloneCheckout, branch: string, strict: boolean, opts?: { replace?: boolean; kept?: string }): Promise<void> {
  try {
    await sendBranch(client, checkout, branch, opts);
  } catch (e) {
    if (strict || !(e instanceof CliError)) throw e;
    err(e.message);
  }
}

/**
 * Before `pr create`: send the branch to stage, from the checkout of `repo`, so galley has it. Not
 * for a person at a terminal, whom galley tells to push it, nor to the branch of an open pull
 * request, which galley says is staged already. galley's branch of that name is replaced when it
 * is nobody's: its pull requests merged, or closed before they were published (one closed on
 * GitHub is reopened by publishing it), the name used again. One that an open pull request is
 * stacked on is only added to.
 */
export async function sendHead(client: Client, cwd: string, repo: RepoRef, branch: string): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout || !cliActor()) return;
  const pulls = (q: string) => client.get<any[]>(`${repoPath(repo)}/gh/pulls?${q}&limit=1000&fields=state,publishedUrl,url`);
  const named = await pulls(`state=all&head=${encodeURIComponent(branch)}`);
  if (named.some((p) => p.state !== 'MERGED' && p.state !== 'CLOSED')) return;
  const stacked = (await pulls(`state=open&base=${encodeURIComponent(branch)}`)).map((p) => p.url);
  const kept = stacked.length ? `${stacked.length === 1 ? 'the open pull request' : 'the open pull requests'} ${stacked.join(', ')} ${stacked.length === 1 ? 'is' : 'are'} stacked on it` : '';
  await send(client, checkout, branch, true, { replace: named.every((p) => p.state === 'MERGED' || !p.publishedUrl), kept });
}

/**
 * Before a command on pull request `number` of `repo`, as its author: send its branch from the
 * checkout, so galley reviews and links to what the author has. With `strict` (pr wait), what keeps
 * it from being sent ends the command; otherwise it is said, and the command goes on.
 */
export async function sendPull(client: Client, cwd: string, repo: RepoRef, number: number, { strict = false } = {}): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  const actor = cliActor();
  if (!checkout || !actor) return;
  const pr = await client.get(`${repoPath(repo)}/gh/pulls/${number}?fields=author,headRefName`);
  if (pr.author.login !== actor.login) return;
  // The branch is the latest pull request's that has it: one done with before its name was used
  // again sends nothing to the other's.
  const named = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=all&head=${encodeURIComponent(pr.headRefName)}&limit=1000&fields=number`);
  if (Math.max(...named.map((p) => p.number)) === number) await send(client, checkout, pr.headRefName, strict);
}

/**
 * Before `galley browse` links to commit `sha`, when galley does not have it: send the current
 * branch, when it is the head of an open pull request of this agent's. When galley still does not
 * have it, say so: the link would show nothing.
 */
export async function sendCommit(client: Client, cwd: string, repo: RepoRef, sha: string): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout || (await galleyCommit(client, repo, sha))) return;
  const branch = currentBranch(cwd);
  const actor = cliActor();
  if (branch && actor) {
    const [pull] = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=open&head=${encodeURIComponent(branch)}&fields=author`);
    if (pull?.author.login === actor.login) await send(client, checkout, branch, false);
    if (await galleyCommit(client, repo, sha)) return;
  }
  err(`galley does not have ${short(sha)}, so the link shows nothing until it does: \`galley pr wait\` sends the branch of your pull request.`);
}

/**
 * After `pr wait`: fetch what galley fetched from GitHub, galley's refs/remotes/origin/<branch> at
 * `sha`, into the checkout's remote-tracking branch, for the author to rebase onto, as it may not
 * reach GitHub from its sandbox: the base the head conflicts with, or the branch on GitHub after a
 * push GitHub refused. One here that has `sha` in it, fetched from GitHub since, stays; one that is
 * older, or another (rewritten on GitHub), becomes galley's. Says what it is called here
 * (<remote>/<branch>), or null when it could not be fetched, or galley keeps no clone of `repo`.
 */
export async function fetchBack(client: Client, cwd: string, repo: RepoRef, branch: string, sha: string): Promise<string | null> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout?.remote) return null;
  const local = `${checkout.remote}/${branch}`;
  const here = (await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/${local}`])).stdout.trim();
  if (here && (await run(checkout, ['merge-base', '--is-ancestor', sha, here])).code === 0) return local;
  const spec = `+refs/remotes/origin/${branch}:refs/remotes/${local}`;
  const { args, env } = toGalley(checkout.gitUrl);
  const r = await run(checkout, [...args, 'fetch', '--no-tags', '--no-prune', '--no-write-fetch-head', '--recurse-submodules=no', checkout.gitUrl, spec], env);
  if (r.code === 0) return local;
  err(`Could not fetch ${branch} from galley into ${local}: ${lastLine(r.stderr) || `git exited with ${r.code}`}. Run \`git fetch ${checkout.gitUrl} ${spec}\` where it can write to the repository.`);
  return null;
}

/**
 * Whether the checkout has `branch`, when galley keeps a clone of `repo`: galley keeps the branches
 * sent to it, so whether one is gone is the checkout's to say. Null for a repository galley reads
 * where it is, which says so itself.
 */
export async function hasBranch(client: Client, cwd: string, repo: RepoRef, branch: string): Promise<boolean | null> {
  const checkout = await cloneCheckout(client, cwd, repo);
  return checkout ? (await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0 : null;
}

/**
 * Before `pr checkout`: the pull request's head from galley's clone, when the checkout does not have
 * it, and unless `detach`, the branch made at it when the checkout has none. How the branch here
 * stands to it: `behind` (pr checkout fast-forwards it) or `differs` (it does not have the head);
 * null when it has the head, or galley keeps no clone of the repository.
 */
export async function fetchHead(client: Client, cwd: string, repo: RepoRef, branch: string, head: string, { detach = false } = {}): Promise<'behind' | 'differs' | null> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout) return null;
  const has = async () => (await run(checkout, ['cat-file', '-e', `${head}^{commit}`])).code === 0;
  if (!(await has())) {
    // By its SHA, which galley's pins keep: its branch may be at other work by now, its name used again.
    const { args, env } = toGalley(checkout.gitUrl);
    const r = await run(checkout, [...args, 'fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', checkout.gitUrl, head], env);
    if (r.code !== 0 || !(await has())) throw new CliError(`could not fetch ${head.slice(0, 7)} from galley at ${checkout.gitUrl}: ${lastLine(r.stderr) || `git exited with ${r.code}`}${sandboxed()}`);
  }
  if (detach) return null;
  const local = (await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).stdout.trim();
  if (!local) {
    const made = await run(checkout, ['branch', branch, head]);
    if (made.code !== 0) throw new CliError(made.stderr.trim());
    return null;
  }
  if (local === head || (await run(checkout, ['merge-base', '--is-ancestor', head, local])).code === 0) return null;
  return (await run(checkout, ['merge-base', '--is-ancestor', local, head])).code === 0 ? 'behind' : 'differs';
}
