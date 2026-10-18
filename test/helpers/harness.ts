// What each end-to-end test file in test/e2e starts from: a repository whose origin is GitHub's
// acme/widgets, pushing to a bare repository beside it; stand-ins for gh, codex, claude and
// sandbox-exec or bwrap; and a galley server for them. Each file calls startHarness() and gets its
// own: node runs test files in parallel, and the tests within a file one after another.
import './env.ts';
import { assertLeftAsFound, fakes } from './fakes.ts';
import { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../../src/server/server.ts';

export const BIN = join(import.meta.dirname, '..', '..', 'bin', 'galley.ts');

/** Whether /tmp is writable here: not in a reviewer agent's sandbox. */
export function slashTmpWritable(): boolean {
  try {
    rmSync(mkdtempSync('/tmp/lx-'), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export const exec = promisify(execFile);

export let dir: string;
export let repo: string;
export let remote: string;
export let server: Awaited<ReturnType<typeof startServer>>;
/** The FAKE_* variables every test starts with. */
let startingFakes: Record<string, string>;

// Keep the user's git config out of the test, and use settings that change diff output,
// which the server must override.
// The reviewer signs with an SSH key, like a user with commit.gpgsign = true; agents commit unsigned.
// Nothing reaches GitHub: the server's fetches from the github.com remotes fail at once on a proxy
// that is not there, as from a remote it can not reach (pushes go to local bare repositories). The
// server allows https whatever the config says, so it can not be turned off that way.
const configDir = mkdtempSync(join(tmpdir(), 'galley-gitconfig-'));
const gitconfig = join(configDir, 'config');
const signingKey = join(configDir, 'id_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'reviewer', '-f', signingKey]);
writeFileSync(
  gitconfig,
  '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tinterHunkContext = 10\n[log]\n\tshowSignature = true\n' +
    `[user]\n\tname = Reviewer\n\temail = reviewer@example.com\n\tsigningkey = ${signingKey}\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n` +
    '[http]\n\tproxy = http://127.0.0.1:1\n',
);
delete process.env.NO_PROXY;
delete process.env.no_proxy;
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

export function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/**
 * The worktrees of the repository that are review checkouts of the test's server: galley-review-*
 * in the temporary directory. A reviewer agent that runs this suite runs it in a galley-review-*
 * of its own, with the temporary directory in it, so the repository's own path may have the name.
 */
export function reviewCheckouts(): string[] {
  const made = join(realpathSync(tmpdir()), 'galley-review-');
  return git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith(`worktree ${made}`));
}

/** A commit on top of `parent` whose short SHA is all digits, as about one commit in 27 has by chance. */
export function digitCommit(parent: string): string {
  const tree = git('rev-parse', `${parent}^{tree}`);
  for (let i = 0; ; i++) {
    const body = `tree ${tree}\nparent ${parent}\nauthor Dev <dev@example.com> 1700000000 +0000\ncommitter Dev <dev@example.com> 1700000000 +0000\n\nDigits ${i}\n`;
    const sha = createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    if (!/^[1-9]\d{6}/.test(sha)) continue;
    assert.equal(execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: body, encoding: 'utf8' }).trim(), sha);
    return sha;
  }
}

export async function cli(args: string[], opts: { input?: string; actor?: string; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = execFile(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: opts.actor ?? 'agent', NO_COLOR: '1' },
  });
  if (opts.input !== undefined) child.stdin!.end(opts.input);
  else child.stdin!.end();
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  return { stdout, stderr, code };
}

/**
 * The wait that says the reviewer agents are done with the head, so the author asks the reviewer
 * to review it. It comes once per commit, before a wait that waits for the reviewer.
 */
export async function handedOver(n?: number, opts: { actor?: string } = {}): Promise<string> {
  const r = await cli(['pr', 'wait', ...(n === undefined ? [] : [String(n)]), '--timeout', '20s'], opts);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /; ask the user to review it: /);
  return r.stdout;
}

