// After publishing, the author waiting pushes each commit to GitHub.
import '../helpers/env.ts';
import { dir, git, human, remote, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { published } from '../helpers/pushes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRow } from '../../src/server/db.ts';
import { githubStatus, Service, type ChangeEvent } from '../../src/server/service.ts';

startHarness();

test('after publishing, the author waiting pushes each commit to GitHub, safely', async (t) => {
  const ghCalls = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);

  await t.test('a commit is pushed when the author waits, and no reviewer agent reviews it', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await published('feature/push-update');
      const before = pr.tip();
      const calls = ghCalls().length;
      const sha = pr.commit('export const updated = 1;\n');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Pushed ${sha} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
      // A fast-forward of the agent's commit, as the publish was unsigned.
      assert.deepEqual(pr.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: before.sha });
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
      // GitHub was asked whether it is still open first; the title and description were left alone.
      const asked = ghCalls().slice(calls);
      assert.ok(asked.includes('pr view https://github.com/acme/widgets/pull/7 --json state,mergedAt,mergedBy,mergeCommit,closedAt'), asked.join('\n'));
      assert.ok(!asked.some((c) => c.startsWith('pr edit ')), asked.join('\n'));
      const [push] = await pr.pushes();
      assert.deepEqual([push.result, push.source, push.head, push.before, push.force], ['pushed', git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'), before.sha, false]);
      assert.deepEqual((await human('GET', pr.base)).turn, { whose: 'none', reasons: [] });
      // No Stop iterating once published: there are no automatic reviews to stop.
      const page = await pr.page();
      assert.doesNotMatch(page, /Stop iterating/);
      assert.match(page, /<span class="agent-chunk">Automatic: 0 before publishing<\/span>/);
      // Nor controls for them in the reviewer agents' menus: asking for a review and the settings stay.
      const menus = [...page.matchAll(/<details class="dropdown details-reset agent-menu[^]*?<\/details>/g)].map((m) => m[0]);
      assert.ok(menus.length);
      for (const menu of menus) {
        assert.match(menu, /class="dropdown-item js-run-reviewer"[^>]*>Ask .+ to review</);
        assert.match(menu, />Settings</);
        assert.doesNotMatch(menu, /Automatic reviews of this pull request|reviewer-limit|js-reviewer-switch|Follow Settings/);
      }
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });

  await t.test('signed as the publish was: signed copies after a signed publish, the commits as they are after an unsigned one', async () => {
    const signed = await published('feature/push-signed', { sign: true });
    const first = signed.tip();
    assert.equal(first.signed, true);
    signed.commit('export const signed = 1;\n');
    assert.match((await signed.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    const copy = signed.tip();
    assert.deepEqual([copy.signed, copy.parent], [true, first.sha]);
    assert.notEqual(copy.sha, git('rev-parse', 'HEAD'));
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${copy.sha}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
    assert.deepEqual((await signed.pushes()).map((p) => [p.sign, p.signed, p.force]), [[true, 1, false]]);

    // git signs by default here, but this one was published unsigned: its update is not signed either, nor forced.
    const unsigned = await published('feature/push-unsigned', { sign: false });
    const before = unsigned.tip();
    unsigned.commit('export const unsigned = 1;\n');
    assert.match((await unsigned.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    assert.deepEqual(unsigned.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: before.sha });

    // Published unsigned before galley recorded whether a publish signed: GitHub's commit says so.
    const older = await published('feature/push-older', { sign: false });
    server.service.db.run("UPDATE events SET data = json_remove(data, '$.sign') WHERE pull_id = ? AND type = 'published'", older.id);
    const tip = older.tip();
    older.commit('export const older = 1;\n');
    assert.match((await older.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    assert.deepEqual(older.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: tip.sha });
  });

  await t.test('signed, the commit added on GitHub that the author brought in is kept as it is, and its commit goes on top', async () => {
    const pr = await published('feature/push-kept', { sign: true });
    // Someone pushes an unsigned commit to the branch on GitHub.
    const at = pr.tip().sha;
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${at}^{tree}`], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', at, '-m', 'Commit suggestion'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-kept', theirs]);
    // The agent brings it in and commits on top: signing copies the agent's commit, not theirs.
    git('fetch', '-q', remote, '+refs/heads/feature/push-kept:refs/remotes/origin/feature/push-kept');
    git('reset', '-q', '--hard', 'origin/feature/push-kept');
    const sha = pr.commit('export const kept = 1;\n');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
    const tip = pr.tip();
    assert.deepEqual([tip.signed, tip.parent], [true, theirs]);
    assert.deepEqual((await pr.pushes()).map((p) => [p.result, p.force, p.before]), [['pushed', false, theirs]]);
  });

  await t.test('a publish by hand under way goes first: the push for the waiting author waits for it, and sees no refusal in it', async () => {
    const pr = await published('feature/push-race');
    pr.commit('export const raced = 1;\n');
    const gate = join(dir, 'push-race-gate');
    const pushUpdate = server.service.pushUpdate;
    let pushing = false;
    server.service.pushUpdate = async (...args: Parameters<Service['pushUpdate']>) => {
      pushing = true;
      return pushUpdate.apply(server.service, args);
    };
    try {
      await withFakes({ FAKE_GH_EDIT_GATE: gate }, async () => {
        // The reviewer publishes the update by hand, signed this time, which force-pushes signed copies; gh pr edit holds it up.
        const publishing = human('POST', `${pr.base}/publish`, { sign: true, force: true });
        await until(() => pr.tip().signed, 'the publish pushed');
        // Meanwhile the agent waits with the same head, and the push for it starts.
        const waiting = pr.wait();
        await until(() => pushing, 'the push for the waiting author starts');
        writeFileSync(gate, '');
        await publishing;
        assert.match((await waiting).stdout, /^Published to GitHub/m);
        await server.autoPublisher.settle(pr.id);
      });
    } finally {
      server.service.pushUpdate = pushUpdate;
      rmSync(gate, { force: true });
    }
    assert.deepEqual(await pr.pushes(), []);
  });

  await t.test('while a commit is pushed, and until galley asks GitHub again, the merge GitHub offered for the commit before is nobody\'s turn', async () => {
    const pr = await published('feature/push-stale');
    /** GitHub would merge `head` now, and auto-merge is off; galley asks, as it does every minute. */
    const mergeable = async (head: string) => {
      const node = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] }, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null };
      writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: node } } }));
      await server.service.followGithub();
    };
    const turn = async () => {
      const { whose, reasons } = (await human('GET', pr.base)).turn;
      return { whose, github: reasons.filter((r: any) => r.kind === 'github').map((r: any) => r.text) };
    };
    // GitHub takes the next push once the gate opens.
    const hook = join(remote, 'hooks', 'pre-receive');
    const pushing = join(dir, 'push-stale-pushing');
    const gate = join(dir, 'push-stale-gate');
    writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\ntouch "${pushing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\n`);
    chmodSync(hook, 0o755);
    let waiting: ReturnType<typeof pr.wait> | null = null;
    try {
      const first = pr.tip().sha;
      await mergeable(first);
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
      // The agent commits and waits, and its commit is on its way to GitHub.
      const sha = pr.commit('export const stale = 1;\n');
      waiting = pr.wait();
      await until(() => existsSync(pushing), 'the push started');
      assert.deepEqual(await turn(), { whose: 'none', github: [] });
      writeFileSync(gate, '');
      assert.match((await waiting).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
      assert.deepEqual(await turn(), { whose: 'none', github: [] });
      // Force-pushed back to the first commit on GitHub before galley asked: GitHub says what it said
      // before, which is about GitHub's commit now, and pages hear of it.
      const heard: string[] = [];
      const hear = (e: ChangeEvent) => void (e.pullId === pr.id && heard.push(e.type));
      server.service.bus.on('change', hear);
      try {
        await mergeable(first);
      } finally {
        server.service.bus.off('change', hear);
      }
      assert.ok(heard.includes('github_status'), heard.join());
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
      // Pushed again, GitHub would merge the new commit: the reviewer's turn.
      await mergeable(pr.tip().sha);
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
    } finally {
      // The push goes through, also after a failure, before the next test pushes.
      rmSync(hook, { force: true });
      writeFileSync(gate, '');
      await waiting;
      for (const f of [pushing, gate, join(dir, 'gh-pulls.json')]) rmSync(f, { force: true });
    }
  });

  await t.test('GitHub\'s answer to a question galley asked before a push counts as being about the commit before it, also when it comes after the push', async () => {
    const pr = await published('feature/push-asked');
    const first = pr.tip().sha;
    // GitHub would merge the first commit, and auto-merge is off.
    const node = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] }, headRefOid: first, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: node } } }));
    const gate = join(dir, 'follow-gate');
    try {
      await withFakes({ FAKE_GH_FOLLOW_GATE: gate }, async () => {
        // galley asks GitHub, which takes its time to answer ...
        const asking = server.service.followGithub();
        await until(() => existsSync(`${gate}.asked`), 'galley asked GitHub');
        // ... while the agent's next commit is pushed.
        const sha = pr.commit('export const asked = 1;\n');
        assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
        writeFileSync(gate, '');
        await asking;
      });
      // The answer is about the commit the push replaced: the merge it offers is nobody's turn.
      assert.equal(githubStatus(server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pr.id)!)?.head, first);
      const { whose, reasons } = (await human('GET', pr.base)).turn;
      assert.deepEqual([whose, reasons.filter((r: any) => r.kind === 'github')], ['none', []]);
    } finally {
      for (const f of [gate, `${gate}.asked`, join(dir, 'gh-pulls.json')]) rmSync(f, { force: true });
    }
  });
});
