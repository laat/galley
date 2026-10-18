// galley serve --check: what this machine has of what the server needs, from stand-ins for gh,
// codex, claude, bwrap and socat, and a global git config of the test's own.
import './helpers/env.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { check, type CheckOptions } from '../src/server/check.ts';

const dir = mkdtempSync(join(tmpdir(), 'galley-check-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in program that runs `script` in sh. */
function bin(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The global git config, for the signing setup. */
function gitconfig(text: string): void {
  const path = join(dir, `gitconfig-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, text);
  process.env.GIT_CONFIG_GLOBAL = path;
}
const you = '[user]\n\tname = Octo Cat\n\temail = octocat@example.com\n';
const signed = `${you}[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ~/.ssh/signing.pub\n`;

const ghSays = (account: object | null) => bin(`gh-${Math.random().toString(36).slice(2)}`, `cat <<'EOF'\n${JSON.stringify({ hosts: account ? { 'github.com': [account] } : {} })}\nEOF`);
const good: CheckOptions = {
  gh: ghSays({ state: 'success', active: true, host: 'github.com', login: 'octocat', tokenSource: 'keyring', scopes: 'gist, read:org, repo, workflow', gitProtocol: 'https', token: 'gho_SECRET' }),
  // What codex prints for a login with an API key holds part of the key.
  codex: bin('codex', 'echo "Logged in using an API key - sk-proj-***SECRET" >&2'),
  claude: bin('claude', `echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "octocat@example.com"}'`),
  platform: 'darwin',
};
const missing = join(dir, 'missing');

/** As serve --check prints them: ! for what galley runs without. */
const texts = async (o: CheckOptions) => (await check(o)).map((c) => `${c.ok ? '✓' : c.optional ? '!' : '✗'} ${c.text}`);

test('says what this machine has, and prints nothing of what the tools say', async () => {
  gitconfig(signed);
  const [git, ...rest] = await texts(good);
  assert.match(git, /^✓ git \d+\.\d+/);
  assert.deepEqual(rest, [
    '✓ gh is logged in to github.com as octocat, with the workflow scope',
    '✓ git signs commits with ssh (user.signingkey), a key GitHub must have as your signing key',
    '✓ codex is logged in',
    '✓ claude is logged in',
  ]);
  // Run as galley serve --check, which starts no server: without a reviewer agent's tool, it passes; without gh's login, it fails.
  const cli = (env: NodeJS.ProcessEnv) =>
    promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), 'serve', '--check'], { env: { ...process.env, GALLEY_GH: good.gh, GALLEY_CODEX: good.codex, ...env } }).then(
      (r) => ({ ...r, code: 0 }),
      (e) => e,
    );
  const without = await cli({ GALLEY_CLAUDE: missing });
  assert.equal(without.code, 0, without.stderr);
  assert.match(without.stdout, /^✓ gh is logged in to github\.com as octocat, with the workflow scope$/m);
  assert.match(without.stdout, /^✓ codex is logged in$/m);
  assert.match(without.stdout, new RegExp(`^! ${missing} not found: Claude reviewer agents need it$`, 'm'));
  const out = await cli({ GALLEY_GH: ghSays(null), GALLEY_CLAUDE: good.claude });
  assert.equal(out.code, 1);
  assert.match(out.stdout, /^✗ gh is not logged in to github\.com: run `gh auth login -s workflow`$/m);
  for (const r of [without, out]) assert.doesNotMatch(r.stdout + r.stderr, /SECRET|octocat@example\.com|galley is serving/);
});

test('says what is missing, and what to do about it', async () => {
  gitconfig(you);
  const said = async (o: Partial<CheckOptions>) => (await texts({ ...good, ...o })).slice(1);
  assert.deepEqual(await said({}), [
    '✓ gh is logged in to github.com as octocat, with the workflow scope',
    '! git does not sign commits (commit.gpgsign): galley publishes them unsigned unless you set up signing in the global git config',
    '✓ codex is logged in',
    '✓ claude is logged in',
  ]);
  gitconfig(`${you}[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n`);
  assert.equal((await said({}))[1], '! git signs commits with ssh, but user.signingkey is not set');
  // gpg finds its key by the committer's email.
  gitconfig(`${you}[commit]\n\tgpgsign = true\n`);
  assert.equal((await said({}))[1], '✓ git signs commits with openpgp, a key GitHub must have as your signing key');
  // The signed copies are committed by the user, which signing can not do without a name and email.
  gitconfig('[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ~/.ssh/signing.pub\n');
  assert.equal((await said({}))[1], '! git signs commits, but user.name and user.email must be set too: the signed copies are committed as you');

  const gh = async (program: string) => (await said({ gh: program }))[0];
  assert.equal(await gh(ghSays({ state: 'success', login: 'octocat', scopes: 'gist, repo' })), '✗ gh is logged in to github.com as octocat, without the workflow scope that publishing changes to GitHub Actions workflows needs: run `gh auth refresh -s workflow`');
  // A token without scopes, as GH_TOKEN's fine-grained one: GitHub decides.
  assert.equal(await gh(ghSays({ state: 'success', login: 'octocat', scopes: '' })), '✓ gh is logged in to github.com as octocat');
  assert.equal(await gh(ghSays({ state: 'error', login: 'octocat', scopes: '' })), "✗ gh's login to github.com as octocat does not work: run `gh auth login -s workflow`");
  assert.equal(await gh(ghSays(null)), '✗ gh is not logged in to github.com: run `gh auth login -s workflow`');
  assert.equal(await gh(bin('old-gh', 'echo "unknown flag: --json" >&2; exit 1')), '✗ gh did not say whether it is logged in (`gh auth status --json hosts`): update gh, or check `gh auth status` yourself');
  assert.equal(await gh(missing), `✗ ${missing} not found: install gh, and run \`gh auth login -s workflow\``);
  // One that can not run, such as a file that is not executable: said, and the checks after it still are.
  const unrunnable = join(dir, 'not-executable');
  writeFileSync(unrunnable, '#!/bin/sh\n');
  const report = await said({ gh: unrunnable, claude: unrunnable });
  assert.equal(report[0], `✗ could not run ${unrunnable} (EACCES): install gh, and run \`gh auth login -s workflow\``);
  assert.equal(report[3], `! could not run ${unrunnable} (EACCES): Claude reviewer agents need it`);

  assert.equal((await said({ codex: bin('codex-out', 'echo "Not logged in" >&2; exit 1') }))[2], '! codex is not logged in: run `codex login`');
  assert.equal((await said({ codex: missing }))[2], `! ${missing} not found: Codex reviewer agents need it`);
  assert.equal((await said({ claude: bin('claude-out', `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`) }))[3], '! claude is not logged in: run `claude auth login`');
  assert.equal((await said({ claude: bin('claude-old', 'echo "Usage: claude"') }))[3], '! claude did not say whether it is logged in (`claude auth status`): update Claude Code');
});

test('on Linux, says whether bwrap can make a sandbox and whether socat is there', async () => {
  gitconfig(signed);
  const linux = async (o: Partial<CheckOptions>) => (await texts({ ...good, platform: 'linux', ...o })).slice(5);
  assert.deepEqual(await linux({ bwrap: bin('bwrap', 'exit 0'), socat: bin('socat', 'echo "socat version 1.8"') }), ['✓ bwrap can make a sandbox', '✓ socat is installed']);
  // What bwrap says is left to running it by hand.
  const denied = bin('bwrap-denied', 'echo "bwrap: PRIVATE_TOOL_OUTPUT" >&2; exit 1');
  assert.deepEqual(await linux({ bwrap: denied, socat: missing }), [
    `! ${denied} could not make a sandbox: it needs unprivileged user namespaces, which Ubuntu 23.10 and later restrict with AppArmor. \`${denied} --ro-bind / / true\` says why`,
    `! ${missing} not found: install it, Claude Code's sandbox needs it`,
  ]);
  assert.equal((await linux({ bwrap: missing, socat: bin('socat', 'exit 0') }))[0], `! ${missing} not found: install bubblewrap, which reviewer agents' sandboxes need`);
});
