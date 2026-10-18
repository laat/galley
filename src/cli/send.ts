// Sending the author's branch to galley's clone of the repository (Service.registerGithub), and
// fetching back what galley fetched from GitHub, with git over HTTP at the clone's git URL
// (git-http.ts), from a checkout of the repository. Nothing for one registered by path before
// galley kept clones, which galley could not move into one (Service.migrateRepos).
//
// The CLI keeps a remote called galley in the checkout, at that URL (galleyRemote), and fetches
// back into its remote-tracking branches, galley/<branch>, leaving origin as the checkout last
// fetched it from GitHub. A staged branch's plain `git push` goes there (setPushRemote). The CLI
// itself sends and fetches by the URL, with git's settings for galley (toGalley), not the remote's.
//
// Only the pull request's author sends, as an agent (cliActor): a person at a terminal reviews, and
// may have the branch at something else. It sends a fast-forward of what galley has, or a rewrite
// of a commit galley has that the branch here had, with a lease on it (receive-hook.ts): never
// over commits the branch here never had, such as another checkout's on a branch of the same name,
// even once they are fetched.
import { execFile } from 'node:child_process';
import { cliActor } from '../config.ts';
import { ApiError, CliError, currentBranch, isGalleyGitUrl, noProxyFromEnv, repoPath, sandboxed, type Checkout, type Client, type RepoRef } from './client.ts';
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

/** The checkout this command registered, when it is `repo`'s and galley has a clone of it; null otherwise. */
async function cloneCheckout(client: Client, cwd: string, repo: RepoRef): Promise<CloneCheckout | null> {
  const checkout = await client.registered(cwd);
  if (!checkout?.gitUrl) return null;
  const same = checkout.owner.toLowerCase() === repo.owner.toLowerCase() && checkout.name.toLowerCase() === repo.name.toLowerCase();
  if (!same) return null;
  await galleyRemote(checkout as CloneCheckout);
  return checkout as CloneCheckout;
}

/** The remote the CLI keeps for galley in the checkout (galleyRemote). */
const REMOTE = 'galley';

/**
 * What `git fetch galley` fetches: what galley fetched from GitHub, which its clone keeps in
 * refs/remotes/origin/ (the bases, and a branch after a push GitHub refused), into galley/<branch>,
 * where `pr wait` fetches it and tells the author to rebase onto it (fetchBack). Not the branches
 * sent to galley, its refs/heads/: the agents' own, which would clash here with GitHub's of the
 * same name, such as a branch's after a push GitHub refused. Nor origin/HEAD, which would be a
 * branch here.
 */
const FETCH = [`+refs/remotes/origin/*:refs/remotes/${REMOTE}/*`, '^refs/remotes/origin/HEAD'];

/**
 * How the checkout's remote called galley stands, once per command (keepRemote): galley's, at its
 * URL; the user's own, at another; or none, the checkout's git config could not be written.
 */
const remotes = new WeakMap<Checkout, Promise<'galley' | 'other' | 'none'>>();
function galleyRemote(checkout: CloneCheckout): Promise<'galley' | 'other' | 'none'> {
  let kept = remotes.get(checkout);
  if (!kept) remotes.set(checkout, (kept = keepRemote(checkout)));
  return kept;
}

/**
 * Keep the remote called galley in the checkout at galley's git URL as the CLI reaches it, so it
 * follows the server when it moves, and its push URL with it, should it have one; one added
 * fetches FETCH. One by that name with a URL or a push URL that is not galley's is the user's (git
 * pushes to each of them), and is left alone. That, or a git config that can not be written (as
 * from a sandbox), is said, and the CLI goes on by URL.
 */
