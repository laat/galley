// The whole loop: an agent stages a pull request with the CLI, a reviewer comments
// through the API (as the web UI does), the agent rewrites history, and the reviewer publishes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createServer, type AddressInfo } from 'node:net';
import { startServer } from '../src/server/server.ts';
import { Db, now } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';
import { CodexReviewer } from '../src/server/reviewers/codex.ts';
import { Repo } from '../src/server/git.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'laatsux.ts');
const exec = promisify(execFile);

let dir: string;
let repo: string;
let remote: string;
let server: Awaited<ReturnType<typeof startServer>>;

// Keep the user's git config out of the test, and use settings that change diff output,
// which the server must override.
// The reviewer signs with an SSH key, like a user with commit.gpgsign = true; agents commit unsigned.
const configDir = mkdtempSync(join(tmpdir(), 'laatsux-gitconfig-'));
const gitconfig = join(configDir, 'config');
const signingKey = join(configDir, 'id_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'reviewer', '-f', signingKey]);
writeFileSync(
  gitconfig,
  '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tinterHunkContext = 10\n[log]\n\tshowSignature = true\n' +
    `[user]\n\tname = Reviewer\n\temail = reviewer@example.com\n\tsigningkey = ${signingKey}\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n`,
);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A commit on top of `parent` whose short SHA is all digits, as about one commit in 27 has by chance. */
function digitCommit(parent: string): string {
  const tree = git('rev-parse', `${parent}^{tree}`);
  for (let i = 0; ; i++) {
    const body = `tree ${tree}\nparent ${parent}\nauthor Dev <dev@example.com> 1700000000 +0000\ncommitter Dev <dev@example.com> 1700000000 +0000\n\nDigits ${i}\n`;
    const sha = createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    if (!/^[1-9]\d{6}/.test(sha)) continue;
    assert.equal(execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: body, encoding: 'utf8' }).trim(), sha);
    return sha;
  }
}