/** Requests without an actor header act as the human reviewer, like the web UI. */
export async function human(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(server.url + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** The file's repository with its remote, the fakes, and the server. */
async function setUp(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'));
  remote = join(dir, 'remote.git');
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  // Pushes go to the local bare repository; the fetch URL still says GitHub.
  git('config', `url.${remote}.pushInsteadOf`, 'https://github.com/acme/widgets.git');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  git('push', '-q', 'origin', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
  git('commit', '-qam', 'Add mul', '-m', 'Multiplication.');

  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    // FAKE_GH_FAIL makes `gh pr ...` fail with its value as the error, FAKE_GH_API_FAIL `gh api ...`. A file gh-merge-fail makes
    // the next `gh pr merge` fail with its contents. `gh pr view` answers FAKE_GH_VIEW, or an open pull request. With
    // FAKE_GH_GATE, `gh pr create` answers once that file exists, with FAKE_GH_EDIT_GATE, `gh pr edit`, and with
    // FAKE_GH_FOLLOW_GATE, following's question about published pull requests, which creates <that file>.asked when asked.
    // The repository allows auto-merge and squash merges unless FAKE_GH_AUTO_MERGE or FAKE_GH_SQUASH is false. What GitHub
    // says about published pull requests comes from gh-pulls.json (see githubSays), an earlier page of their review threads
    // from gh-pulls-earlier.json. With FAKE_GH_NO_READ_ORG, GitHub refuses to name requested teams, as for a token without read:org.
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\ncat >> "${join(dir, 'gh-stdin.log')}"\nif [ -n "$FAKE_GH_GATE" ] && [ "$1 $2" = "pr create" ]; then while [ ! -f "$FAKE_GH_GATE" ]; do sleep 0.05; done; fi\nif [ -n "$FAKE_GH_EDIT_GATE" ] && [ "$1 $2" = "pr edit" ]; then while [ ! -f "$FAKE_GH_EDIT_GATE" ]; do sleep 0.05; done; fi\nif [ -n "$FAKE_GH_FOLLOW_GATE" ] && [ "$1 $2" = "api graphql" ]; then case "$4" in *"pullRequest("*) touch "$FAKE_GH_FOLLOW_GATE.asked"; while [ ! -f "$FAKE_GH_FOLLOW_GATE" ]; do sleep 0.05; done ;; esac; fi\nif [ -n "$FAKE_GH_FAIL" ] && [ "$1" = pr ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\nif [ -n "$FAKE_GH_API_FAIL" ] && [ "$1" = api ]; then echo "$FAKE_GH_API_FAIL" >&2; exit 1; fi\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/widgets/pull/7" ;;\n` +
      `  "pr merge") if [ -f "${join(dir, 'gh-merge-fail')}" ]; then cat "${join(dir, 'gh-merge-fail')}" >&2; rm "${join(dir, 'gh-merge-fail')}"; exit 1; fi ;;\n` +
      `  "pr view") if [ -n "$FAKE_GH_VIEW" ]; then echo "$FAKE_GH_VIEW"; else echo '{"state":"OPEN"}'; fi ;;\n` +
      `  "api graphql") case "$4" in\n    *issueOrPullRequest*) echo '{"data":{"repository":{"i12":{"__typename":"Issue","title":"Widgets wobble","state":"OPEN","stateReason":null}}}}' ;;\n    *before:*) cat "${join(dir, 'gh-pulls-earlier.json')}" ;;\n    *"pullRequest("*) case "$4" in *combinedSlug*) if [ -n "$FAKE_GH_NO_READ_ORG" ]; then echo '{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]}'; echo 'gh: Your token has not been granted the required scopes to execute this query.' >&2; exit 1; fi ;; esac; cat "${join(dir, 'gh-pulls.json')}" 2>/dev/null || echo '{"data":{"repository":{}}}' ;;\n    *) printf '{"data":{"repository":{"autoMergeAllowed":%s,"squashMergeAllowed":%s,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}}}\\n' "\${FAKE_GH_AUTO_MERGE:-true}" "\${FAKE_GH_SQUASH:-true}" ;;\n  esac ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);

  // A stand-in for the Codex CLI: a model catalog, `sandbox` standing in for the package manager
  // it runs (failing with FAKE_INSTALL_FAIL), and `exec` answering with FAKE_CODEX_REVIEW (or
  // failing, with FAKE_CODEX_FAIL), after FAKE_CODEX_SLEEP milliseconds or once the file
  // FAKE_CODEX_GATE exists. Where it may run the
  // tests, it leaves a read-only directory behind, as Go's module cache does. With --json it
  // prints what it does as `codex exec --json` does: it thinks, says something, reads math.js and
  // starts a git diff before it waits, and the diff ends when it answers. FAKE_CODEX_BIG makes the
  // read print 100 kB.
  const codex = join(dir, 'codex');
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log');
  process.env.FAKE_CODEX_SANDBOX_LOG = join(dir, 'codex-sandbox.log');
  writeFileSync(
    codex,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-test', display_name: 'GPT Test', description: 'For tests', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low', visibility: 'list' },
    { slug: 'internal', visibility: 'hide' },
  ] }));
  process.exit(0);
}
if (args[0] === 'sandbox') {
  fs.appendFileSync(process.env.FAKE_CODEX_SANDBOX_LOG, JSON.stringify({ args, cwd: process.cwd(), store: process.env.npm_config_store_dir }) + '\\n');
  if (process.env.FAKE_INSTALL_FAIL) { console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1); }
  console.log('Packages: +3\\nDone in 1s');
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, sawFile: fs.existsSync('codex.js'), tmpdir: process.env.TMPDIR, npmCache: process.env.npm_config_cache }) + '\\n');
if (args.includes('workspace-write')) {
  fs.mkdirSync('.cache/mod', { recursive: true });
  fs.chmodSync('.cache/mod', 0o555);
  fs.chmodSync('.cache', 0o555);
}
const say = (e) => args.includes('--json') && console.log(JSON.stringify(e));
const command = (id, cmd, status, output, exit_code) => say({ type: status === 'in_progress' ? 'item.started' : 'item.completed', item: { id, type: 'command_execution', command: cmd, aggregated_output: output, exit_code, status } });
say({ type: 'thread.started', thread_id: 'thread-1' });
say({ type: 'turn.started' });
say({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the change**' } });
say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I will read math.js and the diff.' } });
const read = "/bin/zsh -lc \\"sed -n '2,20p' math.js\\"";
command('item_2', read, 'in_progress', '', null);
command('item_2', read, 'completed', process.env.FAKE_CODEX_BIG ? 'a'.repeat(50000) + 'x'.repeat(50000) : fs.readFileSync('math.js', 'utf8'), 0);
command('item_3', "/bin/zsh -lc 'git diff HEAD~1 HEAD'", 'in_progress', '', null);
const answer = () => {
  if (process.env.FAKE_CODEX_FAIL) { console.error('model overloaded'); process.exit(3); }
  command('item_3', "/bin/zsh -lc 'git diff HEAD~1 HEAD'", 'completed', '+export const answer = 41;\\n', 0);
  say({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: process.env.FAKE_CODEX_REVIEW } });
  say({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100 } });
  fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_CODEX_REVIEW);
};
const gate = process.env.FAKE_CODEX_GATE;
if (gate) {
  const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20);
} else setTimeout(answer, Number(process.env.FAKE_CODEX_SLEEP || 0));
`,
  );
  chmodSync(codex, 0o755);

  // A stand-in for Claude Code: `claude -p` answering with FAKE_CLAUDE_REVIEW and what the run
  // cost, after FAKE_CLAUDE_SLEEP milliseconds or once the file FAKE_CLAUDE_GATE exists; with
  // FAKE_CLAUDE_FAIL, the error result Claude Code gives. Every server the tests start uses it. As
  // `--output-format stream-json` does, it prints its messages first: it reads math.js (by its
  // full path) and says something before it waits, and gives its answer with StructuredOutput.
  const claude = join(dir, 'claude');
  process.env.GALLEY_CLAUDE = claude;
  process.env.FAKE_CLAUDE_LOG = join(dir, 'claude.log');
  writeFileSync(
    claude,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== '-p') process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
const env = process.env;
fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), sawFile: fs.existsSync('claude.js'), tmpdir: env.TMPDIR, claudeTmpdir: env.CLAUDE_CODE_TMPDIR, claudeTmpdirExists: fs.existsSync(env.CLAUDE_CODE_TMPDIR), session: env.CLAUDECODE ?? env.CLAUDE_CODE_SESSION_ID ?? null }) + '\\n');
// As a test run can (Go's module cache): a read-only directory with a file in it.
fs.mkdirSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache', { recursive: true });
fs.writeFileSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache/file', 'x');
fs.chmodSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache', 0o555);
fs.chmodSync(env.CLAUDE_CODE_TMPDIR + '/mod', 0o555);
const say = (e) => console.log(JSON.stringify({ ...e, parent_tool_use_id: null, session_id: 'session-1' }));
const usage = (output_tokens) => ({ input_tokens: 2, cache_creation_input_tokens: 7000, cache_read_input_tokens: 0, output_tokens });
say({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput'], model: 'claude-haiku-5-5' });
say({ type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: process.cwd() + '/math.js', offset: 2 } }], usage: usage(20) } });
say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '2\\t  return a + b;' }] } });
say({ type: 'assistant', message: { id: 'msg_2', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'The answer is off by one.' }], usage: usage(10) } });
if (env.FAKE_CLAUDE_FAIL) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded', num_turns: 2, total_cost_usd: 0.004, usage: { input_tokens: 5, output_tokens: 300 } }));
  process.exit(1);
}
const answer = () => console.log(
  JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_3', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'StructuredOutput', input: JSON.parse(env.FAKE_CLAUDE_REVIEW) }], usage: usage(200) } }) + '\\n' +
  JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Structured output provided successfully' }] } }) + '\\n' +
  JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 7, duration_ms: 4200, total_cost_usd: 0.0123,
  usage: { input_tokens: 12, cache_creation_input_tokens: 15000, cache_read_input_tokens: 30000, output_tokens: 2100 },
  modelUsage: { 'claude-haiku-5-5': { costUSD: 0.0123 } },
  structured_output: JSON.parse(env.FAKE_CLAUDE_REVIEW),
}));
const gate = env.FAKE_CLAUDE_GATE;
if (gate) {
  const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20);
} else setTimeout(answer, Number(env.FAKE_CLAUDE_SLEEP || 0));
`,
  );
  chmodSync(claude, 0o755);
  // A stand-in for sandbox-exec or bwrap, which install dependencies for Claude: it logs and runs nothing.
  const sandboxExec = join(dir, 'sandbox-exec');
  process.env.FAKE_SANDBOX_LOG = join(dir, 'sandbox-exec.log');
  writeFileSync(
    sandboxExec,
    `#!${process.execPath}
