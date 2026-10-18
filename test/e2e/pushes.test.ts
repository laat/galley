// After publishing, the author waiting pushes each commit to GitHub.
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
import { githubStatus, Service, type ChangeEvent } from '../../src/server/service.ts';

startHarness();

test('after publishing, the author waiting pushes each commit to GitHub, safely', async (t) => {
  /** The branch's tip on GitHub (the bare remote): its commit, whether it is signed, and its parent. */
  const tip = (branch: string) => {
    const sha = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' });
    return { sha, signed: /^gpgsig /m.test(commit), parent: commit.match(/^parent ([0-9a-f]+)$/m)?.[1] ?? null };
  };
  /** Stage a branch with one commit as the agent, publish it as the reviewer, and let the agent hear of the publish. */
  const published = async (branch: string, opts: { sign?: boolean } = {}) => {
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
    const { id } = await human('POST', `${base}/publish`, { sign: opts.sign ?? false });
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
      tip: () => tip(branch),
      pushes: async (): Promise<any[]> => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).filter((e: any) => e.event === 'github_push'),
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(),
    };
  };
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

  /** Runs `fn` with galley's fetches from GitHub, over https, going to the bare repository. */
  const fetchingFromBare = async (fn: () => Promise<void>) => {
    // The remote's URL is the ssh one meanwhile, so `git remote get-url` still gives GitHub's; pushes go to the bare repository too.
    git('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
    git('config', 'remote.origin.pushurl', remote);
    git('config', `url.${remote}.insteadOf`, 'https://github.com/acme/widgets.git');
    try {
      await fn();
    } finally {
      git('config', '--unset', `url.${remote}.insteadOf`);
      git('config', '--unset', 'remote.origin.pushurl');
      git('remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
    }
  };
  /** A commit with `at`'s tree on top of `parent` on GitHub, made there (a suggestion committed, a rebase); its SHA. */
  const madeOnGithub = (at: string, parent: string, message: string) => {
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${at}^{tree}`], { encoding: 'utf8' }).trim();
    return execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', parent, '-m', message], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' },
    }).trim();
  };

  await t.test('a branch that moved on GitHub is not overwritten: the author and the reviewer hear why, it is not tried again, and galley fetches the branch', () =>
    fetchingFromBare(async () => {
      const pr = await published('feature/push-moved');
      // Someone pushes to the branch on GitHub ...
      const at = pr.tip().sha;
      const theirs = madeOnGithub(at, at, 'Commit suggestion');
      execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-moved', theirs]);
      // ... while the agent rewrites its commit, which needs a force-push.
      git('commit', '-q', '--amend', '-m', 'Add push-moved.js, reworded');
      const sha = git('rev-parse', '--short=7', 'HEAD');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Could not push ${sha} to GitHub: git push failed \\(the branch on GitHub changed since it was last published`, 'm'));
      assert.match(r.stdout, /stale info/);
      assert.match(r.stdout, /Nothing on GitHub was overwritten, and this commit is not tried again\. Do not push or force-push to GitHub yourself/);
      // galley fetched the branch, which the agent may not be able to do from its sandbox: only its remote-tracking branch moved.
      assert.match(r.stdout, /one that has the commits added there \(galley fetched the branch on GitHub into origin\/feature\/push-moved: rebase onto it\)/);
      assert.equal(git('rev-parse', 'refs/remotes/origin/feature/push-moved'), theirs);
      assert.equal(git('rev-parse', '--short=7', 'feature/push-moved'), sha);
      assert.equal(pr.tip().sha, theirs);
      const [push] = await pr.pushes();
      assert.deepEqual([push.result, push.source, push.head, push.before, push.force, push.retry], ['failed', git('rev-parse', 'HEAD'), null, at, true, false]);
      assert.deepEqual(push.fetched, { ref: 'origin/feature/push-moved', sha: theirs, rewritten: false });

      // The reviewer sees why, and it is the reviewer's to sort out.
      const page = await pr.page();
      assert.match(page, new RegExp(`<strong>Could not force-push <code>${sha}</code> to GitHub <relative-time [^]*?<pre class="merge-error">git push failed \\(the branch on GitHub changed since it was last published`));
      assert.match(page, new RegExp(`Could not force-push <code>${sha}</code> to <a [^>]*>acme/widgets#7</a> [^]*?; nothing on GitHub was overwritten`));
      const { turn } = await human('GET', pr.base);
      assert.equal(turn.whose, 'reviewer');
      assert.ok(turn.reasons.some((x: any) => x.text === `update not published: commits; pushing ${sha} failed`), JSON.stringify(turn.reasons));

      // Not tried again for this commit: the next wait waits, and GitHub keeps its commit.
      assert.equal((await pr.wait('1s')).code, 124);
      assert.equal(pr.tip().sha, theirs);
      assert.equal((await pr.pushes()).length, 1);

      // The agent rebases onto what galley fetched: its next commit is pushed on top of the commit added on GitHub.
      git('rebase', '-q', 'origin/feature/push-moved');
      const next = pr.commit('export const moved = 1;\n');
      assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${next} to GitHub`, 'm'));
      assert.deepEqual([pr.tip().sha, pr.tip().parent], [git('rev-parse', 'HEAD'), theirs]);
    }));

  await t.test('a branch rewritten on GitHub is fetched, and the author hears that a commit rebased onto it would be refused too', () =>
    fetchingFromBare(async () => {
      const pr = await published('feature/push-rewritten');
      // GitHub's "Update with rebase", or a force-push there: a copy of the commit galley pushed, which the branch no longer has.
      const at = pr.tip().sha;
      const theirs = madeOnGithub(at, git('rev-parse', 'main'), 'Add push-rewritten.js, rebased');
      execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-rewritten', theirs]);
      pr.commit('export const rewritten = 1;\n');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /stale info/);
      assert.match(r.stdout, /The branch on GitHub was rewritten there: galley fetched it into origin\/feature\/push-rewritten, and it no longer has the commit galley pushed last, so the commits you wait with are refused too until the user sorts it out\./);
      assert.doesNotMatch(r.stdout, /rebase onto it/);
      assert.equal(git('rev-parse', 'refs/remotes/origin/feature/push-rewritten'), theirs);
      const [push] = await pr.pushes();
      assert.deepEqual(push.fetched, { ref: 'origin/feature/push-rewritten', sha: theirs, rewritten: true });
    }));

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