async function cli(args: string[], opts: { input?: string; actor?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = execFile(process.execPath, [BIN, ...args], {
    cwd: repo,
    env: { ...process.env, LAATSUX_URL: server.url, LAATSUX_ACTOR: opts.actor ?? 'agent', NO_COLOR: '1' },
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

/** Requests without an actor header act as the human reviewer, like the web UI. */
async function human(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(server.url + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'laatsux-test-'));
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
    // the next `gh pr merge` fail with its contents. `gh pr view` answers FAKE_GH_VIEW, or an open pull request.
    // The repository allows auto-merge and squash merges unless FAKE_GH_AUTO_MERGE or FAKE_GH_SQUASH is false.
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\ncat >> "${join(dir, 'gh-stdin.log')}"\nif [ -n "$FAKE_GH_FAIL" ] && [ "$1" = pr ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\nif [ -n "$FAKE_GH_API_FAIL" ] && [ "$1" = api ]; then echo "$FAKE_GH_API_FAIL" >&2; exit 1; fi\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/widgets/pull/7" ;;\n` +
      `  "pr merge") if [ -f "${join(dir, 'gh-merge-fail')}" ]; then cat "${join(dir, 'gh-merge-fail')}" >&2; rm "${join(dir, 'gh-merge-fail')}"; exit 1; fi ;;\n` +
      `  "pr view") if [ -n "$FAKE_GH_VIEW" ]; then echo "$FAKE_GH_VIEW"; else echo '{"state":"OPEN"}'; fi ;;\n` +
      `  "api graphql") case "$4" in\n    *issueOrPullRequest*) echo '{"data":{"repository":{"i12":{"__typename":"Issue","title":"Widgets wobble","state":"OPEN","stateReason":null}}}}' ;;\n    *) printf '{"data":{"repository":{"issues":{"totalCount":4},"pullRequests":{"totalCount":2},"autoMergeAllowed":%s,"squashMergeAllowed":%s,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}}}\\n' "\${FAKE_GH_AUTO_MERGE:-true}" "\${FAKE_GH_SQUASH:-true}" ;;\n  esac ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);

  // A stand-in for the Codex CLI: a model catalog, `sandbox` standing in for the package manager
  // it runs (failing with FAKE_INSTALL_FAIL), and `exec` answering with FAKE_CODEX_REVIEW, after
  // FAKE_CODEX_SLEEP milliseconds or once the file FAKE_CODEX_GATE exists. Where it may run the
  // tests, it leaves a read-only directory behind, as Go's module cache does.
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
if (process.env.FAKE_CODEX_FAIL) { console.error('model overloaded'); process.exit(3); }
const answer = () => fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_CODEX_REVIEW);
const gate = process.env.FAKE_CODEX_GATE;
if (gate) {
  const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20);
} else setTimeout(answer, Number(process.env.FAKE_CODEX_SLEEP || 0));
`,
  );
  chmodSync(codex, 0o755);
  server = await startServer({ port: 0, dataDir: join(dir, 'data'), ghBin: gh, codexBin: codex, viewerLogin: 'reviewer', pollMs: 50 });
});

after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('the agent loop, from staging to publishing', async (t) => {
  await t.test('pr create stages the current branch', async () => {
    const r = await cli(['pr', 'create', '--title', 'Add multiplication', '--body-file', '-'], { input: 'Adds `mul`.' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${server.url}/acme/widgets/pull/1`);
    const again = await cli(['pr', 'create', '--fill']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);
  });

  await t.test('pr create without a title fails like gh does when not interactive', async () => {
    const r = await cli(['pr', 'create']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must provide `--title`/);
  });

  await t.test('pr view --json and --jq', async () => {
    const r = await cli(['pr', 'view', '--json', 'number,title,state,author,headRefName,isDraft']);
    assert.deepEqual(JSON.parse(r.stdout), { number: 1, title: 'Add multiplication', state: 'OPEN', author: { login: 'agent', is_bot: true }, headRefName: 'feature/mul', isDraft: false });
    const jq = await cli(['pr', 'view', '1', '--json', 'commits', '--jq', '.commits[].messageHeadline']);
    assert.equal(jq.code, 0, jq.stderr);
    assert.equal(jq.stdout.trim(), 'Add mul');
    const list = await cli(['pr', 'list']);
    assert.match(list.stdout, /^1\tAdd multiplication\tfeature\/mul\tOPEN\t/);
  });

  await t.test('pr wait returns the review the reviewer submits', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    // Wait until the server sees the agent waiting, as the UI would show it.
    for (let i = 0; i < 100; i++) {
      const pr = await human('GET', '/api/repos/acme/widgets/pulls/1');
      if (pr.author_waiting) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', {
      event: 'REQUEST_CHANGES',
      body: 'Almost.',
      comments: [{ path: 'math.js', line: 6, side: 'RIGHT', body: 'Add a doc comment.', priority: 'high' }],
    });
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /reviewer reviewed: changes requested/);
    assert.match(r.stdout, /thread \d+ on math\.js:6 \[unresolved\] \(high priority\)/);
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/1/files`)).text(), /<span class="Label Label--priority Label--priority-high" title="Priority">High<\/span>/);
    assert.match(r.stdout, /Add a doc comment\./);
    // Seen feedback is not returned twice.
    const again = await cli(['pr', 'wait', '--timeout', '1s']);
    assert.equal(again.code, 124);
  });

  await t.test('an approval without text still reaches the agent', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    const review = await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'APPROVE' });
    const r = await waiting;
    assert.match(r.stdout, /reviewer reviewed: approved/);
    // Put the decision back to "changes requested" for the tests that follow.
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'REQUEST_CHANGES', body: 'Actually, not yet.' });
    await cli(['pr', 'view', '--comments']);
    assert.ok(review.id);
  });

  await t.test('threads follow their lines when the agent rewrites history', async () => {
    writeFileSync(join(repo, 'math.js'), '// math\n\nexport function add(a, b) {\n  return a + b;\n}\n\n/** Multiply. */\nexport function mul(a, b) {\n  return a * b;\n}\n');
    git('commit', '-q', '--amend', '-am', 'Add mul');
    const r = await cli(['pr', 'view', '--json', 'reviewThreads,headRefOid']);
    const { reviewThreads, headRefOid } = JSON.parse(r.stdout);
    assert.equal(headRefOid, git('rev-parse', 'HEAD'));
    assert.equal(reviewThreads[0].line, 9);
    assert.equal(reviewThreads[0].originalLine, 6);
    assert.equal(reviewThreads[0].isOutdated, false);
    // The old head is kept reachable for the revision history.
    assert.match(git('for-each-ref', 'refs/laatsux/'), /refs\/laatsux\/pull\/1\/1\n.*refs\/laatsux\/pull\/1\/2/);
    const timeline = await human('GET', '/api/repos/acme/widgets/issues/1/timeline');
    assert.ok(timeline.some((e: any) => e.event === 'pushed' && e.forced === true));
  });

  await t.test('a range comment is outdated when a line inside it changes', async () => {
    const review = await human('POST', '/api/repos/acme/widgets/pulls/1/comments', { path: 'math.js', start_line: 8, line: 10, side: 'RIGHT', body: 'Range.' });
    writeFileSync(join(repo, 'math.js'), '// math\n\nexport function add(a, b) {\n  return a + b;\n}\n\n/** Multiply. */\nexport function mul(a, b) {\n  return b * a;\n}\n');
    git('commit', '-q', '--amend', '-am', 'Add mul');
    const threads = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads;
    const range = threads.find((th: any) => th.databaseId === review.id);
    assert.equal(range.isOutdated, true);
    // Seen by the agent so it does not show up in the next wait.
    await cli(['pr', 'view', '--comments']);
  });

  await t.test('pending review comments stay private', async () => {
    const pending = await human('POST', '/api/repos/acme/widgets/pulls/1/pending-comments', { path: 'math.js', line: 9, body: 'Draft thought.' });
    const asAgent = await cli(['api', `repos/{owner}/{repo}/pulls/comments/${pending.id}`]);
    assert.equal(asAgent.code, 1);
    const reply = await cli(['pr', 'comment', '--reply-to', String(pending.id), '-b', 'Sneaky.']);
    assert.equal(reply.code, 1);
    const reviews = await human('GET', '/api/repos/acme/widgets/pulls/1/reviews');
    await human('DELETE', `/api/repos/acme/widgets/pulls/1/reviews/${reviews.find((r: any) => r.state === 'PENDING').id}`);
  });

  await t.test('the agent replies to a thread and edits the pull request', async () => {
    const threads = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads;
    const id = threads[0].databaseId;
    const reply = await cli(['pr', 'comment', '--reply-to', String(id), '-b', 'Done.']);
    assert.equal(reply.code, 0, reply.stderr);
    const edit = await cli(['pr', 'edit', '--title', 'Add multiplication helper']);
    assert.equal(edit.code, 0, edit.stderr);
    const api = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '--jq', '.[] | "\\(.user.login): \\(.body)"']);
    assert.equal(api.code, 0, api.stderr);
    assert.equal(api.stdout, 'reviewer: Add a doc comment.\nreviewer: Range.\nagent: Done.\n');
    // The reply is feedback for nobody: it is the agent's own.
    const pr = await human('GET', '/api/repos/acme/widgets/pulls/1');
    assert.equal(pr.title, 'Add multiplication helper');
  });

  await t.test('api accepts gh-style fields', async () => {
    const r = await cli(['api', 'repos/{owner}/{repo}/issues/1/comments', '-f', 'body=From the API']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).user.login, 'agent');
    writeFileSync(join(dir, 'body.md'), "app.get('/repos/:owner/:repo') {owner}");
    const file = await cli(['api', 'repos/{owner}/{repo}/issues/1/comments', '-F', `body=@${join(dir, 'body.md')}`]);
    assert.equal(JSON.parse(file.stdout).body, "app.get('/repos/:owner/:repo') {owner}");
    const urgent = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '-f', 'body=x', '-f', 'path=math.js', '-F', 'line=9', '-f', 'priority=urgent']);
    assert.equal(urgent.code, 1);
    assert.match(urgent.stderr, /priority must be one of high, medium, low/);
    // Any reviewer that writes the priority into the text gets it moved into the field.
    const prefixed = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '-f', 'body=[P1] Fix this', '-f', 'path=math.js', '-F', 'line=9']);
    assert.equal(prefixed.code, 0, prefixed.stderr);
    assert.deepEqual((({ priority, body }) => ({ priority, body }))(JSON.parse(prefixed.stdout)), { priority: 'high', body: 'Fix this' });
    const missing = await cli(['api', 'repos/{owner}/{repo}/pulls/99']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404/);
  });

  await t.test('the publish button offers to sign, checked when git signs by default', async () => {
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<input type="checkbox" name="sign" checked> Sign the commit as <strong>Reviewer<\/strong> &lt;reviewer@example\.com&gt;/);
  });

  await t.test('the agent resolves a thread it fixed in the same command as its reply', async () => {
    const r = await cli(['pr', 'comment', '--resolve', '-b', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--resolve needs --reply-to/);
    const open = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads.filter((th: any) => !th.isResolved);
    const target = open[0].databaseId;
    const fixed = await cli(['pr', 'comment', '--reply-to', String(target), '--resolve', '-b', 'Fixed in the last commit.']);
    assert.equal(fixed.code, 0, fixed.stderr);
    const after = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads.find((th: any) => th.databaseId === target);
    assert.equal(after.isResolved, true);
    assert.equal(after.comments.at(-1).body, 'Fixed in the last commit.');
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/1`)).text(), /agent marked this conversation as resolved/);
  });

  await t.test('agents cannot publish, and stale pages cannot publish', async () => {
    const r = await cli(['pr', 'publish']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /publishing is for the reviewer/);
    const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected: 'deadbeef:0000' }),
    });
    assert.equal(res.status, 412);
  });

  await t.test('publishing pushes the reviewed commit and opens the pull request', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    const pr = await human('POST', '/api/repos/acme/widgets/pulls/1/publish', {});
    assert.equal(pr.published_url, 'https://github.com/acme/widgets/pull/7');
    assert.equal(pr.staging_state, 'published');
    // GitHub gets signed copies: same tree, message and author, the reviewer as committer.
    const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    assert.notEqual(remoteHead, git('rev-parse', 'HEAD'));
    const copy = execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', remoteHead], { encoding: 'utf8' });
    assert.match(copy, /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    assert.match(copy, /^author Dev <dev@example\.com> /m);
    assert.match(copy, /^committer Reviewer <reviewer@example\.com> /m);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${remoteHead}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
    assert.equal(copy.slice(copy.indexOf('\n\n') + 2), git('cat-file', 'commit', 'HEAD').split('\n\n').slice(1).join('\n\n') + '\n');
    // The agent's branch is left alone.
    assert.doesNotMatch(git('cat-file', 'commit', 'HEAD'), /^gpgsig/m);
    const log = readFileSync(join(dir, 'gh.log'), 'utf8');
    assert.match(log, /^pr create --repo acme\/widgets --base main --head feature\/mul --title Add multiplication helper --body-file -$/m);
    assert.equal(readFileSync(join(dir, 'gh-stdin.log'), 'utf8'), 'Adds `mul`.');
    const r = await waiting;
    assert.match(r.stdout, /Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7/);
  });

  await t.test('publishing new commits signs only those and fast-forwards GitHub', async () => {
    const before = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'README.md'), '# widgets\n');
    git('add', 'README.md');
    git('commit', '-qm', 'Add a readme');
    await human('POST', '/api/repos/acme/widgets/pulls/1/publish', {});
    const after = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${after}^`], { encoding: 'utf8' }).trim(), before);
    const timeline = await human('GET', '/api/repos/acme/widgets/issues/1/timeline');
    assert.equal(timeline.filter((e: any) => e.event === 'published').at(-1).signed, 1);
    // The signed copies count as the staged commits: nothing is left to publish.
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /GitHub has the same commits, title and description/);
  });

  await t.test('a rewritten branch needs force to publish again', async () => {
    git('commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Reworded.');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', {}), /409|rejected|git push failed/);
    await human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true });
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr edit https:\/\/github\.com\/acme\/widgets\/pull\/7 --title/m);
  });

  await t.test('force-publishing never overwrites commits added on GitHub', async () => {
    // Someone commits on the published branch on GitHub ...
    const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${tip}^{tree}`], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', tip, '-m', 'Commit suggestion'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/mul', theirs]);
    // ... while the agent rewrites history locally.
    git('commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Reworded again.');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true }), /changed since it was last published/);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim(), theirs);
  });

  await t.test('pr wait reports feedback that comes with a close', async () => {
    // The agent has seen everything so far (including the last publish).
    await cli(['pr', 'view', '--comments']);
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    await human('POST', '/api/repos/acme/widgets/issues/1/comments', { body: 'Closing: we went another way.' });
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'closed' });
    const r = await waiting;
    assert.match(r.stdout, /Closing: we went another way\./);
    // A closed pull request does not leave the agent waiting forever.
    const again = await cli(['pr', 'wait', '--timeout', '5s']);
    assert.match(again.stdout, /closed .* without publishing/);
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'open' });
  });

  await t.test('repo pages link to the pull requests and issues on GitHub', async () => {
    await server.service.refreshGithubRepo('acme/widgets');
    // When counts arrive in the background, open pages are told so they can show them.
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    server.service.bus.on('change', listen);
    await server.service.refreshGithubRepo('acme/fresh');
    server.service.bus.off('change', listen);
    assert.ok(events.includes('github_repo'), 'a change event when the counts change');
    // Owner and name go as strings (-f): -F would make a repository called "123" a number.
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^api graphql -f query=.* -f owner=acme -f name=widgets$/m);
    for (const path of ['/acme/widgets', '/acme/widgets/pull/1']) {
      const page = await (await fetch(server.url + path)).text();
      assert.match(page, /<a class="UnderlineNav-item selected" href="\/acme\/widgets">[^]*?Staged <span class="Counter">\d+<\/span><\/a>/, path);
      assert.match(page, /href="https:\/\/github\.com\/acme\/widgets\/pulls" target="_blank"[^]*?Pull requests <span class="Counter">2<\/span>/, path);
      assert.match(page, /href="https:\/\/github\.com\/acme\/widgets\/issues" target="_blank"[^]*?Issues <span class="Counter">4<\/span>/, path);
    }
  });

  await t.test('web pages render', async () => {
    for (const path of ['/', '/acme/widgets', '/acme/widgets/pull/1', '/acme/widgets/pull/1/commits', '/acme/widgets/pull/1/files', '/acme/widgets/pull/1/files?diff=split']) {
      const res = await fetch(server.url + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Add multiplication helper/, path);
    }
  });

  await t.test('cross-site writes and foreign Host headers are refused', async () => {
    const cross = await fetch(server.url + '/api/repos/acme/widgets/pulls/1/publish', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
  });
});

test('Markdown links issues, mentions and commits the way GitHub does', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/links');
  writeFileSync(join(repo, 'links.js'), 'export {};\n');
  git('add', 'links.js');
  git('commit', '-qm', 'First try');
  const replaced = git('rev-parse', 'HEAD');
  git('commit', '-q', '--amend', '-m', 'Add links.js');
  const own = git('rev-parse', 'HEAD');
  const pushed = git('rev-parse', 'origin/main');
  const body = `Fixes #12. Thanks @laat. Builds on ${pushed.slice(0, 7)}; ${own.slice(0, 7)} replaces ${replaced.slice(0, 7)}, not deadbeef. \`#13\``;
  const created = await cli(['pr', 'create', '--title', 'Links', '--body', body]);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const events: string[] = [];
  const listen = (e: { type: string }) => events.push(e.type);
  server.service.bus.on('change', listen);

  // "#12" is issue 12 on GitHub, not staged pull request 12; the page never waits for its title.
  const first = await page();
  assert.match(first, /Fixes <a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/12" target="_blank" rel="noopener noreferrer">#12<\/a>\./);
  assert.match(first, /<a class="user-mention" href="https:\/\/github\.com\/laat" target="_blank" rel="noopener noreferrer">@laat<\/a>/);
  assert.match(first, new RegExp(`<a class="commit-link" href="https://github\\.com/acme/widgets/commit/${pushed}" target="_blank" rel="noopener noreferrer"><code>${pushed.slice(0, 7)}</code></a>`));
  assert.match(first, new RegExp(`<a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${own}" title="Add links\\.js"><code>${own.slice(0, 7)}</code></a>`));
  assert.match(first, new RegExp(`replaces <a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${replaced}"><code>`));
  assert.match(first, /, not deadbeef\. <code>#13<\/code>/);
  // The publish box says what merging on GitHub closes (its title may have come in by the time the box renders).
  assert.match(first, /<strong>Merging on GitHub closes <a href="https:\/\/github\.com\/acme\/widgets\/issues\/12" target="_blank" rel="noopener"( title="[^"]*")?>#12<\/a><\/strong>/);

  // The title arrives in the background, and open pages hear about it.
  const titled = /<a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/12" title="Widgets wobble · Open issue"/;
  assert.doesNotMatch(first, titled);
  let later = first;
  for (let i = 0; i < 100 && !titled.test(later); i++) {
    await new Promise((r) => setTimeout(r, 20));
    later = await page();
  }
  server.service.bus.off('change', listen);
  assert.match(later, titled);
  assert.ok(events.includes('github_issues'), 'a change event when titles arrive');
  assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^api graphql -f query=.*i12:issueOrPullRequest\(number:12\).* -f owner=acme -f name=widgets$/m);

  // The editor's preview links the same way when it says which pull request it is on.
  const preview = async (text: string, pull?: string) =>
    (await fetch(`${server.url}/api/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, pull }) })).text();
  const api = `/api/repos/acme/widgets/pulls/${number}`;
  assert.match(await preview(`Fixes #12 in ${own.slice(0, 7)}`, api), new RegExp(`Fixes <a class="issue-link" href="https://github\\.com/acme/widgets/issues/12" title="Widgets wobble · Open issue"[^>]*>#12</a> in <a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${own}"`));
  assert.equal(await preview(`Fixes #12 in ${own.slice(0, 7)}`), `<p>Fixes #12 in ${own.slice(0, 7)}</p>\n`);
  // It takes titles from the cache alone: the answer to a lookup would refresh the page under the preview.
  assert.match(await preview('See #77', api), /<a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/77"/);
  await new Promise((r) => setTimeout(r, 100));
  assert.doesNotMatch(readFileSync(join(dir, 'gh.log'), 'utf8'), /issueOrPullRequest\(number:77\)/);
});

test('codex reviews when the author waits, within the limits in settings', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/codex');
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', 'codex.js', 'pnpm-lock.yaml');
  git('commit', '-qm', 'Add the answer');
  const created = await cli(['pr', 'create', '--title', 'Add the answer', '--body', 'It is 42.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({
    summary: 'Off by one.',
    comments: [
      // Models often write a one-line comment as start_line == line.
      { path: 'codex.js', line: 1, start_line: 1, side: 'RIGHT', priority: 'high', body: '```suggestion\nexport const answer = 42;\n```' },
      // The priority written into the text the way Codex likes to: it becomes the field.
      { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: null, body: '[P2] Not in this diff.' },
    ],
  });

  // Settings belong to the reviewer, and the effort has to suit the model.
  const asAgent = await cli(['api', '-X', 'PUT', 'settings/codex', '-F', 'enabled=true']);
  assert.equal(asAgent.code, 1);
  await assert.rejects(human('PUT', '/api/settings/codex', { model: 'gpt-test', effort: 'ultra' }), /does not support effort \\?"ultra"?/);
  await human('PUT', '/api/settings/codex', { enabled: true, model: 'gpt-test', effort: 'high', maxIterations: 1 });
  const settingsPage = await (await fetch(`${server.url}/settings`)).text();
  assert.match(settingsPage, /<option value="gpt-test"[^>]* selected>GPT Test/);
  assert.doesNotMatch(settingsPage, /internal/);
  assert.match(settingsPage, /<div class="Subhead" id="codex">/);
  assert.match(settingsPage, /<input type="checkbox" name="runTests" checked> Let Codex install dependencies and run tests/);

  // The agent waits; Codex reviews first and its review wakes the agent.
  const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /codex reviewed: commented/);
  assert.match(r.stdout, /Off by one\./);
  assert.match(r.stdout, /thread \d+ on codex\.js:1 \[unresolved\] \(high priority\)/);
  assert.match(r.stdout, /`math\.js:1` \(medium priority\): Not in this diff\./);
  const call = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
  assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-test');
  assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.match(call.prompt, /Title: Add the answer/);
  assert.equal(call.sawFile, true, 'codex runs in a checkout of the head commit');
  // By default laatsux installs the dependencies from the lockfile first, in Codex's sandbox with
  // network and without the repository's scripts. Then Codex may run the tests, without network,
  // writing only to the checkout and a temporary directory beside it, whatever the user's
  // config.toml says, and ignoring the checkout's own .codex/config.toml.
  const checkout = call.args[call.args.indexOf('-C') + 1];
  const workspaceWrite = (network: boolean) => [
    '-c',
    `sandbox_workspace_write.network_access=${network}`,
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
  ];
  const untrusted = ['-c', `projects={${JSON.stringify(checkout)}={trust_level="untrusted"}}`];
  const installs = () => readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(installs(), [
    {
      args: [
        'sandbox',
        '-c',
        'sandbox_mode="workspace-write"',
        ...workspaceWrite(true),
        ...untrusted,
        '--',
        'pnpm',
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
      ],
      cwd: checkout,
      store: join(dirname(checkout), 'tmp', 'pnpm-store'),
    },
  ]);
  assert.deepEqual(call.args.slice(call.args.indexOf('-s'), call.args.indexOf('-C')), ['-s', 'workspace-write', ...workspaceWrite(false), ...untrusted]);
  assert.equal(call.tmpdir, join(dirname(checkout), 'tmp'));
  assert.equal(call.npmCache, join(call.tmpdir, 'npm'));
  assert.match(call.prompt, /laatsux installed the dependencies with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile [^`]*`, which runs no install scripts/);
  assert.match(call.prompt, /\n    Packages: \+3\n    Done in 1s\n/);
  assert.match(call.prompt, /you may run the typecheck, tests or build/);
  assert.match(call.prompt, /There is no network, so you can not install anything/);
  assert.match(call.prompt, /changes you make to it are lost/);
  assert.doesNotMatch(call.prompt, /Do not modify any files/);
  // Removed afterwards, read-only directories and all. The review is posted before the cleanup finishes.
  await server.service.codex!.settle((await human('GET', base)).id);
  assert.equal(existsSync(dirname(checkout)), false);
  assert.doesNotMatch(git('worktree', 'list'), /laatsux-review-/);

  // The cap: after one automatic review, a new commit and another wait start nothing.
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 42;\n');
  git('commit', '-qam', 'Fix the answer');
  const capped = await cli(['pr', 'wait', String(number), '--timeout', '2s']);
  assert.equal(capped.code, 124);

  // Raising this pull request's limit lets Codex go on, at once when the author is waiting.
  assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /data-limit="1"[^]*js-codex-step[^]*js-codex-step/);
  // This time the install fails; Codex reviews anyway and is told why.
  process.env.FAKE_INSTALL_FAIL = '1';
  const resumed = cli(['pr', 'wait', String(number), '--timeout', '20s']);
  for (let i = 0; i < 100 && !(await human('GET', base)).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
  const selfRaise = await cli(['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${number}/reviewers/codex`, '-F', 'max_iterations=9']);
  assert.equal(selfRaise.code, 1, 'agents cannot raise their own limit');
  assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: '2' }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: 2 } });
  const second = await resumed;
  delete process.env.FAKE_INSTALL_FAIL;
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /automatic review 2 of 2/);
  const failedInstall = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
  assert.match(failedInstall.prompt, /laatsux could not install the dependencies: `pnpm install [^`]*` exited with 1\. Its output ended with:\n\n    ERR_PNPM_OUTDATED_LOCKFILE\n/);

  // Asking from the page ignores the cap, and a failed run keeps its error. With running the
  // tests turned off, Codex gets today's read-only sandbox and is told not to modify files.
  process.env.FAKE_CODEX_FAIL = '1';
  await human('PUT', '/api/settings/codex', { runTests: false });
  assert.doesNotMatch(await (await fetch(`${server.url}/settings`)).text(), /name="runTests" checked/);
  const pull = await human('GET', base);
  await human('POST', `${base}/reviewers/codex`);
  await server.service.codex!.settle(pull.id);
  delete process.env.FAKE_CODEX_FAIL;
  const readOnly = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
  assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('-s'), readOnly.args.indexOf('-C')), [
    '-s',
    'read-only',
    '-c',
    `projects={${JSON.stringify(readOnly.args[readOnly.args.indexOf('-C') + 1])}={trust_level="untrusted"}}`,
  ]);
  assert.equal(installs().length, 2, 'nothing is installed for a read-only review');
  assert.equal(readOnly.tmpdir, process.env.TMPDIR);
  assert.match(readOnly.prompt, /Do not modify any files\./);
  assert.doesNotMatch(readOnly.prompt, /install the dependencies/);
  await human('PUT', '/api/settings/codex', { runTests: true });
  const { runs } = await human('GET', `${base}/reviewers/codex`);
  assert.deepEqual(runs.map((x: any) => [x.trigger, x.status]), [['auto', 'done'], ['auto', 'done'], ['manual', 'failed']]);
  assert.match(runs[2].error, /model overloaded/);
  const page = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  assert.match(page, /failed/);
  assert.match(page, /Automatic reviews: 2 of <span class="codex-limit"[^>]*data-limit="2"/);
  assert.match(page, /js-codex-reset" data-api="[^"]*" data-field="max_iterations"/);
  assert.doesNotMatch(page, /for this pull request/, 'following the setting, as without --reviewer');
  assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: null }), { enabled: true, max_iterations: 1, overrides: { enabled: null, max_iterations: null } });

  // The reviewer is one identity: renaming it carries its earlier reviews along.
  await human('PUT', '/api/settings/codex', { name: 'codex-bot' });
  const reviews = await human('GET', `${base}/reviews`);
  assert.deepEqual([...new Set(reviews.map((rv: any) => rv.user.login))], ['codex-bot']);
  await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Looks right.' });
  const renamed = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  assert.equal(renamed.match(/<span class="flex-auto">codex-bot<\/span>/g)?.length, 2, 'once under Reviewers, once under Codex');
  assert.doesNotMatch(renamed, /<span class="flex-auto">codex<\/span>/);
  // Its name goes to its settings, under the new name too; a person's name does not.
  assert.match(renamed, /<a class="sidebar-person" href="\/settings#codex" title="Settings for codex-bot">/);
  assert.match(renamed, /<a class="author" href="\/settings#codex" title="Settings for codex-bot">codex-bot<\/a><span class="Label Label--bot">bot<\/span> reviewed/);
  assert.match(renamed, /<a class="author" href="#" title="reviewer">reviewer<\/a> commented/);
  // A name someone else uses is refused, and nobody can post as the reviewer.
  await assert.rejects(human('PUT', '/api/settings/codex', { name: 'agent' }), /already used by someone else/);
  const impostor = await cli(['pr', 'comment', String(number), '-b', 'hi'], { actor: 'codex-bot' });
  assert.equal(impostor.code, 1);
  assert.match(impostor.stderr, /is the name of the Codex reviewer/);
  await human('PUT', '/api/settings/codex', { name: 'codex' });

  // A pull request written by an agent running in Codex (the CLI calls it "codex-agent") is
  // reviewed too, and the review reaches that agent's wait.
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/by-codex');
  writeFileSync(join(repo, 'by-codex.js'), 'export {};\n');
  git('add', 'by-codex.js');
  git('commit', '-qm', 'Written in Codex');
  const byCodex = await cli(['pr', 'create', '--title', 'Written in Codex', '--body', 'x'], { actor: 'codex-agent' });
  assert.equal(byCodex.code, 0, byCodex.stderr);
  const waited = await cli(['pr', 'wait', byCodex.stdout.trim().split('/').pop()!, '--timeout', '20s'], { actor: 'codex-agent' });
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /codex reviewed: commented/);
  // Without a lockfile nothing is installed, and Codex is told so.
  const noLockfile = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
  assert.match(noLockfile.prompt, /No dependencies are installed: the repository root has no lockfile/);
  assert.equal(installs().length, 2);
  await human('PUT', '/api/settings/codex', { enabled: false });
});

test('symlinks in a pull request lead the reviewer nowhere: not to /dev/zero, not outside the checkout', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'laatsux-outside-'));
  writeFileSync(join(outside, 'secret'), 'keep\n');
  chmodSync(join(outside, 'secret'), 0o444);
  chmodSync(outside, 0o555);
  try {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/symlinks');
    // Read from the checkout, package.json would never end and the symlinked lockfile would win.
    symlinkSync('/dev/zero', join(repo, 'package.json'));
    symlinkSync(join(outside, 'secret'), join(repo, 'pnpm-lock.yaml'));
    symlinkSync(outside, join(repo, 'vendor'));
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');
    git('add', 'package.json', 'pnpm-lock.yaml', 'vendor', 'package-lock.json');
    git('commit', '-qm', 'Link things');
    const created = await cli(['pr', 'create', '--title', 'Link things', '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const base = `/api/repos/acme/widgets/pulls/${created.stdout.trim().split('/').pop()}`;
    process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Fine.', comments: [] });
    const pull = await human('GET', base);
    await human('POST', `${base}/reviewers/codex`);
    await server.service.codex!.settle(pull.id);
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((x: any) => x.status), ['done']);
    const install = readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(install.args.slice(install.args.indexOf('--') + 1, install.args.indexOf('--') + 3), ['npm', 'ci']);
    // Cleaning up the checkout made nothing outside it writable, and removed nothing there.
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'keep\n');
    assert.equal(statSync(join(outside, 'secret')).mode & 0o777, 0o444);
    assert.equal(statSync(outside).mode & 0o777, 0o555);
  } finally {
    chmodSync(outside, 0o755);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a review still running shows in pr view and pr wait, and publishing before it needs a confirmation', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/slow-review');
  writeFileSync(join(repo, 'slow.js'), 'export const slow = true;\n');
  git('add', 'slow.js');
  git('commit', '-qm', 'Add slow');
  const created = await cli(['pr', 'create', '--title', 'Add slow', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const head = git('rev-parse', 'HEAD');
  const sha = head.slice(0, 7);
  const gate = join(dir, 'codex-gate');
  process.env.FAKE_CODEX_GATE = gate;
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({
    summary: 'One thing.',
    comments: [{ path: 'slow.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it after what it means.' }],
  });
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
  try {
    // An author starting to wait queues an automatic review, which shows before it runs.
    const pull = await human('GET', base);
    const codex = server.service.codex!;
    const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
    codex.consider(pull.id);
    assert.deepEqual(codex.atWork(row()), { status: 'QUEUED', head_sha: head, started_at: null });
    for (let i = 0; i < 200 && codex.atWork(row())?.status !== 'IN_PROGRESS'; i++) await new Promise((r) => setTimeout(r, 25));

    const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
    const { reviewRequests } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout);
    assert.equal(reviewRequests.length, 1);
    const { startedAt, ...request } = reviewRequests[0];
    assert.deepEqual(request, { __typename: 'Bot', login: 'codex', status: 'IN_PROGRESS', commit: { oid: head } });
    assert.ok(Date.now() - Date.parse(startedAt) < 20_000);
    const view = await cli(['pr', 'view', String(number)]);
    assert.match(view.stdout, new RegExp(`^reviewers:\tcodex \\(reviewing ${sha}, started just now\\)$`, 'm'));
    const box = await page();
    assert.match(box, /<strong>Codex is still reviewing this commit<\/strong>/);
    assert.match(box, /class="btn btn-primary btn-publish" data-confirm="Click again to publish anyway"/);

    // The reviewer approves while Codex works: the agent hears that Codex is not done.
    for (let i = 0; i < 100 && !(await human('GET', base)).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
    await human('POST', `${base}/reviews`, { event: 'APPROVE' });
    const approved = await waiting;
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /reviewer reviewed: approved/);
    assert.match(approved.stdout, new RegExp(`^codex is reviewing ${sha} \\(started just now\\)\\.$`, 'm'));
    assert.match(approved.stdout, new RegExp(`codex is still reviewing; run \`laatsux pr wait ${number}\` to get its review\\.`));
    assert.doesNotMatch(approved.stdout, /nothing left open/);

    // Its review wakes the next wait, which says the approval came before it.
    writeFileSync(gate, '');
    const reviewed = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.match(reviewed.stdout, /codex reviewed: commented/);
    assert.match(reviewed.stdout, /^The approval from reviewer came before this review from codex\.$/m);
    assert.doesNotMatch(reviewed.stdout, /codex is (still )?reviewing/);
    await codex.settle(pull.id);
    assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout), { reviewRequests: [] });
    const stale = await page();
    assert.doesNotMatch(stale, /Codex is still reviewing/);
    assert.doesNotMatch(stale, /data-confirm/);

    // A page loaded before a review started does not know of it, so the server asks: publishing
    // with that page's fingerprint is refused while Codex works, unless it says to go ahead.
    const expected = stale.match(/name="expected" value="([^"]+)"/)![1];
    rmSync(gate);
    await human('POST', `${base}/reviewers/codex`);
    const refused = await fetch(`${server.url}${base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected }) });
    assert.equal(refused.status, 428);
    assert.match((await refused.json()).message, /^codex is still reviewing this commit, and its review may ask for changes\.$/);
    const fromTerminal = await cli(['pr', 'publish', String(number)], { actor: 'reviewer' });
    assert.equal(fromTerminal.code, 1);
    assert.match(fromTerminal.stderr, new RegExp(`Run \`laatsux pr publish ${number} --during-review\` to publish anyway\\.`));
    const agent = await cli(['pr', 'publish', String(number), '--during-review']);
    assert.match(agent.stderr, /publishing is for the reviewer/);
    const published = await human('POST', `${base}/publish`, { expected, during_review: true });
    assert.equal(published.staging_state, 'published');
    writeFileSync(gate, '');
    await codex.settle(pull.id);
  } finally {
    delete process.env.FAKE_CODEX_GATE;
    rmSync(gate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('pr create --reviewer and --no-review decide Codex reviews for that pull request', async (t) => {
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Fine.', comments: [] });
  const branch = (name: string, file: string) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', name);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
  };
  const create = (args: string[]) => cli(['pr', 'create', '--title', 'Review options', '--body', 'x', ...args]);
  const numberOf = (r: { stdout: string }) => Number(r.stdout.trim().split('/').pop());
  const api = (n: number) => `/api/repos/acme/widgets/pulls/${n}`;
  const page = async (n: number) => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
  const authorWaiting = async (n: number) => {
    for (let i = 0; i < 100 && !(await human('GET', api(n))).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
  };
  /** What Codex reports the moment it starts deciding about the pull request, as when its author waits. */
  const considered = async (n: number) => {
    const { id } = await human('GET', api(n));
    const codex = server.service.codex!;
    codex.consider(id);
    return codex.atWork(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id));
  };

  await t.test('--reviewer codex:2 gets two reviews when automatic reviews are off in settings', async () => {
    await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
    branch('feature/two-loops', 'two.js');
    // Repeated and comma-separated, as in gh; logins without a reviewer agent are ignored.
    const r = await create(['-r', 'octocat,codex:2', '--reviewer', 'alice']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Ignored reviewer octocat: laatsux has no reviewer agent by that name/);
    assert.match(r.stderr, /Ignored reviewer alice/);
    const n = numberOf(r);
    const { enabled, max_iterations, overrides } = await human('GET', `${api(n)}/reviewers/codex`);
    assert.deepEqual({ enabled, max_iterations, overrides }, { enabled: true, max_iterations: 2, overrides: { enabled: true, max_iterations: 2 } });
    const html = await page(n);
    assert.match(html, /Turned on for this pull request \(off in Settings\)/);
    assert.match(html, /Automatic reviews: 0 of <span class="codex-limit"[^>]*data-limit="2"/);
    // Queued as soon as Codex considers it, although automatic reviews are off in settings.
    assert.equal((await considered(n))?.status, 'QUEUED');
    for (const i of [1, 2]) {
      const w = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
      assert.equal(w.code, 0, w.stderr);
      assert.match(w.stdout, new RegExp(`automatic review ${i} of 2`));
      writeFileSync(join(repo, 'two.js'), `export const n = ${i};\n`);
      git('commit', '-qam', `Change two.js (${i})`);
    }
    const capped = await cli(['pr', 'wait', String(n), '--timeout', '2s']);
    assert.equal(capped.code, 124);
    assert.equal((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 2);
  });

  await t.test('--reviewer codex follows the limit in settings, raised while the author waits', async () => {
    await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 1 });
    branch('feature/settings-limit', 'limit.js');
    const r = await create(['--reviewer', 'codex']);
    assert.equal(r.code, 0, r.stderr);
    const n = numberOf(r);
    const first = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /automatic review 1 of 1/);
    writeFileSync(join(repo, 'limit.js'), 'export const n = 1;\n');
    git('commit', '-qam', 'Change limit.js');
    const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
    await authorWaiting(n);
    // Let Codex see the new commit and find the cap reached before the limit goes up.
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 1);
    await human('PUT', '/api/settings/codex', { maxIterations: 2 });
    const second = await waiting;
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /automatic review 2 of 2/);
    await human('PUT', '/api/settings/codex', { maxIterations: 3 });
  });

  await t.test('--no-review gets no reviews when automatic reviews are on in settings', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    branch('feature/no-review', 'none.js');
    const r = await create(['--no-review']);
    assert.equal(r.code, 0, r.stderr);
    const n = numberOf(r);
    const w = await cli(['pr', 'wait', String(n), '--timeout', '2s']);
    assert.equal(w.code, 124);
    assert.equal(await considered(n), null, 'nothing queued, although automatic reviews are on in settings');
    const config = await human('GET', `${api(n)}/reviewers/codex`);
    assert.deepEqual(config.runs, []);
    assert.equal(config.enabled, false);
    assert.equal(config.overrides.enabled, false);
    const html = await page(n);
    assert.match(html, /Automatic reviews are off/);
    assert.match(html, /Turned off for this pull request \(on in Settings\)/);
    assert.match(html, /js-codex-reset" data-api="[^"]*" data-field="enabled"/);
    // Back to the setting (the page's reset) while the author waits: Codex starts at once.
    const resumed = cli(['pr', 'wait', String(n), '--timeout', '20s']);
    await authorWaiting(n);
    const reset = await human('PATCH', `${api(n)}/reviewers/codex`, { enabled: null });
    assert.deepEqual(reset, { enabled: true, max_iterations: 3, overrides: { enabled: null, max_iterations: null } });
    const second = await resumed;
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /codex reviewed: commented/);
  });

  await t.test('without either flag, the setting decides', async () => {
    await human('PUT', '/api/settings/codex', { enabled: false });
    branch('feature/default-review', 'default.js');
    const r = await create([]);
    assert.equal(r.code, 0, r.stderr);
    const n = numberOf(r);
    assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).overrides, { enabled: null, max_iterations: null });
    assert.equal((await cli(['pr', 'wait', String(n), '--timeout', '2s'])).code, 124);
    assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs, []);
    assert.doesNotMatch(await page(n), /for this pull request/);
    // Turned on in Settings while the author waits, Codex reviews this one too.
    const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
    await authorWaiting(n);
    await human('PUT', '/api/settings/codex', { enabled: true });
    const w = await waiting;
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout, /codex reviewed: commented/);
    await human('PUT', '/api/settings/codex', { enabled: false });
  });

  await t.test('flags that cannot work stage nothing', async () => {
    branch('feature/refused', 'refused.js');
    const bad = await create(['-r', 'codex:two']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /invalid reviewer "codex:two"/);
    const both = await create(['--no-review', '-r', 'codex:2']);
    assert.equal(both.code, 1);
    assert.match(both.stderr, /codex was asked to review, but automatic reviews are turned off/);
    const tooMany = await create(['-r', 'codex:99']);
    assert.equal(tooMany.code, 1);
    assert.match(tooMany.stderr, /from 0 to 20/);
    assert.deepEqual(await human('GET', '/api/repos/acme/widgets/pulls?state=all&head=feature/refused'), []);
  });

  await t.test('the API takes logins as GitHub does, and turns every reviewer agent on or off', async () => {
    const post = async (body: object) => {
      const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-laatsux-actor': 'agent' },
        body: JSON.stringify({ title: 'Through the API', head: 'feature/refused', base: 'main', ...body }),
      });
      assert.equal(res.status, 201);
      const pr = await res.json();
      const config = await human('GET', `${api(pr.number)}/reviewers/codex`);
      await human('DELETE', api(pr.number));
      return { pr, config };
    };
    const byLogin = await post({ reviewers: ['Codex', 'octocat'] });
    assert.deepEqual(byLogin.pr.ignored_reviewers, ['octocat']);
    assert.deepEqual(byLogin.config.overrides, { enabled: true, max_iterations: null });
    assert.deepEqual((await post({ automatic_reviews: true })).config.overrides, { enabled: true, max_iterations: null });
    const plain = await post({});
    assert.equal(plain.pr.ignored_reviewers, undefined);
    assert.deepEqual(plain.config.overrides, { enabled: null, max_iterations: null });
  });
});

