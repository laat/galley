// Whose turn it is: the author agent's, the reviewer agents', the reviewer's or nobody's.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from '../../src/server/db.ts';
import { AUTHOR_STALL_MS, WAIT_GRACE_MS } from '../../src/server/service.ts';

startHarness();

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
  /** The tab and the group the front page shows this pull request in. */
  const group = async () => {
    for (const tab of ['staged', 'published']) {
      const groups = (await page(`/?state=${tab}`)).split('<div class="Box-row turn-group">').slice(1);
      const title = groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
      if (title) return `${tab}: ${title}`;
    }
  };
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  /** What a list page notifies about: your turn in every repository (data-your-turn). */
  const yourTurn = (html: string): { id: number; title: string; url: string; reasons: string }[] =>
    JSON.parse(html.match(/data-your-turn="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  /** This pull request's row on a list page. */
  const rowOf = (html: string) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${number}"`));
  /** A wait counts for a few seconds after it ends, as pages show it (Service.setWaiting); until then the author still waits. */
  const waitEnded = () => until(() => !server.service.authorWaiting(id, { grace: true }), 'the wait is over');
  const threadId = async () => JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
  // Codex's first review waits for this gate, which stays open once opened.
  const gate = join(dir, 'turn-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'turns.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
    // A wait that ended counts for a moment, not seconds: waitEnded waits for that.
    server.service.waitGraceMs = 100;
    try {
      await t.test("staged and not waiting: the author's, to start Codex", async () => {
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review reviews ${sha()} when agent waits for review`] });
        assert.equal(await group(), 'staged: With agents');
        assert.ok(!yourTurn(await page('/')).some((x) => x.id === id), 'not your turn');
        assert.match((await cli(['pr', 'status'])).stdout, /^ {4}- the author's turn: agent has not asked for review yet \(pr wait\), 1 min; codex-review reviews [0-9a-f]{7} when agent waits for review$/m);
      });

      let waiting: ReturnType<typeof cli>;
      await t.test("waiting while Codex reviews: the reviewer agents'", async () => {
        waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
        await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        const { turn } = await human('GET', base);
        assert.equal(turn.whose, 'reviewer_agents');
        const { since, ...reviewing } = turn.reasons[0];
        assert.deepEqual(reviewing, { kind: 'reviewer_agent', state: 'reviewing', to_review: true, text: `codex-review is reviewing ${sha()}`, engine: 'codex', reviewer: 'codex' });
        assert.ok(Date.now() - Date.parse(since) < 20_000);
        assert.equal(turn.reasons[1].text, 'agent is waiting for review');
        // gh JSON says it in words, with how long it has been so.
        const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
        assert.deepEqual(view, { turn: { whose: 'REVIEWER_AGENTS', reasons: [`codex-review is reviewing ${sha()}, 1 min`, 'agent is waiting for review, 1 min'] } });
        assert.equal(await group(), 'staged: With agents');
        // The list says it shorter, with the reason in full as its tooltip, and the reviewer agent's avatar at the row's end.
        const front = await page('/');
        assert.match(front, new RegExp(`<span class="turn-reason" title="codex-review is reviewing ${sha()}"><svg class="octicon octicon-dot-fill turn-mark turn-pulse"[^>]*>.*?</svg>codex-review reviewing<span class="turn-since"><relative-time [^>]*data-format="duration"`));
        assert.match(rowOf(front)!, /<span class="turn-avatar" title="codex-review is reviewing [0-9a-f]{7}"><img class="avatar avatar-bot"/);
      });

      await t.test("handed Codex's findings: the author's, until it acts", async () => {
        writeFileSync(gate, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed: commented/);
        await server.service.codex!.settle(id);
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex-review commented on ${sha()}`, '1 unresolved thread'] });
        assert.equal(await group(), 'staged: With agents');
      });

      await t.test("answered and not waiting: the reviewer's", async () => {
        await waitEnded();
        const reply = await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '-b', 'It is named after what it counts.']);
        assert.equal(reply.code, 0, reply.stderr);
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent is not waiting', 'no review from reviewer yet', 'agent answered 1 thread', `codex-review's findings in ${sha()} are answered`, '1 unresolved thread'],
        });
        const front = await page('/');
        assert.equal(await group(), 'staged: Your turn');
        assert.deepEqual(yourTurn(front).find((x) => x.id === id), {
          id,
          title: 'Take turns',
          url: `/acme/widgets/pull/${number}`,
          reasons: `agent is not waiting, 1 min · no review from reviewer yet · agent answered 1 thread · codex-review's findings in ${sha()} are answered · 1 unresolved thread`,
        });
        // The tab's title counts the pull requests waiting for the reviewer.
        assert.match(front, new RegExp(`<title>\\(${yourTurn(front).length}\\) Staged pull requests · galley</title>`));
        assert.match((await cli(['pr', 'status'])).stdout, /^ {4}- the user's turn: agent is not waiting, 1 min; no review from reviewer yet; agent answered 1 thread;/m);
      });

      await t.test("feedback the author does not wait for: still the reviewer's, saying so", async () => {
        await human('POST', `${base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Count something else.' });
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent has not seen the latest feedback', 'agent is not waiting', `codex-review's findings in ${sha()} are answered`, 'changes requested', '1 unresolved thread'],
        });
        // While a wait hands it over, it is the author's.
        server.service['waiters'].set(id, 1);
        try {
          assert.equal(server.service.turn(row()).whose, 'author');
        } finally {
          server.service['waiters'].delete(id);
        }
        // Reading it is being handed it.
        await cli(['pr', 'view', String(number), '--comments']);
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex-review's findings in ${sha()} are answered`, 'changes requested', '1 unresolved thread'] });
      });

      await t.test("a push, and a review from Codex that finds nothing: the reviewer's", async () => {
        assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '--resolve', '-b', 'Renamed.'])).code, 0);
        writeFileSync(join(repo, 'turns.js'), 'export const rounds = 1;\n');
        git('commit', '-qam', 'Count rounds');
        // Codex reviews the new commit once the author waits: until then, the author's turn.
        await until(async () => (await turn()).whose === 'author', "the author's turn after its push");
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review reviews ${sha()} when agent waits for review`, 'changes requested'] });
        const r = await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, () => cli(['pr', 'wait', String(number), '--timeout', '20s']));
        assert.match(r.stdout, /Fine now\./);
        await server.service.codex!.settle(id);
        // Nothing more is coming from Codex for this commit, so the next wait says to ask the reviewer.
        assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); ask the user to review it: ${server.url}/acme/widgets/pull/${number}\n`));
        await waitEnded();
        // The clean review asks nothing of the author, so its turn does not come back.
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent is not waiting', "1 push since reviewer's review", 'agent answered 1 thread', `codex-review found nothing in ${sha()}`, 'changes requested'],
        });
      });

      await t.test("a failed review of the head: the reviewer's, with Retry", async () => {
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        const failed = (await human('GET', base)).turn.reasons.find((x: any) => x.kind === 'reviewer_agent');
        assert.deepEqual(failed, { kind: 'reviewer_agent', state: 'failed', to_review: false, text: `codex-review's review of ${sha()} failed`, engine: 'codex', reviewer: 'codex' });
        assert.match(await page('/'), new RegExp(`codex-review&#39;s review failed <button type="button" class="btn-link js-run-reviewer" data-api="${base}/reviewers/codex">Retry</button>`));
        // Also while the author waits: nothing more is coming from Codex for this commit. The author
        // was told so when Codex found nothing in it, and is not told again.
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
        // Approved here: the label opens it here.
        assert.match(rowOf(await page('/'))!, new RegExp(`<a class="Label Label--success" href="/acme/widgets/pull/${number}">.*?Approved</a>`));
      });

      await t.test("published: nobody's, until a commit is not pushed: the author's, whose wait pushes it", async () => {
        // Codex's review of this commit failed before it was published: that holds nothing up now.
        await human('POST', `${base}/publish`, {});
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        assert.equal(await group(), 'published: Waiting on GitHub');
        // A review asked for after publishing that fails is the reviewer's to retry, and a retry that finds nothing ends it.
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        const failed = await turn();
        assert.equal(failed.whose, 'reviewer');
        assert.ok(failed.reasons.includes(`codex-review's review of ${sha()} failed`));
        assert.equal(await group(), 'published: Your turn');
        assert.match(await page('/?state=published'), new RegExp(`data-api="${base}/reviewers/codex">Retry</button>`));
        await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        // Feedback after publishing that the author, not waiting, has not been handed is the reviewer's to pass on.
        await waitEnded();
        await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'One more thing.' });
        const told = await turn();
        assert.equal(told.whose, 'reviewer');
        assert.deepEqual(told.reasons.slice(0, 2), ['agent has not seen the latest feedback', 'agent is not waiting']);
        assert.equal(await group(), 'published: Your turn');
        // Handed over, it is the author's; answered, nobody's again.
        await cli(['pr', 'view', String(number), '--comments']);
        assert.equal((await turn()).whose, 'author');
        assert.equal((await cli(['pr', 'comment', String(number), '-b', 'Noted.'])).code, 0);
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        writeFileSync(join(repo, 'turns.js'), 'export const rounds = 2;\n');
        git('commit', '-qam', 'Count two rounds');
        assert.equal((await cli(['pr', 'edit', String(number), '--title', 'Take turns, in rounds'])).code, 0);
        await waitEnded();
        // A commit GitHub does not have is the author's: its wait pushes it.
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not waited since its last commit', 'approved', 'update not published: commits, title'] });
        // gh's state stays as gh would show it; the update is an extension field.
        const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'state,unpublishedChanges'])).stdout);
        assert.deepEqual(view, { state: 'PUBLISHED', unpublishedChanges: ['COMMITS', 'TITLE'] });
        const plain = (await cli(['pr', 'view', String(number)])).stdout;
        assert.match(plain, /^unpublished:\tcommits, title$/m);
        assert.match(plain, /^turn:\tauthor\tagent has not waited since its last commit, 1 min; approved; update not published: commits, title$/m);
        // Staged, in the badge and the merge box, until GitHub has the update.
        const pullPage = await page(`/acme/widgets/pull/${number}`);
        assert.match(pullPage, /<span class="State State--staged">.*?Update not published<\/span>/);
        assert.match(pullPage, /<div class="merge-box" id="publish">/);
        assert.match(pullPage, /Staged changes not on GitHub yet: commits, title\.[^]*? The commits are also pushed when agent waits\./);
        assert.match(rowOf(await page('/acme/widgets?state=published'))!, /<span class="turn-reason" title="agent has not waited since its last commit">agent not waiting<span class="turn-since">[^]*?<span class="turn-reason">update not published: commits, title<\/span>/);
        assert.equal(await group(), 'published: With agents');
        assert.ok(!yourTurn(await page('/')).some((x) => x.id === id), 'not your turn');
      });

      await t.test("an update: the author's wait pushes its commit, which Codex does not review; the title is the reviewer's to publish", async () => {
        // An automatic review to spare, which a published pull request does not get.
        await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 3 });
        const runs = (await human('GET', `${base}/reviewers/codex`)).runs.length;
        const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^Pushed ${sha()} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
        assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, runs);
        await waitEnded();
        assert.deepEqual(await turn(), { whose: 'reviewer', reasons: ['agent is not waiting', "1 push since reviewer's review", 'approved', 'update not published: title'] });
        assert.equal(await group(), 'published: Your turn');
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
        const events: string[] = [];
        const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
        const first = new AbortController();
        const renewal = new AbortController();
        // Every wait here counts for seconds after it ends, the one that hands the comment over too,
        // so the next starts within that also when the steps between are slow.
        const grace = server.service.waitGraceMs;
        server.service.waitGraceMs = WAIT_GRACE_MS;
        try {
          // Handed the comment and confirming it, as `pr wait` does: the author's turn.
          const handed = await server.service.wait(ctx, author, 5_000);
          server.service.markSeen(ctx.pull, handed.seenAt!);
          assert.equal((await turn()).whose, 'author');
          server.service.bus.on('change', listen);
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
          server.service.waitGraceMs = grace;
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
          headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
          body: JSON.stringify({ title: 'Change a', head: 'feature', base: 'main' }),
        });
        assert.equal(res.status, 201);
        const { id: otherId, number: otherNumber } = await res.json();
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex`);
          await server.service.codex!.settle(otherId);
        });
        assert.match(await page('/acme/pull'), new RegExp(`data-api="/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex">Retry</button>`));
        // Every list page carries your turn in every repository, whatever its tab or repository shows.
        for (const path of ['/', '/?state=done', '/?state=published', '/acme/pull', '/acme/pull?state=done']) {
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

      await t.test("an approval the next wait returns, while the author works on feedback: the reviewer's", async () => {
        // The author works on the comment it was handed above, and an approval arrives meanwhile.
        await human('POST', `${base}/reviews`, { event: 'APPROVE', body: 'Fine as it is.' });
        assert.equal((await turn()).whose, 'author');
        // Its next wait returns only the approval, which asks nothing: waiting is its latest action,
        // while the wait counts (setWaiting).
        server.service.waitGraceMs = WAIT_GRACE_MS;
        const r = await cli(['pr', 'wait', String(number), '--timeout', '5s']);
        assert.match(r.stdout, /Fine as it is\./);
        const { whose, reasons } = await turn();
        assert.equal(whose, 'reviewer');
        assert.ok(!reasons.includes('agent is working on the feedback'), reasons.join('; '));
        assert.ok(reasons.includes('approved'), reasons.join('; '));
      });

      await t.test("closed: nobody's", async () => {
        await human('PATCH', base, { state: 'closed' });
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      });
    } finally {
      server.service.waitGraceMs = WAIT_GRACE_MS;
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });
});

test("while the reviewer agents still have the head to review, it is theirs or the author's, until the author stalls", async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/agents-first');
  writeFileSync(join(repo, 'agents-first.js'), 'export const first = 1;\n');
  git('add', 'agents-first.js');
  git('commit', '-qm', 'Add agents-first.js');
  // Both reviewer agents, for this pull request only.
  const created = await cli(['pr', 'create', '--title', 'Agents first', '--body', 'x', '--reviewer', 'codex:3', '--reviewer', 'claude:3']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const page = async (path: string) => (await fetch(server.url + path)).text();
  const turn = async (): Promise<{ whose: string; reasons: string[] }> => {
    const { turn } = await human('GET', base);
    return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
  };
  /** The tab and the group the front page shows this pull request in. */
  const group = async () => {
    for (const tab of ['staged', 'published']) {
      const groups = (await page(`/?state=${tab}`)).split('<div class="Box-row turn-group">').slice(1);
      const title = groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
      if (title) return `${tab}: ${title}`;
    }
  };
  /** Whether the front page notifies about this pull request as your turn (data-your-turn). */
  const yours = async () => (await page('/')).match(/data-your-turn="([^"]*)"/)![1].includes(`/acme/widgets/pull/${number}&quot;`);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const waitEnded = () => until(() => !server.service.authorWaiting(id, { grace: true }), 'the wait is over');
  const toStart = (login: string) => `${login} reviews ${sha()} when agent waits for review`;
  const codexGate = join(dir, 'agents-first-codex');
  const claudeGate = join(dir, 'agents-first-claude');
  // A wait that ended counts for a moment, not seconds: waitEnded waits for that.
  server.service.waitGraceMs = 100;
  try {
    await t.test("staged, not waiting: the author's, to start the reviewer agents", async () => {
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', toStart('codex-review'), toStart('claude-review')] });
      assert.equal(await group(), 'staged: With agents');
      assert.equal(await yours(), false);
      const { turn: view } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
      assert.deepEqual(view, { whose: 'AUTHOR', reasons: ['agent has not asked for review yet (pr wait), 1 min', toStart('codex-review'), toStart('claude-review')] });
    });

    await t.test("feedback it is not waiting for: the reviewer's to pass on, then the author's", async () => {
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Say what comes first.' });
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent has not seen the latest feedback', 'agent has not asked for review yet (pr wait)', 'no review from reviewer yet', toStart('codex-review'), toStart('claude-review')],
      });
      await cli(['pr', 'view', String(number), '--comments']);
      assert.equal((await turn()).whose, 'author');
      // Its answer ends its turn on the feedback, and the reviewer agents still wait for it.
      assert.equal((await cli(['pr', 'comment', String(number), '-b', 'The reviewer agents do.'])).code, 0);
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', toStart('codex-review'), toStart('claude-review')] });
    });

    await t.test("stalled: the reviewer's, and pages hear of it when the time is up", async () => {
      const events: string[] = [];
      const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
      server.service.bus.on('change', listen);
      try {
        // As if the author's last action were longer ago than that: the server's poll notices, once.
        server.service.stallMs = 0;
        await until(() => events.includes('stalled'), 'pages hear that the author stalled');
        // The next poll says nothing again.
        server.service.noticeStalls();
        assert.deepEqual(events.filter((e) => e === 'stalled'), ['stalled']);
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent stopped without asking for review', 'no review from reviewer yet', toStart('codex-review'), toStart('claude-review')],
        });
        assert.equal(await group(), 'staged: Your turn');
        assert.equal(await yours(), true);
        assert.match(await page('/'), /<span class="turn-reason" title="agent stopped without asking for review">agent stalled<span class="turn-since">/);
        // Waiting starts the reviewer agents: theirs.
        await withFakes({
          FAKE_CODEX_GATE: codexGate,
          FAKE_CLAUDE_GATE: claudeGate,
          FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
          FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine too.', comments: [] }),
        }, async () => {
          const waited = cli(['pr', 'wait', String(number), '--timeout', '20s']);
          await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS' && server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'both review');
          assert.deepEqual((await turn()).whose, 'reviewer_agents');
          // Done with the head: the reviewer's, as the next wait says, and no longer stalled though the author does not wait.
          writeFileSync(codexGate, '');
          writeFileSync(claudeGate, '');
          assert.equal((await waited).code, 0);
          await server.service.codex!.settle(id);
          await server.service.claude!.settle(id);
          await waitEnded();
          assert.deepEqual(await turn(), {
            whose: 'reviewer',
            reasons: ['agent is not waiting', 'no review from reviewer yet', `codex-review found nothing in ${sha()}`, `claude-review found nothing in ${sha()}`],
          });
          assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} `));
        });
      } finally {
        server.service.stallMs = AUTHOR_STALL_MS;
        server.service.bus.off('change', listen);
        rmSync(codexGate, { force: true });
        rmSync(claudeGate, { force: true });
      }
    });

    await t.test("one reviewer agent done with a new commit and the other still to start: the author's", async () => {
      await waitEnded();
      writeFileSync(join(repo, 'agents-first.js'), 'export const first = 2;\n');
      git('commit', '-qam', 'Count from two');
      await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the push is seen');
      server.service.db.insert('review_runs', { pull_id: id, reviewer: 'codex', head_sha: row().head_sha, trigger: 'auto', status: 'done', findings: 0, started_at: now(), finished_at: now() });
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review found nothing in ${sha()}`, toStart('claude-review')] });
    });

    await t.test("stopped iterations count as done: the reviewer's, until Resume", async () => {
      await human('PUT', `${base}/stop-iterating`);
      const stopped = await turn();
      assert.equal(stopped.whose, 'reviewer');
      assert.deepEqual(stopped.reasons.slice(0, 1), ['agent is not waiting']);
      assert.ok(stopped.reasons.some((x) => /^reviewer stopped automatic reviews after round \d+$/.test(x)), stopped.reasons.join('; '));
      await human('DELETE', `${base}/stop-iterating`);
      assert.equal((await turn()).whose, 'author');
    });

    await t.test("a review asked for by hand: the reviewer agents'; cancelled by publishing: nobody's; an update: the author's to wait with", async () => {
      await withFakes({ FAKE_CODEX_GATE: codexGate }, async () => {
        await human('POST', `${base}/reviewers/codex`);
        await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        const asked = await turn();
        assert.equal(asked.whose, 'reviewer_agents');
        assert.deepEqual(asked.reasons.slice(0, 2), [`codex-review is reviewing ${sha()}`, toStart('claude-review')]);
        await human('POST', `${base}/publish`, { sign: false, during_review: true });
        await server.service.codex!.settle(id);
      });
      // Claude never reviewed the head, but GitHub has it now: the next move is there.
      assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.at(-1).status, 'cancelled');
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      assert.equal(await group(), 'published: Waiting on GitHub');
      writeFileSync(join(repo, 'agents-first.js'), 'export const first = 3;\n');
      git('commit', '-qam', 'Count from three');
      await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the push is seen');
      // No reviewer agent reviews it on its own once it is published: the author's wait pushes it.
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not waited since its last commit', 'update not published: commits'] });
      assert.equal(await group(), 'published: With agents');
    });

    await t.test("no reviewer agent reviews it: staging hands it to the reviewer", async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/no-agents');
      writeFileSync(join(repo, 'no-agents.js'), 'export const none = 1;\n');
      git('add', 'no-agents.js');
      git('commit', '-qm', 'Add no-agents.js');
      await human('PUT', '/api/settings/codex', { enabled: true });
      const r = await cli(['pr', 'create', '--title', 'No agents', '--body', 'x', '--no-review']);
      assert.equal(r.code, 0, r.stderr);
      const { turn } = await human('GET', `/api/repos/acme/widgets/pulls/${r.stdout.trim().split('/').pop()}`);
      assert.deepEqual({ whose: turn.whose, reasons: turn.reasons.map((x: any) => x.text) }, { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet'] });
    });
  } finally {
    server.service.waitGraceMs = WAIT_GRACE_MS;
    rmSync(codexGate, { force: true });
    rmSync(claudeGate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test("feedback the author acted on since it came, without being handed it: the author's, until it stalls", async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/acted-on');
  writeFileSync(join(repo, 'acted-on.js'), 'export const acted = 1;\n');
  git('add', 'acted-on.js');
  git('commit', '-qm', 'Add acted-on.js');
  writeFileSync(join(repo, 'acted-on.md'), 'Acted on.\n');
  git('add', 'acted-on.md');
  git('commit', '-qm', 'Describe acted-on.js');
  // No reviewer agent: nothing waits for the author to start one.
  const created = await cli(['pr', 'create', '--title', 'Act on it', '--body', 'x', '--no-review']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const turn = async (): Promise<{ whose: string; reasons: any[] }> => (await human('GET', base)).turn;
  const texts = async () => (await turn()).reasons.map((r) => r.text);
  // As when a restart cuts off the wait that would have handed the feedback over, or it was read some other way.
  const working = async (since: string) => {
    const { whose, reasons } = await turn();
    assert.equal(whose, 'author');
    assert.deepEqual(reasons[0], { kind: 'author', state: 'working', text: 'agent is working on the feedback', since });
  };

  await t.test("a new base the reviewer picked after it: still the reviewer's", async () => {
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Count from two.' });
    const { whose, reasons } = await turn();
    assert.equal(whose, 'reviewer');
    assert.deepEqual(reasons.slice(0, 2).map((r) => r.text), ['agent has not seen the latest feedback', 'agent is not waiting']);
    // A base with the first commit in it moves the merge base alone, which galley records as a push of the author's.
    git('branch', 'acted-on-base', 'HEAD~1');
    await human('PATCH', base, { base: 'acted-on-base' });
    const moved = JSON.parse(server.service.db.get<{ data: string }>("SELECT data FROM events WHERE pull_id = ? AND type = 'pushed' ORDER BY id DESC LIMIT 1", id)!.data);
    assert.equal(moved.before, moved.after);
    assert.equal((await turn()).whose, 'reviewer');
  });

  await t.test("a push after it: the author's", async () => {
    const asked = server.service.db.get<{ at: string }>('SELECT MAX(created_at) AS at FROM comments WHERE pull_id = ?', id)!.at;
    writeFileSync(join(repo, 'acted-on.js'), 'export const acted = 2;\n');
    git('commit', '-qam', 'Count from two');
    await until(async () => (await turn()).whose === 'author', "the author's turn after its push");
    await working(asked);
    assert.ok(!(await texts()).includes('agent has not seen the latest feedback'));
  });

  await t.test("a reply in a thread after it: the author's", async () => {
    await human('POST', `${base}/reviews`, { event: 'COMMENT', comments: [{ path: 'acted-on.js', line: 1, side: 'RIGHT', body: 'Why two?' }] });
    assert.equal((await turn()).whose, 'reviewer');
    const asked = server.service.db.get<{ at: string }>("SELECT submitted_at AS at FROM reviews WHERE pull_id = ? AND state = 'COMMENTED'", id)!.at;
    const thread = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
    const reply = await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', 'It starts from two now.']);
    assert.equal(reply.code, 0, reply.stderr);
    await working(asked);
  });

  await t.test("nothing from it for the stall time: the reviewer's, and pages hear of it", async () => {
    const events: string[] = [];
    const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
    server.service.bus.on('change', listen);
    try {
      // As if the author's last action were longer ago than that: the server's poll notices.
      server.service.stallMs = 0;
      await until(() => events.includes('stalled'), 'pages hear that the author stalled');
      assert.equal((await turn()).whose, 'reviewer');
      assert.deepEqual(await texts(), ['agent has not seen the latest feedback', 'agent stopped without waiting', 'agent answered 1 thread', '1 unresolved thread']);
    } finally {
      server.service.stallMs = AUTHOR_STALL_MS;
      server.service.bus.off('change', listen);
    }
  });
});
