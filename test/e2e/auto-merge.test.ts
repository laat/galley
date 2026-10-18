// Publishing with auto-merge on GitHub.
import '../helpers/env.ts';
import { cli, dir, git, human, remote, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Service } from '../../src/server/service.ts';

startHarness();

test('publishing can enable auto-merge on GitHub', async (t) => {
  const stage = async (branch: string, file: string) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export const merged = true;\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    return {
      number,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      /** The commit GitHub has: the signed copy publishing pushed. */
      pushed: () => execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim(),
    };
  };
  /** gh calls from here on. */
  const ghCalls = () => {
    const log = () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8') : '');
    const start = log().length;
    return () => log().slice(start).split('\n').filter(Boolean);
  };
  const url = 'https://github.com/acme/widgets/pull/7';
  /** Read the repository's settings from GitHub (the fake gh, with `env`) into galley's cache. */
  const refresh = (env: Record<string, string>) => withFakes(env, () => server.service.refreshGithubRepo('acme/widgets'));
  // The option shows once galley knows that the repository allows auto-merge.
  await refresh({});

  await t.test('when publishing by hand, with the merge method from settings', async () => {
    const pr = await stage('feature/merge-manual', 'manual-merge.js');
    assert.match(await pr.page(), /<label><input type="checkbox" name="auto_merge"> <span>Enable auto-merge on GitHub \(squash\)<\/span><\/label>/);
    const calls = ghCalls();
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /✓ https:\/\/github\.com\/acme\/widgets\/pull\/7 will be automatically merged via squash when all requirements are met/);
    // After the pull request is created, and only for the commit that was pushed.
    assert.deepEqual(
      calls().filter((c) => c.startsWith('pr ')),
      [
        'pr create --repo acme/widgets --base main --head feature/merge-manual --title Add manual-merge.js --body-file -',
        `pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`,
        `pr view ${url} --json state,mergedAt,mergedBy,mergeCommit`,
      ],
    );
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.deepEqual([enabled.url, enabled.method, enabled.merged, enabled.actor.login], [url, 'squash', false, 'reviewer']);
    assert.deepEqual({ ...(await human('GET', pr.base)).auto_merge, enabled_by: undefined }, { enabled_by: undefined, merge_method: 'squash', commit_title: null, commit_message: null });
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tenabled\treviewer\tsquash$/m);
    const { autoMergeRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoMergeRequest'])).stdout);
    assert.deepEqual([autoMergeRequest.enabledBy.login, autoMergeRequest.mergeMethod], ['reviewer', 'SQUASH']);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge is on for <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7"[^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /enabled auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a>/);

    // The merge method is a setting.
    const refused = await fetch(`${server.url}/api/settings/publish`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mergeMethod: 'octopus' }) });
    assert.equal(refused.status, 422);
    writeFileSync(join(repo, 'manual-merge.js'), 'export const merged = 1;\n');
    git('commit', '-qam', 'Change manual-merge.js');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the push is recorded');
    // The page sends the method it shows; open pages hear when the setting changes.
    // Auto-merge is on for it, so the update asks for it again unless unchecked.
    assert.match(
      await pr.page(),
      /<label title="Unchecked, this publish does not ask for auto-merge\. It does not turn auto-merge off on GitHub\."><input type="checkbox" name="auto_merge" checked> <span>Enable auto-merge on GitHub \(squash\)\. Auto-merge is on for <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7"[^>]*>acme\/widgets#7<\/a>\.<\/span><\/label><input type="hidden" name="merge_method" value="squash">/,
    );
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    server.service.bus.on('change', listen);
    assert.equal((await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' })).publish.mergeMethod, 'rebase');
    server.service.bus.off('change', listen);
    assert.ok(events.includes('settings'), 'open pages hear that the merge method changed');
    try {
      assert.match(await (await fetch(`${server.url}/settings/publishing`)).text(), /<option value="rebase" selected>Rebase and merge<\/option>/);
      // A page that still shows squash cannot publish with rebase, nor turn on auto-publish.
      const update = ghCalls();
      for (const [method, path] of [['POST', 'publish'], ['PUT', 'auto-publish']]) {
        const stale = await fetch(`${server.url}${pr.base}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true, merge_method: 'squash' }) });
        assert.equal(stale.status, 412, path);
        assert.equal((await stale.json()).message, 'The merge method in Settings changed to rebase after this page was loaded. Refresh before publishing.');
      }
      assert.deepEqual(update(), []);
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.match(await pr.page(), /<input type="hidden" name="merge_method" value="rebase">/);
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'rebase' });
      assert.deepEqual(pull.auto_merge_result, { state: 'enabled', merge_method: 'rebase', error: null });
      assert.ok(update().includes(`pr merge ${url} --auto --rebase --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('when auto-publish publishes, if it was chosen with it', async () => {
    const pr = await stage('feature/merge-auto', 'auto-merge.js');
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--auto-merge'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stderr, /will be published when the reviewer agents are done and the author has answered them, with auto-merge on GitHub/);
    // The merge method is fixed when auto-publish is turned on, like its other options.
    assert.equal((await human('GET', pr.base)).auto_publish.auto_merge, 'squash');
    assert.equal(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout).autoPublishRequest.autoMerge, 'squash');
    await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
    try {
      assert.match(await pr.page(), /and enables auto-merge on GitHub \(squash\)\. After that, each commit agent waits with is pushed\./);
      const calls = ghCalls();
      const waited = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(waited.stdout, /Published to GitHub/);
      await until(async () => (await pr.timeline()).some((e) => e.event === 'auto_merge_enabled'), 'auto-merge is enabled');
      assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('the publish form checks it when auto-publish includes it, with the same merge method', async () => {
    const pr = await stage('feature/merge-form', 'form-merge.js');
    await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true, merge_method: 'squash' });
    await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
    try {
      assert.match(
        await pr.page(),
        /<label title="Unchecked, this publish does not ask for auto-merge\. It does not turn auto-merge off on GitHub\."><input type="checkbox" name="auto_merge" checked> <span>Enable auto-merge on GitHub \(squash\)<\/span><\/label><input type="hidden" name="merge_method" value="squash">/,
      );
      // Publishing by hand from it does what auto-publish would, though the setting says rebase now.
      const calls = ghCalls();
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'squash' });
      assert.deepEqual(pull.auto_merge_result, { state: 'enabled', merge_method: 'squash', error: null });
      assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`), calls().join('\n'));
      // A method that is neither auto-publish's nor the one in settings is still refused.
      const stale = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true, merge_method: 'merge' }) });
      assert.equal(stale.status, 412);
    } finally {
      await human('DELETE', `${pr.base}/auto-publish`);
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('a failure is recorded, and the pull request stays published', async () => {
    const pr = await stage('feature/merge-fail', 'fail-merge.js');
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /Published, but turning on auto-merge failed:\nGraphQL: Auto merge is not allowed for this repository/);
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.staging_state, pull.published_url, pull.auto_merge], ['published', url, null]);
    const timeline = await pr.timeline();
    assert.ok(timeline.some((e) => e.event === 'published'));
    assert.equal(timeline.findLast((e) => e.event === 'auto_merge_failed').error, 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge failed <relative-time [^]*?<\/strong>[^]*?<pre class="merge-error">GraphQL: Auto merge is not allowed for this repository \(enablePullRequestAutoMerge\)<\/pre>/);
    assert.match(page, /Enabling auto-merge on <a [^>]*>acme\/widgets#7<\/a> failed/);
    // What came of it stays in the merge box when GitHub no longer allows auto-merge, or cannot be asked.
    for (const env of [{ FAKE_GH_AUTO_MERGE: 'false' }, { FAKE_GH_API_FAIL: 'HTTP 502' }] as Record<string, string>[]) {
      await refresh(env);
      assert.match(await pr.page(), /<strong>Auto-merge failed <relative-time /, Object.keys(env)[0]);
    }
    await refresh({});
  });

  await t.test('a merge gh accepted but galley could not check is not reported as auto-merge on', async () => {
    const pr = await stage('feature/merge-unknown', 'unknown-merge.js');
    await withFakes({ FAKE_GH_VIEW: 'not JSON' }, async () => {
      const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /✓ Requested auto-merge via squash for https:\/\/github\.com\/acme\/widgets\/pull\/7; whether GitHub merged it at once could not be checked/);
    });
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.equal(enabled.merged, null);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /requested auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a> [^]*?; whether GitHub merged it at once could not be checked/);
  });

  await t.test('the merge method checked when the request came in is the one used', async () => {
    const pr = await stage('feature/merge-race', 'race-merge.js');
    const service = server.service;
    const publish = service.publish;
    // The setting changes after the request was checked, while publishing is under way.
    service.publish = async (...args: Parameters<Service['publish']>) => {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
      return publish.apply(service, args);
    };
    const calls = ghCalls();
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'squash' });
      assert.equal(pull.auto_merge_result.merge_method, 'squash');
    } finally {
      service.publish = publish;
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
    assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`), calls().join('\n'));
  });

  await t.test('a lookup that cannot even start leaves the outcome unknown, not failed', async () => {
    const pr = await stage('feature/merge-lookup', 'lookup-merge.js');
    const service = server.service;
    const gh = service.ghBin;
    const calls = ghCalls();
    // Once gh pr merge has run, gh cannot be started any more, as when its working directory is gone.
    Object.defineProperty(service, 'ghBin', { configurable: true, get: () => (calls().some((c) => c.startsWith('pr merge ')) ? join(dir, 'no-such-gh') : gh) });
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'requested', merge_method: 'squash', error: null });
    } finally {
      Object.defineProperty(service, 'ghBin', { configurable: true, writable: true, value: gh });
      await refresh({});
    }
    assert.match(await pr.page(), /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
  });

  await t.test('asks GitHub before publishing, rather than trusting what it read earlier', async () => {
    // Auto-publish was approved with auto-merge while GitHub allowed squash merges; then the
    // repository stopped allowing them, and galley's cache has not heard yet.
    const pr = await stage('feature/merge-stale', 'stale-merge.js');
    await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
    const calls = ghCalls();
    try {
      await withFakes({ FAKE_GH_SQUASH: 'false' }, async () => {
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
        await until(async () => (await human('GET', pr.base)).auto_publish === null, 'auto-publish gives up');
        await waiting;
      });
      const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
      assert.match(failed.error, /^acme\/widgets does not allow squash merges/);

      // The same for publishing by hand: galley read that squash merges are allowed, and GitHub no longer allows them.
      await refresh({});
      assert.match(await pr.page(), /<input type="checkbox" name="auto_merge">/);
      const refused = await withFakes({ FAKE_GH_SQUASH: 'false' }, () =>
        fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) }),
      );
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /^acme\/widgets does not allow squash merges/);
    } finally {
      await refresh({});
    }
    // Refused before anything was pushed or opened on GitHub.
    assert.equal((await human('GET', pr.base)).staging_state, 'staged');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
    assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'feature/merge-stale'], { stdio: 'pipe' }));
  });

  await t.test('GitHub merges at once when there is nothing to wait for', async () => {
    const pr = await stage('feature/merge-clean', 'clean-merge.js');
    // Right after creating the pull request, gh asks for auto-merge before GitHub knows it is
    // clean, and GitHub refuses. Asked again, gh merges it.
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)');
    const mergeCommit = 'f00d' + '0'.repeat(36);
    const calls = ghCalls();
    await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T10:00:00Z', mergedBy: { login: 'reviewer' }, mergeCommit: { oid: mergeCommit } }) }, async () => {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'merged', merge_method: 'squash', error: null });
    });
    assert.equal(calls().filter((c) => c.startsWith('pr merge ')).length, 2);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    const page = await pr.page();
    assert.match(page, /<strong>Merged on GitHub<\/strong>/);
    assert.match(page, /merged <a [^>]*>acme\/widgets#7<\/a> on GitHub \(squash\) [^]*?: auto-merge had nothing to wait for/);
    // Recorded as merged, as following would: the agent hears of it, and nothing is published over it.
    const recorded = await human('GET', pr.base);
    assert.deepEqual([recorded.github_state, recorded.merged_by?.login, recorded.merge_commit_sha], ['merged', 'reviewer', mergeCommit]);
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Merged on GitHub as f00d000 by reviewer/m);
    const pushed = pr.pushed();
    writeFileSync(join(repo, 'clean-merge.js'), 'export const after = 1;\n');
    git('commit', '-qam', 'After the merge');
    const again = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 422);
    assert.equal(pr.pushed(), pushed);
  });

  await t.test('only where GitHub allows auto-merge, and with a merge method it allows', async () => {
    const pr = await stage('feature/merge-allowed', 'allowed-merge.js');
    const checkbox = /<input type="checkbox" name="auto_merge">/;
    const calls = ghCalls();
    try {
      // The repository does not allow auto-merge: no option, and the CLI refuses before publishing.
      const events: string[] = [];
      const listen = (e: { type: string }) => events.push(e.type);
      server.service.bus.on('change', listen);
      await refresh({ FAKE_GH_AUTO_MERGE: 'false' });
      server.service.bus.off('change', listen);
      assert.ok(events.includes('github_repo'), 'open pages hear that the option went away');
      assert.doesNotMatch(await pr.page(), /name="auto_merge"/);
      await withFakes({ FAKE_GH_AUTO_MERGE: 'false' }, async () => {
        for (const args of [['--auto-merge'], ['--auto', '--auto-merge']]) {
          const r = await cli(['pr', 'publish', String(pr.number), ...args], { actor: 'reviewer' });
          assert.equal(r.code, 1, args.join(' '));
          assert.match(r.stderr, /acme\/widgets does not allow auto-merge\. Turn on "Allow auto-merge" in the repository's settings on GitHub\./);
        }
      });
      assert.equal((await human('GET', pr.base)).auto_publish, null);

      // It allows auto-merge, but not the merge method in settings: the option says so, and publishing refuses.
      await refresh({});
      await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
      await refresh({ FAKE_GH_SQUASH: 'false' });
      const box = await pr.page();
      assert.match(box, /<input type="checkbox" name="auto_merge" disabled> Enable auto-merge on GitHub: acme\/widgets does not allow squash merges\. <a href="\/settings\/publishing">/);
      // Auto-publish, turned on before, would fail.
      assert.match(box, /acme\/widgets does not allow squash merges, so publishing will fail<\/span>/);
      await human('DELETE', `${pr.base}/auto-publish`);
      const refused = await withFakes({ FAKE_GH_SQUASH: 'false' }, () =>
        fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) }),
      );
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /acme\/widgets does not allow squash merges, the merge method in galley's settings \(it allows merge, rebase\)\. Change it under Settings → Publishing\./);

      // Not knowing, because gh failed, hides it too.
      await refresh({ FAKE_GH_API_FAIL: 'HTTP 502' });
      assert.doesNotMatch(await pr.page(), /name="auto_merge"/);
    } finally {
      await refresh({});
    }
    assert.match(await pr.page(), checkbox);
    // Nothing was pushed or published while it refused.
    assert.equal((await human('GET', pr.base)).staging_state, 'staged');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
  });
});