test('auto-publish publishes once the agents are done', async (t) => {
  /** Stage a branch with one commit, as the agent. */
  const stage = async (branch: string, file: string, ...args: string[]) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), `export const value = 1;\n`);
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...args]);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    return {
      number,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      created: () => new RegExp(`^pr create .* --head ${branch} `, 'm').test(readFileSync(join(dir, 'gh.log'), 'utf8')),
    };
  };
  const untilWaiting = async (base: string) => {
    for (let i = 0; i < 100 && !(await human('GET', base)).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
  };
  const defaults = { enabled: false, model: '', effort: '', maxIterations: 3 };
  const until = async (done: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 400 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(await done(), what);
  };
  const comment = (number: number, body: string) => human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body });
  /** Make signing wait for a gate, as it would for a passphrase or a 1Password prompt. */
  const gateSigning = () => {
    const signing = join(dir, 'signing');
    const gate = join(dir, 'sign-gate');
    const program = join(dir, 'gated-ssh-keygen');
    const reset = () => {
      rmSync(signing, { force: true });
      rmSync(gate, { force: true });
    };
    reset();
    writeFileSync(program, `#!/bin/sh\ntouch "${signing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.02; done\nexec ssh-keygen "$@"\n`);
    chmodSync(program, 0o755);
    git('config', 'gpg.ssh.program', program);
    return {
      started: () => existsSync(signing),
      open: () => writeFileSync(gate, ''),
      reset,
      restore: () => {
        git('config', '--unset', 'gpg.ssh.program');
        reset();
      },
    };
  };

  await t.test('after the last automatic review is answered', async () => {
    const pr = await stage('feature/auto', 'auto.js');
    process.env.FAKE_CODEX_REVIEW = JSON.stringify({
      summary: 'Two things.',
      comments: [
        { path: 'auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it after what it is.' },
        { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' },
      ],
    });
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
    try {
      assert.match(await pr.page(), /<button type="submit" class="btn" data-api="[^"]*\/auto-publish" data-method="PUT"[^>]*>.*Publish when reviews are done<\/button>/);
      // Only the reviewer can turn it on, as only the reviewer can publish.
      const agent = await cli(['pr', 'publish', String(pr.number), '--auto']);
      assert.equal(agent.code, 1);
      assert.match(agent.stderr, /auto-publish is for the reviewer/);
      const on = await cli(['pr', 'publish', String(pr.number), '--auto'], { actor: 'reviewer' });
      assert.equal(on.code, 0, on.stderr);
      assert.match(on.stderr, new RegExp(`Pull request acme/widgets#${pr.number} will be published when the reviewer agents are done`));
      assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-publish:\tenabled\treviewer$/m);
      const { autoPublishRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout);
      assert.deepEqual(
        { ...autoPublishRequest, enabledAt: undefined },
        { enabledAt: undefined, enabledBy: { login: 'reviewer', is_bot: false }, sign: true, draft: false, force: false, autoMerge: null },
      );

      // Codex's review wakes the agent, and nothing is published until the agent has answered it.
      const first = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /codex reviewed: commented/);
      // Findings on lines outside the diff, which only the review's body carries, count too.
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs.map((r: any) => r.findings), [2]);
      assert.match(first.stdout, /Auto-publish is on \(reviewer turned it on\): laatsux publishes this pull request once the reviewer agents are done/);
      assert.equal(pr.created(), false);
      const box = await pr.page();
      assert.match(box, /<strong>Auto-publish is on<\/strong>/);
      assert.match(box, /codex has used up its automatic reviews/);
      assert.match(box, /agent is working \(not waiting for review\)/);
      assert.match(box, /js-auto-publish-cancel/);
      assert.doesNotMatch(box, /Publish when reviews are done/);

      // The agent fixes it and waits again. Codex has used its one review, so laatsux publishes the new commit.
      writeFileSync(join(repo, 'auto.js'), 'export const answer = 1;\n');
      git('commit', '-qam', 'Name the value');
      const second = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7/);
      assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/widgets --base main --head feature\/auto --title Add auto\.js --body-file -$/m);
      const published = (await pr.timeline()).findLast((e) => e.event === 'published');
      assert.equal(published.auto, true);
      assert.equal(published.source, git('rev-parse', 'HEAD'));
      assert.equal(published.signed, 2);
      // It publishes once, and then it is off.
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.match(await pr.page(), /published this pull request to <a [^>]*>acme\/widgets#7<\/a> at <code>[0-9a-f]{7}<\/code> \(signed 2 commits\) with auto-publish/);
    } finally {
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('not while Codex reviews, and after a review that finds nothing', async () => {
    const pr = await stage('feature/auto-clean', 'clean.js');
    const gate = join(dir, 'auto-gate');
    process.env.FAKE_CODEX_GATE = gate;
    process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Looks right.', comments: [] });
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      const codex = server.service.codex!;
      const pull = await human('GET', pr.base);
      const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
      const reviewed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      for (let i = 0; i < 200 && codex.atWork(row())?.status !== 'IN_PROGRESS'; i++) await new Promise((r) => setTimeout(r, 25));
      await untilWaiting(pr.base);
      // The agent waits and nothing else is open, but Codex is at work.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(pr.created(), false);
      assert.match(await pr.page(), new RegExp(`codex is reviewing <code>${git('rev-parse', '--short=7', 'HEAD')}</code>`));
      writeFileSync(gate, '');
      assert.match((await reviewed).stdout, /Looks right\./);
      // Codex found nothing in the head; once the agent has seen that and waits, it is published.
      const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.equal(done.code, 0, done.stderr);
      assert.match(done.stdout, /Published to GitHub/);
      assert.equal(pr.created(), true);
    } finally {
      delete process.env.FAKE_CODEX_GATE;
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('without waiting for Codex when the pull request was staged with --no-review', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await stage('feature/auto-no-review', 'no-review.js', '--no-review');
      await human('PUT', `${pr.base}/auto-publish`, {});
      assert.match(await pr.page(), /codex does not review this pull request automatically/);
      // Codex reviews automatically in settings, but not this pull request: the author waiting is enough.
      const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Published to GitHub/);
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
      assert.equal((await pr.timeline()).findLast((e) => e.event === 'published').auto, true);
    } finally {
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('held up by a failed review until it is cancelled, and turned off by a close, a change request or a new base', async () => {
    const pr = await stage('feature/auto-failed', 'failed.js');
    process.env.FAKE_CODEX_FAIL = '1';
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
      for (let i = 0; i < 100 && !(await human('GET', `${pr.base}/reviewers/codex`)).runs.some((r: any) => r.status === 'failed'); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // A failed review is no feedback for the agent, and it stops auto-publish from going ahead.
      assert.equal((await waiting).code, 124);
      assert.equal(pr.created(), false);
      assert.match(await pr.page(), new RegExp(`codex's review of <code>${git('rev-parse', '--short=7', 'HEAD')}</code> failed\\. Ask it to review again, or publish by hand\\.`));
      const agent = await cli(['pr', 'publish', String(pr.number), '--disable-auto']);
      assert.equal(agent.code, 1);
      const off = await cli(['pr', 'publish', String(pr.number), '--disable-auto'], { actor: 'reviewer' });
      assert.equal(off.code, 0, off.stderr);
      assert.match(off.stderr, new RegExp(`Auto-publish disabled for pull request acme/widgets#${pr.number}`));
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_disabled').reason, 'cancelled');
    } finally {
      delete process.env.FAKE_CODEX_FAIL;
      await human('PUT', '/api/settings/codex', defaults);
    }

    // The agent editing the title leaves it on; the reviewer's own change request, a new base and a close turn it off.
    await human('PUT', `${pr.base}/auto-publish`, {});
    assert.equal((await cli(['pr', 'edit', String(pr.number), '--title', 'Add failed.js, renamed'])).code, 0);
    assert.ok((await human('GET', pr.base)).auto_publish);
    const turnOffs: [string, () => Promise<unknown>][] = [
      ['changes_requested', () => human('POST', `${pr.base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Not like this.' })],
      ['base_changed', () => human('PATCH', pr.base, { base: 'feature/mul' })],
      ['closed', () => human('PATCH', pr.base, { state: 'closed' })],
    ];
    for (const [reason, change] of turnOffs) {
      await human('PUT', `${pr.base}/auto-publish`, {});
      await change();
      assert.equal((await human('GET', pr.base)).auto_publish, null, reason);
      assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_disabled').reason, reason);
    }
    assert.match(await pr.page(), /disabled auto-publish by closing the pull request/);
  });

  await t.test('checks again after signing, which can wait for a prompt', async () => {
    const pr = await stage('feature/auto-sign', 'sign.js');
    const signing = gateSigning();
    const signedCopy = () => git('for-each-ref', '--format=%(objectname)', `refs/laatsux/pull/${pr.number}/published`);
    try {
      // Cancelled while signing waits: nothing is pushed.
      await human('PUT', `${pr.base}/auto-publish`, {});
      const cancelled = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started');
      await human('DELETE', `${pr.base}/auto-publish`);
      signing.open();
      await until(() => signedCopy() !== '', 'signing finished');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pr.created(), false);
      assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/auto-sign'], { stdio: 'ignore' }));
      await comment(pr.number, 'Hold on.');
      assert.match((await cancelled).stdout, /Hold on\./);

      // Feedback while signing waits: it reaches the agent first, and the next wait publishes.
      signing.reset();
      writeFileSync(join(repo, 'sign.js'), 'export const value = 2;\n');
      git('commit', '-qam', 'Change the value');
      const before = signedCopy();
      await human('PUT', `${pr.base}/auto-publish`, {});
      const fed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started again');
      await comment(pr.number, 'One more thing.');
      signing.open();
      assert.match((await fed).stdout, /One more thing\./);
      await until(() => signedCopy() !== before, 'signing finished again');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pr.created(), false);
      const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(done.stdout, /Published to GitHub/);
    } finally {
      signing.restore();
    }
  });

  await t.test('an attempt stops when its approval is replaced, and the new approval publishes', async () => {
    const pr = await stage('feature/auto-replace', 'replace.js');
    const signing = gateSigning();
    try {
      await human('PUT', `${pr.base}/auto-publish`, { draft: false });
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started');
      // Turned off and on again, now as a draft, while the first attempt signs.
      await human('DELETE', `${pr.base}/auto-publish`);
      await human('PUT', `${pr.base}/auto-publish`, { draft: true });
      signing.open();
      assert.match((await waiting).stdout, /Published to GitHub/);
      // Published once, with the options of the approval in force: as a draft.
      const creates = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr create ') && l.includes(' --head feature/auto-replace '));
      assert.equal(creates.length, 1);
      assert.match(creates[0], / --draft$/);
    } finally {
      signing.restore();
    }
  });

  await t.test("a stale attempt's failure leaves a newer approval on", async () => {
    const pr = await stage('feature/auto-stale', 'stale.js');
    const { id } = await human('GET', pr.base);
    const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
    await human('PUT', `${pr.base}/auto-publish`, { draft: false });
    const first = row().auto_publish;
    await human('PUT', `${pr.base}/auto-publish`, { draft: true });
    const second = row().auto_publish;
    assert.notEqual(first, second);
    server.service.autoPublishFailed(row(), server.service.viewer(), 'from the first approval', first);
    assert.equal(row().auto_publish, second);
    assert.equal((await pr.timeline()).some((e) => e.event === 'auto_publish_failed'), false);
    server.service.autoPublishFailed(row(), server.service.viewer(), 'from the second approval', second);
    assert.equal(row().auto_publish, null);
    assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed').error, 'from the second approval');
  });

  await t.test('a cancel while the force-push lease is looked up stops the push', async () => {
    const pr = await stage('feature/auto-lease', 'lease.js');
    // On GitHub before its first publish, then rewritten: publishing force-pushes with a lease.
    git('push', '-q', 'origin', 'feature/auto-lease');
    const theirs = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'Add lease.js, reworded');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the rewrite is recorded');
    // Hold publish's look-up of the branch on GitHub, which decides force and the lease (not the page's).
    const resolve = Repo.prototype.resolve;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    Repo.prototype.resolve = async function (this: Repo, ref: string) {
      if (ref === 'refs/remotes/origin/feature/auto-lease' && /at (async )?Service\.publish \(/.test(new Error().stack ?? '')) {
        holding = true;
        await held;
      }
      return resolve.call(this, ref);
    };
    try {
      await human('PUT', `${pr.base}/auto-publish`, { force: true });
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(() => holding, 'the lease is being looked up');
      await human('DELETE', `${pr.base}/auto-publish`);
      release();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/auto-lease'], { encoding: 'utf8' }).trim(), theirs);
      assert.equal(pr.created(), false);
      await comment(pr.number, 'Not yet.');
      assert.match((await waiting).stdout, /Not yet\./);
    } finally {
      Repo.prototype.resolve = resolve;
      release();
    }
  });

  await t.test('only the author waiting counts', async () => {
    // Should a review start, it waits for this gate and never finishes.
    const gate = join(dir, 'observer-gate');
    process.env.FAKE_CODEX_GATE = gate;
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await stage('feature/auto-observer', 'observer.js');
      await human('PUT', `${pr.base}/auto-publish`, {});
      const observe = async () => {
        const res = await fetch(`${server.url}${pr.base}/wait?timeout=1`, { headers: { 'x-laatsux-actor': 'observer' } });
        return { status: res.status, message: (await res.json()).message };
      };
      // Another agent waiting is not the author waiting: Codex does not start ...
      const refused = await observe();
      assert.equal(refused.status, 403);
      assert.match(refused.message, /^only the author of this pull request \(agent\) can wait for its feedback, not observer\./);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
      // ... and with Codex off for the pull request, auto-publish does not go ahead.
      await human('PATCH', `${pr.base}/reviewers/codex`, { enabled: false });
      assert.equal((await observe()).status, 403);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pr.created(), false);
      assert.ok((await human('GET', pr.base)).auto_publish);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
    } finally {
      delete process.env.FAKE_CODEX_GATE;
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('force-pushes over a branch already on GitHub when that was approved', async () => {
    const pr = await stage('feature/auto-force', 'force.js');
    // The branch reached GitHub before its first publish, and the agent then rewrote it.
    git('push', '-q', 'origin', 'feature/auto-force');
    const theirs = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'Add force.js, reworded');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the rewrite is recorded');
    // As for publishing by hand, the box offers to force-push.
    assert.match(await pr.page(), /<label class="js-force-option"><input type="checkbox" name="force" checked> Force-push/);
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--force'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '10s']);
    assert.match(r.stdout, /Published to GitHub/);
    const published = (await pr.timeline()).findLast((e) => e.event === 'published');
    assert.deepEqual([published.auto, published.force], [true, true]);
    const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/auto-force'], { encoding: 'utf8' }).trim();
    assert.notEqual(tip, theirs);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${tip}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
  });

  /** The branch's tip in the bare remote, and whether it carries a signature. */
  const remoteTip = (branch: string) => {
    const sha = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();
    const signed = /^gpgsig /m.test(execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' }));
    return { sha, signed, tree: execFileSync('git', ['--git-dir', remote, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim() };
  };

  await t.test('force-pushes signed copies over the unsigned commits already on GitHub when that was approved', async () => {
    const pr = await stage('feature/auto-unsigned', 'unsigned.js');
    // The agent's unsigned commit reached GitHub before the first publish; signing replaces it with a copy.
    git('push', '-q', 'origin', 'feature/auto-unsigned');
    const theirs = git('rev-parse', 'HEAD');
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--sign', '--force'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '10s']);
    assert.match(r.stdout, /Published to GitHub/);
    const published = (await pr.timeline()).findLast((e) => e.event === 'published');
    assert.deepEqual([published.auto, published.force, published.signed], [true, true, 1]);
    const tip = remoteTip('feature/auto-unsigned');
    assert.notEqual(tip.sha, theirs);
    assert.deepEqual([tip.signed, tip.tree], [true, git('rev-parse', 'HEAD^{tree}')]);
  });

  await t.test('publishing by hand offers force when signing replaces unsigned commits on GitHub', async () => {
    const pr = await stage('feature/manual-unsigned', 'manual.js');
    git('push', '-q', 'origin', 'feature/manual-unsigned');
    const theirs = git('rev-parse', 'HEAD');
    await until(async () => (await human('GET', pr.base)).head.sha === theirs, 'the pull request is synced');
    // The history did not change, but the signed copy does not contain the commit on GitHub.
    assert.match(await pr.page(), /<label class="js-force-option"><input type="checkbox" name="force" checked> Force-push/);
    // Without force it is refused before anything is pushed.
    const refused = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: false }) });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).message, /force-pushing was not chosen\.$/);
    assert.equal(remoteTip('feature/manual-unsigned').sha, theirs);
    const pull = await human('POST', `${pr.base}/publish`, { force: true });
    assert.equal(pull.staging_state, 'published');
    assert.equal((await pr.timeline()).findLast((e) => e.event === 'published').force, true);
    assert.equal(remoteTip('feature/manual-unsigned').signed, true);
  });

  await t.test('waits for your own threads, and a failure to publish turns it off', async () => {
    const pr = await stage('feature/auto-gh', 'gh.js');
    const thread = await human('POST', `${pr.base}/comments`, { path: 'gh.js', line: 1, side: 'RIGHT', body: 'Is this needed?' });
    await human('PUT', `${pr.base}/auto-publish`, {});
    // Codex is off. The agent answers the thread but leaves it for the reviewer to resolve.
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Is this needed\?/);
    assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(thread.id), '-b', 'Yes.'])).code, 0);
    const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
    await untilWaiting(pr.base);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pr.created(), false);
    assert.match(await pr.page(), /1 conversation you started is unresolved/);

    process.env.FAKE_GH_FAIL = 'HTTP 502: gh is down';
    try {
      await human('PUT', `${pr.base}/threads/${thread.id}/resolved`);
      for (let i = 0; i < 100 && (await human('GET', pr.base)).auto_publish; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      delete process.env.FAKE_GH_FAIL;
    }
    assert.equal((await human('GET', pr.base)).auto_publish, null);
    const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
    assert.equal(failed.error, 'gh pr create failed:\nHTTP 502: gh is down');
    const page = await pr.page();
    assert.match(page, /<strong>Auto-publish failed [^]*?<\/strong>[^]*?<pre class="merge-error">gh pr create failed:\nHTTP 502: gh is down<\/pre>/);
    assert.match(page, /Auto-publish failed and turned itself off/);
    assert.match(page, /Publish when reviews are done/);
    // The reviewer tells the agent; it was never told it was published.
    await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'I will publish this by hand.' });
    const told = await waiting;
    assert.match(told.stdout, /I will publish this by hand\./);
    assert.doesNotMatch(told.stdout, /Published to GitHub/);
  });
});

test('publishing can enable auto-merge on GitHub', async (t) => {
  const stage = async (branch: string, file: string) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export const merged = true;\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    return {
      number,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      /** The commit GitHub has: the signed copy publishing pushed. */
      pushed: () => execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim(),
    };
  };
  const until = async (done: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 400 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(await done(), what);
  };
  /** gh calls from here on. */
  const ghCalls = () => {
    const log = () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8') : '');
    const start = log().length;
    return () => log().slice(start).split('\n').filter(Boolean);
  };
  const url = 'https://github.com/acme/widgets/pull/7';
  /** Read the repository's settings from GitHub (the fake gh, with `env`) into laatsux's cache. */
  const refresh = async (env: Record<string, string>) => {
    Object.assign(process.env, env);
    try {
      await server.service.refreshGithubRepo('acme/widgets');
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
  // The option shows once laatsux knows that the repository allows auto-merge.
  await refresh({});

  await t.test('when publishing by hand, with the merge method from settings', async () => {
    const pr = await stage('feature/merge-manual', 'manual-merge.js');
    assert.match(await pr.page(), /<label><input type="checkbox" name="auto_merge"> Enable auto-merge on GitHub \(squash\)<\/label>/);
    const calls = ghCalls();
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /✓ https:\/\/github\.com\/acme\/widgets\/pull\/7 will be automatically merged via squash when all requirements are met/);
    // After the pull request is created, and only for the commit that was pushed.
    assert.deepEqual(
      calls().filter((c) => c.startsWith('pr ')),
      [
        'pr create --repo acme/widgets --base main --head feature/merge-manual --title Add manual-merge.js --body-file -',
        `pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`,
        `pr view ${url} --json state`,
      ],
    );
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.deepEqual([enabled.url, enabled.method, enabled.merged, enabled.actor.login], [url, 'squash', false, 'reviewer']);
    assert.deepEqual({ ...(await human('GET', pr.base)).auto_merge, enabled_by: undefined }, { enabled_by: undefined, merge_method: 'squash', commit_title: null, commit_message: null });
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tenabled\treviewer\tsquash$/m);
    const { autoMergeRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoMergeRequest'])).stdout);
    assert.deepEqual([autoMergeRequest.enabledBy.login, autoMergeRequest.mergeMethod], ['reviewer', 'SQUASH']);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge is on for <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7"[^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /enabled auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a>/);

    // The merge method is a setting.
    const refused = await fetch(`${server.url}/api/settings/publish`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mergeMethod: 'octopus' }) });
    assert.equal(refused.status, 422);
    writeFileSync(join(repo, 'manual-merge.js'), 'export const merged = 1;\n');
    git('commit', '-qam', 'Change manual-merge.js');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the push is recorded');
    // The page sends the method it shows; open pages hear when the setting changes.
    assert.match(await pr.page(), /<input type="hidden" name="merge_method" value="squash">/);
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    server.service.bus.on('change', listen);
    assert.equal((await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' })).publish.mergeMethod, 'rebase');
    server.service.bus.off('change', listen);
    assert.ok(events.includes('settings'), 'open pages hear that the merge method changed');
    try {
      assert.match(await (await fetch(`${server.url}/settings/publishing`)).text(), /<option value="rebase" selected>Rebase and merge<\/option>/);
      // A page that still shows squash cannot publish with rebase, nor turn on auto-publish.
      const update = ghCalls();
      for (const [method, path] of [['POST', 'publish'], ['PUT', 'auto-publish']]) {
        const stale = await fetch(`${server.url}${pr.base}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true, merge_method: 'squash' }) });
        assert.equal(stale.status, 412, path);
        assert.equal((await stale.json()).message, 'The merge method in Settings changed to rebase after this page was loaded. Refresh before publishing.');
      }
      assert.deepEqual(update(), []);
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.match(await pr.page(), /<input type="hidden" name="merge_method" value="rebase">/);
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'rebase' });
      assert.deepEqual(pull.auto_merge_result, { state: 'enabled', merge_method: 'rebase', error: null });
      assert.ok(update().includes(`pr merge ${url} --auto --rebase --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('when auto-publish publishes, if it was chosen with it', async () => {
    const pr = await stage('feature/merge-auto', 'auto-merge.js');
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--auto-merge'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stderr, /will be published when the reviewer agents are done and the author has answered them, with auto-merge on GitHub/);
    // The merge method is fixed when auto-publish is turned on, like its other options.
    assert.equal((await human('GET', pr.base)).auto_publish.auto_merge, 'squash');
    assert.equal(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout).autoPublishRequest.autoMerge, 'squash');
    await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
    try {
      assert.match(await pr.page(), /Then it enables auto-merge on GitHub \(squash\)\./);
      const calls = ghCalls();
      const waited = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(waited.stdout, /Published to GitHub/);
      await until(async () => (await pr.timeline()).some((e) => e.event === 'auto_merge_enabled'), 'auto-merge is enabled');
      assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('a failure is recorded, and the pull request stays published', async () => {
    const pr = await stage('feature/merge-fail', 'fail-merge.js');
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /Published, but turning on auto-merge failed:\nGraphQL: Auto merge is not allowed for this repository/);
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.staging_state, pull.published_url, pull.auto_merge], ['published', url, null]);
    const timeline = await pr.timeline();
    assert.ok(timeline.some((e) => e.event === 'published'));
    assert.equal(timeline.findLast((e) => e.event === 'auto_merge_failed').error, 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge failed <relative-time [^]*?<\/strong>[^]*?<pre class="merge-error">GraphQL: Auto merge is not allowed for this repository \(enablePullRequestAutoMerge\)<\/pre>/);
    assert.match(page, /Enabling auto-merge on <a [^>]*>acme\/widgets#7<\/a> failed/);
    // What came of it stays in the merge box when GitHub no longer allows auto-merge, or cannot be asked.
    for (const env of [{ FAKE_GH_AUTO_MERGE: 'false' }, { FAKE_GH_API_FAIL: 'HTTP 502' }] as Record<string, string>[]) {
      await refresh(env);
      assert.match(await pr.page(), /<strong>Auto-merge failed <relative-time /, Object.keys(env)[0]);
    }
    await refresh({});
  });

  await t.test('a merge gh accepted but laatsux could not check is not reported as auto-merge on', async () => {
    const pr = await stage('feature/merge-unknown', 'unknown-merge.js');
    process.env.FAKE_GH_VIEW = 'not JSON';
    try {
      const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /✓ Requested auto-merge via squash for https:\/\/github\.com\/acme\/widgets\/pull\/7; whether GitHub merged it at once could not be checked/);
    } finally {
      delete process.env.FAKE_GH_VIEW;
    }
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.equal(enabled.merged, null);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /requested auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a> [^]*?; whether GitHub merged it at once could not be checked/);
  });

  await t.test('the merge method checked when the request came in is the one used', async () => {
    const pr = await stage('feature/merge-race', 'race-merge.js');
    const service = server.service;
    const publish = service.publish;
    // The setting changes after the request was checked, while publishing is under way.
    service.publish = async (...args: Parameters<Service['publish']>) => {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
      return publish.apply(service, args);
    };
    const calls = ghCalls();
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'squash' });
      assert.equal(pull.auto_merge_result.merge_method, 'squash');
    } finally {
      service.publish = publish;
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
    assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`), calls().join('\n'));
  });

  await t.test('a lookup that cannot even start leaves the outcome unknown, not failed', async () => {
    const pr = await stage('feature/merge-lookup', 'lookup-merge.js');
    const service = server.service;
    const gh = service.ghBin;
    const calls = ghCalls();
    // Once gh pr merge has run, gh cannot be started any more, as when its working directory is gone.
    Object.defineProperty(service, 'ghBin', { configurable: true, get: () => (calls().some((c) => c.startsWith('pr merge ')) ? join(dir, 'no-such-gh') : gh) });
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'requested', merge_method: 'squash', error: null });
    } finally {
      Object.defineProperty(service, 'ghBin', { configurable: true, writable: true, value: gh });
      await refresh({});
    }
    assert.match(await pr.page(), /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
  });

  await t.test('asks GitHub before publishing, rather than trusting what it read earlier', async () => {
    // Auto-publish was approved with auto-merge while GitHub allowed squash merges; then the
    // repository stopped allowing them, and laatsux's cache has not heard yet.
    const pr = await stage('feature/merge-stale', 'stale-merge.js');
    await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
    const calls = ghCalls();
    process.env.FAKE_GH_SQUASH = 'false';
    try {
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
      await until(async () => (await human('GET', pr.base)).auto_publish === null, 'auto-publish gives up');
      await waiting;
      const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
      assert.match(failed.error, /^acme\/widgets does not allow squash merges/);

      // The same for publishing by hand.
      await refresh({});
      process.env.FAKE_GH_SQUASH = 'false';
      const refused = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) });
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /^acme\/widgets does not allow squash merges/);
    } finally {
      delete process.env.FAKE_GH_SQUASH;
      await refresh({});
    }
    // Refused before anything was pushed or opened on GitHub.
    assert.equal((await human('GET', pr.base)).staging_state, 'open');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
    assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'feature/merge-stale'], { stdio: 'pipe' }));
  });

  await t.test('GitHub merges at once when there is nothing to wait for', async () => {
    const pr = await stage('feature/merge-clean', 'clean-merge.js');
    // Right after creating the pull request, gh asks for auto-merge before GitHub knows it is
    // clean, and GitHub refuses. Asked again, gh merges it.
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)');
    process.env.FAKE_GH_VIEW = '{"state":"MERGED"}';
    const calls = ghCalls();
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'merged', merge_method: 'squash', error: null });
    } finally {
      delete process.env.FAKE_GH_VIEW;
    }
    assert.equal(calls().filter((c) => c.startsWith('pr merge ')).length, 2);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    const page = await pr.page();
    assert.match(page, /<strong>Merged on GitHub<\/strong>/);
    assert.match(page, /merged <a [^>]*>acme\/widgets#7<\/a> on GitHub \(squash\) [^]*?: auto-merge had nothing to wait for/);
  });

  await t.test('only where GitHub allows auto-merge, and with a merge method it allows', async () => {
    const pr = await stage('feature/merge-allowed', 'allowed-merge.js');
    const checkbox = /<input type="checkbox" name="auto_merge">/;
    const calls = ghCalls();
    try {
      // The repository does not allow auto-merge: no option, and the CLI refuses before publishing.
      const events: string[] = [];
      const listen = (e: { type: string }) => events.push(e.type);
      server.service.bus.on('change', listen);
      await refresh({ FAKE_GH_AUTO_MERGE: 'false' });
      server.service.bus.off('change', listen);
      assert.ok(events.includes('github_repo'), 'open pages hear that the option went away');
      assert.doesNotMatch(await pr.page(), /name="auto_merge"/);
      process.env.FAKE_GH_AUTO_MERGE = 'false';
      for (const args of [['--auto-merge'], ['--auto', '--auto-merge']]) {
        const r = await cli(['pr', 'publish', String(pr.number), ...args], { actor: 'reviewer' });
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.stderr, /acme\/widgets does not allow auto-merge\. Turn on "Allow auto-merge" in the repository's settings on GitHub\./);
      }
      delete process.env.FAKE_GH_AUTO_MERGE;
      assert.equal((await human('GET', pr.base)).auto_publish, null);

      // It allows auto-merge, but not the merge method in settings: the option says so, and publishing refuses.
      await refresh({});
      await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
      await refresh({ FAKE_GH_SQUASH: 'false' });
      const box = await pr.page();
      assert.match(box, /<input type="checkbox" name="auto_merge" disabled> Enable auto-merge on GitHub: acme\/widgets does not allow squash merges\. <a href="\/settings\/publishing">/);
      // Auto-publish, turned on before, would fail.
      assert.match(box, /acme\/widgets does not allow squash merges, so publishing will fail<\/span>/);
      await human('DELETE', `${pr.base}/auto-publish`);
      process.env.FAKE_GH_SQUASH = 'false';
      const refused = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) });
      delete process.env.FAKE_GH_SQUASH;
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /acme\/widgets does not allow squash merges, the merge method in laatsux's settings \(it allows merge, rebase\)\. Change it under Settings → Publishing\./);

      // Not knowing, because gh failed, hides it too; the counts on the tabs stay.
      await refresh({ FAKE_GH_API_FAIL: 'HTTP 502' });
      const page = await pr.page();
      assert.doesNotMatch(page, /name="auto_merge"/);
      assert.match(page, /Pull requests <span class="Counter">2<\/span>/);
    } finally {
      await refresh({});
    }
    assert.match(await pr.page(), checkbox);
    // Nothing was pushed or published while it refused.
    assert.equal((await human('GET', pr.base)).staging_state, 'open');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
  });
});

