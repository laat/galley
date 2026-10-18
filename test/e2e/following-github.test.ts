// Published pull requests: what galley reads about them on GitHub, until they are merged or closed.
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

test('published pull requests are followed until they are merged or closed on GitHub', async (t) => {
  /** Stage a branch with one commit as the agent (`actor`), publish it as the reviewer, and let the agent hear of the publish. */
  const published = async (branch: string, file: string, actor = 'agent') => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', '--no-review'], { actor });
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    const { id } = await human('POST', `${base}/publish`, { sign: false });
    // The first wait after a publish reports it; the next one waits for GitHub.
    const heard = await cli(['pr', 'wait', String(number), '--timeout', '20s'], { actor });
    assert.match(heard.stdout, /^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
    assert.match(heard.stdout, new RegExp(`Run \`galley pr wait s${number}\` again to hear when it is merged or closed on GitHub`));
    return {
      number,
      id,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      /** How many times galley has asked GitHub about it. */
      asked: () => readFileSync(join(dir, 'gh.log'), 'utf8').split(`p${id}:pullRequest(number:7)`).length - 1,
    };
  };
  /** What GitHub says about these pull requests (by staged pull id), and galley asking it, as it does every minute. */
  const githubSays = async (nodes: Record<number, object>) => {
    const repository = Object.fromEntries(Object.entries(nodes).map(([id, node]) => [`p${id}`, node]));
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository } }));
    await server.service.followGithub();
  };
  const untilWaiting = async (...bases: string[]) => {
    for (const base of bases) await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
  };
  const comment = (number: number, body: string) => human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body });
  const mergeCommit = 'e468a4e' + '1'.repeat(33);
  const open = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] } };
  const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: mergeCommit }, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'laat' } }] } };
  const closed = { state: 'CLOSED', mergedAt: null, closedAt: '2026-10-16T10:00:00Z', mergedBy: null, mergeCommit: null, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] } };

  try {
    await t.test('pr wait after a publish waits for the merge, and says who merged it as what', async () => {
      const pr = await published('feature/follow-merge', 'merge.js');
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await untilWaiting(pr.base);
      // Still open on GitHub: nothing to tell.
      await githubSays({ [pr.id]: open });
      assert.equal((await human('GET', pr.base)).github_state, 'open');
      const returned = await Promise.race([waiting.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
      assert.equal(returned, false, 'a pull request still open on GitHub does not end the wait');
      await githubSays({ [pr.id]: merged });
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
      assert.match(r.stdout, /Next: fast-forward your main to the merge, remove the worktree and the branch feature\/follow-merge/);
      // Every later wait says so at once.
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Merged on GitHub as e468a4e by laat/m);

      const rest = await human('GET', pr.base);
      assert.deepEqual(
        [rest.github_state, rest.merged, rest.merged_at, rest.merged_by.login, rest.merge_commit_sha, rest.github_closed_by],
        ['merged', true, '2026-10-16T09:00:00Z', 'laat', mergeCommit, 'laat'],
      );
      const view = await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,mergedAt,mergedBy,mergeCommit,turn']);
      assert.deepEqual(JSON.parse(view.stdout), {
        state: 'MERGED',
        closed: true,
        mergedAt: '2026-10-16T09:00:00Z',
        mergedBy: { login: 'laat', is_bot: false },
        mergeCommit: { oid: mergeCommit },
        // A merged pull request is nobody's turn.
        turn: { whose: 'NONE', reasons: [] },
      });
      assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^state:\tMERGED$[^]*^merged:\tas e468a4e by laat at 2026-10-16T09:00:00Z$/m);
      assert.match((await cli(['pr', 'list', '--state', 'merged'])).stdout, new RegExp(`^s#${pr.number}\\tAdd merge\\.js\\tfeature/follow-merge\\tMERGED\\t`, 'm'));
      const event = (await pr.timeline()).find((e) => e.event === 'merged');
      assert.deepEqual([event.by, event.commit, event.at, event.url], ['laat', mergeCommit, '2026-10-16T09:00:00Z', 'https://github.com/acme/widgets/pull/7']);

      const page = await pr.page();
      assert.match(page, /<span class="State State--merged" title="Merged on GitHub"><svg class="octicon octicon-git-merge"[^>]*>.*?<\/svg> Merged<\/span>/);
      assert.match(
        page,
        new RegExp(
          `<a class="author" href="https://github\\.com/laat" target="_blank" rel="noopener">laat</a> merged commit <a class="commit-link" href="https://github\\.com/acme/widgets/commit/${mergeCommit}" target="_blank" rel="noopener"><code>e468a4e</code></a> into <span class="branch-name branch-name-sm">main</span> on GitHub`,
        ),
      );
      assert.match(page, /<strong>Merged on GitHub<\/strong>/);
      assert.doesNotMatch(page, /js-publish-form/);
      const list = await (await fetch(`${server.url}/acme/widgets?state=all`)).text();
      assert.match(list, new RegExp(`octicon-git-merge color-fg-done[^]*?href="/acme/widgets/pull/${pr.number}">Add merge\\.js</a>\\s*<span class="Label Label--merged">Merged</span>`));
      // Nothing is published over a merge.
      const res = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST' });
      assert.equal(res.status, 422);
      assert.match((await res.json()).message, /merged on GitHub/);

      // Merged is final: galley stops asking GitHub about it.
      const asked = pr.asked();
      await githubSays({ [pr.id]: merged });
      assert.equal(pr.asked(), asked);
      assert.ok(!server.service.followed().some((p) => p.id === pr.id));

      // Its branch can be staged again, and the merged pull request keeps the commits it was merged with.
      const mergedHead = (await human('GET', pr.base)).head.sha;
      git('checkout', '-q', 'feature/follow-merge');
      writeFileSync(join(repo, 'merge.js'), 'export const more = 1;\n');
      git('commit', '-qam', 'More work on the branch');
      const again = await cli(['pr', 'create', '--title', 'More on the merged branch', '--body', 'x', '--no-review']);
      assert.equal(again.code, 0, again.stderr);
      await server.service.pollAll();
      assert.equal((await human('GET', pr.base)).head.sha, mergedHead);
      assert.equal((await human('GET', `${pr.base}/commits`)).length, 1);
      assert.equal(JSON.parse((await cli(['pr', 'view', '--json', 'number'])).stdout).number, Number(again.stdout.trim().split('/').pop()));
    });

    await t.test('an author named "github" hears of the merge at once', async () => {
      const pr = await published('feature/follow-github', 'github.js', 'github');
      let ended = false;
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s'], { actor: 'github' }).finally(() => (ended = true));
      await untilWaiting(pr.base);
      // What galley learns from GitHub has no actor: the wait does not take it for the author's own change.
      await githubSays({ [pr.id]: merged });
      await until(() => ended, 'the wait ends on the merge, not at its timeout', 5000);
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: /m);
    });

    await t.test('commits GitHub did not merge: pr wait lists them and says to keep the branch', async () => {
      const pr = await published('feature/follow-left-out', 'left-out.js');
      const branch = 'feature/follow-left-out';
      // The base moves, and the author rebases onto it: the base's commit is not left out, the copy of the published one is.
      git('checkout', '-q', 'main');
      writeFileSync(join(repo, 'base-moved.js'), 'export {};\n');
      git('add', 'base-moved.js');
      git('commit', '-qm', 'Move the base');
      git('push', '-q', 'origin', 'main');
      git('checkout', '-q', branch);
      git('rebase', '-q', 'main');
      const copy = git('rev-parse', 'HEAD');
      const moved = git('rev-parse', 'main');
      // Synced before galley hears of the merge, and never pushed: the author did not wait with it.
      writeFileSync(join(repo, 'left-out.js'), 'export const synced = 1;\n');
      git('commit', '-qam', 'Synced before the merge');
      const synced = git('rev-parse', 'HEAD');
      await until(async () => (await human('GET', pr.base)).head.sha === synced, 'the server has the synced commit');
      assert.deepEqual((await human('GET', pr.base)).unpublished_changes, ['commits']);
      await githubSays({ [pr.id]: merged });
      // Made after it, when galley no longer follows the branch.
      writeFileSync(join(repo, 'left-out.js'), 'export const after = 1;\n');
      git('commit', '-qam', 'Made after the merge');
      const after = git('rev-parse', 'HEAD');
      const wait = async () => {
        const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '5s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
        assert.doesNotMatch(r.stdout, /remove the worktree/);
        return r.stdout;
      };
      const short = (sha: string) => sha.slice(0, 7);
      assert.match(
        await wait(),
        new RegExp(
          `^GitHub merged it without these 3 commits of ${branch}, which it never got:\n  ${short(copy)} Add left-out\\.js\n  ${short(synced)} Synced before the merge\n  ${short(after)} Made after the merge\n` +
            `Next: keep the branch ${branch} and tell the user\\. Fast-forward your main to the merge, move them onto it with \`git rebase --onto main ${short(moved)} ${branch}\`, `,
          'm',
        ),
      );

      // With a merge among them, no rebase carries them over as they are.
      git('checkout', '-qb', 'feature/follow-left-out-side', copy);
      writeFileSync(join(repo, 'side.js'), 'export {};\n');
      git('add', 'side.js');
      git('commit', '-qm', 'Side work');
      git('checkout', '-q', branch);
      git('merge', '-q', '--no-ff', '-m', 'Merge the side work', 'feature/follow-left-out-side');
      const withMerge = await wait();
      assert.match(withMerge, /^GitHub merged it without these 5 commits of feature\/follow-left-out, which it never got:$/m);
      assert.match(withMerge, new RegExp(`^Next: keep the branch ${branch}, tell the user, and ask how to stage them as a new pull request: a rebase would not carry them over as they are \\(a merge, say\\)\\.`, 'm'));
      assert.doesNotMatch(withMerge, /git rebase/);

      // Deleted here: what galley last saw, and how to bring the branch back.
      git('checkout', '-q', 'main');
      git('branch', '-qD', branch, 'feature/follow-left-out-side');
      const gone = await wait();
      assert.match(gone, new RegExp(`^GitHub merged it without these 2 commits of ${branch}, which it never got:\n  ${short(copy)} Add left-out\\.js\n  ${short(synced)} Synced before the merge\n`, 'm'));
      assert.match(gone, new RegExp(`^The branch ${branch} is gone here; bring it back with \`git branch ${branch} ${synced}\`\\. Next: keep the branch`, 'm'));
    });

    await t.test('a merge found while a publish signs stops the push', async () => {
      const pr = await published('feature/follow-race', 'race.js');
      writeFileSync(join(repo, 'race.js'), 'export const raced = 1;\n');
      git('commit', '-qam', 'Race the merge');
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-race'], { encoding: 'utf8' }).trim();
      const before = remoteHead();
      // Signing waits, as for a passphrase, while following finds the merge.
      const signing = join(dir, 'race-signing');
      const gate = join(dir, 'race-gate');
      const program = join(dir, 'race-ssh-keygen');
      writeFileSync(program, `#!/bin/sh\ntouch "${signing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.02; done\nexec ssh-keygen "$@"\n`);
      chmodSync(program, 0o755);
      git('config', 'gpg.ssh.program', program);
      try {
        const publishing = fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: true, force: true }) });
        await until(() => existsSync(signing), 'signing starts');
        await githubSays({ [pr.id]: merged });
        writeFileSync(gate, '');
        const res = await publishing;
        assert.equal(res.status, 422);
        assert.match((await res.json()).message, /merged on GitHub/);
        assert.equal(remoteHead(), before);
      } finally {
        git('config', '--unset', 'gpg.ssh.program');
        for (const f of [signing, gate, program]) rmSync(f, { force: true });
      }
    });

    await t.test('closed on GitHub without merging, and followed again when published again', async () => {
      const pr = await published('feature/follow-close', 'close.js');
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await untilWaiting(pr.base);
      await githubSays({ [pr.id]: closed });
      const r = await waiting;
      assert.match(r.stdout, /^Closed on GitHub without merging by octocat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Closed on GitHub without merging/m);
      const view = await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,closedAt,mergedAt,turn']);
      assert.deepEqual(JSON.parse(view.stdout), { state: 'CLOSED', closed: true, closedAt: '2026-10-16T10:00:00Z', mergedAt: null, turn: { whose: 'NONE', reasons: [] } });
      const page = await pr.page();
      assert.match(page, /<span class="State State--closed" title="Closed on GitHub">/);
      assert.match(page, /<a class="author" href="https:\/\/github\.com\/octocat" target="_blank" rel="noopener">octocat<\/a> closed this pull request on GitHub/);
      assert.match(page, /<strong>Closed on GitHub<\/strong>/);

      // Published again (it was reopened on GitHub, say): followed again, and a close GitHub still reports is no news.
      writeFileSync(join(repo, 'close.js'), 'export const again = 1;\n');
      git('commit', '-qam', 'Again');
      await human('POST', `${pr.base}/publish`, { sign: false });
      assert.equal((await human('GET', pr.base)).github_state, null);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Published to GitHub/m);
      const asked = pr.asked();
      await githubSays({ [pr.id]: closed });
      assert.equal(pr.asked(), asked + 1);
      assert.equal((await human('GET', pr.base)).github_state, 'closed');
      assert.equal((await pr.timeline()).filter((e) => e.event === 'closed_on_github').length, 1);

      // Reopened on GitHub and published again: open, with no close time, though galley keeps the close to know it if GitHub reports it again.
      writeFileSync(join(repo, 'close.js'), 'export const reopened = 1;\n');
      git('commit', '-qam', 'Reopened');
      await human('POST', `${pr.base}/publish`, { sign: false });
      await githubSays({ [pr.id]: open });
      const reopened = await human('GET', pr.base);
      assert.deepEqual([reopened.state, reopened.staging_state, reopened.github_state, reopened.closed_at], ['open', 'published', 'open', null]);
      assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,closedAt'])).stdout), { state: 'PUBLISHED', closed: false, closedAt: null });
    });

    await t.test('how it stands on GitHub is shown to the reviewer, and makes it their turn; the agent waits on', async () => {
      const pr = await published('feature/follow-checks', 'checks.js');
      const n = String(pr.number);
      const head = 'c0ffee' + '0'.repeat(34);
      const run = (name: string, job: number, status: string, conclusion: string | null = null) => ({
        __typename: 'CheckRun',
        databaseId: job,
        name,
        status,
        conclusion,
        detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${job}`,
        checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
      });
      const github = (checks: object[], more: object = {}) => ({
        ...open,
        headRefOid: head,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } }, checkSuites: { nodes: [] } } }] },
        ...more,
      });
      const turn = async () => JSON.parse((await cli(['pr', 'view', n, '--json', 'turn'])).stdout).turn;

      // The agent waits for the reviewer; nothing from GitHub below wakes it.
      const waiting = cli(['pr', 'wait', n, '--timeout', '20s']);
      await untilWaiting(pr.base);

      // Checks run, then pass: shown, and nobody's turn.
      await githubSays({ [pr.id]: github([run('test', 11, 'IN_PROGRESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')]) });
      assert.match((await cli(['pr', 'view', n])).stdout, /^github:\tchecks: 1 pending, 1 passed$/m);
      await githubSays({ [pr.id]: github([run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')]) });
      const view = JSON.parse((await cli(['pr', 'view', n, '--json', 'statusCheckRollup,mergeable,mergeStateStatus'])).stdout);
      assert.deepEqual(view.statusCheckRollup[0], { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/11' });
      assert.deepEqual([view.mergeable, view.mergeStateStatus], ['MERGEABLE', 'CLEAN']);
      assert.match(await pr.page(), /<strong>All checks have passed<\/strong>/);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /Add checks\.js<\/a> <span class="checks-indicator" title="All 2 checks passed on GitHub">/);
      assert.equal((await turn()).whose, 'NONE');

      /** The group the repository's Published tab shows it in, and its row there. */
      const listed = async () => {
        const groups = (await (await fetch(`${server.url}/acme/widgets?state=published`)).text()).split('<div class="Box-row turn-group">').slice(1);
        const group = groups.find((g) => g.includes(`href="/acme/widgets/pull/${n}"`))!;
        const row = group.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${n}"`))!;
        return { group: group.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)![1], row };
      };
      // GitHub would merge it now, and auto-merge is off: the reviewer's turn, to merge it there.
      const passed = [run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')];
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null }) });
      const ready = await turn();
      assert.equal(ready.whose, 'REVIEWER');
      assert.deepEqual(ready.reasons.filter((r: string) => /GitHub/.test(r)), ['ready to merge on GitHub']);
      const mine = await listed();
      assert.equal(mine.group, 'Your turn');
      assert.match(mine.row, /<span class="turn-reason"><svg [^>]*octicon-mark-github[^]*?<\/svg>ready to merge on GitHub<\/span>/);
      // Its title opens it on GitHub, where the reviewer merges it; its number opens it here.
      assert.match(mine.row, /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add checks\.js<\/a>/);
      assert.match(mine.row, new RegExp(`<a href="/acme/widgets/pull/${n}">s#${n}</a> staged`));
      // With auto-merge on, GitHub merges it by itself.
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: { enabledAt: '2026-10-17T12:00:00Z' } }) });
      assert.deepEqual(await turn(), { whose: 'NONE', reasons: [] });
      assert.equal((await listed()).group, 'Waiting on GitHub');
      // Blocked by a required review: it waits on GitHub, for those asked to review.
      const requested = { totalCount: 3, nodes: [{ requestedReviewer: { login: 'eskilgh' } }, { requestedReviewer: { login: 'cbjerkan' } }, { requestedReviewer: { combinedSlug: 'acme/platform' } }] };
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: requested }) });
      assert.deepEqual(await turn(), { whose: 'NONE', reasons: ['waiting for review from eskilgh, cbjerkan, acme/platform'] });
      const blocked = await listed();
      assert.equal(blocked.group, 'Waiting on GitHub');
      assert.match(blocked.row, /<\/svg> acme\/widgets#7<\/a><\/span><span class="turn-reason">waiting for review from eskilgh, cbjerkan, acme\/platform<\/span>/);
      assert.match(blocked.row, /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add checks\.js<\/a>/);
      assert.match(blocked.row, new RegExp(`<a class="pr-row-number" href="/acme/widgets/pull/${n}">s#${n}</a>`));
      // A token without the read:org scope: GitHub refuses the teams' names, so galley asks again without them, from then on.
      const follows = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.includes('reviewRequests('));
      const before = follows().length;
      try {
        await withFakes({ FAKE_GH_NO_READ_ORG: '1' }, async () => {
          const unnamed = { totalCount: 2, nodes: [{ requestedReviewer: { login: 'eskilgh' } }, { requestedReviewer: {} }] };
          await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: unnamed }) });
          assert.deepEqual(await turn(), { whose: 'NONE', reasons: ['waiting for review from eskilgh and 1 more'] });
          await server.service.followGithub();
          const since = follows().slice(before);
          assert.equal(since.filter((q) => q.includes('combinedSlug')).length, 1, 'refused once');
          assert.match(since.at(-1)!, new RegExp(`p${pr.id}:pullRequest`));
          assert.doesNotMatch(since.at(-1)!, /combinedSlug/);
        });
      } finally {
        server.service.githubTeamNames = true;
      }

      // More checks than one page reads, and one past it failed: GitHub's sum says so.
      const many = github([]);
      many.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE', contexts: { totalCount: 130, nodes: [run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')] } } as any;
      await githubSays({ [pr.id]: many });
      assert.match(await pr.page(), /<strong>Some checks were not successful<\/strong><div class="color-fg-muted">2 successful of the first 2 of 130 checks\./);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /<span class="checks-indicator" title="Checks failed on GitHub">/);
      assert.deepEqual((await turn()).reasons.filter((r: string) => /GitHub/.test(r)), ['checks failed on GitHub']);
      assert.match((await cli(['pr', 'view', n])).stdout, /^github:\tchecks: failed \(first 2 of 130: 2 passed\)$/m);

      // A failed check, changes requested with a thread (on an earlier page than the first query
      // reads), and a conflict: shown, and the reviewer's turn, saying why.
      const thread = {
        id: 'PRRT_1',
        isResolved: false,
        isOutdated: false,
        path: 'checks.js',
        line: 1,
        originalLine: 1,
        startLine: null,
        diffSide: 'RIGHT',
        comments: { nodes: [{ databaseId: 501, author: { login: 'octocat' }, body: 'Export a function.', createdAt: '2026-10-16T12:00:00Z', url: 'https://github.com/acme/widgets/pull/7#discussion_r501', diffHunk: '@@ -0,0 +1 @@\n+export {};' }] },
      };
      writeFileSync(join(dir, 'gh-pulls-earlier.json'), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [thread] } } } } }));
      try {
        await githubSays({
          [pr.id]: github([run('test', 21, 'COMPLETED', 'FAILURE'), run('lint', 12, 'COMPLETED', 'SUCCESS')], {
            reviewDecision: 'CHANGES_REQUESTED',
            reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'T50' }, nodes: [] },
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
          }),
        });
      } finally {
        rmSync(join(dir, 'gh-pulls-earlier.json'), { force: true });
      }
      assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /reviewThreads\(last:100,before:\$cursor\).* -f cursor=T50$/m);
      const page = await pr.page();
      assert.match(page, /<strong>Some checks were not successful<\/strong>/);
      assert.match(page, /<strong>Changes requested on GitHub<\/strong>/);
      assert.match(page, /<strong>1 unresolved conversation on GitHub<\/strong>/);
      assert.match(page, /This branch has conflicts with <span class="branch-name branch-name-sm">main<\/span> on GitHub/);
      const yours = await turn();
      assert.equal(yours.whose, 'REVIEWER');
      assert.match(yours.reasons.join(' · '), /1 check failed on GitHub · changes requested on GitHub · 1 unresolved thread on GitHub · conflicts with main on GitHub/);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /<span class="turn-reason"><svg [^>]*octicon-mark-github[^]*?<\/svg>1 check failed on GitHub<\/span>/);
      assert.doesNotMatch((await cli(['pr', 'view', n, '--comments'])).stdout, /Export a function/);
      // The earlier page cannot be read this time (gh-pulls-earlier.json is gone): its thread stays.
      await githubSays({
        [pr.id]: github([run('test', 21, 'COMPLETED', 'FAILURE'), run('lint', 12, 'COMPLETED', 'SUCCESS')], {
          reviewDecision: 'CHANGES_REQUESTED',
          reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'T50' }, nodes: [] },
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
        }),
      });
      assert.match(await pr.page(), /<strong>1 unresolved conversation on GitHub<\/strong>/);
      assert.match((await turn()).reasons.join(' · '), /1 unresolved thread on GitHub/);

      // The agent hears only from the reviewer, who decides what to hand over.
      await comment(pr.number, 'The test fails on GitHub; please fix it.');
      const heard = (await waiting).stdout;
      assert.match(heard, /The test fails on GitHub; please fix it\./);
      assert.doesNotMatch(heard, /Export a function|Checks failed|Conflicts/);
    });

    await t.test("after auto-publish's first publish, the agent's wait pushes the fix for a failed check, unreviewed, and asks for auto-merge again; nothing after a merge", async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/follow-auto');
      writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = true;\n');
      git('add', 'auto-fix.js');
      git('commit', '-qm', 'Add auto-fix.js');
      const created = await cli(['pr', 'create', '--title', 'Add auto-fix.js', '--body', 'x']);
      assert.equal(created.code, 0, created.stderr);
      const n = created.stdout.trim().split('/').pop()!;
      const base = `/api/repos/acme/widgets/pulls/${n}`;
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-auto'], { encoding: 'utf8' }).trim();
      const updates = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr edit https://github.com/acme/widgets/pull/7 ')).length;
      const wait = async (expect: RegExp) => {
        const r = await cli(['pr', 'wait', n, '--timeout', '20s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, expect);
        return r.stdout;
      };
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        // With auto-merge, which is asked for again after each push.
        await human('PUT', `${base}/auto-publish`, { sign: false, auto_merge: true, merge_method: 'squash' });
        const merges = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr merge https://github.com/acme/widgets/pull/7 --auto --squash --match-head-commit ')).length;
        const mergesBefore = merges();
        // Codex finds nothing; once the agent has seen that and waits, the first publish, which uses auto-publish up.
        await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, () => wait(/Looks right\./));
        assert.match(await wait(/^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m), /It is published: commit and wait/);
        const { id, auto_publish } = await human('GET', base);
        assert.equal(auto_publish, null);
        assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
        const reviews = (await human('GET', `${base}/reviewers/codex`)).runs.length;

        // A check fails on GitHub: the reviewer's turn. The reviewer hands it to the agent, which commits a fix and waits.
        const check = { __typename: 'CheckRun', databaseId: 21, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/2/job/21', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } };
        await githubSays({ [id]: { ...open, headRefOid: remoteHead(), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check] } }, checkSuites: { nodes: [] } } }] } } });
        assert.equal(JSON.parse((await cli(['pr', 'view', n, '--json', 'turn'])).stdout).turn.whose, 'REVIEWER');
        await comment(Number(n), 'The test fails on GitHub; please fix it.');
        await wait(/The test fails on GitHub; please fix it\.[^]*It is published: commit and wait/);
        const before = updates();
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false;\n');
        git('commit', '-qam', 'Fix auto-fix.js');

        // Its wait pushes the fix, unsigned as the publish was, with no review from Codex; the title and description are left alone.
        await wait(new RegExp(`^Pushed ${git('rev-parse', '--short=7', 'HEAD')} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
        assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
        assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, reviews);
        assert.equal(updates(), before);
        await until(() => merges() === mergesBefore + 2, 'auto-merge asked for after the first publish and after the push');
        // Asking for it again failed once: the push after that asks again all the same.
        writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Something went wrong while executing your query.');
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 1\n');
        git('commit', '-qam', 'Fix auto-fix.js again');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await until(async () => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).some((e: any) => e.event === 'auto_merge_failed'), 'asking for auto-merge failed');
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 2\n');
        git('commit', '-qam', 'Fix auto-fix.js once more');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await until(() => merges() === mergesBefore + 4, 'auto-merge asked for again after the failure');
        // Turned off on GitHub since: the next push leaves it off.
        await githubSays({ [id]: { ...open, headRefOid: remoteHead(), autoMergeRequest: null } });
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 3\n');
        git('commit', '-qam', 'Fix auto-fix.js with auto-merge off');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await server.autoPublisher.settle(id);
        assert.equal(merges(), mergesBefore + 4);
        const pushed = (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).findLast((e: any) => e.event === 'github_push');
        assert.deepEqual([pushed.result, pushed.source, pushed.head, pushed.force, pushed.sign], ['pushed', git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'), false, false]);
        assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(), new RegExp(`Pushed an update to <a [^>]*>acme/widgets#7</a> at <code>${git('rev-parse', '--short=7', 'HEAD')}</code> when agent waited`));
        assert.equal(updates(), before);

        // Merged on GitHub: the agent's next commit goes nowhere.
        await githubSays({ [id]: merged });
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = 0;\n');
        git('commit', '-qam', 'After the merge');
        await wait(/^Merged on GitHub as e468a4e by laat/m);
        await server.autoPublisher.settle(id);
        assert.notEqual(remoteHead(), git('rev-parse', 'HEAD'));
      } finally {
        await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
      }
    });

    await t.test('auto-merge that merges at once: the next commit is not pushed', async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/follow-merged-at-once');
      writeFileSync(join(repo, 'at-once.js'), 'export const once = 1;\n');
      git('add', 'at-once.js');
      git('commit', '-qm', 'Add at-once.js');
      const created = await cli(['pr', 'create', '--title', 'Add at-once.js', '--body', 'x', '--no-review']);
      assert.equal(created.code, 0, created.stderr);
      const n = created.stdout.trim().split('/').pop()!;
      const base = `/api/repos/acme/widgets/pulls/${n}`;
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-merged-at-once'], { encoding: 'utf8' }).trim();
      // GitHub has nothing to wait for: gh merges as soon as auto-merge is asked for.
      await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T11:00:00Z', mergedBy: { login: 'reviewer' }, mergeCommit: { oid: mergeCommit } }) }, async () => {
        await human('PUT', `${base}/auto-publish`, { sign: false, auto_merge: true, merge_method: 'squash' });
        // The agent waits, auto-publish publishes, and gh merges: the agent hears of the merge (the
        // publish may reach it first, a moment before galley has asked GitHub about the merge).
        let heard = (await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout;
        if (/^Published to GitHub/m.test(heard)) heard = (await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout;
        assert.match(heard, /^Merged on GitHub as e468a4e by reviewer/m);
        const pull = await human('GET', base);
        assert.deepEqual([pull.github_state, pull.auto_publish], ['merged', null]);
        // Another commit, and the agent waits again: nothing is pushed over the merge.
        const pushed = remoteHead();
        writeFileSync(join(repo, 'at-once.js'), 'export const once = 2;\n');
        git('commit', '-qam', 'After the merge');
        assert.match((await cli(['pr', 'wait', n, '--timeout', '5s'])).stdout, /^Merged on GitHub/m);
        await server.autoPublisher.settle(pull.id);
        assert.equal(remoteHead(), pushed);
      });
    });

    await t.test('pr wait on several pull requests returns the first with news, and says which', async () => {
      const a = await published('feature/multi-a', 'a.js');
      const b = await published('feature/multi-b', 'b.js');
      const both = [String(a.number), String(b.number)];
      const waiting = cli(['pr', 'wait', ...both, '--timeout', '20s']);
      await untilWaiting(a.base, b.base);
      await comment(b.number, 'One more thing on b.');
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^acme/widgets s#${b.number} \\(feature/multi-b\\): ${server.url}/acme/widgets/pull/${b.number}$`, 'm'));
      assert.match(r.stdout, /One more thing on b\./);
      // Given as numbers, as gh takes them, it says to wait again with the s-numbers.
      assert.match(r.stdout, new RegExp(`then run \`galley pr wait s${a.number} s${b.number}\` again`));

      // News on both: a wait brings one, and the next the other. The poll it dropped lost nothing.
      await comment(a.number, 'Note on a.');
      await comment(b.number, 'Note on b.');
      const first = (await cli(['pr', 'wait', ...both, '--timeout', '5s'])).stdout;
      const second = (await cli(['pr', 'wait', ...both, '--timeout', '5s'])).stdout;
      assert.notEqual(/Note on a\./.test(first), /Note on b\./.test(first), first);
      assert.match(first + second, /Note on a\.[^]*Note on b\.|Note on b\.[^]*Note on a\./);

      // One query asks GitHub about both. Given as people write them, s#N, the hints use s-numbers.
      const waitingAgain = cli(['pr', 'wait', `s#${a.number}`, `s#${b.number}`, '--timeout', '20s']);
      await untilWaiting(a.base, b.base);
      await githubSays({ [a.id]: merged, [b.id]: open });
      const query = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').findLast((l) => l.includes(`p${a.id}:pullRequest`));
      assert.match(query!, new RegExp(`p${b.id}:pullRequest\\(number:7\\)`));
      const merge = await waitingAgain;
      assert.match(merge.stdout, new RegExp(`^acme/widgets s#${a.number} \\(feature/multi-a\\)`, 'm'));
      assert.match(merge.stdout, /^Merged on GitHub as e468a4e by laat/m);
      assert.match(merge.stdout, new RegExp(`Wait on the others with \`galley pr wait s${b.number}\`\\.`));
    });
  } finally {
    rmSync(join(dir, 'gh-pulls.json'), { force: true });
  }
});
