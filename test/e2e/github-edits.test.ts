// Published pull requests: an edit of the title or description someone makes on GitHub comes back
// to galley when it follows them (following-github.test.ts), and the author hears of it.
import '../helpers/env.ts';
import { cli, dir, git, human, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

test('an edit of the title or description on GitHub comes back to galley', async (t) => {
  const url = 'https://github.com/acme/widgets/pull/7';
  /** Stage a branch with one commit as the agent, publish it as the reviewer, and let the agent hear of the publish. */
  const published = async (branch: string) => {
    const file = `${branch.split('/').pop()}.js`;
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', '--no-review']);
    assert.equal(created.code, 0, created.stderr);
    const n = created.stdout.trim().split('/').pop()!;
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    const { id } = await human('POST', `${base}/publish`, { sign: false });
    assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    return {
      n,
      id,
      base,
      wait: (timeout = '20s') => cli(['pr', 'wait', n, '--timeout', timeout]),
      /** Its edits of the title and description, as [event, from, to, github]. */
      edits: async () => ((await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)) as any[]).filter((e) => e.event === 'renamed' || e.event === 'body_edited').map((e) => [e.event, e.from, e.to, e.github]),
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(),
    };
  };
  /** What GitHub answers about the pull request, with this title and description, edited there by `by`. */
  const answer = (pr: { id: number }, title: string, body: string, by: { title?: string; body?: string } = {}) => {
    const renames = by.title ? [{ __typename: 'RenamedTitleEvent', actor: { login: by.title }, currentTitle: title }] : [];
    const node = { state: 'OPEN', title, body, editor: by.body ? { login: by.body } : null, timelineItems: { nodes: renames } };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: node } } }));
  };
  /** GitHub has this title and description (`gh pr view` says so too), and galley asks it, as it does every minute. */
  const githubHas = async (pr: { id: number }, title: string, body: string, by: { title?: string; body?: string } = {}) => {
    writeFileSync(join(dir, 'gh-title'), title);
    writeFileSync(join(dir, 'gh-body'), body);
    answer(pr, title, body, by);
    await server.service.followGithub();
  };

  await t.test('galley takes it in, the author hears of it once, and its own edits after it are published when it waits', async () => {
    const pr = await published('feature/gh-edit');
    const waiting = pr.wait();
    await until(async () => (await human('GET', pr.base)).author_waiting, 'the author waits');
    // Edited in a browser, whose line ends are CRLF.
    await githubHas(pr, 'Retitled on GitHub', 'Edited\r\non GitHub', { title: 'octocat', body: 'laat' });
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^octocat edited the title on GitHub, and galley has it now: Retitled on GitHub$/m);
    assert.match(r.stdout, new RegExp(`^laat edited the description on GitHub, and galley has it now\\. Read it with \`galley pr view s${pr.n}\` before you edit it\\.$`, 'm'));
    assert.match(r.stdout, new RegExp(`Run \`galley pr wait s${pr.n}\` again to hear when it is merged or closed on GitHub`));

    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.title, pull.body, pull.unpublished_changes], ['Retitled on GitHub', 'Edited\non GitHub', []]);
    const edits = [
      ['renamed', 'Add gh-edit.js', 'Retitled on GitHub', { url, by: 'octocat' }],
      ['body_edited', 'x', 'Edited\non GitHub', { url, by: 'laat' }],
    ];
    assert.deepEqual(await pr.edits(), edits);
    const page = await pr.page();
    assert.match(page, /href="https:\/\/github\.com\/octocat" target="_blank" rel="noopener">octocat<\/a> changed the title <del class="color-fg-muted">Add gh-edit\.js<\/del> <ins class="title-ins">Retitled on GitHub<\/ins> on GitHub/);
    assert.match(page, /href="https:\/\/github\.com\/laat" target="_blank" rel="noopener">laat<\/a> edited the description on GitHub/);

    // Asked again, GitHub says the same: nothing new.
    await githubHas(pr, 'Retitled on GitHub', 'Edited\r\non GitHub', { title: 'octocat', body: 'laat' });
    assert.equal((await pr.wait('1s')).code, 124);
    assert.deepEqual(await pr.edits(), edits);

    // GitHub's text is the one published now, as after a publish: the author's edit of it is its wait's to publish.
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Retitled by the agent'])).code, 0);
    assert.match((await pr.wait()).stdout, /^Published the title to GitHub: /m);
    assert.equal(readFileSync(join(dir, 'gh-title'), 'utf8'), 'Retitled by the agent');
    assert.deepEqual((await human('GET', pr.base)).unpublished_changes, []);
  });

  await t.test("GitHub's edit replaces one here that GitHub does not have, which the timeline keeps; the same text there is no edit", async () => {
    const pr = await published('feature/gh-edit-over');
    await human('PATCH', pr.base, { title: "The user's title", body: "The user's draft." });
    assert.deepEqual((await human('GET', pr.base)).unpublished_changes, ['title', 'description']);
    // Someone on GitHub gave it the same title, and another description.
    await githubHas(pr, "The user's title", 'Edited on GitHub', { title: 'octocat', body: 'octocat' });
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.title, pull.body, pull.unpublished_changes], ["The user's title", 'Edited on GitHub', []]);
    assert.deepEqual(await pr.edits(), [
      ['renamed', 'Add gh-edit-over.js', "The user's title", undefined],
      ['body_edited', 'x', "The user's draft.", undefined],
      // GitHub has the user's title: no edit, but published.
      ['renamed', "The user's title", "The user's title", { url, by: 'octocat' }],
      ['body_edited', "The user's draft.", 'Edited on GitHub', { url, by: 'octocat' }],
    ]);
    assert.doesNotMatch(await pr.page(), /changed the title <del class="color-fg-muted">The user&#39;s title<\/del>/);
    // A CLI from before galley took edits in is not told of them, which it would take for feedback.
    const old = await cli(['api', `repos/acme/widgets/pulls/${pr.n}/wait?timeout=1`]);
    assert.equal(JSON.parse(old.stdout).status, 'timeout', old.stderr);
    const r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^octocat edited the description on GitHub, and galley has it now\./m);
    assert.doesNotMatch(r.stdout, /edited the title/);
    // The user's title counts as published: the author's edit of it is its wait's to publish.
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', "The agent's title"])).code, 0);
    assert.match((await pr.wait()).stdout, /^Published the title to GitHub: /m);
    assert.equal(readFileSync(join(dir, 'gh-title'), 'utf8'), "The agent's title");
  });

  await t.test('a CLI from before galley took edits in, which confirms other news, leaves them for the next wait to tell', async () => {
    const pr = await published('feature/gh-edit-old-cli');
    await githubHas(pr, 'Retitled on GitHub', 'x', { title: 'octocat' });
    await human('POST', `/api/repos/acme/widgets/issues/${pr.n}/comments`, { body: 'Looks fine.' });
    // It hears of the comment, not of the edit, and confirms what it showed.
    const old = JSON.parse((await cli(['api', `repos/acme/widgets/pulls/${pr.n}/wait?timeout=5`])).stdout);
    assert.deepEqual([old.status, old.edited_on_github], ['feedback', null]);
    assert.equal((await cli(['api', '-X', 'PUT', `repos/acme/widgets/pulls/${pr.n}/seen`, '-f', `at=${old.seen_at}`])).code, 0);
    const r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^octocat edited the title on GitHub, and galley has it now: Retitled on GitHub$/m);
    assert.doesNotMatch(r.stdout, /Looks fine/);
    assert.equal((await pr.wait('1s')).code, 124);
  });

  await t.test("GitHub getting the user's text is nothing new for the user's dismissed turn", async () => {
    const pr = await published('feature/gh-edit-dismissed');
    await githubHas(pr, 'Add gh-edit-dismissed.js', 'x');
    await human('PATCH', pr.base, { title: "The user's title" });
    await human('PUT', `${pr.base}/dismissed`);
    await githubHas(pr, "The user's title", 'x');
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.title, pull.unpublished_changes], ["The user's title", []]);
    const timeline: any[] = await human('GET', `/api/repos/acme/widgets/issues/${pr.n}/timeline`);
    assert.equal(timeline.findLast((e) => e.event === 'turn_dismissed').ended, undefined);
  });

  await t.test("an edit the author's wait left because GitHub had another is not left once GitHub's is taken in", async () => {
    const pr = await published('feature/gh-edit-left');
    // Retitled on GitHub, before galley asks.
    writeFileSync(join(dir, 'gh-title'), 'Retitled on GitHub');
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Retitled by the agent'])).code, 0);
    const left = await pr.wait();
    assert.match(left.stdout, /^Could not publish the title to GitHub: someone edited the title on GitHub since galley published it\. Nothing on GitHub was overwritten\. galley takes GitHub's title in, and a wait tells you of it; do not edit it on GitHub yourself\.$/m);
    await githubHas(pr, 'Retitled on GitHub', 'x', { title: 'octocat' });
    assert.match((await pr.wait()).stdout, /^octocat edited the title on GitHub, and galley has it now: Retitled on GitHub$/m);
    // The same text as the try that was left, which GitHub had another title for then.
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Retitled by the agent'])).code, 0);
    assert.match((await pr.wait()).stdout, /^Published the title to GitHub: /m);
    assert.equal(readFileSync(join(dir, 'gh-title'), 'utf8'), 'Retitled by the agent');
  });

  await t.test('an answer GitHub gave about the text before galley published the author’s edit there does not take it back', async () => {
    const pr = await published('feature/gh-edit-race');
    const gate = join(dir, 'gh-edit-follow-gate');
    try {
      await withFakes({ FAKE_GH_FOLLOW_GATE: gate }, async () => {
        answer(pr, 'Add gh-edit-race.js', 'x');
        const following = server.service.followGithub();
        await until(() => existsSync(`${gate}.asked`), 'GitHub is asked');
        assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Retitled by the agent'])).code, 0);
        assert.match((await pr.wait()).stdout, /^Published the title to GitHub: /m);
        writeFileSync(gate, '');
        await following;
      });
    } finally {
      rmSync(gate, { force: true });
      rmSync(`${gate}.asked`, { force: true });
    }
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.title, pull.unpublished_changes], ['Retitled by the agent', []]);
    assert.deepEqual(await pr.edits(), [['renamed', 'Add gh-edit-race.js', 'Retitled by the agent', undefined]]);
  });
});