test('closing the server stops a running review and records why', async () => {
  const data = mkdtempSync(join(tmpdir(), 'laatsux-stop-'));
  const second = await startServer({ port: 0, dataDir: data, ghBin: 'false', codexBin: join(dir, 'codex'), viewerLogin: 'reviewer', pollMs: 60_000 });
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${second.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const api = `${second.url}/api/repos/${registered.full_name}`;
  const pr = await (
    await fetch(`${api}/pulls`, { method: 'POST', headers: { ...json, 'x-laatsux-actor': 'agent' }, body: JSON.stringify({ title: 'Slow review', head: 'feature/by-codex', base: 'main' }) })
  ).json();
  process.env.FAKE_CODEX_SLEEP = '10000';
  try {
    assert.equal((await fetch(`${api}/pulls/${pr.number}/reviewers/codex`, { method: 'POST' })).status, 202);
    const started = Date.now();
    await second.close();
    assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
  } finally {
    delete process.env.FAKE_CODEX_SLEEP;
  }
  const db = new Db(join(data, 'laatsux.db'));
  const run = db.get<{ status: string; error: string }>('SELECT status, error FROM review_runs');
  db.sql.close();
  assert.equal(run?.status, 'failed');
  assert.match(run!.error, /stopped during the review/);
  assert.doesNotMatch(git('worktree', 'list'), /laatsux-review-/);
  rmSync(data, { recursive: true, force: true });
});

test('the reviewer does not take over an author an older CLI called "codex"', async () => {
  const data = mkdtempSync(join(tmpdir(), 'laatsux-upgrade-'));
  const db = new Db(join(data, 'laatsux.db'));
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
    const registered = await s.registerRepo(repo);
    const oldAuthor = db.actor('codex', 'Bot');
    await s.createPull(registered, { title: 'From an older Codex agent', head: 'feature/by-codex', base: 'main' }, oldAuthor);
    const reviewer = new CodexReviewer(s, join(dir, 'codex'));
    assert.equal(reviewer.actor().login, 'codex');
    assert.notEqual(reviewer.actor().id, oldAuthor.id);
    assert.equal(db.actorById(oldAuthor.id).login, 'codex-agent', 'the author keeps its pull request under the new name');
  } finally {
    db.sql.close();
    rmSync(data, { recursive: true, force: true });
  }

  // Both names already exist: the old author becomes the new one, pull requests included,
  // so the agent (now "codex-agent") can still confirm feedback on them.
  const data2 = mkdtempSync(join(tmpdir(), 'laatsux-upgrade-'));
  const db2 = new Db(join(data2, 'laatsux.db'));
  try {
    const s = new Service({ db: db2, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
    const registered = await s.registerRepo(repo);
    const old = db2.actor('codex', 'Bot');
    const current = db2.actor('codex-agent', 'Bot');
    const pull = await s.createPull(registered, { title: 'From an older Codex agent', head: 'feature/by-codex', base: 'main' }, old);
    const reviewer = new CodexReviewer(s, join(dir, 'codex'));
    assert.equal(reviewer.actor().login, 'codex');
    assert.equal(db2.get<{ author_id: number }>('SELECT author_id FROM pulls WHERE id = ?', pull.id)!.author_id, current.id);
    assert.equal(db2.get('SELECT 1 FROM actors WHERE id = ?', old.id), undefined);
  } finally {
    db2.sql.close();
    rmSync(data2, { recursive: true, force: true });
  }
});
test('Codex reviews from before findings were counted are counted from their review', async () => {
  const data = mkdtempSync(join(tmpdir(), 'laatsux-findings-'));
  const db = new Db(join(data, 'laatsux.db'));
  const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
  const reviewer = new CodexReviewer(s, join(dir, 'codex'));
  s.codex = reviewer;
  try {
    for (const branch of ['feature/legacy-counted', 'feature/legacy-uncounted']) {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, 'legacy.js'), 'export {};\n');
      git('add', 'legacy.js');
      git('commit', '-qm', 'Add legacy.js');
    }
    const registered = await s.registerRepo(repo);
    const author = db.actor('agent', 'Bot');
    const counted = await s.createPull(registered, { title: 'Counted', head: 'feature/legacy-counted', base: 'main' }, author);
    const uncounted = await s.createPull(registered, { title: 'Uncounted', head: 'feature/legacy-uncounted', base: 'main' }, author);
    // Codex is on for both, so a clean head is not mistaken for Codex being off.
    db.run('UPDATE pulls SET codex_enabled = 1');
    const row = (id: number) => db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
    // Runs as an older version left them: done, linked to their review, and no count.
    const run = (pullId: number, head: string, reviewId: number | null) =>
      db.insert('review_runs', { pull_id: pullId, reviewer: 'codex', head_sha: head, trigger: 'auto', status: 'done', review_id: reviewId, started_at: now(), finished_at: now() });
    const ctx = await s.ctx(registered.owner, registered.name, counted.number);
    const nothing = await s.createReview(ctx, { event: 'COMMENT', body: 'Codex found nothing to comment on.\n\n<sub>Codex reviewed it.</sub>' }, reviewer.actor());
    const nothingRun = run(counted.id, counted.head_sha, nothing.id);
    const found = await s.createReview(
      ctx,
      {
        event: 'COMMENT',
        body: 'Three things.\n\n**Comments on lines outside the diff**\n\n- `math.js:1`: First.\n- `math.js:2-3` (low priority): Second,\n  over two lines.\n\n<sub>Codex reviewed it.</sub>',
        comments: [{ path: 'legacy.js', line: 1, body: 'Third.' }],
      },
      reviewer.actor(),
    );
    const foundRun = run(counted.id, '0'.repeat(40), found.id);
    const lostRun = run(uncounted.id, uncounted.head_sha, null);
    reviewer.start();
    const findings = (id: number) => db.get<{ findings: number | null }>('SELECT findings FROM review_runs WHERE id = ?', id)!.findings;
    assert.deepEqual([findings(nothingRun), findings(foundRun), findings(lostRun)], [0, 3, null]);
    // A review that found nothing lets the head through; one that cannot be counted is reviewed again.
    assert.equal(reviewer.headStatus(row(counted.id)).state, 'clean');
    assert.equal(reviewer.headStatus(row(uncounted.id)).state, 'unreviewed');
    reviewer.consider(uncounted.id);
    assert.equal(reviewer.atWork(row(uncounted.id))?.status, 'QUEUED');
  } finally {
    await reviewer.stop();
    db.sql.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('a reviewer never takes the human reviewer\'s own name', async () => {
  // Known at startup: the human is set up first, and the reviewer takes another name.
  const data = mkdtempSync(join(tmpdir(), 'laatsux-viewer-'));
  const named = await startServer({ port: 0, dataDir: data, ghBin: 'false', codexBin: join(dir, 'codex'), viewerLogin: 'codex', pollMs: 60_000 });
  try {
    assert.equal(named.service.viewer().type, 'User');
    assert.notEqual(named.service.codex!.actor().id, named.service.viewer().id);
    const res = await fetch(`${named.url}/api/settings/codex`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxIterations: 2 }) });
    assert.equal(res.status, 200, 'settings stay the human\'s');
  } finally {
    await named.close();
    rmSync(data, { recursive: true, force: true });
  }

  // Learned later (from gh): the reviewer gives the name up.
  const data2 = mkdtempSync(join(tmpdir(), 'laatsux-viewer-'));
  const db = new Db(join(data2, 'laatsux.db'));
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'someone' });
    s.codex = new CodexReviewer(s, join(dir, 'codex'));
    assert.equal(s.codex.actor().login, 'codex');
    s.setViewerLogin('codex');
    assert.equal(s.viewer().type, 'User');
    assert.equal(s.codex.actor().login, 'codex-reviewer');
  } finally {
    db.sql.close();
    rmSync(data2, { recursive: true, force: true });
  }
});