async function keepRemote(checkout: CloneCheckout): Promise<'galley' | 'other' | 'none'> {
  const all = async (key: string) => (await run(checkout, ['config', '--get-all', key])).stdout.split('\n').filter(Boolean);
  const urls = await all(`remote.${REMOTE}.url`);
  const pushUrls = await all(`remote.${REMOTE}.pushurl`);
  const theirs = [...urls, ...pushUrls].find((u) => !isGalleyGitUrl(u));
  if (theirs) {
    err(`This checkout has a remote called ${REMOTE} at ${theirs}, which is not galley's. The CLI leaves it alone, and goes to galley by its URL, ${checkout.gitUrl}.`);
    return 'other';
  }
  if (urls.length === 1 && [...urls, ...pushUrls].every((u) => u === checkout.gitUrl)) return 'galley';
  const url = urls[0];
  const writes = [['config', '--replace-all', `remote.${REMOTE}.url`, checkout.gitUrl]];
  if (!url) writes.push(['config', '--replace-all', `remote.${REMOTE}.fetch`, FETCH[0]], ...FETCH.slice(1).map((spec) => ['config', '--add', `remote.${REMOTE}.fetch`, spec]));
  if (pushUrls.length) writes.push(['config', '--replace-all', `remote.${REMOTE}.pushurl`, checkout.gitUrl]);
  for (const args of writes) {
    const r = await run(checkout, args);
    if (r.code === 0) continue;
    err(
      `Could not ${url ? 'set' : 'add'} the remote ${REMOTE} at ${checkout.gitUrl} in this checkout: ${lastLine(r.stderr) || `git exited with ${r.code}`}. ` +
        `The CLI sends and fetches by that URL all the same, but a plain \`git push\` here does not go to galley.`,
    );
    return 'none';
  }
  return 'galley';
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

/** The settings of `branch` in the checkout's git config (branch.<name>.<setting>), read at once: a setting's value, or empty. */
async function branchSettings(checkout: Checkout, branch: string): Promise<(name: string) => string> {
  const prefix = `branch.${branch}.`;
  const r = await run(checkout, ['config', '-z', '--get-regexp', `^${prefix.replace(/[.*+?^${}()|[\]]/g, '\\$&')}[^.]+$`]);
  // Each `<key>\n<value>`, the key's section and name in lower case; a setting's last value wins.
  const settings = new Map(r.stdout.split('\0').filter(Boolean).map((entry) => [entry.split('\n')[0].slice(prefix.length), entry.slice(entry.indexOf('\n') + 1)]));
  return (name) => settings.get(name.toLowerCase()) ?? '';
}

/**
 * Write settings of `branch` to the checkout's git config in order, unsetting those with no value:
 * the first that could not be written, and why, or null when all were.
 */
async function writeSettings(checkout: Checkout, branch: string, settings: [name: string, value: string][]): Promise<{ key: string; value: string; why: string } | null> {
  for (const [name, value] of settings) {
    const key = `branch.${branch}.${name}`;
    const r = await run(checkout, value ? ['config', key, value] : ['config', '--unset', key]);
    // Exit code 5: there was none to unset.
    if (r.code !== 0 && (value || r.code !== 5)) return { key, value, why: lastLine(r.stderr) || `git exited with ${r.code}` };
  }
  return null;
}

/**
 * Where setPushRemote keeps a setting of the branch's from before it was staged, for
 * clearPushRemote to put back: its pushRemote, such as a fork the user pushes it to, and its remote
 * when it has no upstream's merge, which a first push with push.autoSetupRemote replaces with
 * galley. In the branch's section, which `git branch -D` removes with it.
 */
const before = (name: 'pushRemote' | 'remote') => `${name}BeforeGalley`;

/**
 * After `pr create` or `pr reopen`, and before the author's commands on an open pull request
 * (sendPull): point a plain `git push` of its branch at galley (branch.<name>.pushRemote), so that
 * one run by hand goes to galley, not GitHub. It runs the user's hooks and settings, unlike the
 * CLI's (sendBranch): galley takes a fast-forward from it, but refuses the whole push when it
 * brings a tag (push.followTags), and git-lfs's hook fails it; nothing goes to GitHub either way.
 * A rewrite needs the lease that only the CLI sends. Only for the agent, whose branches the CLI
 * sends. What the branch pushed to before is kept (before), and comes back when the pull request
 * is done with.
 */
export async function setPushRemote(client: Client, cwd: string, repo: RepoRef, branch: string): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout || !cliActor() || (await galleyRemote(checkout)) !== 'galley') return;
  const get = await branchSettings(checkout, branch);
  if (get('pushRemote') === REMOTE) return;
  if ((await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) return;
  const replaceable = get('remote') !== REMOTE && !get('merge');
  // Unset when there was none, so that one kept from an earlier pull request of the branch does not come back.
  const failed = await writeSettings(checkout, branch, [
    [before('pushRemote'), get('pushRemote')],
    [before('remote'), replaceable ? get('remote') : ''],
    ['pushRemote', REMOTE],
  ]);
  if (failed) err(`Could not point \`git push\` of ${branch} at galley in this checkout: ${failed.why}.`);
}

/**
 * After the pull request of `branch` was merged or closed: its plain `git push` goes where it went
 * before it was staged (before), unless an open pull request has the branch (its name used again).
 * An upstream on galley goes too: the one a first push set with push.autoSetupRemote. Only on
 * galley's remote, not one of the user's by that name, and only while the branch pushes to galley:
 * a pushRemote the user set since stays, and what was kept with it.
 */
