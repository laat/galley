// A new review loop that the author asks for when the user tells it to (`pr edit --add-reviewer`):
// before publishing, the reviewer agents review the head again; after it, they review the author's
// commits as before publishing, and galley pushes one only once they are done with it.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { published } from '../helpers/pushes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRow } from '../../src/server/db.ts';

startHarness();

const clean = JSON.stringify({ summary: 'Fine.', comments: [] });

/** The agent's waits until one hands the head to the user, the reviews before it read. */
async function untilHandedOver(n: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const r = await cli(['pr', 'wait', n, '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    if (/; ask the user to review it: /.test(r.stdout)) return r.stdout;
  }
  assert.fail('no wait handed the head over');
}

/** Stage a branch with one commit as the agent, with these flags; its number. */
async function staged(branch: string, ...flags: string[]): Promise<string> {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  const file = `${branch.split('/').pop()}.js`;
  writeFileSync(join(repo, file), 'export {};\n');
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...flags]);
  assert.equal(created.code, 0, created.stderr);
  return created.stdout.trim().split('/').pop()!;
}

test('the author asks the reviewer agents for a new review loop', async (t) => {
  await t.test('before publishing, they review the head again, with a limit of their own', async () => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/again-staged');
    writeFileSync(join(repo, 'again-staged.js'), 'export {};\n');
    git('add', 'again-staged.js');
    git('commit', '-qm', 'Add again-staged.js');
    const created = await cli(['pr', 'create', '--title', 'Add again-staged.js', '--body', 'x', '--reviewer', 'codex:1']);
    assert.equal(created.code, 0, created.stderr);
    const n = created.stdout.trim().split('/').pop()!;
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    const sha = git('rev-parse', '--short=7', 'HEAD');
    await withFakes({ FAKE_CODEX_REVIEW: clean }, async () => {
      assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /codex-review reviewed/);
      assert.match(await handedOver(Number(n)), new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}\\)`));

      // The user wants another look: the agent asks, and the head is reviewed again, its one automatic review used up or not.
      const asked = await cli(['pr', 'edit', n, '--add-reviewer', 'codex']);
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stderr, /^When you wait, codex-review reviews it again, from its head, in a new review loop\.$/m);
      assert.equal(asked.stdout.trim(), `${server.url}/acme/widgets/pull/${n}`);
      assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /codex-review reviewed/);
      // Said again for the same commit, since the loop is new.
      assert.match(await handedOver(Number(n)), new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}\\)`));
    });
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((r: any) => [r.trigger, r.status, r.head_sha.slice(0, 7)]), [['auto', 'done', sha], ['auto', 'done', sha]]);
    const timeline = await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`);
    const requested = timeline.filter((e: any) => e.event === 'review_requested');
    assert.deepEqual(requested.map((e: any) => [e.actor.login, e.reviewers]), [['agent', [{ reviewer: 'codex', after: runs[0].id }]]]);
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(), /asked codex-review to review it again/);
  });

  await t.test('after publishing, they review its commits, and galley pushes the first one they are done with', async () => {
    const pr = await published('feature/again-published');
    const before = pr.tip().sha;
    pr.commit('export const value = 1;\n');
    const findings = JSON.stringify({ summary: 'One thing.', comments: [{ path: 'again-published.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name the value.' }] });
    await withFakes({ FAKE_CODEX_REVIEW: findings }, async () => {
      const asked = await cli(['pr', 'edit', pr.n, '--add-reviewer', 'codex:3']);
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stderr, /^When you wait, codex-review reviews it again, as before publishing, until they are done with a commit\. galley pushes that commit to GitHub, and the ones after it without review\.$/m);
      // Its findings come back, and the commit stays off GitHub.
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Name the value\./);
      assert.doesNotMatch(r.stdout, /Pushed/);
      await server.autoPublisher.settle(pr.id);
      assert.equal(pr.tip().sha, before);
      const page = await pr.page();
      assert.match(page, /<span class="agent-chunk">Automatic: 1 of 3 since asked again<\/span>/);
      // The user can end the loop from the page, as before publishing.
      assert.match(page, />Stop iterating</);
    });
    // The agent addresses them; codex reviews the new commit, and once the agent has seen that it found nothing, the wait pushes it.
    const second = pr.commit('export const named = 1;\n');
    await withFakes({ FAKE_CODEX_REVIEW: clean }, async () => {
      const r = await pr.wait();
      assert.match(r.stdout, /codex-review reviewed/);
      assert.doesNotMatch(r.stdout, /Pushed/);
      assert.equal(pr.tip().sha, before);
      assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${second} to GitHub`, 'm'));
    });
    assert.equal(pr.tip().sha, git('rev-parse', 'HEAD'));
    // That push ended the loop: the next commit goes to GitHub without review.
    const third = pr.commit('export const named = 2;\n');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${third} to GitHub`, 'm'));
    assert.equal((await human('GET', `${pr.base}/reviewers/codex`)).runs.length, 2);
    assert.match(await pr.page(), /<span class="agent-chunk">Automatic: 0 before publishing<\/span>/);
  });

  await t.test('only the user and the author may ask, and only for reviewer agents of the pull request', async () => {
    const pr = await published('feature/again-refused');
    const other = await cli(['pr', 'edit', pr.n, '--add-reviewer', 'codex'], { actor: 'observer' });
    assert.equal(other.code, 1);
    assert.match(other.stderr, /only the user or the author of this pull request \(agent\) can ask the reviewer agents to review it again, not observer/);
    // The edit before it is made all the same, and said, so the agent does not make it again.
    const unknown = await cli(['pr', 'edit', pr.n, '--title', 'Renamed', '--add-reviewer', 'nobody']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, new RegExp(`^Changed the title of s#${pr.n}, but could not ask the reviewer agents to review it again:$`, 'm'));
    assert.match(unknown.stderr, /no reviewer agent reviews this pull request by the name "nobody"; `galley reviewers` lists them/);
    assert.equal((await human('GET', pr.base)).title, 'Renamed');
    // The user may, through the API as on GitHub; a login it does not know is left out.
    const asked = await human('POST', `${pr.base}/requested_reviewers`, { reviewers: ['codex', 'someone'] });
    assert.deepEqual([asked.ignored_reviewers, asked.reviewer_agents.map((a: any) => a.login)], [['someone'], ['codex-review']]);
    // Nothing to review: the head is on GitHub, and the agent does not wait.
    assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);

    // A push checked before the request, which went ahead without the reviewers, leaves the loop on; one checked after it ends it.
    const pull = server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pr.id)!;
    const loop = server.service.reviewLoop(pull, 'codex')!;
    const push = (checked: number) =>
      server.service.addEvent(pull, server.service.viewer(), 'github_push', { url: pull.published_url!, source: pull.head_sha, head: pull.head_sha, before: pull.head_sha, sign: false, signed: 0, force: false, result: 'pushed', checked_upto: checked });
    push(loop.id - 1);
    assert.equal(server.service.reviewLoop(pull, 'codex')?.id, loop.id);
    push(loop.id);
    assert.equal(server.service.reviewLoop(pull, 'codex'), null);

    // Likewise a publish: one that began before the request leaves the loop on, though it read the pull request after it.
    await human('POST', `${pr.base}/requested_reviewers`, { reviewers: ['codex'] });
    const again = server.service.reviewLoop(pull, 'codex')!;
    const publish = (began: number, read: number) =>
      server.service.addEvent(pull, server.service.viewer(), 'published', { url: pull.published_url!, head: pull.head_sha, source: pull.head_sha, first: false, force: false, began_upto: began, read_upto: read });
    publish(again.id - 1, again.id + 1);
    assert.equal(server.service.reviewLoop(pull, 'codex')?.id, again.id);
    publish(again.id, again.id);
    assert.equal(server.service.reviewLoop(pull, 'codex'), null);

    // A wait confirmed with the time of a request, in the same millisecond, does not say the agents are done in that request's loop.
    await human('POST', `${pr.base}/requested_reviewers`, { reviewers: ['codex'] });
    const [request] = (await human('GET', `/api/repos/acme/widgets/issues/${pr.n}/timeline`)).filter((e: any) => e.event === 'review_requested').slice(-1);
    server.service.markSeen(server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pr.id)!, request.created_at, pull.head_sha);
    assert.equal(server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pr.id)!.agents_done_sha, null);
  });

  await t.test('after publishing, the wait says when they are done with a head GitHub has, also when a review failed', async () => {
    const pr = await published('feature/again-failed');
    const sha = git('rev-parse', '--short=7', 'HEAD');
    const agent = { 'x-galley-actor': 'agent' };
    await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
      assert.equal((await cli(['pr', 'edit', pr.n, '--add-reviewer', 'codex'])).code, 0);
      // A wait whose confirmation comes only after the next request: it does not count for that loop.
      const first = await (await fetch(`${server.url}${pr.base}/wait?timeout=20`, { headers: agent })).json();
      assert.deepEqual([first.status, first.agents_done?.sha], ['agents_done', git('rev-parse', 'HEAD')]);
      assert.equal((await cli(['pr', 'edit', pr.n, '--add-reviewer', 'codex'])).code, 0);
      const late = await fetch(`${server.url}${pr.base}/seen`, { method: 'PUT', headers: { ...agent, 'content-type': 'application/json' }, body: JSON.stringify({ at: first.seen_at, agents_done: first.agents_done.sha }) });
      assert.equal(late.status, 204);
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review's review of ${sha} failed\\), which GitHub has already: https://github\\.com/acme/widgets/pull/7$`, 'm'));
    });
    // Once per commit.
    assert.equal((await pr.wait('2s')).code, 124);
  });

  await t.test('a review in a loop asked for while a publish was under way is not cancelled by that publish', async () => {
    const n = await staged('feature/again-publishing', '--no-review');
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    const ghCalls = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);
    const [ghGate, codexGate] = [join(dir, 'again-publishing-gh'), join(dir, 'again-publishing-codex')];
    await withFakes({ FAKE_GH_GATE: ghGate, FAKE_CODEX_GATE: codexGate, FAKE_CODEX_REVIEW: clean }, async () => {
      try {
        // The user publishes; it waits on GitHub to open the pull request.
        const calls = ghCalls().length;
        const publishing = human('POST', `${base}/publish`, { sign: false });
        await until(() => ghCalls().slice(calls).some((c) => c.startsWith('pr create ')), 'the publish opens the pull request');
        // Meanwhile the agent asks codex for a new loop and waits, and codex starts.
        assert.equal((await cli(['pr', 'edit', n, '--add-reviewer', 'codex'])).code, 0);
        const waiting = cli(['pr', 'wait', n, '--timeout', '20s']);
        await until(async () => (await human('GET', `${base}/reviewers/codex`)).runs.some((r: any) => r.status === 'running'), 'codex reviews');
        writeFileSync(ghGate, '');
        await publishing;
        writeFileSync(codexGate, '');
        await server.service.codex!.settle((await human('GET', base)).id);
        assert.deepEqual((await human('GET', `${base}/reviewers/codex`)).runs.map((r: any) => [r.trigger, r.status]), [['auto', 'done']]);
        assert.match((await waiting).stdout, /^Published to GitHub: /m);
      } finally {
        rmSync(ghGate, { force: true });
        rmSync(codexGate, { force: true });
      }
    });
  });

  await t.test('a stop holds no reviewer agent that is off for the pull request', async () => {
    const n = await staged('feature/again-off', '--reviewer', 'codex:3');
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    await withFakes({ FAKE_CODEX_REVIEW: clean }, async () => {
      await untilHandedOver(n);
      await human('PUT', `${base}/stop-iterating`);
      assert.equal((await cli(['pr', 'edit', n, '--add-reviewer', 'codex:1'])).code, 0);
      writeFileSync(join(repo, 'again-off.js'), 'export const off = 1;\n');
      git('commit', '-qam', 'Change again-off.js');
      const sha = git('rev-parse', '--short=7', 'HEAD');
      // claude-review is off here: the stop holds nobody, and nothing says it does.
      assert.match(await untilHandedOver(n), new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}\\); ask`, 'm'));
      const page = await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
      assert.doesNotMatch(page, />Resume</);
      assert.doesNotMatch(page, /claude-review stopped/);
    });
  });

  await t.test('a stop the user made before the loop holds the reviewers it does not name, and one during it those it names', async () => {
    const n = await staged('feature/again-stopped', '--reviewer', 'codex:3', '--reviewer', 'claude:3');
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    const runs = async (reviewer: string) => (await human('GET', `${base}/reviewers/${reviewer}`)).runs.length;
    const commit = (text: string) => {
      writeFileSync(join(repo, 'again-stopped.js'), text);
      git('commit', '-qam', 'Change again-stopped.js');
      return git('rev-parse', '--short=7', 'HEAD');
    };
    await withFakes({ FAKE_CODEX_REVIEW: clean, FAKE_CLAUDE_REVIEW: clean }, async () => {
      await untilHandedOver(n);
      assert.deepEqual([await runs('codex'), await runs('claude')], [1, 1]);
      await human('PUT', `${base}/stop-iterating`);
      // The agent asks codex alone, for one review: codex reviews its next commit, and claude stays stopped.
      assert.equal((await cli(['pr', 'edit', n, '--add-reviewer', 'codex:1'])).code, 0);
      const sha = commit('export const again = 1;\n');
      assert.match(await untilHandedOver(n), new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}; \\S+ stopped automatic reviews after round 1\\)`, 'm'));
      assert.deepEqual([await runs('codex'), await runs('claude')], [2, 1]);
      // The page still offers Resume for claude, and no Stop iterating: codex has used up its loop.
      const page = await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
      assert.match(page, /<strong>Automatic reviews by claude-review stopped by \S+ after round 1<\/strong>/);
      assert.match(page, />Resume</);
      assert.doesNotMatch(page, />Stop iterating</);
      // The user stops again, during the loop: that holds codex too.
      await human('PUT', `${base}/stop-iterating`);
      const next = commit('export const again = 2;\n');
      assert.match(await untilHandedOver(n), new RegExp(`^The reviewer agents are done with ${next} \\(\\S+ stopped automatic reviews after round 1\\)`, 'm'));
      assert.deepEqual([await runs('codex'), await runs('claude')], [2, 1]);
    });
  });
});
