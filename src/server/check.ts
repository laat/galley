// `galley serve --check`: whether this machine has what the server needs, as far as galley can
// tell without changing anything: git, gh logged in with the workflow scope, a signing setup,
// Codex and Claude Code logged in for reviewer agents, and on Linux what their sandboxes need.
// It prints none of what the tools say, which can hold a token or part of one.
import { tmpdir } from 'node:os';
import { fromEnv } from '../config.ts';
import { run, type RunResult } from './git.ts';
import { sandboxed } from './reviewers/sandbox.ts';

export interface Check {
  ok: boolean;
  /** galley runs without it, and leaves out what needs it: signing, or reviewer agents. */
  optional?: boolean;
  text: string;
}

/** The programs to check; tests give stand-ins. */
export interface CheckOptions {
  gh?: string;
  codex?: string;
  claude?: string;
  bwrap?: string;
  socat?: string;
  platform?: NodeJS.Platform;
}

/** What `bin args` did, in a directory of no repository; or why it did not run: not there, say. */
async function ran(bin: string, args: string[]): Promise<RunResult | string> {
  try {
    return await run(bin, args, { allowFail: true, timeoutMs: 30_000, cwd: tmpdir() });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? `${bin} not found` : `could not run ${bin} (${code ?? 'failed to start'})`;
  }
}

async function git(): Promise<Check> {
  const r = await ran('git', ['--version']);
  const version = typeof r === 'string' ? null : r.stdout.match(/(\d+)\.(\d+)\S*/);
  if (!version) return { ok: false, text: `${typeof r === 'string' ? r : 'git did not say its version'}: galley needs git 2.38 or newer` };
  const ok = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 38);
  return { ok, text: ok ? `git ${version[0]}` : `git ${version[0]}: galley needs 2.38 or newer` };
}

/** gh's login to github.com, which galley fetches and publishes with: its JSON has the login and scopes, not the token. */
async function gh(bin: string): Promise<Check> {
  const login = '`gh auth login -s workflow`';
  const r = await ran(bin, ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts']);
  if (typeof r === 'string') return { ok: false, text: `${r}: install gh, and run ${login}` };
  let account: { state?: string; login?: string; scopes?: string } | undefined;
  try {
    account = JSON.parse(r.stdout).hosts?.['github.com']?.[0];
  } catch {
    return { ok: false, text: `gh did not say whether it is logged in (\`gh auth status --json hosts\`): update gh, or check \`gh auth status\` yourself` };
  }
  if (!account) return { ok: false, text: `gh is not logged in to github.com: run ${login}` };
  if (account.state !== 'success') return { ok: false, text: `gh's login to github.com as ${account.login} does not work: run ${login}` };
  const scopes = (account.scopes ?? '').split(',').map((s) => s.trim());
  // A token without scopes (a fine-grained one, or GH_TOKEN) says none; GitHub decides then.
  if (account.scopes && !scopes.includes('workflow')) {
    return { ok: false, text: `gh is logged in to github.com as ${account.login}, without the workflow scope that publishing changes to GitHub Actions workflows needs: run \`gh auth refresh -s workflow\`` };
  }
  return { ok: true, text: `gh is logged in to github.com as ${account.login}${account.scopes ? ', with the workflow scope' : ''}` };
}

/**
 * The signing setup the server's clones get from the global git config: publishing signs as the
 * user when git signs their commits, and commits the signed copies with the user's name and email.
 */
async function signing(): Promise<Check> {
  const get = async (key: string, type?: string) => {
    const r = await ran('git', ['config', ...(type ? [`--type=${type}`] : []), '--get', key]);
    return typeof r === 'string' ? '' : r.stdout.trim();
  };
  const [sign, format, key, name, email] = await Promise.all([get('commit.gpgsign', 'bool'), get('gpg.format'), get('user.signingkey'), get('user.name'), get('user.email')]);
  const kind = format || 'openpgp';
  const no = (text: string): Check => ({ ok: false, optional: true, text });
  if (sign !== 'true') return no('git does not sign commits (commit.gpgsign): galley publishes them unsigned unless you set up signing in the global git config');
  if (!key && kind !== 'openpgp') return no(`git signs commits with ${kind}, but user.signingkey is not set`);
  if (!name || !email) return no('git signs commits, but user.name and user.email must be set too: the signed copies are committed as you');
  return { ok: true, text: `git signs commits with ${kind}${key ? ' (user.signingkey)' : ''}, a key GitHub must have as your signing key` };
}

/** Codex's login, by `codex login status`'s exit status only: it prints part of an API key. */
async function codex(bin: string): Promise<Check> {
  const r = await ran(bin, ['login', 'status']);
  if (typeof r === 'string') return { ok: false, optional: true, text: `${r}: Codex reviewer agents need it` };
  return r.code === 0 ? { ok: true, text: 'codex is logged in' } : { ok: false, optional: true, text: 'codex is not logged in: run `codex login`' };
}

async function claude(bin: string): Promise<Check> {
  const r = await ran(bin, ['auth', 'status', '--json']);
  if (typeof r === 'string') return { ok: false, optional: true, text: `${r}: Claude reviewer agents need it` };
  let loggedIn: unknown;
  try {
    loggedIn = JSON.parse(r.stdout).loggedIn;
  } catch {
    return { ok: false, optional: true, text: 'claude did not say whether it is logged in (`claude auth status`): update Claude Code' };
  }
  return loggedIn === true ? { ok: true, text: 'claude is logged in' } : { ok: false, optional: true, text: 'claude is not logged in: run `claude auth login`' };
}

/** On Linux: bwrap for installs and for Codex's and Claude Code's sandboxes, and socat for Claude Code's proxy. */
async function linux(o: CheckOptions): Promise<Check[]> {
  // As galley's installs try one (noSandbox), saying only whether it worked.
  const s = sandboxed(['true'], { writable: [], readOnly: [] }, o.bwrap, 'linux')!;
  const bwrap = await ran(s.bin, s.args);
  const socat = await ran(o.socat ?? 'socat', ['-V']);
  return [
    typeof bwrap === 'string'
      ? { ok: false, optional: true, text: `${bwrap}: install bubblewrap, which reviewer agents' sandboxes need` }
      : bwrap.code === 0
        ? { ok: true, text: 'bwrap can make a sandbox' }
        : { ok: false, optional: true, text: `${s.bin} could not make a sandbox: it needs unprivileged user namespaces, which Ubuntu 23.10 and later restrict with AppArmor. \`${s.bin} --ro-bind / / true\` says why` },
    typeof socat === 'string' ? { ok: false, optional: true, text: `${socat}: install it, Claude Code's sandbox needs it` } : { ok: true, text: 'socat is installed' },
  ];
}

export async function check(o: CheckOptions = {}): Promise<Check[]> {
  return [
    await git(),
    await gh(o.gh ?? fromEnv('GH') ?? 'gh'),
    await signing(),
    await codex(o.codex ?? fromEnv('CODEX') ?? 'codex'),
    await claude(o.claude ?? fromEnv('CLAUDE') ?? 'claude'),
    ...((o.platform ?? process.platform) === 'linux' ? await linux(o) : []),
  ];
}
