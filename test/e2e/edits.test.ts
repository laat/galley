// After publishing, the author's edits of the title and description are published when it waits,
// as its commits are pushed (pushes.test.ts).
import '../helpers/env.ts';
import { cli, dir, git, human, remote, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

test("after publishing, the author's edits of the title and description are published when it waits, unless they are the user's", async (t) => {
  /**
   * Stage a branch with one commit as the agent, publish it as the reviewer (with `publish`, given
   * the pull request's API path), and let the agent hear of the publish.
   */
  const published = async (branch: string, publish = (base: string): Promise<unknown> => human('POST', `${base}/publish`, { sign: false })) => {
    const file = `${branch.split('/').pop()}.js`;
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const n = created.stdout.trim().split('/').pop()!;
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    await publish(base);
    const { id } = await human('GET', base);
    assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    return {
      n,
      id,
      base,
      /** A new commit, as the agent; its short SHA. */
      commit: (text: string) => {
        writeFileSync(join(repo, file), text);
        git('commit', '-qam', `Change ${file}`);
        return git('rev-parse', '--short=7', 'HEAD');
      },
      wait: (timeout = '20s') => cli(['pr', 'wait', n, '--timeout', timeout]),
      /** The branch's tip on GitHub (the bare remote). */
      tip: () => execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim(),
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(),
    };
  };
  const ghCalls = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);

  /** The title and description GitHub has: what gh last gave it, or what someone wrote there. */
  const onGithub = () => ({ title: readFileSync(join(dir, 'gh-title'), 'utf8'), body: readFileSync(join(dir, 'gh-body'), 'utf8') });
  const edits = async (n: string): Promise<any[]> => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).filter((e: any) => e.event === 'github_edit');
  const turn = async (base: string) => {
    const { turn } = await human('GET', base);
    return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
  };

  await t.test("the author's edits of the description and title are published when it waits, with its commits or without, and are not the user's turn meanwhile", async () => {
    // A wait counts for a moment after it ends, not seconds, so the turn of an author not waiting shows soon.
    const grace = server.service.waitGraceMs;
    server.service.waitGraceMs = 100;
    const gate = join(dir, 'edit-gate');
    // GitHub takes a push once the gate is open.
    const hook = join(remote, 'hooks', 'pre-receive');
    const pushing = join(dir, 'edit-pushing');
    const pushGate = join(dir, 'edit-push-gate');
    try {
      const pr = await published('feature/edit-own');
      assert.deepEqual(onGithub(), { title: 'Add edit-own.js', body: 'x' });
      assert.equal((await cli(['pr', 'edit', pr.n, '--body', 'What it does, and why.'])).code, 0);
      // Not waiting, it is the author's turn: its wait publishes the edit.
      await until(() => !server.service.authorWaiting(pr.id, { grace: true }), 'the wait is over');
      assert.deepEqual(await turn(pr.base), { whose: 'author', reasons: ['agent has not waited since its last edit', 'approved', 'update not published: description'] });
      const calls = ghCalls().length;
      await withFakes({ FAKE_GH_EDIT_GATE: gate }, async () => {
        const waiting = pr.wait();
        await until(() => ghCalls().includes('pr edit https://github.com/acme/widgets/pull/7 --body-file -'), 'the description is being published');
        // Waiting with it, while it is published: nobody's turn, not the user's.
        assert.deepEqual(await turn(pr.base), { whose: 'none', reasons: [] });
        writeFileSync(gate, '');
        const r = await waiting;
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Published the description to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
      });
      // GitHub was asked first, for its title and description too, and got the description only.
      assert.ok(ghCalls().slice(calls).includes('pr view https://github.com/acme/widgets/pull/7 --json state,mergedAt,mergedBy,mergeCommit,closedAt,title,body'));
      assert.deepEqual(onGithub(), { title: 'Add edit-own.js', body: 'What it does, and why.' });
      assert.deepEqual((await edits(pr.n)).map((e) => [e.published, e.edited_on_github, e.failed]), [[['description'], [], []]]);
      assert.match(await pr.page(), /Published the description to <a [^>]*>acme\/widgets#7<\/a> when agent waited/);
      assert.deepEqual((await human('GET', pr.base)).unpublished_changes, []);
      assert.deepEqual(await turn(pr.base), { whose: 'none', reasons: [] });

      // A title edit with a commit: both go with the next wait, which says so once both are done,
      // also when something else happens meanwhile (following GitHub).
      assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Add edit-own.js, retitled'])).code, 0);
      const sha = pr.commit('export const own = 1;\n');
      writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\ntouch "${pushing}"\nwhile [ ! -f "${pushGate}" ]; do sleep 0.05; done\n`);
      chmodSync(hook, 0o755);
      const waiting = pr.wait();
      await until(() => existsSync(pushing), 'the push started');
      assert.equal(onGithub().title, 'Add edit-own.js, retitled');
      server.service.emitSystem(pr.id, 'github_status', 'github');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(server.service.authorWaiting(pr.id), 'the wait told of the edit before the push was done');
      writeFileSync(pushGate, '');
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Pushed ${sha} to GitHub: https://github\\.com/acme/widgets/pull/7\nPublished the title to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
      assert.deepEqual(onGithub(), { title: 'Add edit-own.js, retitled', body: 'What it does, and why.' });
      assert.equal(pr.tip(), git('rev-parse', 'HEAD'));
      assert.ok(ghCalls().includes('pr edit https://github.com/acme/widgets/pull/7 --title Add edit-own.js, retitled'));
      assert.deepEqual((await human('GET', pr.base)).unpublished_changes, []);
    } finally {
      server.service.waitGraceMs = grace;
      // The push goes through, also after a failure, before the next test pushes.
      writeFileSync(pushGate, '');
      for (const f of [gate, hook, pushing, pushGate]) rmSync(f, { force: true });
    }
  });

  await t.test('feedback that comes while the edits are published comes at once, and what came of them with the next wait', async () => {
    const pr = await published('feature/edit-feedback');
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words."])).code, 0);
    const gate = join(dir, 'edit-feedback-gate');
    const calls = ghCalls().length;
    try {
      await withFakes({ FAKE_GH_EDIT_GATE: gate }, async () => {
        const waiting = pr.wait();
        await until(() => ghCalls().slice(calls).includes('pr edit https://github.com/acme/widgets/pull/7 --body-file -'), 'the description is being published');
        await human('POST', `/api/repos/acme/widgets/issues/${pr.n}/comments`, { body: 'Say why in the first line.' });
        const r = await waiting;
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /Say why in the first line\./);
        assert.doesNotMatch(r.stdout, /Published the description/);
        writeFileSync(gate, '');
        await server.autoPublisher.settle(pr.id);
      });
    } finally {
      rmSync(gate, { force: true });
    }
    assert.equal(onGithub().body, "The agent's words.");
    assert.match((await pr.wait()).stdout, /^Published the description to GitHub: /m);
  });

  await t.test("an edit the user makes while publishing counts as one since: the author's later edit does not publish it", async () => {
    const gate = join(dir, 'edit-publish-gate');
    try {
      const pr = await published('feature/edit-during', (base) =>
        withFakes({ FAKE_GH_GATE: gate }, async () => {
          const publishing = human('POST', `${base}/publish`, { sign: false });
          await until(() => ghCalls().some((c) => c.startsWith('pr create ') && c.includes('--head feature/edit-during')), 'gh pr create runs');
          // GitHub gets the description as it was read, before this edit.
          await human('PATCH', base, { body: "The user's words." });
          writeFileSync(gate, '');
          return publishing;
        }),
      );
      assert.equal(onGithub().body, 'x');
      assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words, on top of the user's."])).code, 0);
      assert.equal((await pr.wait('1s')).code, 124);
      assert.equal(onGithub().body, 'x');
      assert.ok((await turn(pr.base)).reasons.includes('update not published: description'));
    } finally {
      rmSync(gate, { force: true });
    }
  });

  await t.test('an edit by the user while GitHub is asked, even one the author takes back, keeps the field from being published', async () => {
    const pr = await published('feature/edit-race');
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words."])).code, 0);
    const gate = join(dir, 'edit-view-gate');
    const calls = ghCalls().length;
    try {
      await withFakes({ FAKE_GH_VIEW_GATE: gate }, async () => {
        const waiting = pr.wait('5s');
        await until(() => ghCalls().slice(calls).some((c) => c.endsWith(',title,body')), 'GitHub is asked');
        await human('PATCH', pr.base, { body: "The user's words." });
        assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words."])).code, 0);
        writeFileSync(gate, '');
        assert.equal((await waiting).code, 124);
        await server.autoPublisher.settle(pr.id);
      });
    } finally {
      rmSync(gate, { force: true });
    }
    assert.equal(onGithub().body, 'x');
    assert.deepEqual(await edits(pr.n), []);
    assert.ok((await turn(pr.base)).reasons.includes('update not published: description'));
  });

  await t.test('GitHub could not be asked: nothing is published, the author waits on, the user sees it, and the next wait tries again', async () => {
    const pr = await published('feature/edit-retry');
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words."])).code, 0);
    await withFakes({ FAKE_GH_FAIL: 'HTTP 502: gh is down' }, async () => {
      assert.equal((await pr.wait('3s')).code, 124);
      await server.autoPublisher.settle(pr.id);
    });
    assert.equal(onGithub().body, 'x');
    assert.deepEqual((await edits(pr.n)).map((e) => [e.published, e.failed, e.retry, e.error]), [[[], ['description'], true, 'could not ask GitHub whether https://github.com/acme/widgets/pull/7 is still open:\nHTTP 502: gh is down']]);
    const { whose, reasons } = await turn(pr.base);
    assert.equal(whose, 'reviewer');
    assert.ok(reasons.includes('update not published: description; publishing the description failed'), reasons.join('\n'));
    assert.match(await pr.page(), /<strong>Could not publish the description to GitHub <relative-time [^]*?It is tried again each time agent waits/);
    // GitHub answers again: the next wait publishes it.
    assert.match((await pr.wait()).stdout, /^Published the description to GitHub: /m);
    assert.equal(onGithub().body, "The agent's words.");
  });

  await t.test("the user's edit is not published over: a field the user edited since publishing stays the user's, also when the author edits it after", async () => {
    const pr = await published('feature/edit-user');
    await human('PATCH', pr.base, { body: "The user's words." });
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words.", '--title', 'Add edit-user.js, retitled'])).code, 0);
    const r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Published the title to GitHub: /m);
    assert.deepEqual(onGithub(), { title: 'Add edit-user.js, retitled', body: 'x' });
    assert.deepEqual((await human('GET', pr.base)).unpublished_changes, ['description']);
    const { whose, reasons } = await turn(pr.base);
    assert.equal(whose, 'reviewer');
    assert.ok(reasons.includes('update not published: description'), reasons.join('\n'));
    // Its next wait leaves it too.
    assert.equal((await pr.wait('1s')).code, 124);
    assert.equal(onGithub().body, 'x');

    // Once the user publishes it, the author's later edits are its waits' again.
    await human('POST', `${pr.base}/publish`, { sign: false });
    assert.match((await pr.wait()).stdout, /^Published to GitHub: /m);
    assert.equal(onGithub().body, "The agent's words.");
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words, again."])).code, 0);
    assert.match((await pr.wait()).stdout, /^Published the description to GitHub: /m);
    assert.equal(onGithub().body, "The agent's words, again.");
  });

  await t.test('a description edited on GitHub since galley published it is not overwritten: the author and the user hear why, and it is not tried again', async () => {
    const pr = await published('feature/edit-github');
    // Someone indents the description on github.com, which makes it a code block.
    writeFileSync(join(dir, 'gh-body'), '    x');
    assert.equal((await cli(['pr', 'edit', pr.n, '--body', "The agent's words."])).code, 0);
    const calls = ghCalls().length;
    const r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Could not publish the description to GitHub: someone edited the description on GitHub since galley published it\. Nothing on GitHub was overwritten\. The user has been told, and decides; do not edit it on GitHub yourself\.$/m);
    assert.ok(!ghCalls().slice(calls).some((c) => c.startsWith('pr edit ')));
    assert.equal(onGithub().body, '    x');
    assert.deepEqual((await edits(pr.n)).map((e) => [e.published, e.edited_on_github, e.failed]), [[[], ['description'], []]]);
    const { whose, reasons } = await turn(pr.base);
    assert.equal(whose, 'reviewer');
    assert.ok(reasons.includes('update not published: description; the description was edited on GitHub'), reasons.join('\n'));
    const page = await pr.page();
    assert.match(page, /Did not publish the description to <a [^>]*>acme\/widgets#7<\/a> when agent waited [^]*?: someone edited it on GitHub since galley published it, and GitHub's was kept/);
    assert.match(page, /<strong>The description was edited on GitHub<\/strong>/);
    assert.equal((await pr.wait('1s')).code, 124);
  });

  await t.test('a failure GitHub is to blame for is tried again at the next wait, but not a field edited on GitHub that the same try left', async () => {
    const pr = await published('feature/edit-500');
    writeFileSync(join(dir, 'gh-title'), 'Retitled on GitHub');
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Add edit-500.js, retitled', '--body', "The agent's words."])).code, 0);
    await withFakes({ FAKE_GH_EDIT_FAIL: 'HTTP 500: Internal Server Error (https://api.github.com/graphql)' }, async () => {
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Could not publish the title and description to GitHub: someone edited the title on GitHub since galley published it; gh pr edit failed:\nHTTP 500: Internal Server Error/m);
      await server.autoPublisher.settle(pr.id);
    });
    assert.deepEqual((await edits(pr.n)).map((e) => [e.published, e.edited_on_github, e.failed, e.retry]), [[[], ['title'], ['description'], true]]);
    // GitHub's title is back as galley published it: the title is still left, the description tried again.
    writeFileSync(join(dir, 'gh-title'), 'Add edit-500.js');
    const r = await pr.wait();
    assert.match(r.stdout, /^Published the description to GitHub: /m);
    assert.deepEqual(onGithub(), { title: 'Add edit-500.js', body: "The agent's words." });
    assert.ok((await turn(pr.base)).reasons.includes('update not published: title; the title was edited on GitHub'));
  });

  await t.test("a failure is told to the author and the user, and is not tried again until the author edits again", async () => {
    const pr = await published('feature/edit-fail');
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Add edit-fail.js, retitled'])).code, 0);
    await withFakes({ FAKE_GH_EDIT_FAIL: 'GraphQL: Title is too long (updatePullRequest)' }, async () => {
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Could not publish the title to GitHub: gh pr edit failed:\nGraphQL: Title is too long \(updatePullRequest\)\. Nothing on GitHub was overwritten\./m);
      assert.equal((await pr.wait('1s')).code, 124);
      await server.autoPublisher.settle(pr.id);
    });
    assert.equal(onGithub().title, 'Add edit-fail.js');
    const { whose, reasons } = await turn(pr.base);
    assert.equal(whose, 'reviewer');
    assert.ok(reasons.includes('update not published: title; publishing the title failed'), reasons.join('\n'));
    const page = await pr.page();
    assert.match(page, /Could not publish the title to <a [^>]*>acme\/widgets#7<\/a> when agent waited [^]*?GraphQL: Title is too long/);
    assert.match(page, /<strong>Could not publish the title to GitHub <relative-time [^]*?agent was told, and it is not tried again with this text\. Publish the update yourself to publish it anyway\.[^]*?<pre class="merge-error">gh pr edit failed:\nGraphQL: Title is too long/);
    // Edited again, the next wait publishes it.
    assert.equal((await cli(['pr', 'edit', pr.n, '--title', 'Add edit-fail.js, shorter'])).code, 0);
    assert.match((await pr.wait()).stdout, /^Published the title to GitHub: /m);
    assert.equal(onGithub().title, 'Add edit-fail.js, shorter');
  });
});