export async function clearPushRemote(client: Client, cwd: string, repo: RepoRef, branch: string): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout || (await galleyRemote(checkout)) !== 'galley') return;
  const get = await branchSettings(checkout, branch);
  if (get('pushRemote') !== REMOTE) return;
  // Left as it is when galley does not say: the wait's news comes first.
  const open = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=open&head=${encodeURIComponent(branch)}&limit=1&fields=number`).catch(() => null);
  if (open?.length !== 0) return;
  // In this order, so that while pushRemote is galley, what was kept is still there: a cleanup at
  // the same time (`pr close` while `pr wait` hears of the close) puts back the same, and one cut
  // short by a failure is tried again by the next command.
  const upstream: [string, string][] = get('remote') === REMOTE ? [['remote', get(before('remote'))], ['merge', '']] : [];
  const failed = await writeSettings(checkout, branch, [...upstream, ['pushRemote', get(before('pushRemote'))], [before('pushRemote'), ''], [before('remote'), '']]);
  if (failed) err(`Could not ${failed.value ? `set ${failed.key} back to ${failed.value}` : `unset ${failed.key}`} in this checkout: ${failed.why}.`);
}

/**
 * Before `pr create --base`: send the base, a branch of this checkout's that galley does not have,
 * which is not on GitHub either as far as the checkout knows (it has no remote-tracking branch of
 * it): the branch of another pull request, not staged yet, that this one is stacked on. galley
 * fetches one that is on GitHub from there.
 */
export async function sendBase(client: Client, cwd: string, repo: RepoRef, base: string): Promise<void> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout || !cliActor()) return;
  const here = async (ref: string) => (await run(checkout, ['rev-parse', '--verify', '--quiet', ref])).code === 0;
  if (!(await here(`refs/heads/${base}`)) || (checkout.remote && (await here(`refs/remotes/${checkout.remote}/${base}`)))) return;
  if (await galleyCommit(client, repo, `refs/heads/${base}`)) return;
  await send(client, checkout, base, true);
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
  const pr = await client.get(`${repoPath(repo)}/gh/pulls/${number}?fields=author,headRefName,state`);
  if (pr.author.login !== actor.login) return;
  // The branch is the latest pull request's that has it: one done with before its name was used
  // again sends nothing to the other's.
  const named = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=all&head=${encodeURIComponent(pr.headRefName)}&limit=1000&fields=number`);
  if (Math.max(...named.map((p) => p.number)) !== number) return;
  await send(client, checkout, pr.headRefName, strict);
  // Also for one staged before the CLI kept the remote, or reopened.
  if (pr.state !== 'MERGED' && pr.state !== 'CLOSED') await setPushRemote(client, cwd, repo, pr.headRefName);
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
 * `sha`, into galley/<branch> here (FETCH), for the author to rebase onto, as it may not reach
 * GitHub from its sandbox: the base the head conflicts with, or the branch on GitHub after a push
 * GitHub refused. With `staged`, the base is a branch staged in galley (stacked pull requests):
 * galley's refs/heads/<branch>, also into galley/<branch>, never a local branch. One here that has
 * `sha` in it, fetched since, stays; one that is older, or another (rewritten), becomes galley's.
 * Says what it is called here, or null when it could not be fetched, or galley has no clone of
 * `repo`. When the user has a remote called galley of their own, what is GitHub's goes into the
 * remote-tracking branch of the remote that names GitHub's repository, and a staged base nowhere.
 */
export async function fetchBack(client: Client, cwd: string, repo: RepoRef, branch: string, sha: string, { staged = false } = {}): Promise<string | null> {
  const checkout = await cloneCheckout(client, cwd, repo);
  if (!checkout?.remote) return null;
  const theirs = (await galleyRemote(checkout)) === 'other';
  if (theirs && staged) {
    err(`Did not fetch ${branch} from galley: the remote called ${REMOTE} here is not galley's. Fetch it with \`git fetch ${checkout.gitUrl} ${branch}\`, and rebase onto FETCH_HEAD rather than your ${branch}.`);
    return null;
  }
  const local = `${theirs ? checkout.remote : REMOTE}/${branch}`;
  const here = (await run(checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/${local}`])).stdout.trim();
  if (here && (await run(checkout, ['merge-base', '--is-ancestor', sha, here])).code === 0) return local;
  const spec = `+refs/${staged ? 'heads' : 'remotes/origin'}/${branch}:refs/remotes/${local}`;
  const { args, env } = toGalley(checkout.gitUrl);
  const r = await run(checkout, [...args, 'fetch', '--no-tags', '--no-prune', '--no-write-fetch-head', '--recurse-submodules=no', checkout.gitUrl, spec], env);
  if (r.code === 0) return local;
  err(`Could not fetch ${branch} from galley into ${local}: ${lastLine(r.stderr) || `git exited with ${r.code}`}. Run \`git fetch ${checkout.gitUrl} ${spec}\` where it can write to the repository.`);
  return null;
}

/**
 * Whether the checkout has `branch`, when galley has a clone of `repo`: galley keeps the branches
 * sent to it, so whether one is gone is the checkout's to say. Null otherwise.
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
