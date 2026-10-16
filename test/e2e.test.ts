// The whole loop: an agent stages a pull request with the CLI, a reviewer comments
// through the API (as the web UI does), the agent rewrites history, and the reviewer publishes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer, type AddressInfo } from 'node:net';
import { startServer } from '../src/server/server.ts';
import { Db } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';
import { CodexReviewer } from '../src/server/reviewers/codex.ts';

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
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\ncat >> "${join(dir, 'gh-stdin.log')}"\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/widgets/pull/7" ;;\n  "api graphql") echo '{"data":{"repository":{"issues":{"totalCount":4},"pullRequests":{"totalCount":2}}}}' ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);

  // A stand-in for the Codex CLI: a model catalog, and `exec` answering with FAKE_CODEX_REVIEW,
  // after FAKE_CODEX_SLEEP milliseconds or once the file FAKE_CODEX_GATE exists.
  const codex = join(dir, 'codex');
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log');
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
if (args[0] !== 'exec') process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, sawFile: fs.existsSync('codex.js') }) + '\\n');
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
    await server.service.refreshGithubCounts('acme/widgets');
    // When counts arrive in the background, open pages are told so they can show them.
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    server.service.bus.on('change', listen);
    await server.service.refreshGithubCounts('acme/fresh');
    server.service.bus.off('change', listen);
    assert.ok(events.includes('github_counts'), 'a change event when the counts change');
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

test('codex reviews when the author waits, within the limits in settings', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/codex');
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 41;\n');
  git('add', 'codex.js');
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
  assert.equal(call.args[call.args.indexOf('-s') + 1], 'read-only');
  assert.match(call.prompt, /Title: Add the answer/);
  assert.equal(call.sawFile, true, 'codex runs in a checkout of the head commit');
  assert.doesNotMatch(git('worktree', 'list'), /laatsux-review-/);

  // The cap: after one automatic review, a new commit and another wait start nothing.
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 42;\n');
  git('commit', '-qam', 'Fix the answer');
  const capped = await cli(['pr', 'wait', String(number), '--timeout', '2s']);
  assert.equal(capped.code, 124);

  // Raising this pull request's limit lets Codex go on, at once when the author is waiting.
  assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /data-limit="1"[^]*js-codex-step[^]*js-codex-step/);
  const resumed = cli(['pr', 'wait', String(number), '--timeout', '20s']);
  for (let i = 0; i < 100 && !(await human('GET', base)).author_waiting; i++) await new Promise((r) => setTimeout(r, 50));
  const selfRaise = await cli(['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${number}/reviewers/codex`, '-F', 'max_iterations=9']);
  assert.equal(selfRaise.code, 1, 'agents cannot raise their own limit');
  assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: '2' }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: 2 } });
  const second = await resumed;
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /automatic review 2 of 2/);

  // Asking from the page ignores the cap, and a failed run keeps its error.
  process.env.FAKE_CODEX_FAIL = '1';
  const pull = await human('GET', base);
  await human('POST', `${base}/reviewers/codex`);
  await server.service.codex!.settle(pull.id);
  delete process.env.FAKE_CODEX_FAIL;
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
  const renamed = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  assert.equal(renamed.match(/<span class="flex-auto">codex-bot<\/span>/g)?.length, 2, 'once under Reviewers, once under Codex');
  assert.doesNotMatch(renamed, /<span class="flex-auto">codex<\/span>/);
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
  await human('PUT', '/api/settings/codex', { enabled: false });
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
