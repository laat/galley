// Auto-publish: galley publishes a pull request once the agents are done with it.
import '../helpers/env.ts';
import { cli, dir, git, human, remote, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRow } from '../../src/server/db.ts';
import { Repo } from '../../src/server/git.ts';
import { AUTHOR_STALL_MS, type ChangeEvent } from '../../src/server/service.ts';

startHarness();

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
      /** Until auto-publish is done checking it: what it would publish is published by then. */
      settle: async () => server.autoPublisher.settle((await human('GET', base)).id),
    };
  };
  const untilWaiting = async (base: string) => {
    await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
  };
  const defaults = { enabled: false, model: '', effort: '', maxIterations: 3 };
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
    const review = {
      summary: 'Two things.',
      comments: [
        { path: 'auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it after what it is.' },
        { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' },
      ],
    };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
      try {
        assert.match(await pr.page(), /<button type="submit" class="btn" data-api="[^"]*\/auto-publish" data-method="PUT"[^>]*>.*Publish when reviews are done<\/button>/);
        // Only the reviewer can turn it on, as only the reviewer can publish.
        const agent = await cli(['pr', 'publish', String(pr.number), '--auto']);
        assert.equal(agent.code, 1);
        assert.match(agent.stderr, /only the user can turn on auto-publish/);
        const on = await cli(['pr', 'publish', String(pr.number), '--auto'], { actor: 'reviewer' });
        assert.equal(on.code, 0, on.stderr);
        assert.match(on.stderr, new RegExp(`Pull request acme/widgets s#${pr.number} will be published when the reviewer agents are done`));
        assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-publish:\tenabled\treviewer$/m);
        const { autoPublishRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout);
        assert.deepEqual(
          { ...autoPublishRequest, enabledAt: undefined },
          { enabledAt: undefined, enabledBy: { login: 'reviewer', is_bot: false }, sign: true, draft: false, force: false, autoMerge: null },
        );

        // Codex's review wakes the agent, and nothing is published until the agent has answered it.
        const first = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.stdout, /codex-review reviewed: commented/);
        // Findings on lines outside the diff, which only the review's body carries, count too.
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs.map((r: any) => r.findings), [2]);
        assert.match(first.stdout, /Auto-publish is on \(reviewer turned it on\): galley publishes this pull request once the reviewer agents are done/);
        assert.equal(pr.created(), false);
        const box = await pr.page();
        assert.match(box, /<strong>Auto-publish is on<\/strong>/);
        assert.match(box, /codex-review has used up its automatic reviews/);
        assert.match(box, /agent is working \(not waiting for review\)/);
        assert.match(box, /js-auto-publish-cancel/);
        assert.doesNotMatch(box, /Publish when reviews are done/);

        // The agent fixes it and waits again. Codex has used its one review, so galley publishes the new commit.
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
        // It approved the first publish only: the commits after it are pushed when the agent waits.
        assert.equal((await human('GET', pr.base)).auto_publish, null);
        const after = await pr.page();
        assert.match(after, /published this pull request to <a [^>]*>acme\/widgets#7<\/a> at <code>[0-9a-f]{7}<\/code> \(signed 2 commits\) with auto-publish/);
        assert.doesNotMatch(after, /Auto-publish is on|Publish when reviews are done/);
        assert.match(second.stdout, /It is published: commit and wait, and galley pushes each commit you wait with to GitHub\. Never push to GitHub yourself\./);
        const refused = await fetch(`${server.url}${pr.base}/auto-publish`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(refused.status, 422);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('after the agent answers every thread without a new commit, which Codex would wait for', async () => {
    const pr = await stage('feature/auto-answered', 'answered-auto.js');
    const review = {
      summary: 'Two things.',
      comments: [
        { path: 'answered-auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it after what it is.' },
        { path: 'answered-auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Export a function.' },
      ],
    };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
        const sha = git('rev-parse', '--short=7', 'HEAD');
        const [first, second] = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'reviewThreads'])).stdout).reviewThreads.map((th: any) => th.databaseId);

        // One thread answered and resolved, the other not: it waits for the other.
        assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(first), '--resolve', '-b', 'It is named after what it is.'])).code, 0);
        assert.equal((await cli(['pr', 'wait', String(pr.number), '--timeout', '1s'])).code, 124);
        await pr.settle();
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review found problems in <code>${sha}</code>, and reviews the commit that addresses them`));

        // A reply answers a thread left open too.
        assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(second), '-b', 'Out of scope: a constant is what callers need.'])).code, 0);
        assert.match(await pr.page(), new RegExp(`<svg [^>]*octicon-check[^>]*>.*?</svg> <span>codex-review's findings in <code>${sha}</code> are answered</span>`));
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
        assert.equal((await human('GET', `${pr.base}/reviewers/codex`)).runs.length, 1);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('after the agent has seen findings that are all outside the diff, which have no thread to answer in', async () => {
    const pr = await stage('feature/auto-outside', 'outside.js');
    const review = { summary: 'One thing.', comments: [{ path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' }] };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const first = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.match(first.stdout, /Not in this diff\./);
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs.map((r: any) => r.findings), [1]);
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('not while Codex reviews, and after a review that finds nothing', async () => {
    const pr = await stage('feature/auto-clean', 'clean.js');
    const gate = join(dir, 'auto-gate');
    await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const codex = server.service.codex!;
        const pull = await human('GET', pr.base);
        const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
        const reviewed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        await untilWaiting(pr.base);
        // The agent waits and nothing else is open, but Codex is at work.
        await pr.settle();
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review is reviewing <code>${git('rev-parse', '--short=7', 'HEAD')}</code>`));
        writeFileSync(gate, '');
        assert.match((await reviewed).stdout, /Looks right\./);
        // Codex found nothing in the head; once the agent has seen that and waits, it is published.
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
      } finally {
        rmSync(gate, { force: true });
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test("never the user's turn on its way from the reviewer agents to published", async () => {
    const pr = await stage('feature/auto-turn', 'auto-turn.js');
    const { id } = await human('GET', pr.base);
    const row = () => server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
    // Whose turn it is after each change and each wait, as pages and the desktop app hear of them:
    // once whoever made the change is done with it.
    const turns: string[] = [];
    const look = (pullId: number | null) => {
      if (pullId !== id) return;
      setImmediate(() => {
        const { whose, reasons } = server.service.turn(row());
        const now = whose === 'none' ? `none: ${reasons.map((r) => r.text).join('; ')}` : whose;
        if (turns.at(-1) !== now) turns.push(now);
      });
    };
    const onChange = (e: ChangeEvent) => look(e.pullId);
    server.service.bus.on('change', onChange);
    server.service.bus.on('author-waiting', look);
    const gate = join(dir, 'auto-turn-gate');
    const signing = gateSigning();
    try {
      await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
        await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
        await human('PUT', `${pr.base}/auto-publish`, {});
        const reviewed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        writeFileSync(gate, '');
        assert.match((await reviewed).stdout, /Looks right\./);
        // Codex found nothing, and the agent waits again: auto-publish publishes it, while signing waits for a prompt.
        const published = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(signing.started, 'signing started');
        const { turn } = await human('GET', pr.base);
        assert.deepEqual([turn.whose, turn.reasons.map((r: any) => r.text)], ['none', ['auto-publish is publishing it']]);
        assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^turn:\tnone\tauto-publish is publishing it$/m);
        // The front page lists it under auto-publish, not as yours, and does not notify about it.
        const front = await (await fetch(`${server.url}/`)).text();
        const group = front.split('<div class="Box-row turn-group">').find((g) => g.includes(`href="/acme/widgets/pull/${pr.number}"`))!;
        assert.match(group, /<h2 class="turn-group-title">Auto-publish<\/h2> <span class="Counter">1<\/span> <span class="turn-group-note">publishes on its own<\/span>/);
        assert.match(group, /<div class="pr-row-turn"><span class="turn-reason">auto-publish is publishing it<\/span><\/div>/);
        assert.doesNotMatch(front.match(/data-your-turn="([^"]*)"/)![1], new RegExp(`/acme/widgets/pull/${pr.number}&quot;`));
        signing.open();
        assert.match((await published).stdout, /Published to GitHub/);
        await new Promise((resolve) => setImmediate(resolve));
      });
    } finally {
      server.service.bus.off('change', onChange);
      server.service.bus.off('author-waiting', look);
      signing.restore();
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', defaults);
    }
    assert.ok(!turns.includes('reviewer'), turns.join(' → '));
    assert.deepEqual(turns.slice(0, 2), ['author', 'reviewer_agents'], turns.join(' → '));
    assert.ok(turns.includes('none: auto-publish is publishing it'), turns.join(' → '));
    // Published, with nothing from GitHub yet.
    assert.equal(turns.at(-1), 'none: ', turns.join(' → '));
  });

  await t.test("the author's turn when auto-publish waits for it to wait, and the user's once it stalls", async () => {
    const pr = await stage('feature/auto-stall', 'stall.js', '--no-review');
    await human('PUT', `${pr.base}/auto-publish`, {});
    const turn = async () => {
      const { turn } = await human('GET', pr.base);
      return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
    };
    assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)'] });
    // As if the agent's last action were longer ago than that.
    server.service.stallMs = 0;
    try {
      assert.deepEqual(await turn(), { whose: 'reviewer', reasons: ['agent stopped without asking for review', 'no review from reviewer yet'] });
    } finally {
      server.service.stallMs = AUTHOR_STALL_MS;
    }
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
  });

  await t.test('without waiting for Codex when the pull request was staged with --no-review', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await stage('feature/auto-no-review', 'no-review.js', '--no-review');
      await human('PUT', `${pr.base}/auto-publish`, {});
      assert.match(await pr.page(), /codex-review does not review this pull request automatically/);
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
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
        await until(async () => (await human('GET', `${pr.base}/reviewers/codex`)).runs.some((r: any) => r.status === 'failed'), "Codex's review fails");
        // A failed review is no feedback for the agent, and it stops auto-publish from going ahead.
        assert.equal((await waiting).code, 124);
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review's review of <code>${git('rev-parse', '--short=7', 'HEAD')}</code> failed\\. Ask it to review again, or publish by hand\\.`));
        // Someone has to ask for another review, or publish by hand: the user's turn.
        assert.equal((await human('GET', pr.base)).turn.whose, 'reviewer');
        const agent = await cli(['pr', 'publish', String(pr.number), '--disable-auto']);
        assert.equal(agent.code, 1);
        const off = await cli(['pr', 'publish', String(pr.number), '--disable-auto'], { actor: 'reviewer' });
        assert.equal(off.code, 0, off.stderr);
        assert.match(off.stderr, new RegExp(`Auto-publish disabled for pull request acme/widgets s#${pr.number}`));
        assert.equal((await human('GET', pr.base)).auto_publish, null);
        assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_disabled').reason, 'cancelled');
      });
    } finally {
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
    const signedCopy = () => git('for-each-ref', '--format=%(objectname)', `refs/galley/${server.service.db.instance}/pull/${pr.number}/published`);
    try {
      // Cancelled while signing waits: nothing is pushed.
      await human('PUT', `${pr.base}/auto-publish`, {});
      const cancelled = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started');
      await human('DELETE', `${pr.base}/auto-publish`);
      signing.open();
      await until(() => signedCopy() !== '', 'signing finished');
      await pr.settle();
      assert.equal(pr.created(), false);
      assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/auto-sign'], { stdio: 'ignore' }));
      // Without auto-publish, the reviewer agents being done with the commit makes it the reviewer's to review.
      assert.match((await cancelled).stdout, /^No reviewer agent reviews .*; ask the user to review it: /);
      await comment(pr.number, 'Hold on.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Hold on\./);

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
      await pr.settle();
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
      // Turned off and on again, now as a draft, while the first attempt signs. Turned off, it is
      // the reviewer's to review, and the agent hears so; the new approval publishes when it waits again.
      await human('DELETE', `${pr.base}/auto-publish`);
      assert.match((await waiting).stdout, /ask the user to review it/);
      await human('PUT', `${pr.base}/auto-publish`, { draft: true });
      signing.open();
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
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
      await pr.settle();
      assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/auto-lease'], { encoding: 'utf8' }).trim(), theirs);
      assert.equal(pr.created(), false);
      assert.match((await waiting).stdout, /ask the user to review it/);
      await comment(pr.number, 'Not yet.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Not yet\./);
    } finally {
      Repo.prototype.resolve = resolve;
      release();
    }
  });

  await t.test('only the author waiting counts', async () => {
    // Should a review start, it waits for this gate and never finishes.
    const gate = join(dir, 'observer-gate');
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await withFakes({ FAKE_CODEX_GATE: gate }, async () => {
        const pr = await stage('feature/auto-observer', 'observer.js');
        await human('PUT', `${pr.base}/auto-publish`, {});
        const observe = async () => {
          const res = await fetch(`${server.url}${pr.base}/wait?timeout=1`, { headers: { 'x-galley-actor': 'observer' } });
          return { status: res.status, message: (await res.json()).message };
        };
        // Another agent waiting is not the author waiting: Codex does not start ...
        const refused = await observe();
        assert.equal(refused.status, 403);
        assert.match(refused.message, /^only the author of this pull request \(agent\) can wait for its feedback, not observer\./);
        // An author waiting would have Codex deciding by now (consider), or reviewing.
        const { id } = await human('GET', pr.base);
        assert.equal(server.service.codex!.atWork(server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!), null);
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
        // ... and with Codex off for the pull request, auto-publish does not go ahead.
        await human('PATCH', `${pr.base}/reviewers/codex`, { enabled: false });
        assert.equal((await observe()).status, 403);
        await pr.settle();
        assert.equal(pr.created(), false);
        assert.ok((await human('GET', pr.base)).auto_publish);
        assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
      });
    } finally {
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
    await pr.settle();
    assert.equal(pr.created(), false);
    assert.match(await pr.page(), /1 conversation you started is unresolved/);
    // Only the user resolves it: their turn.
    const held = (await human('GET', pr.base)).turn;
    assert.equal(held.whose, 'reviewer');
    assert.ok(held.reasons.some((r: any) => r.text === '1 unresolved thread'), JSON.stringify(held.reasons));

    await withFakes({ FAKE_GH_FAIL: 'HTTP 502: gh is down' }, async () => {
      await human('PUT', `${pr.base}/threads/${thread.id}/resolved`);
      await until(async () => !(await human('GET', pr.base)).auto_publish, 'the failed publish turns auto-publish off');
    });
    assert.equal((await human('GET', pr.base)).auto_publish, null);
    const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
    assert.equal(failed.error, 'gh pr create failed:\nHTTP 502: gh is down');
    const page = await pr.page();
    assert.match(page, /<strong>Auto-publish failed [^]*?<\/strong>[^]*?<pre class="merge-error">gh pr create failed:\nHTTP 502: gh is down<\/pre>/);
    assert.match(page, /Auto-publish failed and turned itself off/);
    assert.match(page, /Publish when reviews are done/);
    // The agent is told to ask the reviewer, never that it was published.
    const told = await waiting;
    assert.match(told.stdout, /^No reviewer agent reviews .*; ask the user to review it: /);
    assert.doesNotMatch(told.stdout, /Published to GitHub/);
    assert.equal((await human('GET', pr.base)).turn.whose, 'reviewer');
    await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'I will publish this by hand.' });
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /I will publish this by hand\./);
  });
});
