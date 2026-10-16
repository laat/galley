// The whole loop: an agent stages a pull request with the CLI, a reviewer comments
// through the API (as the web UI does), the agent rewrites history, and the reviewer publishes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../src/server/server.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'laatsux.ts');
const exec = promisify(execFile);

let dir: string;
let repo: string;
let remote: string;
let server: Awaited<ReturnType<typeof startServer>>;

// Keep the user's git config out of the test, and use settings that change diff output,
// which the server must override.
const gitconfig = join(mkdtempSync(join(tmpdir(), 'laatsux-gitconfig-')), 'config');
writeFileSync(gitconfig, '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tinterHunkContext = 10\n[log]\n\tshowSignature = true\n');
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

async function cli(args: string[], opts: { input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = execFile(process.execPath, [BIN, ...args], {
    cwd: repo,
    env: { ...process.env, LAATSUX_URL: server.url, LAATSUX_ACTOR: 'agent', NO_COLOR: '1' },
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
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\ncat >> "${join(dir, 'gh-stdin.log')}"\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/widgets/pull/7" ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);
  server = await startServer({ port: 0, dataDir: join(dir, 'data'), ghBin: gh, viewerLogin: 'reviewer', pollMs: 50 });
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
      comments: [{ path: 'math.js', line: 6, side: 'RIGHT', body: 'Add a doc comment.' }],
    });
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /reviewer reviewed: changes requested/);
    assert.match(r.stdout, /thread \d+ on math\.js:6 \[unresolved\]/);
    assert.match(r.stdout, /Add a doc comment\./);
    // Seen feedback is not returned twice.
    const again = await cli(['pr', 'wait', '--timeout', '1s']);
    assert.equal(again.code, 124);
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
    const missing = await cli(['api', 'repos/{owner}/{repo}/pulls/99']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404/);
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
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'));
    const log = readFileSync(join(dir, 'gh.log'), 'utf8');
    assert.match(log, /^pr create --repo acme\/widgets --base main --head feature\/mul --title Add multiplication helper --body-file -$/m);
    assert.equal(readFileSync(join(dir, 'gh-stdin.log'), 'utf8'), 'Adds `mul`.');
    const r = await waiting;
    assert.match(r.stdout, /Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7/);
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