require('fs').appendFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), store: process.env.npm_config_store_dir }) + '\\n');
console.log('Packages: +1\\nDone in 1s');
`,
  );
  chmodSync(sandboxExec, 0o755);
  // Tests ask GitHub and fetch base branches themselves (followGithub, page loads, publishing), so its
  // timer does not run in between; it has a test of its own.
  server = await startServer({ port: 0, dataDir: join(dir, 'data'), ghBin: gh, codexBin: codex, claudeBin: claude, sandboxExec, reviewersDir: join(dir, 'reviewers'), viewerLogin: 'reviewer', pollMs: 50, followMs: 60 * 60_000 });
  startingFakes = fakes();
}

/**
 * Sets up the file's repository, fakes and server before its tests, and removes them after. After
 * each test, checks that it left no review running and the fakes as it found them.
 */
export function startHarness(): void {
  before(setUp);

  // A test leaves no review running or about to start on the file's server, where it would answer
  // with the fakes of the tests after it, and leaves the fakes as it found them. Checked after each
  // test, not each step: a step may leave a review or a fake to the next.
  afterEach((t) => {
    if (t.fullName === t.name) assertLeftAsFound([server.service], startingFakes);
  });

  after(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
}

/**
 * A repository of its own, acme/<name> on GitHub (pushing to a bare repository), or with `github`
 * false local/<name> with no remote, where `stage` stages a branch with a commit of its own as the agent.
 */
export async function scratchRepo(name: string, { github = true } = {}) {
  const path = join(dir, name);
  const bare = join(dir, `${name}.git`);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = (...args: string[]) => execFileSync('git', ['-C', path, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', '.');
  g('commit', '-qm', 'Initial commit');
  if (github) {
    execFileSync('git', ['init', '-q', '--bare', bare]);
    g('remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    g('config', `url.${bare}.pushInsteadOf`, `https://github.com/acme/${name}.git`);
    g('push', '-q', 'origin', 'main');
    g('update-ref', 'refs/remotes/origin/main', 'main');
  }
  const { full_name } = await human('POST', '/api/repos', { path });
  const api = `/api/repos/${full_name}/pulls`;
  const stage = async (branch: string): Promise<{ id: number; number: number }> => {
    g('checkout', '-q', 'main');
    g('checkout', '-qb', branch);
    writeFileSync(join(path, `${branch}.js`), 'export {};\n');
    g('add', '.');
    g('commit', '-qm', `Add ${branch}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${branch}`, head: branch, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  return { fullName: full_name as string, api, stage, path, g };
}