test('pr wait keeps waiting when the server restarts under it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'laatsux-restart-'));
  const first = await startServer({ port: 0, dataDir: data, ghBin: 'false', viewerLogin: 'reviewer', pollMs: 60_000 });
  const port = first.port;
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-laatsux-actor': 'agent' },
      body: JSON.stringify({ title: 'Survives restarts', head: 'feature/by-codex', base: 'main' }),
    })
  ).json();
  const waiting = exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], {
    cwd: repo,
    env: { ...process.env, LAATSUX_URL: first.url, LAATSUX_ACTOR: 'agent', LAATSUX_NO_AUTOSTART: '1' },
  });
  // Close the server while the wait's request is open, then bring it back on the same port.
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}`)).json()).author_waiting) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await first.close();
  const second = await startServer({ port, dataDir: data, ghBin: 'false', viewerLogin: 'reviewer', pollMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 4000)); // the wait retries every 3 seconds
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Still there?' }) });
    const r = await waiting;
    assert.match(r.stdout, /Still there\?/);

    // Delivered but never confirmed (the CLI died, say): the next wait brings it again.
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    const asAgent = { 'x-laatsux-actor': 'agent' };
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Second?' }) });
    const once = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    const twice = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    assert.equal(once.status, 'feedback');
    assert.deepEqual(twice.comments, once.comments);
    assert.ok(once.pr.comments.some((cm: any) => cm.body === 'Second?'), 'the wait carries what is needed to show the feedback');
    const confirm = await fetch(`${api}/seen`, { method: 'PUT', headers: { ...asAgent, ...json }, body: JSON.stringify({ at: once.seen_at }) });
    assert.equal(confirm.status, 204);
    assert.equal((await (await fetch(`${api}/wait?timeout=1`, { headers: asAgent })).json()).status, 'timeout');
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('auto-publish stays on when the server restarts', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/auto-restart');
  writeFileSync(join(repo, 'restart.js'), 'export {};\n');
  git('add', 'restart.js');
  git('commit', '-qm', 'Add restart');
  const data = mkdtempSync(join(tmpdir(), 'laatsux-auto-restart-'));
  const options = { port: 0, dataDir: data, ghBin: join(dir, 'gh'), codexBin: join(dir, 'codex'), viewerLogin: 'reviewer', pollMs: 60_000 };
  const json = { 'content-type': 'application/json' };
  const first = await startServer(options);
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-laatsux-actor': 'agent' },
      body: JSON.stringify({ title: 'Published after a restart', head: 'feature/auto-restart', base: 'main' }),
    })
  ).json();
  assert.equal((await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}/auto-publish`, { method: 'PUT', headers: json, body: '{}' })).status, 200);
  await first.close();
  const second = await startServer(options);
  try {
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    assert.equal((await (await fetch(api)).json()).auto_publish.enabled_by.login, 'reviewer');
    // The agent waits on the new server, which publishes.
    const r = await (await fetch(`${api}/wait?timeout=10`, { headers: { 'x-laatsux-actor': 'agent' } })).json();
    assert.equal(r.status, 'published');
    const timeline = await (await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/timeline`)).json();
    assert.equal(timeline.findLast((e: any) => e.event === 'published').auto, true);
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('the CLI starts a server when none is running', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const url = `http://localhost:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'laatsux-autostart-'));
  try {
    const r = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, LAATSUX_URL: url, LAATSUX_HOME: home, LAATSUX_ACTOR: 'agent' } });
    assert.match(r.stderr, new RegExp(`Started the laatsux server at ${url}`));
    // It keeps running after the command that started it.
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
    process.kill(health.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const off = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, LAATSUX_URL: url, LAATSUX_NO_AUTOSTART: '1' } }).catch((e) => e);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /not running/);
});

