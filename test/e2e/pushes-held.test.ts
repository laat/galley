// After publishing, a commit the author waits with is not pushed, or not yet: GitHub declines it,
// can not be asked or says it was merged, or the author has feedback to read first.
import '../helpers/env.ts';
import { dir, git, human, remote, send, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { published } from '../helpers/pushes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

test('after publishing, a commit is not pushed, or not yet, when GitHub declines it, can not be asked or says it was merged, or the author has feedback to read', async (t) => {
  await t.test('a push GitHub declines, for a secret say, is told to the author, and not tried again', async () => {
    const pr = await published('feature/push-declined');
    const before = pr.tip().sha;
    // GitHub's push protection, or a rule on the branch.
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = refs/heads/feature/push-declined ]; then echo "GH013: Repository rule violations found: push cannot contain secrets" >&2; exit 1; fi; done\n');
    chmodSync(hook, 0o755);
    try {
      const sha = pr.commit('export const token = "ghp_0";\n');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Could not push ${sha} to GitHub: git push failed \\(GitHub declined it, for example for a secret in it, or a rule on the branch\\)`, 'm'));
      assert.match(r.stdout, /GH013: Repository rule violations found/);
      assert.equal((await pr.wait('1s')).code, 124);
    } finally {
      rmSync(hook, { force: true });
    }
    assert.equal(pr.tip().sha, before);
  });

  await t.test('GitHub could not be asked: nothing is pushed, the author waits on, and its next wait tries again', async () => {
    const pr = await published('feature/push-retry');
    const before = pr.tip().sha;
    const sha = pr.commit('export const retried = 1;\n');
    await withFakes({ FAKE_GH_FAIL: 'HTTP 502: gh is down' }, async () => {
      // The author hears nothing of it, and one wait tries once.
      assert.equal((await pr.wait('3s')).code, 124);
      await server.autoPublisher.settle(pr.id);
    });
    assert.equal(pr.tip().sha, before);
    const failed = await pr.pushes();
    assert.deepEqual(failed.map((p) => [p.result, p.retry, p.error]), [['failed', true, 'could not ask GitHub whether https://github.com/acme/widgets/pull/7 is still open:\nHTTP 502: gh is down']]);
    // The reviewer sees it, and that it is tried again.
    assert.match(await pr.page(), new RegExp(`<strong>Could not push <code>${sha}</code> to GitHub <relative-time [^]*?It is tried again each time agent waits`));
    const { turn } = await human('GET', pr.base);
    assert.equal(turn.whose, 'reviewer');
    assert.ok(turn.reasons.some((x: any) => x.text === `update not published: commits; pushing ${sha} failed`), JSON.stringify(turn.reasons));
    // GitHub answers again: the next wait pushes it.
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
    assert.equal(pr.tip().sha, git('rev-parse', 'HEAD'));
  });

  await t.test('nothing is pushed once GitHub says it was merged, also before galley has heard', async () => {
    const pr = await published('feature/push-merged');
    const before = pr.tip().sha;
    pr.commit('export const late = 1;\n');
    // Merged on GitHub a moment ago: following has not asked yet, so galley knows only when it asks before the push.
    await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T12:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '2'.repeat(33) } }) }, async () => {
      assert.match((await pr.wait()).stdout, /^Merged on GitHub as e468a4e by laat/m);
      await server.autoPublisher.settle(pr.id);
    });
    assert.equal(pr.tip().sha, before);
    assert.deepEqual(await pr.pushes(), []);
  });

  await t.test('feedback the author has not seen holds the push until it has', async () => {
    const pr = await published('feature/push-held');
    const before = pr.tip().sha;
    const sha = pr.commit('export const held = 1;\n');
    await send('feature/push-held');
    // The reviewer asks Codex and Claude to look at the new commit. Codex comments; Claude is still at it.
    const gate = join(dir, 'push-held-gate');
    await withFakes({
      FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'One thing.', comments: [{ path: 'push-held.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name the value.' }] }),
      FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
      FAKE_CLAUDE_GATE: gate,
    }, async () => {
      try {
        await human('POST', `${pr.base}/reviewers/codex`);
        await human('POST', `${pr.base}/reviewers/claude`);
        await server.service.codex!.settle(pr.id);
        // The agent waits: its wait holds Codex's review for Claude's, and its commit is not pushed meanwhile.
        const waiting = pr.wait();
        await until(async () => (await human('GET', pr.base)).author_waiting, 'the agent waits');
        await server.autoPublisher.settle(pr.id);
        assert.equal(pr.tip().sha, before);
        writeFileSync(gate, '');
        const r = await waiting;
        assert.match(r.stdout, /Name the value\./);
        assert.doesNotMatch(r.stdout, /Pushed/);
        await server.service.claude!.settle(pr.id);
        assert.equal(pr.tip().sha, before);
        // Seen, the next wait pushes it.
        assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
        assert.equal(pr.tip().sha, git('rev-parse', 'HEAD'));
      } finally {
        rmSync(gate, { force: true });
      }
    });
  });
});
