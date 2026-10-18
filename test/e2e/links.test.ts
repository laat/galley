// Links to comments and threads: the one URL the API, gh's shapes, the CLI and each comment's Copy
// link give, and what a pull request's pages tell public/app.js about where a comment is shown.
// Opening, scrolling to and flashing it, and going on to another tab, happen in the browser.
import '../helpers/env.ts';
import { cli, git, handedOver, human, repo, server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a comment links to the Conversation tab at it, wherever its link is given', async (t) => {
  // A second commit renames the function the first one added.
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'math.js'), readFileSync(join(repo, 'math.js'), 'utf8').replace('function mul', 'function times'));
  git('commit', '-qam', 'Rename mul');
  const second = git('rev-parse', 'HEAD');
  const created = await cli(['pr', 'create', '--title', 'Add multiplication', '--body', 'Adds `mul`.', '--no-review']);
  assert.equal(created.code, 0, created.stderr);
  const pull = `${server.url}/acme/widgets/pull/1`;
  const api = '/api/repos/acme/widgets/pulls/1';
  const page = async (tab: string) => (await fetch(`${pull}${tab}`)).text();
  await handedOver();

  const root = await human('POST', `${api}/comments`, { path: 'math.js', line: 6, side: 'RIGHT', body: 'Add a doc comment.' });
  const reply = await cli(['pr', 'comment', '--reply-to', String(root.id), '-b', 'Will do.']);
  assert.equal(reply.code, 0, reply.stderr);
  const replyUrl = reply.stdout.trim();
  const replyId = Number(replyUrl.match(/#discussion_r(\d+)$/)![1]);
  const onCommit = await human('POST', `${api}/comments`, { subject_type: 'commit', commit_id: first, body: 'Say why.' });
  const issue = await cli(['pr', 'comment', '-b', 'Ready.']);
  const issueUrl = issue.stdout.trim();
  const issueId = Number(issueUrl.match(/#issuecomment-(\d+)$/)![1]);

  await t.test("the API's html_url and gh's url are the Conversation tab at the comment", async () => {
    assert.equal(root.html_url, `${pull}#discussion_r${root.id}`);
    assert.equal(replyUrl, `${pull}#discussion_r${replyId}`);
    assert.equal(issueUrl, `${pull}#issuecomment-${issueId}`);
    const listed = await human('GET', `${api}/comments`);
    assert.deepEqual(
      listed.map((c: any) => c.html_url),
      [root.id, replyId, onCommit.id].map((id) => `${pull}#discussion_r${id}`),
    );
    const gh = await human('GET', '/api/repos/acme/widgets/gh/pulls/1?fields=reviewThreads,comments');
    assert.deepEqual(
      gh.reviewThreads.flatMap((th: any) => th.comments.map((c: any) => c.url)),
      [root.id, replyId, onCommit.id].map((id) => `${pull}#discussion_r${id}`),
    );
    assert.deepEqual(gh.comments.map((c: any) => c.url), [`${pull}#issuecomment-${issueId}`]);
  });

  await t.test("every comment's menu has Copy link, which copies that URL, beside its timestamp's link", async () => {
    // The reviewer's own comments also have Edit and Delete; the agent's only Copy link.
    const comment = (text: string, anchor: string) => text.match(new RegExp(`<div class="review-comment" id="${anchor}">[^]*?<div class="review-comment-body">`))?.[0];
    for (const tab of ['', '/files']) {
      const text = await page(tab);
      const mine = comment(text, `discussion_r${root.id}`)!;
      assert.match(mine, new RegExp(`<a href="#discussion_r${root.id}" class="link-muted">`), tab);
      assert.match(mine, new RegExp(`<button type="button" class="dropdown-item js-copy-link" data-copy="${escape(`${pull}#discussion_r${root.id}`)}">Copy link</button>\\s*<div class="dropdown-divider"></div>\\s*<button type="button" class="dropdown-item js-comment-edit">Edit</button>`), tab);
      const agents = comment(text, `discussion_r${replyId}`)!;
      assert.match(agents, new RegExp(`<button type="button" class="dropdown-item js-copy-link" data-copy="${escape(replyUrl)}">Copy link</button>\\s*</div>`), tab);
      assert.doesNotMatch(agents, /js-comment-edit/, tab);
    }
    const commits = await page('/commits');
    assert.match(comment(commits, `discussion_r${onCommit.id}`)!, new RegExp(`data-copy="${escape(`${pull}#discussion_r${onCommit.id}`)}">Copy link<`));
    const conversation = await page('');
    assert.match(conversation, new RegExp(`<div class="timeline-comment-group" id="issuecomment-${issueId}">[^]*?<a href="#issuecomment-${issueId}" class="link-muted">[^]*?data-copy="${escape(issueUrl)}">Copy link</button>\\s*</div>`));
    assert.match(conversation, new RegExp(`<div class="timeline-comment-group" id="pullrequest-description">[^]*?data-copy="${escape(`${pull}#pullrequest-description`)}">Copy link</button>\\s*<div class="dropdown-divider"></div>\\s*<button type="button" class="dropdown-item js-comment-edit">Edit</button>\\s*</div>`));
  });

  await t.test("each tab tells the page where a comment it does not show is: a pending one's tab, else the Conversation tab", async () => {
    const onLine = await human('POST', `${api}/pending-comments`, { path: 'math.js', line: 5, body: 'Draft.' });
    const onMessage = await human('POST', `${api}/pending-comments`, { subject_type: 'commit', commit_id: first, body: 'Draft about the message.' });
    // On the old side of the second commit's diff, on a line the first commit added, which the pull
    // request's diff does not have: only the diff of that commit shows it.
    const onOldSide = await human('POST', `${api}/pending-comments`, { path: 'math.js', line: 5, side: 'LEFT', commit_id: second, base_commit_id: first, body: 'Draft on the old side.' });
    const range = `/acme/widgets/pull/1/files?range=${first}..${second}`;
    const tabs = JSON.stringify({ [onLine.id]: '/acme/widgets/pull/1/files', [onMessage.id]: '/acme/widgets/pull/1/commits', [onOldSide.id]: range });
    for (const tab of ['', '/files', '/commits']) {
      const main = (await page(tab)).match(/<div id="main"[^>]*>/)![0];
      assert.match(main, / data-conversation-url="\/acme\/widgets\/pull\/1"/, tab);
      assert.ok(main.includes(` data-comment-tabs="${tabs.replaceAll('"', '&quot;')}"`), `${tab}: ${main}`);
    }
    // Where they are shown, as threads that open and scroll to their comments.
    assert.match(await page('/files'), new RegExp(`<details class="review-thread" id="thread-${onLine.id}"[^]*?<div class="review-comment" id="discussion_r${onLine.id}">`));
    assert.match(await page('/commits'), new RegExp(`<details class="review-thread" id="thread-${onMessage.id}"[^]*?<div class="review-comment" id="discussion_r${onMessage.id}">`));
    assert.doesNotMatch(await page('/files'), new RegExp(`id="thread-${onOldSide.id}"`));
    assert.match(await page(range.replace('/acme/widgets/pull/1', '')), new RegExp(`<details class="review-thread is-outdated" id="thread-${onOldSide.id}"`));
    const review = (await human('GET', `${api}/reviews`)).find((r: any) => r.state === 'PENDING').id;
    await human('DELETE', `${api}/reviews/${review}`);
    assert.match((await page('')).match(/<div id="main"[^>]*>/)![0], / data-comment-tabs="\{\}"/);
  });

  await t.test("pr view --comments and pr wait print each thread's link after it", async () => {
    const view = await cli(['pr', 'view', '--comments']);
    assert.equal(view.code, 0, view.stderr);
    assert.match(view.stdout, new RegExp(`^  thread ${root.id} on math\\.js:6 \\[unresolved\\] ${escape(root.html_url)}\\n`, 'm'));
    assert.match(view.stdout, new RegExp(`^  thread ${onCommit.id} on the message of commit ${first.slice(0, 7)} "Add mul" \\[unresolved\\] ${escape(`${pull}#discussion_r${onCommit.id}`)}\\n`, 'm'));
    // A reply that came after its review shows its whole thread, with the link to the thread.
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await until(async () => (await human('GET', api)).author_waiting, 'the agent waits');
    await human('POST', `${api}/comments/${root.id}/replies`, { body: 'Thanks.' });
    const wait = await waiting;
    assert.equal(wait.code, 0, wait.stderr);
    assert.match(wait.stdout, new RegExp(`^reviewer replied:\\n  thread ${root.id} on math\\.js:6 \\[unresolved\\] ${escape(root.html_url)}\\n`, 'm'));
  });
});