test('images pasted into comments are stored, shown to agents, and warned about before publishing', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/images');
  writeFileSync(join(repo, 'images.js'), 'export {};\n');
  git('add', 'images.js');
  git('commit', '-qm', 'Add images.js');
  const created = await cli(['pr', 'create', '--title', 'Show images', '--body', 'Nothing to see.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  // A 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const path = `/uploads/${hash}.png`;
  const upload = (body: Buffer<ArrayBuffer> | string, headers: Record<string, string> = { 'content-type': 'image/png' }) => fetch(`${server.url}/api/uploads`, { method: 'POST', headers, body });

  await t.test('an uploaded PNG is stored under its hash and served back as a PNG', async () => {
    const res = await upload(png);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { path, url: server.url + path, content_type: 'image/png', size: png.length });
    assert.deepEqual(readFileSync(join(dir, 'data', 'uploads', `${hash}.png`)), png);
    const served = await fetch(server.url + path);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    // The bytes decide the type, whatever the request said; the same bytes are the same file.
    assert.equal((await (await upload(png, { 'content-type': 'image/jpeg' })).json()).path, path);
    assert.equal((await fetch(`${server.url}/uploads/${'0'.repeat(64)}.png`)).status, 404);
  });

  await t.test('only PNG, JPEG, GIF and WebP images of at most 10 MB are accepted', async () => {
    const kinds: [Buffer<ArrayBuffer>, string, string][] = [
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'jpg', 'image/jpeg'],
      [Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'gif', 'image/gif'],
      [Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), 'webp', 'image/webp'],
    ];
    for (const [bytes, ext, type] of kinds) {
      // Without a declared type, as from a file the browser does not know.
      const res = await upload(bytes, {});
      assert.equal(res.status, 201, ext);
      const { path: stored, content_type } = await res.json();
      assert.match(stored, new RegExp(`^/uploads/[0-9a-f]{64}\\.${ext}$`));
      assert.equal(content_type, type);
      assert.equal((await fetch(server.url + stored)).headers.get('content-type'), type);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const asSvg = await upload(svg, { 'content-type': 'image/svg+xml' });
    assert.equal(asSvg.status, 415);
    assert.match((await asSvg.json()).message, /SVG images are not accepted/);
    // Declared as a PNG, but the bytes are not one.
    const disguised = await upload(svg);
    assert.equal(disguised.status, 415);
    assert.match((await disguised.json()).message, /this file is none of them/);
    assert.equal((await upload(Buffer.from('GIF8 and then some'))).status, 415);
    assert.equal((await upload(png, { 'content-type': 'text/html' })).status, 415);
    assert.equal((await upload(Buffer.alloc(0))).status, 422);
    const big = Buffer.alloc(png.length + 10 * 1024 * 1024);
    png.copy(big);
    const tooBig = await upload(big);
    assert.equal(tooBig.status, 413);
    assert.match((await tooBig.json()).message, /at most 10 MB/);
    // Also when the size is not declared up front.
    const chunks = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(png);
        for (let i = 0; i < 11; i++) ctl.enqueue(new Uint8Array(1024 * 1024));
        ctl.close();
      },
    });
    const streamed = await fetch(`${server.url}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: chunks, duplex: 'half' } as RequestInit);
    assert.equal(streamed.status, 413);
  });

  await t.test('uploads from other sites are refused', async () => {
    const res = await fetch(`${server.url}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', origin: 'https://evil.example' }, body: png });
    assert.equal(res.status, 403);
  });

  await t.test('rendered Markdown keeps uploaded images, and no other local ones', async () => {
    const render = async (text: string) => (await fetch(`${server.url}/api/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).text();
    assert.match(await render(`![screenshot](${path})`), new RegExp(`<img src="${path}" alt="screenshot" />`));
    assert.match(await render(`<img src="${path}" width="200">`), new RegExp(`<img src="${path}" width="200" />`));
    assert.match(await render('![remote](https://example.com/a.png)'), /<img src="https:\/\/example\.com\/a\.png" alt="remote" \/>/);
    for (const src of [
      '/api/repos/acme/widgets/pulls/1',
      `/uploads/${hash}.svg`,
      `/uploads/${hash}.png/../../laatsux.db`,
      '//evil.example/a.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      for (const text of [`![x](${src})`, `<img src="${src}" alt="x">`]) assert.match(await render(text), /^(<p>)?<img alt="x" \/>(<\/p>)?$/m, text);
    }
  });

  await t.test('pr wait and pr view --comments list the images, and --download-images saves them', async () => {
    const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
    for (let i = 0; i < 100 && !(await human('GET', base)).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: `It is cut off:\n\n![screenshot](${path})` });
    const woken = await waiting;
    assert.equal(woken.code, 0, woken.stderr);
    assert.match(woken.stdout, new RegExp(`^    !\\[screenshot\\]\\(${path}\\)\n    Image: ${server.url}${path}$`, 'm'));
    assert.match(woken.stdout, new RegExp(`laatsux pr view ${number} --comments --download-images <dir>`));

    await human('POST', `${base}/reviews`, { event: 'COMMENT', comments: [{ path: 'images.js', line: 1, side: 'RIGHT', body: `Like this:\n![after](${path})` }] });
    const view = await cli(['pr', 'view', String(number), '--comments']);
    assert.equal(view.code, 0, view.stderr);
    assert.equal(view.stdout.match(new RegExp(`Image: ${server.url}${path}$`, 'gm'))?.length, 2, 'under the comment and under the thread comment');
    assert.match(view.stdout, /Run again with --download-images <dir>/);

    const saveTo = join(dir, 'images');
    const saved = await cli(['pr', 'view', String(number), '--comments', '--download-images', saveTo]);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout.match(new RegExp(`Image: ${join(saveTo, `${hash}.png`)}$`, 'gm'))?.length, 2);
    assert.doesNotMatch(saved.stdout, /download-images|Image: http/);
    assert.deepEqual(readFileSync(join(saveTo, `${hash}.png`)), png);
  });

  await t.test('the publish box warns about images in the description, not in comments', async () => {
    const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    const before = await page();
    assert.match(before, /js-attach-image/);
    assert.doesNotMatch(before, /stored in laatsux/);
    await human('PATCH', base, { body: `Before and after:\n\n![before](${path})\n![after](${path.replace('.png', '.gif')})` });
    assert.match(await page(), /The description has 2 images stored in laatsux, which GitHub cannot show\. Remove them, or replace them with images uploaded to GitHub\./);
  });
});

test('browsing the repository at a commit of a pull request', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/browse');
  const numbered = (n: number, change: (i: number) => string | null = () => null) =>
    Array.from({ length: n }, (_, k) => change(k + 1) ?? `export const v${k + 1} = ${k + 1};`).join('\n') + '\n';
  mkdirSync(join(repo, 'dir with space'));
  writeFileSync(
    join(repo, 'dir with space', 'notes.md'),
    '# Notes\n\nSee [math](../math.js) and ![logo](../logo.png).\n\nFrom the root: [long](/long.js) ![root logo](/logo.png), [elsewhere](//example.com/x).\n\n![icon](../icon.svg) ![big](../big.svg) ![web](https://example.com/w.png) ![other](//example.com/o.png)\n\n[up](../) and [root](/)\n',
  );
  writeFileSync(join(repo, 'big.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(300_000)} --></svg>\n`);
  writeFileSync(join(repo, 'long.js'), numbered(60));
  writeFileSync(join(repo, 'page.html'), '<!doctype html><script>alert(document.cookie)</script>\n');
  writeFileSync(join(repo, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
  writeFileSync(join(repo, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  writeFileSync(join(repo, 'data.bin'), Buffer.from([0, 1, 2, 0, 3]));
  writeFileSync(join(repo, 'doomed.txt'), 'gone soon\n');
  git('add', '-A');
  git('commit', '-qm', 'Add files to browse');
  const base = git('rev-parse', 'HEAD');
  git('branch', 'browse-base');
  // The pull request changes lines 10 and 50 of long.js; lines 14 to 46 stay unchanged, outside the diff.
  writeFileSync(join(repo, 'long.js'), numbered(60, (i) => (i === 10 || i === 50 ? `export const v${i} = -${i};` : null)));
  git('rm', '-q', 'doomed.txt');
  git('commit', '-qam', 'Negate two values');
  const head = git('rev-parse', 'HEAD');
  const created = await cli(['pr', 'create', '--title', 'Negate', '--body', 'x', '--base', 'browse-base']);
  assert.equal(created.code, 0, created.stderr);
  const n = Number(created.stdout.trim().split('/').pop());
  const page = async (path: string) => {
    const res = await fetch(server.url + path, { redirect: 'manual' });
    return { status: res.status, type: res.headers.get('content-type'), location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  };

  await t.test('tree and blob views, with a path that has a space', async () => {
    const root = await page(`/acme/widgets/tree/${head.slice(0, 7)}`);
    assert.equal(root.status, 200);
    assert.match(root.text, new RegExp(`<a href="/acme/widgets/tree/${head}/dir%20with%20space">dir with space</a>`));
    assert.match(root.text, new RegExp(`<a href="/acme/widgets/blob/${head}/long.js">long.js</a>`));
    assert.doesNotMatch(root.text, /doomed\.txt/);
    const dir = await page(`/acme/widgets/tree/${head}/dir%20with%20space`);
    assert.equal(dir.status, 200);
    assert.match(dir.text, /<a href="[^"]*\/dir%20with%20space\/notes\.md">notes\.md<\/a>/);
    // The README-like rendering and Markdown links point into the same commit.
    const md = await page(`/acme/widgets/blob/${head}/dir%20with%20space/notes.md`);
    assert.equal(md.status, 200);
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/math\\.js">math</a>`));
    assert.match(md.text, new RegExp(`<img src="/acme/widgets/raw/${head}/logo\\.png"`));
    // "/x" is from the repository's root; "//host/x" is another site.
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/long\\.js">long</a>`));
    assert.match(md.text, new RegExp(`<img src="/acme/widgets/raw/${head}/logo\\.png" alt="root logo"`));
    assert.match(md.text, /<a href="\/\/example\.com\/x">elsewhere<\/a>/);
    // /raw serves SVG as text, so SVG images go inline; one too big to inline becomes a link.
    assert.match(md.text, /<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+" alt="icon"/);
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/big\\.svg">big</a>`));
    // Other images stay only when they come from the web, as in comments.
    assert.match(md.text, /<img src="https:\/\/example\.com\/w\.png" alt="web"/);
    assert.match(md.text, /<img alt="other"/);
    // The root is a directory, at /tree; /blob without a path goes there too.
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/tree/${head}">up</a> and <a href="/acme/widgets/tree/${head}">root</a>`));
    assert.equal((await page(`/acme/widgets/blob/${head}`)).location, `/acme/widgets/tree/${head}`);
    // Rendered files carry their source's URL, where app.js sends #L12 links.
    assert.match(md.text, new RegExp(`<div class="blob-body" data-plain="/acme/widgets/blob/${head}/dir%20with%20space/notes\\.md\\?plain=1">`));
    assert.match((await page(`/acme/widgets/blob/${head}/icon.svg`)).text, /data-plain="[^"]*\/icon\.svg\?plain=1"/);
    const plain = await page(`/acme/widgets/blob/${head}/dir%20with%20space/notes.md?plain=1`);
    assert.match(plain.text, /<td id="L3" class="blob-num js-line-number" data-num="3"><\/td>/);
    assert.doesNotMatch(plain.text, /data-plain=/);
    const code = await page(`/acme/widgets/blob/${head}/long.js`);
    assert.match(code.text, /<td id="L60" class="blob-num js-line-number" data-num="60"><\/td><td class="blob-code"><span class="hljs-keyword">export<\/span>/);
    assert.match(code.text, /60 lines/);
    // The base commit still has the deleted file.
    assert.equal((await page(`/acme/widgets/blob/${base}/doomed.txt`)).status, 200);
    // A directory at a /blob URL and a file at a /tree URL go where they belong.
    assert.equal((await page(`/acme/widgets/blob/${head}/dir%20with%20space`)).location, `/acme/widgets/tree/${head}/dir%20with%20space`);
    assert.equal((await page(`/acme/widgets/tree/${head}/long.js`)).location, `/acme/widgets/blob/${head}/long.js`);
  });

  await t.test('raw files never run as HTML on this origin', async () => {
    const html = await page(`/acme/widgets/raw/${head}/page.html`);
    assert.equal(html.status, 200);
    assert.equal(html.type, 'text/plain; charset=utf-8');
    assert.equal(html.text, '<!doctype html><script>alert(document.cookie)</script>\n');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.match(html.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal((await page(`/acme/widgets/raw/${head}/icon.svg`)).type, 'text/plain; charset=utf-8');
    assert.equal((await page(`/acme/widgets/raw/${head}/logo.png`)).type, 'image/png');
    const bin = await page(`/acme/widgets/raw/${head}/data.bin`);
    assert.equal(bin.type, 'application/octet-stream');
    assert.equal(bin.headers.get('content-disposition'), "attachment; filename*=UTF-8''data.bin");
    const spaced = await page(`/acme/widgets/raw/${head}/dir%20with%20space/notes.md`);
    assert.match(spaced.text, /^# Notes/);
  });

  await t.test('unknown commits and paths are not found', async () => {
    for (const path of [
      `/acme/widgets/tree/${'0'.repeat(40)}`,
      `/acme/widgets/tree/not-a-sha`,
      `/acme/widgets/blob/${head}/nope.js`,
      `/acme/widgets/raw/${head}/nope.js`,
      `/acme/widgets/raw/${head}/dir%20with%20space`,
      `/acme/widgets/tree/${head}/dir%20with%20space/..%2F..%2Fetc`,
      `/acme/widgets/blob_excerpt/${head}?path=nope.js&from=1&to=2&delta=0`,
      `/acme/nothing/tree/${head}`,
    ]) {
      assert.equal((await page(path)).status, 404, path);
    }
    assert.equal((await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=a&to=2&delta=0`)).status, 400);
  });

  await t.test('the unfold arrows load lines of the file as diff rows', async () => {
    const files = await page(`/acme/widgets/pull/${n}/files`);
    assert.match(files.text, new RegExp(`data-excerpt="/acme/widgets/blob_excerpt/${head}\\?path=long\\.js"`));
    // Lines 14 to 46 are folded between the hunks, and lines 54 to 60 after the last.
    assert.match(files.text, /<tr class="hunk-row" data-gap-from="14" data-gap-to="46" data-delta="0"/);
    assert.match(files.text, /<tr class="hunk-row hunk-row-end" data-gap-from="54" data-gap-to="60" data-delta="0"/);
    assert.match(files.text, new RegExp(`href="/acme/widgets/blob/${head}/long\\.js">View file`));
    assert.match(files.text, new RegExp(`href="/acme/widgets/blob/${base}/doomed\\.txt">View old version`));
    const rows = await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=20&to=22&delta=2`);
    assert.equal(rows.status, 200);
    assert.deepEqual([...rows.text.matchAll(/<tr class="line context"><td class="blob-num blob-num-context" data-num="(\d+)"><\/td><td class="blob-num blob-num-context" data-num="(\d+)"><\/td><td class="blob-code blob-code-context " data-side="RIGHT" data-line="(\d+)"/g)].map((m) => m.slice(1).map(Number)), [[18, 20, 20], [19, 21, 21], [20, 22, 22]]);
    assert.match(rows.text, /export<\/span> <span class="hljs-keyword">const<\/span> v20/);
    const split = await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=20&to=20&delta=0&diff=split`);
    assert.match(split.text, /data-side="LEFT" data-line="20"[^]*data-side="RIGHT" data-line="20"/);
    // Past the end of the file there is nothing to load.
    assert.equal((await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=61&to=80&delta=0`)).text, '');
  });

  await t.test('lines loaded by the arrows can carry comments, which follow them across pushes', async () => {
    const comment = await human('POST', `/api/repos/acme/widgets/pulls/${n}/comments`, { path: 'long.js', line: 30, side: 'RIGHT', body: 'Negate this one too.' });
    assert.equal(comment.line, 30);
    assert.equal(comment.diff_hunk, '@@ -27,4 +27,4 @@\n export const v27 = 27;\n export const v28 = 28;\n export const v29 = 29;\n export const v30 = 30;');
    const range = await human('POST', `/api/repos/acme/widgets/pulls/${n}/comments`, { path: 'long.js', start_line: 8, line: 20, side: 'RIGHT', body: 'From a changed line into folded ones.' });
    assert.match(range.diff_hunk, /v8 = 8;[^]*v10 = -10;[^]*v20 = 20;$/);
    for (const bad of [{ line: 61 }, { line: -1 }, { start_line: 70, line: 30 }]) {
      const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/${n}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'long.js', side: 'RIGHT', body: 'x', ...bad }) });
      assert.equal(res.status, 422, JSON.stringify(bad));
    }
    // The Files changed tab shows the thread with the lines around it, as if expanded.
    const files = await page(`/acme/widgets/pull/${n}/files`);
    assert.match(files.text, /data-side="RIGHT" data-line="33"/);
    assert.match(files.text, /Negate this one too\./);
    let threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => [th.line, th.isOutdated]), [[30, false], [20, false]]);
    // Two lines added at the top: the threads move down with their lines and are not outdated.
    writeFileSync(join(repo, 'long.js'), '// one\n// two\n' + numbered(60, (i) => (i === 10 || i === 50 ? `export const v${i} = -${i};` : null)));
    git('commit', '-qam', 'Add a header');
    threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => [th.line, th.isOutdated]), [[32, false], [22, false]]);
    // Changing the line itself makes it outdated, as for any comment.
    writeFileSync(join(repo, 'long.js'), '// one\n// two\n' + numbered(60, (i) => (i === 10 || i === 50 || i === 30 ? `export const v${i} = -${i};` : null)));
    git('commit', '-qam', 'Negate v30');
    threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => th.isOutdated), [true, false]);
  });

  await t.test('commits and revisions link to their tree', async () => {
    const commits = await page(`/acme/widgets/pull/${n}/commits`);
    assert.match(commits.text, new RegExp(`href="/acme/widgets/tree/${head}" title="Browse the repository at this commit"`));
    const conversation = await page(`/acme/widgets/pull/${n}`);
    assert.match(conversation.text, new RegExp(`href="/acme/widgets/tree/${head}" title="Browse the repository at this revision"`));
  });

  await t.test('laatsux browse prints the URL of a pull request, file or directory', async () => {
    const browse = async (...args: string[]) => {
      const r = await cli(['browse', ...args]);
      assert.equal(r.code, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(await browse('long.js:12', '--commit', head), `${server.url}/acme/widgets/blob/${head}/long.js#L12`);
    assert.equal(await browse(`--commit=${head.slice(0, 7)}`, 'long.js:12-14'), `${server.url}/acme/widgets/blob/${head}/long.js#L12-L14`);
    const now = git('rev-parse', 'HEAD');
    assert.equal(await browse('dir with space/notes.md:2'), `${server.url}/acme/widgets/blob/${now}/dir%20with%20space/notes.md?plain=1#L2`);
    assert.equal(await browse('icon.svg:1'), `${server.url}/acme/widgets/blob/${now}/icon.svg?plain=1#L1`);
    assert.equal(await browse('icon.svg'), `${server.url}/acme/widgets/blob/${now}/icon.svg`);
    assert.equal(await browse('dir with space/', '-c'), `${server.url}/acme/widgets/tree/${now}/dir%20with%20space`);
    assert.equal(await browse(String(n)), `${server.url}/acme/widgets/pull/${n}`);
    assert.equal(await browse(), `${server.url}/acme/widgets`);
    assert.equal(await browse(head.slice(0, 7)), `${server.url}/acme/widgets/tree/${head}`);
    // A number is a pull request when there is one; otherwise all digits can be a commit SHA.
    const digits = digitCommit(head);
    assert.equal(await browse(digits.slice(0, 7)), `${server.url}/acme/widgets/tree/${digits}`);
    const none = await cli(['browse', '99999']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no pull request #99999 in acme\/widgets/);
    const neither = await cli(['browse', '1234567']);
    assert.equal(neither.code, 1);
    assert.match(neither.stderr, /no pull request or commit "1234567" in acme\/widgets/);
    const missing = await cli(['browse', 'doomed.txt']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /doomed\.txt does not exist at [0-9a-f]{7}/);
    // The URLs work.
    assert.equal((await page(new URL(await browse('long.js:12', '--commit', head)).pathname)).status, 200);
  });

  await t.test('laatsux browse --repo looks up commits and paths in that repository, through the server', async () => {
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '--allow-empty', '-m', 'Other']);
    const browseFrom = (cwd: string, ...args: string[]) =>
      exec(process.execPath, [BIN, 'browse', ...args], { cwd, env: { ...process.env, LAATSUX_URL: server.url, LAATSUX_ACTOR: 'agent', NO_COLOR: '1' } }).then(
        (r) => r.stdout.trim(),
        (e) => `exit ${e.code}: ${e.stderr.trim()}`,
      );
    // Without --commit, HEAD of that repository's checkout.
    const now = git('rev-parse', 'HEAD');
    for (const cwd of [other, dir]) {
      assert.equal(await browseFrom(cwd, '-R', 'acme/widgets', 'dir with space/notes.md:2'), `${server.url}/acme/widgets/blob/${now}/dir%20with%20space/notes.md?plain=1#L2`, cwd);
    }
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', 'long.js:3', '--commit', head.slice(0, 7)), `${server.url}/acme/widgets/blob/${head}/long.js#L3`);
    assert.equal(await browseFrom(other, '--repo=acme/widgets', '-b', 'browse-base', 'doomed.txt'), `${server.url}/acme/widgets/blob/${base}/doomed.txt`);
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', '/dir with space/'), `${server.url}/acme/widgets/tree/${now}/dir%20with%20space`);
    assert.match(await browseFrom(other, '-R', 'acme/widgets', 'nope.js'), /^exit 1: nope\.js does not exist at [0-9a-f]{7}$/);
    assert.match(await browseFrom(other, '-R', 'acme/widgets', '-c', 'nope', 'long.js'), /^exit 1: no commit "nope" in acme\/widgets$/);

    // The GitHub endpoints it uses.
    const api = async (endpoint: string) => {
      const r = await cli(['api', endpoint]);
      return r.code === 0 ? JSON.parse(r.stdout) : r.stderr;
    };
    assert.deepEqual((await api(`repos/{owner}/{repo}/contents/dir%20with%20space?ref=${head}`)).map((e: any) => [e.type, e.path]), [['file', 'dir with space/notes.md']]);
    const file = await api(`repos/{owner}/{repo}/contents/long.js?ref=${base}`);
    assert.equal(Buffer.from(file.content, 'base64').toString(), numbered(60));
    assert.equal(file.html_url, `${server.url}/acme/widgets/blob/${base}/long.js`);
    assert.equal((await api('repos/{owner}/{repo}/commits/browse-base')).sha, base);
    assert.match(await api(`repos/{owner}/{repo}/contents/nope.js?ref=${head}`), /HTTP 404/);
    assert.match(await api('repos/{owner}/{repo}/commits/nope'), /No commit found for SHA: nope \(HTTP 422\)/);
  });
});

