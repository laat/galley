// The whole loop: an agent stages a pull request with the CLI, a reviewer comments
// through the API (as the web UI does), the agent rewrites history, and the reviewer publishes.
// And what pages show beside it: Markdown, pasted images, the repository at a commit, the file tree.
import '../helpers/env.ts';
import { BIN, cli, digitCommit, dir, exec, git, handedOver, human, inClone, remote, repo, send, server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

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
    assert.deepEqual(JSON.parse(r.stdout), { number: 1, title: 'Add multiplication', state: 'STAGED', author: { login: 'agent', is_bot: true }, headRefName: 'feature/mul', isDraft: false });
    const jq = await cli(['pr', 'view', '1', '--json', 'commits', '--jq', '.commits[].messageHeadline']);
    assert.equal(jq.code, 0, jq.stderr);
    assert.equal(jq.stdout.trim(), 'Add mul');
    const list = await cli(['pr', 'list']);
    assert.match(list.stdout, /^s#1\tAdd multiplication\tfeature\/mul\tSTAGED\t/);
  });

  await t.test('a staged pull request is s#1: the CLI takes s1, s#1 and, as gh, 1 and #1, and its page is at /pull/s1 too', async () => {
    for (const arg of ['s1', 's#1', 'S1', '1', '#1', `${server.url}/acme/widgets/pull/s1`, `${server.url}/acme/widgets/pull/1/files`]) {
      const r = await cli(['pr', 'view', arg, '--json', 'number,ref']);
      assert.equal(r.code, 0, `${arg}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), { number: 1, ref: 's1' }, arg);
    }
    assert.match((await cli(['pr', 'view', '1'])).stdout, /^number:\ts#1$/m);
    const res = await fetch(`${server.url}/acme/widgets/pull/s1/files?diff=split`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/acme/widgets/pull/1/files?diff=split');
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<title>Add multiplication by agent · Pull Request s#1 · acme\/widgets<\/title>/);
    assert.match(page, /<span class="gh-header-number">s#1<\/span>/);
  });

  await t.test('pr wait says when the reviewer agents are done with a commit, once', async () => {
    // Codex is off in settings, so no reviewer agent reviews it: the reviewer's turn at once. The
    // API tells it apart from feedback, and says it again until the author confirms it.
    const earlier: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/wait?timeout=5`, { headers: { 'x-galley-actor': 'agent' } });
      const body = await res.json();
      assert.deepEqual([body.status, body.reviews, body.comments, body.agents_done], ['agents_done', [], [], { sha: git('rev-parse', 'HEAD'), reviewers: [] }]);
      earlier.push(body.seen_at);
    }
    const r = await cli(['pr', 'wait', '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    const sha = git('rev-parse', '--short=7', 'HEAD');
    assert.equal(r.stdout, `No reviewer agent reviews ${sha}; ask the user to review it: ${server.url}/acme/widgets/pull/1\nThen run \`galley pr wait s1\` to wait for the review.\n`);
    // A confirmation that arrives late, from an earlier wait about an earlier commit (overlapping
    // waits, a retry), does not take back the newer one.
    const late = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/seen`, {
      method: 'PUT',
      headers: { 'x-galley-actor': 'agent', 'content-type': 'application/json' },
      body: JSON.stringify({ at: earlier[0], agents_done: git('rev-parse', 'main') }),
    });
    assert.equal(late.status, 204);
    // Once per commit: the next wait waits for the reviewer.
    assert.equal((await cli(['pr', 'wait', '--timeout', '1s'])).code, 124);
  });

  await t.test('pr wait returns the review the reviewer submits', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    // Wait until the server sees the agent waiting, as the UI would show it.
    await until(async () => (await human('GET', '/api/repos/acme/widgets/pulls/1')).author_waiting, 'the server sees the agent waiting');
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', {
      event: 'REQUEST_CHANGES',
      body: 'Almost.',
      comments: [{ path: 'math.js', line: 6, side: 'RIGHT', body: 'Add a doc comment.', priority: 'high' }],
    });
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /reviewer reviewed: changes requested/);
    assert.match(r.stdout, /thread \d+ on math\.js:6 \[unresolved\] \(high priority\)/);
    // The priority is the thread's: it shows once, at the right end of the thread's header.
    const files = await (await fetch(`${server.url}/acme/widgets/pull/1/files`)).text();
    assert.match(files, /<summary class="review-thread-header">[^]*?<span class="Label Label--priority Label--priority-high" title="Priority">High<\/span>\s*<span class="review-thread-toggle">[^]*?<\/summary>/);
    assert.equal(files.match(/Label--priority-high/g)?.length, 1);
    assert.match(r.stdout, /Add a doc comment\./);
    // Seen feedback is not returned twice.
    const again = await cli(['pr', 'wait', '--timeout', '1s']);
    assert.equal(again.code, 124);
  });

  await t.test('an approval without text still reaches the agent', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await until(async () => (await human('GET', '/api/repos/acme/widgets/pulls/1')).author_waiting, 'the agent waits');
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
    // The old head is kept reachable for the revision history, in galley's clone.
    const pins = inClone('for-each-ref', '--format=%(refname)', `refs/galley/${server.service.db.instance}/pull/1/`);
    assert.deepEqual(pins.split('\n'), [1, 2].map((seq) => `refs/galley/${server.service.db.instance}/pull/1/${seq}`));
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
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page.match(new RegExp(`id="thread-${review.id}"[^]*?</summary>`))![0], /<span class="review-thread-range">L8–10<\/span>/);
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
    const review = reviews.find((r: any) => r.state === 'PENDING').id;
    // The Commits tab tells its comment forms (public/app.js, from #main) to add to the pending review.
    const commits = async () => (await (await fetch(`${server.url}/acme/widgets/pull/1/commits`)).text()).match(/<div id="main"[^>]*>/)![0];
    assert.match(await commits(), new RegExp(` data-pending-review="${review}"`));
    await human('DELETE', `/api/repos/acme/widgets/pulls/1/reviews/${review}`);
    assert.match(await commits(), / data-pending-review=""/);
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
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /Resolved by agent</);
    // The collapsed header shows the priority, not a "Resolved" label.
    const header = page.match(new RegExp(`id="thread-${target}"[^]*?</summary>`))![0];
    assert.match(header, /Label--priority-high/);
    assert.doesNotMatch(header, />Resolved</);
  });

  await t.test('agents other than the author cannot publish, and stale pages cannot publish', async () => {
    const r = await cli(['pr', 'publish'], { actor: 'observer' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only the user or the author of this pull request \(agent\) can publish it, not observer/);
    const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected: 'deadbeef:0000' }),
    });
    assert.equal(res.status, 412);
  });

  await t.test('publishing pushes the reviewed commit and opens the pull request', async () => {
    await handedOver();
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await until(async () => (await human('GET', '/api/repos/acme/widgets/pulls/1')).author_waiting, 'the agent waits');
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

  await t.test("the reviewer's publish approves what it published, over their earlier request for changes, and feedback after it is the agent's to address", async () => {
    const decision = async () => JSON.parse((await cli(['pr', 'view', '--json', 'reviewDecision'])).stdout).reviewDecision;
    assert.equal(await decision(), 'APPROVED');
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<span class="flex-auto">reviewer<\/span> <span title="Approved by publishing"><svg class="octicon octicon-check color-fg-success"/);
    assert.match(page, /<strong>Changes approved<\/strong>/);
    // A comment after it asks something of the agent: not an approval to wait on.
    await human('POST', '/api/repos/acme/widgets/issues/1/comments', { body: 'Also bump the version.' });
    const r = await cli(['pr', 'wait', '--timeout', '20s']);
    assert.match(r.stdout, /Also bump the version\./);
    assert.match(r.stdout, /^Address the feedback\./m);
    assert.doesNotMatch(r.stdout, /Approved with nothing left open/);
    // A review that only comments leaves the approval standing, as on GitHub.
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'COMMENT', body: 'Looks fine otherwise.' });
    assert.equal(await decision(), 'APPROVED');
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/1`)).text(), /<span class="flex-auto">reviewer<\/span> <span title="Approved by publishing">/);
    // Requesting changes after publishing counts over it.
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'REQUEST_CHANGES', body: 'One more thing.' });
    assert.equal(await decision(), 'CHANGES_REQUESTED');
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/1`)).text(), /<span class="flex-auto">reviewer<\/span> <svg class="octicon octicon-file-diff color-fg-danger"/);
    await cli(['pr', 'view', '--comments']);
  });

  await t.test('publishing new commits signs only those and fast-forwards GitHub', async () => {
    const before = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'README.md'), '# widgets\n');
    git('add', 'README.md');
    git('commit', '-qm', 'Add a readme');
    await send('feature/mul');
    await human('POST', '/api/repos/acme/widgets/pulls/1/publish', {});
    const after = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${after}^`], { encoding: 'utf8' }).trim(), before);
    // The signed copies are kept from garbage collection: the ref moves from the earlier ones.
    assert.equal(inClone('rev-parse', `refs/galley/${server.service.db.instance}/pull/1/published`), after);
    const timeline = await human('GET', '/api/repos/acme/widgets/issues/1/timeline');
    assert.equal(timeline.filter((e: any) => e.event === 'published').at(-1).signed, 1);
    // The signed copies count as the staged commits: nothing is left to publish.
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /GitHub has the same commits, title and description/);
  });

  await t.test('a rewritten branch needs force to publish again', async () => {
    git('commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Reworded.');
    await send('feature/mul');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', {}), /409|rejected|git push failed/);
    // A published ref at a commit galley did not sign is not its to move.
    const published = `refs/galley/${server.service.db.instance}/pull/1/published`;
    const unsigned = git('rev-parse', 'main');
    inClone('update-ref', published, unsigned);
    const errors = mock.method(console, 'error', () => {});
    try {
      await human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true });
    } finally {
      errors.mock.restore();
    }
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr edit https:\/\/github\.com\/acme\/widgets\/pull\/7 --title/m);
    assert.equal(inClone('rev-parse', published), unsigned);
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(logged.some((line) => line.startsWith(`left ${published} alone in `) && line.endsWith(`it points at ${unsigned}, which galley did not sign`)), logged.join('\n'));
    inClone('update-ref', published, execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim());
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
    await send('feature/mul');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true }), /changed since it was last published/);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim(), theirs);
  });

  await t.test('pr wait reports feedback that comes with a close', async () => {
    // The agent has seen everything so far (including the last publish).
    await cli(['pr', 'view', '--comments']);
    // Published, its wait pushes the rewritten history, which the commit added on GitHub refuses, once.
    assert.match((await cli(['pr', 'wait', '--timeout', '20s'])).stdout, /^Could not push [0-9a-f]{7} to GitHub: git push failed \(the branch on GitHub changed since it was last published/m);
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await until(async () => (await human('GET', '/api/repos/acme/widgets/pulls/1')).author_waiting, 'the agent waits');
    await human('POST', '/api/repos/acme/widgets/issues/1/comments', { body: 'Closing: we went another way.' });
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'closed' });
    const r = await waiting;
    assert.match(r.stdout, /Closing: we went another way\./);
    // A closed pull request does not leave the agent waiting forever.
    const again = await cli(['pr', 'wait', '--timeout', '5s']);
    assert.match(again.stdout, /closed .* without publishing/);
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'open' });
  });

  await t.test('the repository page links to the repository on GitHub', async () => {
    await server.service.refreshGithubRepo('acme/widgets');
    // Owner and name go as strings (-f): -F would make a repository called "123" a number.
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^api graphql -f query=.* -f owner=acme -f name=widgets$/m);
    const link = (slug: string) => new RegExp(`<h1 class="page-title">[^<]*</h1><a class="page-title-github" href="https://github\\.com/${slug}" target="_blank" rel="noopener" title="${slug} on GitHub"><svg class="octicon octicon-mark-github"[^]*?</svg> ${slug} <svg class="octicon octicon-link-external"`);
    assert.match(await (await fetch(`${server.url}/acme/widgets`)).text(), link('acme/widgets'));
    // No tabs for the repository under the header; the breadcrumbs lead back to its page, and start
    // with it: the logo before them is the way to the front page, whose header has no crumbs.
    const { head } = await human('GET', '/api/repos/acme/widgets/pulls/1');
    for (const path of ['/acme/widgets', '/acme/widgets/pull/1', `/acme/widgets/tree/${head.sha}`]) {
      const page = await (await fetch(server.url + path)).text();
      assert.doesNotMatch(page, /UnderlineNav|github\.com\/acme\/widgets\/(pulls|issues)/, path);
      assert.match(page, /<nav class="app-header-context"><a href="\/acme\/widgets"><strong>acme\/widgets<\/strong><\/a>/, path);
    }
    const front = await (await fetch(`${server.url}/`)).text();
    assert.match(front, /<a class="app-header-logo" href="\/" title="All staged pull requests" aria-label="galley">[^]*?<\/a>\s*<nav class="app-header-context"><\/nav>/);
    // At the other end, your avatar is the way to the settings.
    assert.match(front, /<a class="app-header-avatar" href="\/settings" title="Settings" aria-label="Settings"><img class="avatar avatar-circle" [^>]*><\/a>\s*<\/div>\s*<\/div>\s*<\/header>/);
    // One registered by path before galley kept clones, without a GitHub remote: no link.
    server.service.db.insert('repos', { git_dir: join(dir, 'elsewhere', '.git'), work_dir: join(dir, 'elsewhere'), owner: 'local', name: 'elsewhere', remote: 'origin', github_slug: null, created_at: new Date().toISOString() });
    const local = await (await fetch(`${server.url}/local/elsewhere`)).text();
    assert.match(local, /<h1 class="page-title">/);
    assert.doesNotMatch(local, /page-title-github/);
  });

  await t.test('web pages render', async () => {
    // Published by now, it is on the Published tab.
    for (const path of ['/?state=published', '/acme/widgets?state=published', '/acme/widgets/pull/1', '/acme/widgets/pull/1/commits', '/acme/widgets/pull/1/files', '/acme/widgets/pull/1/files?diff=split']) {
      const res = await fetch(server.url + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Add multiplication helper/, path);
    }
    // Its number here, and where it is on GitHub.
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<span class="gh-header-number">s#1 → <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">acme\/widgets#7<\/a><\/span>/);
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
  // Sent before the amend, so galley has it.
  await send('feature/links');
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
  await until(async () => titled.test(await page()), 'the page has the title of issue 12');
  server.service.bus.off('change', listen);
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
  // s#N is a staged pull request here, with its title; one there is none of stays text.
  assert.match(await preview(`Follows s#${number} and s#999`, api), new RegExp(`Follows <a class="issue-link" href="/acme/widgets/pull/${number}" title="Links · staged">s#${number}</a> and s#999`));
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
    // Read to its end before it is refused, so the client was done sending, and the connection carries on.
    assert.equal(streamed.headers.get('connection'), 'keep-alive');
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
      `/uploads/${hash}.png/../../galley.db`,
      '//evil.example/a.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      for (const text of [`![x](${src})`, `<img src="${src}" alt="x">`]) assert.match(await render(text), /^(<p>)?<img alt="x" \/>(<\/p>)?$/m, text);
    }
  });

  await t.test('pr wait and pr view --comments list the images, and --download-images saves them', async () => {
    await handedOver(number);
    const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
    await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: `It is cut off:\n\n![screenshot](${path})` });
    const woken = await waiting;
    assert.equal(woken.code, 0, woken.stderr);
    assert.match(woken.stdout, new RegExp(`^    !\\[screenshot\\]\\(${path}\\)\n    Image: ${server.url}${path}$`, 'm'));
    assert.match(woken.stdout, new RegExp(`galley pr view s${number} --comments --download-images <dir>`));

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
    assert.doesNotMatch(before, /stored in galley/);
    await human('PATCH', base, { body: `Before and after:\n\n![before](${path})\n![after](${path.replace('.png', '.gif')})` });
    assert.match(await page(), /The description has 2 images stored in galley, which GitHub cannot show\. Remove them, or replace them with images uploaded to GitHub\./);
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
  mkdirSync(join(repo, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(repo, 'nested', 'deeper', 'leaf.txt'), 'leaf\n');
  writeFileSync(join(repo, 'nested', 'top.txt'), 'top\n');
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

  await t.test('a file tree beside the pages, open down to the page, its directories loading when opened', async () => {
    const at = (path: string) => `/acme/widgets/${path}`.replace('@', head);
    // A file: its directories open, the file highlighted, other directories closed and empty.
    const leaf = await page(at('blob/@/nested/deeper/leaf.txt'));
    assert.match(leaf.text, new RegExp(`<nav class="file-tree browse-tree js-browse-tree" aria-label="Files" data-sha="${head}" data-items="/acme/widgets/file-tree/${head}" data-paths="/acme/widgets/tree-list/${head}"`));
    assert.match(leaf.text, /<details data-path="nested" open><summary>/);
    assert.match(leaf.text, /<details data-path="nested\/deeper" open><summary>/);
    assert.match(leaf.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/deeper/leaf\\.txt" aria-current="page">`));
    assert.match(leaf.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/top\\.txt">`));
    assert.match(leaf.text, /<details data-path="dir with space"><summary>/);
    assert.doesNotMatch(leaf.text, /notes\.md/);
    assert.equal(leaf.text.match(/aria-current="page"/g)?.length, 1);
    // A directory: open and highlighted itself.
    const dirPage = await page(at('tree/@/nested/deeper'));
    assert.match(dirPage.text, new RegExp(`<a class="tree-name" href="/acme/widgets/tree/${head}/nested/deeper" aria-current="page">deeper</a>`));
    assert.match(dirPage.text, /<details data-path="nested\/deeper" open><summary>/);
    // The root: nothing open, directories before files.
    const root = await page(at('tree/@'));
    assert.doesNotMatch(root.text, /<details data-path="[^"]*" open>/);
    assert.doesNotMatch(root.text, /aria-current/);
    assert.match(root.text, /data-path="nested"[^]*long\.js/);

    // A directory's items, as the tree loads them.
    const items = await page(at('file-tree/@/nested'));
    assert.equal(items.status, 200);
    assert.match(items.text, /^<ul><li class="tree-dir"><details data-path="nested\/deeper"><summary>/);
    assert.match(items.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/top\\.txt">.*<span class="tree-name">top\\.txt</span></a></li></ul>$`));
    assert.match((await page(at('file-tree/@/dir%20with%20space'))).text, new RegExp(`<a href="/acme/widgets/blob/${head}/dir%20with%20space/notes\\.md">`));
    assert.match((await page(at('file-tree/@'))).text, /data-path="nested"/);
    for (const path of ['file-tree/@/long.js', 'file-tree/@/nope', 'file-tree/@/nested/..%2F..%2Fetc', `file-tree/${'0'.repeat(40)}`, 'file-tree/not-a-sha/nested', 'tree-list/not-a-sha']) {
      assert.equal((await page(at(path))).status, 404, path);
    }

    // Every file's path, for "Go to file"; the browser keeps it when asked by full SHA.
    const list = await page(at('tree-list/@'));
    const paths: string[] = JSON.parse(list.text).paths;
    assert.ok(paths.includes('nested/deeper/leaf.txt') && paths.includes('dir with space/notes.md') && paths.includes('long.js'), paths.join());
    assert.ok(!paths.includes('doomed.txt') && !paths.includes('nested'), paths.join());
    assert.match(list.headers.get('cache-control')!, /immutable/);
    assert.equal((await page(`/acme/widgets/tree-list/${head.slice(0, 7)}`)).headers.get('cache-control'), null);
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

  await t.test('galley browse prints the URL of a pull request, file or directory', async () => {
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
    assert.match(none.stderr, /no pull request s#99999 in acme\/widgets/);
    const neither = await cli(['browse', '1234567']);
    assert.equal(neither.code, 1);
    assert.match(neither.stderr, /no pull request or commit "1234567" in acme\/widgets/);
    const missing = await cli(['browse', 'doomed.txt']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /doomed\.txt does not exist at [0-9a-f]{7}/);
    // The URLs work.
    assert.equal((await page(new URL(await browse('long.js:12', '--commit', head)).pathname)).status, 200);
  });

  await t.test('galley browse --repo looks up commits and paths in that repository, through the server', async () => {
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '--allow-empty', '-m', 'Other']);
    const browseFrom = (cwd: string, ...args: string[]) =>
      exec(process.execPath, [BIN, 'browse', ...args], { cwd, env: { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: 'agent', NO_COLOR: '1' } }).then(
        (r) => r.stdout.trim(),
        (e) => `exit ${e.code}: ${e.stderr.trim()}`,
      );
    // Without --commit, the default branch, as on GitHub.
    const main = inClone('rev-parse', 'refs/remotes/origin/main');
    for (const cwd of [other, dir]) {
      assert.equal(await browseFrom(cwd, '-R', 'acme/widgets', 'math.js:2'), `${server.url}/acme/widgets/blob/${main}/math.js#L2`, cwd);
    }
    const now = git('rev-parse', 'HEAD');
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', 'long.js:3', '--commit', head.slice(0, 7)), `${server.url}/acme/widgets/blob/${head}/long.js#L3`);
    assert.equal(await browseFrom(other, '--repo=acme/widgets', '-b', 'browse-base', 'doomed.txt'), `${server.url}/acme/widgets/blob/${base}/doomed.txt`);
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', '/dir with space/', '-c', now), `${server.url}/acme/widgets/tree/${now}/dir%20with%20space`);
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
  await send('feature/tree');
  assert.deepEqual(await tree(), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
  assert.deepEqual(await tree('?diff=split'), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
});
