// A pull request's link back to the author's session, such as its T3 Code thread: the author gives
// it with `pr create --link` or `pr edit --link`, galley shows it, and GitHub never gets it.
import '../helpers/env.ts';
import { cli, dir, git, human, repo, server, startHarness } from '../helpers/harness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

const thread = 't3code://threads/80bfeaad-cd4a-455e-b90e-9b5805ecbfcd/be3e88e5-6e9b-463a-b73b-a02ea2550806';

test("the author's link to its session is on the pull request's pages, and is never published", async (t) => {
  writeFileSync(join(repo, 'links.js'), 'export {};\n');
  git('add', 'links.js');
  git('commit', '-qm', 'Add links.js');
  const created = await cli(['pr', 'create', '--title', 'Add links.js', '--body', 'Adds a file.', '--no-review', '--link', thread]);
  assert.equal(created.code, 0, created.stderr);
  const n = created.stdout.trim().split('/').pop()!;
  const api = `/api/repos/acme/widgets/pulls/${n}`;
  const page = async (path = `/acme/widgets/pull/${n}`) => (await fetch(server.url + path)).text();

  await t.test('pr create --link keeps it, as `link` in the API and in gh --json', async () => {
    assert.equal((await human('GET', api)).link, thread);
    const json = await cli(['pr', 'view', n, '--json', 'link']);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { link: thread });
    assert.match((await cli(['pr', 'view', n])).stdout, new RegExp(`^link:\\t${thread}$`, 'm'));
  });

  await t.test("the pull request's header and its row in the list link to it, an app's link without a new tab", async () => {
    assert.ok((await page()).includes(`<a class="btn btn-sm" href="${thread}" title="${thread}">`), 'header');
    assert.match(await page(), /<svg class="octicon octicon-link"[^>]*>.*?<\/svg> Open in T3 Code<\/a>/);
    const list = await page('/acme/widgets');
    assert.ok(list.includes(`<a class="pr-row-link link-muted" href="${thread}" title="${thread}"><svg class="octicon octicon-link" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Open in T3 Code"`), 'list row');
  });

  await t.test('pr edit --link changes it, a web page opens in a new tab, and one that would run script is refused', async () => {
    const web = 'https://example.com/session/1';
    const before = (await human('GET', api)).updated_at;
    assert.equal((await cli(['pr', 'edit', n, '--link', web])).code, 0);
    const after = await human('GET', api);
    assert.equal(after.link, web);
    // Not activity: the pull request keeps its place in the lists.
    assert.equal(after.updated_at, before);
    assert.ok((await page()).includes(`<a class="btn btn-sm" href="${web}" title="${web}" target="_blank" rel="noopener">`));
    assert.match(await page(), /<\/svg> example\.com<\/a>/);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'not a url']) {
      const refused = await cli(['pr', 'edit', n, '--link', bad]);
      assert.notEqual(refused.code, 0, bad);
      assert.match(refused.stderr, /link/, bad);
    }
    assert.equal((await human('GET', api)).link, web);
    // Nothing in the timeline: it is not part of the pull request.
    const timeline = await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`);
    assert.ok(!JSON.stringify(timeline).includes('example.com'));
    assert.equal((await cli(['pr', 'edit', n, '--link', thread])).code, 0);
  });

  await t.test('publishing gives GitHub the title and description, not the link', async () => {
    await human('POST', `${api}/publish`, { sign: false });
    assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    assert.equal(readFileSync(join(dir, 'gh-body'), 'utf8'), 'Adds a file.');
    assert.ok(!readFileSync(join(dir, 'gh.log'), 'utf8').includes('t3code'));
    assert.ok(!readFileSync(join(dir, 'gh-stdin.log'), 'utf8').includes('t3code'));
    // And it stays on the page, where the user still goes to the author from.
    assert.ok((await page()).includes(`href="${thread}"`));
  });

  await t.test('pr edit --link "" removes it', async () => {
    assert.equal((await cli(['pr', 'edit', n, '--link', ''])).code, 0);
    assert.equal((await human('GET', api)).link, null);
    assert.ok(!(await page()).includes('t3code:'));
    assert.ok(!(await page('/acme/widgets?state=all')).includes('pr-row-link'));
  });
});