test('the file tree counts the unresolved conversations on each file in the diff shown', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/tree');
  const five = (name: string, change: (i: number) => string | null = () => null) =>
    Array.from({ length: 5 }, (_, k) => change(k + 1) ?? `export const ${name}${k + 1} = ${k + 1};`).join('\n') + '\n';
  writeFileSync(join(repo, 'one.js'), five('one'));
  writeFileSync(join(repo, 'two.js'), five('two'));
  git('add', '-A');
  git('commit', '-qm', 'Add one and two');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'two.js'), five('two', (i) => (i === 1 ? 'export const two1 = -1;' : null)));
  git('commit', '-qam', 'Negate two1');
  const created = await cli(['pr', 'create', '--title', 'Tree', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const n = Number(created.stdout.trim().split('/').pop());
  const api = `/api/repos/acme/widgets/pulls/${n}`;
  const comment = (body: object) => human('POST', `${api}/comments`, body);

  /** Each file in the tree with the conversations its bubble goes to, after checking the count it shows. */
  const tree = async (query = '') => {
    const text = await (await fetch(`${server.url}/acme/widgets/pull/${n}/files${query}`)).text();
    const out: Record<string, number[]> = {};
    for (const [, path, row] of text.matchAll(/<li class="tree-file[^"]*"><a [^>]*data-path="([^"]+)">([^]*?)<\/li>/g)) {
      const bubble = row.match(/<button type="button" class="tree-threads js-tree-threads" data-threads="([\d ]+)" aria-label="(\d+) unresolved conversations?"[^>]*><svg[^]*?<\/svg>(\d+)<\/button>/);
      const ids = bubble ? bubble[1].split(' ').map(Number) : [];
      if (bubble) assert.deepEqual([Number(bubble[2]), Number(bubble[3])], [ids.length, ids.length], path);
      else assert.doesNotMatch(row, /tree-threads/, path);
      out[path] = ids;
    }
    return out;
  };

  const lower = await comment({ path: 'one.js', line: 4, side: 'RIGHT', body: 'Open, lower.' });
  const higher = await comment({ path: 'one.js', line: 2, side: 'RIGHT', body: 'Open, higher.' });
  const about = await comment({ path: 'one.js', subject_type: 'file', body: 'About the file.' });
  const resolved = await comment({ path: 'one.js', line: 3, side: 'RIGHT', body: 'Resolved.' });
  await human('PUT', `${api}/threads/${resolved.id}/resolved`);
  // The reviewer's own pending comments are not conversations yet.
  await human('POST', `${api}/pending-comments`, { path: 'one.js', line: 5, body: 'Pending.' });
  const soonOutdated = await comment({ path: 'two.js', line: 5, side: 'RIGHT', body: 'Soon outdated.' });
  // On the first commit's diff; the second commit changed the line, so it is outdated in the pull request's.
  const onFirst = await comment({ path: 'two.js', line: 1, side: 'RIGHT', commit_id: first, body: 'On the first commit.' });

  // In page order: the lines from the top, then the conversations about the whole file.
  assert.deepEqual(await tree(), { 'one.js': [higher.id, lower.id, about.id], 'two.js': [soonOutdated.id] });
  assert.deepEqual(await tree(`?commit=${first}`), { 'one.js': [], 'two.js': [onFirst.id] });
  assert.deepEqual(await tree(`?range=${first}..${git('rev-parse', 'HEAD')}`), { 'two.js': [] });

  // Resolving, reopening and pushing change the counts.
  await human('PUT', `${api}/threads/${higher.id}/resolved`);
  await human('DELETE', `${api}/threads/${resolved.id}/resolved`);
  writeFileSync(join(repo, 'two.js'), five('two', (i) => (i === 1 ? 'export const two1 = -1;' : i === 5 ? 'export const two5 = -5;' : null)));
  git('commit', '-qam', 'Negate two5');
  assert.deepEqual(await tree(), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
  assert.deepEqual(await tree('?diff=split'), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
});

test('whose turn it is: the author agent, the reviewer agents, or the reviewer', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/turns');
  writeFileSync(join(repo, 'turns.js'), 'export const turns = 1;\n');
  git('add', 'turns.js');
  git('commit', '-qm', 'Add turns');
  const created = await cli(['pr', 'create', '--title', 'Take turns', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** Whose turn it is, and the reasons' text, as the API has them. */
  const turn = async (): Promise<{ whose: string; reasons: string[] }> => {
    const { turn } = await human('GET', base);
    return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
  };
  /** The group the front page shows this pull request in. */
  const group = async () => {
    const groups = (await page('/')).split('<div class="Box-row turn-group">').slice(1);
    return groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
  };
  const until = async (done: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 400 && !(await done()); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(await done(), what);
  };
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  /** What a list page notifies about: your turn in every repository (data-your-turn). */
  const yourTurn = (html: string): { id: number; title: string; url: string; reasons: string }[] =>
    JSON.parse(html.match(/data-your-turn="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  /** This pull request's row on a list page. */
  const rowOf = (html: string) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${number}"`));
  /** A wait counts for a few seconds after it ends, as pages show it (Service.setWaiting); until then the author still waits. */
  const waitEnded = () => until(() => !server.service.waiters.has(id) && !server.service['waitingStopped'].has(id), 'the wait is over');
  const threadId = async () => JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
  const gate = join(dir, 'turn-gate');
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
  try {
    await t.test("staged and not waiting: the reviewer's, with Codex still to come", async () => {
      assert.deepEqual(await turn(), { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet', `codex reviews ${sha()} when agent waits for review`] });
    });

    let waiting: ReturnType<typeof cli>;
    await t.test("waiting while Codex reviews: the reviewer agents'", async () => {
      process.env.FAKE_CODEX_GATE = gate;
      process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'One thing.', comments: [{ path: 'turns.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] });
      waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
      const { turn } = await human('GET', base);
      assert.equal(turn.whose, 'reviewer_agents');
      const { since, ...reviewing } = turn.reasons[0];
      assert.deepEqual(reviewing, { kind: 'reviewer_agent', state: 'reviewing', text: `codex is reviewing ${sha()}`, engine: 'codex' });
      assert.ok(Date.now() - Date.parse(since) < 20_000);
      assert.equal(turn.reasons[1].text, 'agent is waiting for review');
      // gh JSON says it in words, with how long it has been so.
      const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
      assert.deepEqual(view, { turn: { whose: 'REVIEWER_AGENTS', reasons: [`codex is reviewing ${sha()}, 1 min`, 'agent is waiting for review, 1 min'] } });
      assert.equal(await group(), 'With agents');
      assert.match(await page('/'), new RegExp(`<span class="turn-reason turn-reason--running">.*?codex is reviewing ${sha()}<span class="turn-since">, <relative-time [^>]*data-format="duration"`));
    });

    await t.test("handed Codex's findings: the author's, until it acts", async () => {
      writeFileSync(gate, '');
      const r = await waiting;
      assert.match(r.stdout, /codex reviewed: commented/);
      delete process.env.FAKE_CODEX_GATE;
      rmSync(gate);
      await server.service.codex!.settle(id);
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex commented on ${sha()}`, '1 unresolved thread'] });
      assert.equal(await group(), 'With agents');
    });

    await t.test("answered and not waiting: the reviewer's", async () => {
      await waitEnded();
      const reply = await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '-b', 'It is named after what it counts.']);
      assert.equal(reply.code, 0, reply.stderr);
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent is not waiting', 'no review from reviewer yet', 'agent answered 1 thread', `codex commented on ${sha()}`, '1 unresolved thread'],
      });
      const front = await page('/');
      assert.equal(await group(), 'Your turn');
      assert.deepEqual(yourTurn(front).find((x) => x.id === id), {
        id,
        title: 'Take turns',
        url: `/acme/widgets/pull/${number}`,
        reasons: `agent is not waiting, 1 min · no review from reviewer yet · agent answered 1 thread · codex commented on ${sha()} · 1 unresolved thread`,
      });
      // The tab's title counts the pull requests waiting for the reviewer.
      assert.match(front, new RegExp(`<title>\\(${yourTurn(front).length}\\) Staged pull requests · laatsux</title>`));
      assert.match((await cli(['pr', 'status'])).stdout, /^ {4}- the reviewer's turn: agent is not waiting, 1 min; no review from reviewer yet; agent answered 1 thread;/m);
    });

    await t.test("feedback the author does not wait for: still the reviewer's, saying so", async () => {
      await human('POST', `${base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Count something else.' });
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent has not seen the latest feedback', 'agent is not waiting', `codex commented on ${sha()}`, 'changes requested', '1 unresolved thread'],
      });
      // While a wait hands it over, it is the author's.
      server.service.waiters.set(id, 1);
      try {
        assert.equal(server.service.turn(row()).whose, 'author');
      } finally {
        server.service.waiters.delete(id);
      }
      // Reading it is being handed it.
      await cli(['pr', 'view', String(number), '--comments']);
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex commented on ${sha()}`, 'changes requested', '1 unresolved thread'] });
    });

    await t.test("a push, and a review from Codex that finds nothing: the reviewer's", async () => {
      process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Fine now.', comments: [] });
      assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '--resolve', '-b', 'Renamed.'])).code, 0);
      writeFileSync(join(repo, 'turns.js'), 'export const rounds = 1;\n');
      git('commit', '-qam', 'Count rounds');
      const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.match(r.stdout, /Fine now\./);
      await server.service.codex!.settle(id);
      await waitEnded();
      // The clean review asks nothing of the author, so its turn does not come back.
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent is not waiting', "1 push since reviewer's review", 'agent answered 1 thread', `codex found nothing in ${sha()}`, 'changes requested'],
      });
    });

    await t.test("a failed review of the head: the reviewer's, with Retry", async () => {
      process.env.FAKE_CODEX_FAIL = '1';
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(id);
      delete process.env.FAKE_CODEX_FAIL;
      const failed = (await human('GET', base)).turn.reasons.find((x: any) => x.kind === 'reviewer_agent');
      assert.deepEqual(failed, { kind: 'reviewer_agent', state: 'failed', text: `codex's review of ${sha()} failed`, engine: 'codex' });
      assert.match(await page('/'), new RegExp(`codex&#39;s review of ${sha()} failed <button type="button" class="btn-link js-run-codex" data-api="${base}/reviewers/codex">Retry</button>`));
      // Also while the author waits: nothing more is coming from Codex for this commit.
      const waited = cli(['pr', 'wait', String(number), '--timeout', '2s']);
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      const { whose, reasons } = await turn();
      assert.equal(whose, 'reviewer');
      assert.equal(reasons[0], 'agent is waiting for review');
      assert.equal((await waited).code, 124);
    });

    await t.test("an approval asks nothing of the author: the reviewer's", async () => {
      await human('POST', `${base}/reviews`, { event: 'APPROVE' });
      await cli(['pr', 'view', String(number), '--comments']);
      const { whose, reasons } = await turn();
      assert.equal(whose, 'reviewer');
      assert.ok(reasons.includes('approved'));
      assert.match(rowOf(await page('/'))!, /<span class="Label Label--success">.*?Approved<\/span>/);
    });

    await t.test("published: nobody's, until an update is not published", async () => {
      // Codex's review of this commit failed before it was published: that holds nothing up now.
      await human('POST', `${base}/publish`, {});
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      assert.equal(await group(), 'Published');
      // A review asked for after publishing that fails is the reviewer's to retry, and a retry that finds nothing ends it.
      process.env.FAKE_CODEX_FAIL = '1';
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(id);
      delete process.env.FAKE_CODEX_FAIL;
      const failed = await turn();
      assert.equal(failed.whose, 'reviewer');
      assert.ok(failed.reasons.includes(`codex's review of ${sha()} failed`));
      assert.equal(await group(), 'Your turn');
      assert.match(await page('/'), new RegExp(`data-api="${base}/reviewers/codex">Retry</button>`));
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(id);
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      // Feedback after publishing that the author, not waiting, has not been handed is the reviewer's to pass on.
      await waitEnded();
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'One more thing.' });
      const told = await turn();
      assert.equal(told.whose, 'reviewer');
      assert.deepEqual(told.reasons.slice(0, 2), ['agent has not seen the latest feedback', 'agent is not waiting']);
      assert.equal(await group(), 'Your turn');
      // Handed over, it is the author's; answered, nobody's again.
      await cli(['pr', 'view', String(number), '--comments']);
      assert.equal((await turn()).whose, 'author');
      assert.equal((await cli(['pr', 'comment', String(number), '-b', 'Noted.'])).code, 0);
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      writeFileSync(join(repo, 'turns.js'), 'export const rounds = 2;\n');
      git('commit', '-qam', 'Count two rounds');
      assert.equal((await cli(['pr', 'edit', String(number), '--title', 'Take turns, in rounds'])).code, 0);
      await waitEnded();
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent is not waiting', "1 push since reviewer's review", 'codex used 2 of 2 automatic reviews', 'approved', 'update not published: commits, title'],
      });
      // gh's state stays as gh would show it; the update is an extension field.
      const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'state,unpublishedChanges'])).stdout);
      assert.deepEqual(view, { state: 'PUBLISHED', unpublishedChanges: ['COMMITS', 'TITLE'] });
      const plain = (await cli(['pr', 'view', String(number)])).stdout;
      assert.match(plain, /^unpublished:\tcommits, title$/m);
      assert.match(plain, /^turn:\treviewer\tagent is not waiting, 1 min; 1 push since reviewer's review;/m);
      assert.match(await page(`/acme/widgets/pull/${number}`), /<span class="State State--open">.*?Update not published<\/span>/);
      assert.match(await page('/acme/widgets?state=published'), /<span class="Label Label--attention">.*?Update not published: commits, title<\/span>/);
      assert.equal(await group(), 'Your turn');
    });

    await t.test("an update Codex reviews: the reviewer agents', not the reviewer's", async () => {
      process.env.FAKE_CODEX_GATE = gate;
      const waited = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 3 });
      await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
      const { whose, reasons } = await turn();
      assert.equal(whose, 'reviewer_agents');
      assert.deepEqual([reasons[0], reasons.at(-1)], [`codex is reviewing ${sha()}`, 'update not published: commits, title']);
      writeFileSync(gate, '');
      assert.equal((await waited).code, 0);
      await server.service.codex!.settle(id);
    });

    await t.test("an edit to its own comment is the author's next action", async () => {
      assert.equal((await cli(['pr', 'comment', String(number), '-b', 'Working on it.'])).code, 0);
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Say what changed in the description.' });
      await cli(['pr', 'view', String(number), '--comments']);
      assert.equal((await turn()).whose, 'author');
      assert.equal((await cli(['pr', 'comment', String(number), '--edit-last', '-b', 'Done: the description says what changed.'])).code, 0);
      assert.equal((await turn()).whose, 'reviewer');
    });

    await t.test("waiting again at once ends the author's turn, and pages hear of it once", async () => {
      const ctx = await server.service.ctx('acme', 'widgets', number);
      const author = server.service.db.actorById(ctx.pull.author_id);
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'And the README.' });
      // Handed the comment and confirming it, as `pr wait` does: the author's turn.
      const handed = await server.service.wait(ctx, author, 5_000);
      server.service.markSeen(ctx.pull, handed.seenAt!);
      assert.equal((await turn()).whose, 'author');
      const events: string[] = [];
      const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
      server.service.bus.on('change', listen);
      const first = new AbortController();
      const renewal = new AbortController();
      try {
        // A wait started within seconds of the last one announces nothing itself (setWaiting) ...
        const again = server.service.wait(ctx, author, 20_000, first.signal);
        await until(async () => (await turn()).whose === 'reviewer', "the reviewer's turn");
        // ... so the wait says that it ended the author's turn.
        assert.deepEqual(events, ['waiting']);
        // A renewal that changes nothing says nothing.
        first.abort();
        await again;
        const renewed = server.service.wait(ctx, author, 20_000, renewal.signal);
        await new Promise((r) => setTimeout(r, 200));
        renewal.abort();
        await renewed;
        assert.deepEqual(events, ['waiting']);
      } finally {
        first.abort();
        renewal.abort();
        server.service.bus.off('change', listen);
      }
    });

    await t.test('notifications follow your turn whatever the list shows, and Retry finds its pull request', async () => {
      // A second repository, named so that a pull request's path in it has "pull" twice.
      const other = join(dir, 'pull');
      execFileSync('git', ['init', '-q', '-b', 'main', other]);
      const g = (...args: string[]) => execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args]);
      g('remote', 'add', 'origin', 'https://github.com/acme/pull.git');
      writeFileSync(join(other, 'a.js'), 'export const a = 1;\n');
      g('add', '.');
      g('commit', '-qm', 'Initial commit');
      g('update-ref', 'refs/remotes/origin/main', 'main');
      g('checkout', '-qb', 'feature');
      writeFileSync(join(other, 'a.js'), 'export const a = 2;\n');
      g('commit', '-qam', 'Change a');
      await human('POST', '/api/repos', { path: other });
      const res = await fetch(`${server.url}/api/repos/acme/pull/pulls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-laatsux-actor': 'agent' },
        body: JSON.stringify({ title: 'Change a', head: 'feature', base: 'main' }),
      });
      assert.equal(res.status, 201);
      const { id: otherId, number: otherNumber } = await res.json();
      process.env.FAKE_CODEX_FAIL = '1';
      await human('POST', `/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex`);
      await server.service.codex!.settle(otherId);
      delete process.env.FAKE_CODEX_FAIL;
      assert.match(await page('/acme/pull'), new RegExp(`data-api="/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex">Retry</button>`));
      // Every list page carries your turn in every repository, whatever its tab or repository shows.
      for (const path of ['/', '/?state=closed', '/?state=published', '/acme/pull', '/acme/pull?state=closed']) {
        const ids = yourTurn(await page(path)).map((x) => x.id);
        assert.ok(ids.includes(id) && ids.includes(otherId), path);
      }
      await human('PATCH', `/api/repos/acme/pull/pulls/${otherNumber}`, { state: 'closed' });
    });

    await t.test("feedback handed over after a push the author made meanwhile: the author's", async () => {
      await waitEnded();
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Mention it in the changelog.' });
      assert.equal((await turn()).whose, 'reviewer');
      // The author pushes what it was working on, then its wait hands it the comment.
      writeFileSync(join(repo, 'turns.js'), 'export const rounds = 3;\n');
      git('commit', '-qam', 'Count three rounds');
      const r = await cli(['pr', 'wait', String(number), '--timeout', '5s']);
      assert.match(r.stdout, /Mention it in the changelog\./);
      const { whose, reasons } = await turn();
      assert.equal(whose, 'author');
      assert.equal(reasons[0], 'agent is working on the feedback');
    });

    await t.test("closed: nobody's", async () => {
      await human('PATCH', base, { state: 'closed' });
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
    });
  } finally {
    delete process.env.FAKE_CODEX_GATE;
    delete process.env.FAKE_CODEX_FAIL;
    rmSync(gate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
  }
});
