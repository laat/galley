// When reviewer agents review and what they are told: --reviewer and --no-review, reviews still
// running or cancelled, findings the author answers, and their earlier reviews.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, send, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service } from '../../src/server/service.ts';

startHarness();

test('symlinks in a pull request lead the reviewer nowhere: not to /dev/zero, not outside the checkout', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'galley-outside-'));
  writeFileSync(join(outside, 'secret'), 'keep\n');
  chmodSync(join(outside, 'secret'), 0o444);
  chmodSync(outside, 0o555);
  try {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/symlinks');
    // Read from the checkout, package.json would never end and the symlinked lockfile would win.
    symlinkSync('/dev/zero', join(repo, 'package.json'));
    symlinkSync(join(outside, 'secret'), join(repo, 'pnpm-lock.yaml'));
    symlinkSync(outside, join(repo, 'vendor'));
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');
    git('add', 'package.json', 'pnpm-lock.yaml', 'vendor', 'package-lock.json');
    git('commit', '-qm', 'Link things');
    const created = await cli(['pr', 'create', '--title', 'Link things', '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const base = `/api/repos/acme/widgets/pulls/${created.stdout.trim().split('/').pop()}`;
    const pull = await human('GET', base);
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }) }, async () => {
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(pull.id);
    });
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((x: any) => x.status), ['done']);
    const install = readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(install.args.slice(install.args.indexOf('--') + 1, install.args.indexOf('--') + 3), ['npm', 'ci']);
    // Cleaning up the checkout made nothing outside it writable, and removed nothing there.
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'keep\n');
    assert.equal(statSync(join(outside, 'secret')).mode & 0o777, 0o444);
    assert.equal(statSync(outside).mode & 0o777, 0o555);
  } finally {
    chmodSync(outside, 0o755);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a review still running shows in pr view and pr wait, and publishing before it needs a confirmation', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/slow-review');
  writeFileSync(join(repo, 'slow.js'), 'export const slow = true;\n');
  git('add', 'slow.js');
  git('commit', '-qm', 'Add slow');
  const created = await cli(['pr', 'create', '--title', 'Add slow', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const head = git('rev-parse', 'HEAD');
  const sha = head.slice(0, 7);
  const gate = join(dir, 'codex-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'slow.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it after what it means.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
    try {
      // An author starting to wait queues an automatic review, which shows before it runs.
      const pull = await human('GET', base);
      const codex = server.service.codex!;
      const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
      codex.consider(pull.id);
      assert.deepEqual(codex.atWork(row()), { status: 'QUEUED', head_sha: head, started_at: null });
      await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');

      const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      const { reviewRequests } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout);
      assert.equal(reviewRequests.length, 1);
      const { startedAt, ...request } = reviewRequests[0];
      assert.deepEqual(request, { __typename: 'Bot', login: 'codex-review', status: 'IN_PROGRESS', commit: { oid: head } });
      assert.ok(Date.now() - Date.parse(startedAt) < 20_000);
      const view = await cli(['pr', 'view', String(number)]);
      assert.match(view.stdout, new RegExp(`^reviewers:\tcodex-review \\(reviewing ${sha}, started just now\\)$`, 'm'));
      const box = await page();
      assert.match(box, /<strong>Codex is still reviewing this commit<\/strong>/);
      assert.match(box, /class="btn btn-primary btn-publish" data-confirm="Click again to publish anyway"/);

      // The reviewer approves while Codex works: the agent hears that Codex is not done.
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      await human('POST', `${base}/reviews`, { event: 'APPROVE' });
      const approved = await waiting;
      assert.equal(approved.code, 0, approved.stderr);
      assert.match(approved.stdout, /reviewer reviewed: approved/);
      assert.match(approved.stdout, new RegExp(`^codex-review is reviewing ${sha} \\(started just now\\)\\.$`, 'm'));
      assert.match(approved.stdout, new RegExp(`codex-review is still reviewing; run \`galley pr wait s${number}\` to get its review\\.`));
      assert.doesNotMatch(approved.stdout, /nothing left open/);

      // Its review wakes the next wait, which says the approval came before it.
      writeFileSync(gate, '');
      const reviewed = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /codex-review reviewed: commented/);
      assert.match(reviewed.stdout, /^The approval from reviewer came before this review from codex-review\.$/m);
      assert.doesNotMatch(reviewed.stdout, /codex-review is (still )?reviewing/);
      await codex.settle(pull.id);
      assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout), { reviewRequests: [] });
      const stale = await page();
      assert.doesNotMatch(stale, /Codex is still reviewing/);
      assert.doesNotMatch(stale, /data-confirm/);

      // A page loaded before a review started does not know of it, so the server asks: publishing
      // with that page's fingerprint is refused while Codex works, unless it says to go ahead.
      const expected = stale.match(/name="expected" value="([^"]+)"/)![1];
      rmSync(gate);
      await human('POST', `${base}/reviewers/codex`);
      const refused = await fetch(`${server.url}${base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected }) });
      assert.equal(refused.status, 428);
      assert.match((await refused.json()).message, /^codex-review is still reviewing this commit, and its review may ask for changes\. Publishing now cancels it\.$/);
      const fromTerminal = await cli(['pr', 'publish', String(number)], { actor: 'reviewer' });
      assert.equal(fromTerminal.code, 1);
      assert.match(fromTerminal.stderr, new RegExp(`Run \`galley pr publish s${number} --during-review\` to publish anyway\\.`));
      const agent = await cli(['pr', 'publish', String(number), '--during-review'], { actor: 'observer' });
      assert.match(agent.stderr, /only the user or the author of this pull request \(agent\) can publish it/);
      const published = await human('POST', `${base}/publish`, { expected, during_review: true });
      assert.equal(published.staging_state, 'published');
      writeFileSync(gate, '');
      await codex.settle(pull.id);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false });
    }
  });
});

test('a running review is cancelled when the pull request is published, closed, merged on GitHub or pushed to', async (t) => {
  // Both fake reviewers answer once their gate exists; until then their reviews run.
  const gates = { codex: join(dir, 'cancel-codex-gate'), claude: join(dir, 'cancel-claude-gate') };
  await withFakes({
    FAKE_CODEX_GATE: gates.codex,
    FAKE_CLAUDE_GATE: gates.claude,
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
  }, async () => {
    const stage = async (branch: string, file: string, review = ['--no-review']) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
      const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...review]);
      assert.equal(created.code, 0, created.stderr);
      const number = Number(created.stdout.trim().split('/').pop());
      const base = `/api/repos/acme/widgets/pulls/${number}`;
      const { id } = await human('GET', base);
      return { number, base, id, page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text() };
    };
    type Pr = Awaited<ReturnType<typeof stage>>;
    const reviewer = (engine: 'codex' | 'claude') => server.service[engine]!;
    const row = (pr: Pr) => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
    /** Ask for a review by hand, and wait until it runs. */
    const ask = async (pr: Pr, engine: 'codex' | 'claude') => {
      await human('POST', `${pr.base}/reviewers/${engine}`);
      await until(() => reviewer(engine).atWork(row(pr))?.status === 'IN_PROGRESS', `${engine} reviews`);
    };
    const runs = async (pr: Pr, engine: 'codex' | 'claude') => (await human('GET', `${pr.base}/reviewers/${engine}`)).runs.map((r: any) => [r.status, r.reason]);
    const untilWaiting = async (pr: Pr) => {
      await until(async () => (await human('GET', pr.base)).author_waiting, 'the author waits');
    };

    try {
      await t.test('published: both reviewers stop, the wait hears only of the publish, and they do not review the commit again', async () => {
        const pr = await stage('feature/cancel-publish', 'cancel-publish.js');
        await ask(pr, 'codex');
        await ask(pr, 'claude');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await untilWaiting(pr);
        await human('POST', `${pr.base}/publish`, { sign: false, during_review: true });
        const r = await waiting;
        assert.match(r.stdout, /^Published to GitHub: /m);
        assert.match(r.stdout, /^Its review in galley is over\.$/m);
        await reviewer('codex').settle(pr.id);
        await reviewer('claude').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'published']]);
        assert.deepEqual(await runs(pr, 'claude'), [['cancelled', 'published']]);
        // Done with the head: nothing waits for them.
        const { reviewers } = server.service.readiness(row(pr));
        assert.deepEqual(reviewers.map((x) => [x.status.state, x.status.cancelled]), [['cancelled', 'published'], ['cancelled', 'published']]);
        const page = await pr.page();
        assert.match(page, /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Published<\/span>/);
        assert.match(page, /codex-review<\/a><span class="Label Label--bot">bot<\/span> stopped reviewing <code>[0-9a-f]{7}<\/code> .*?: published/);
        // Turned on afterwards, Codex does not review the commit again when the author waits.
        await human('PATCH', `${pr.base}/reviewers/codex`, { enabled: true });
        assert.equal((await cli(['pr', 'wait', String(pr.number), '--timeout', '1s'])).code, 124);
        assert.equal((await runs(pr, 'codex')).length, 1);
      });

      await t.test('closed here', async () => {
        const pr = await stage('feature/cancel-close', 'cancel-close.js');
        await ask(pr, 'codex');
        // Until Codex has finished reading math.js and runs the diff, which the close cuts short.
        const steps = () => reviewer('codex').live(row(pr))?.progress.steps.map((s) => s.status).join() ?? '';
        await until(() => steps() === 'completed,in_progress', 'Codex has read math.js and runs the diff');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await untilWaiting(pr);
        await human('PATCH', pr.base, { state: 'closed' });
        const r = await waiting;
        assert.match(r.stdout, /closed .* without publishing it/);
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'closed']]);
        assert.match(await pr.page(), /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Closed here<\/span>/);
        // Its live box is gone, and its transcript keeps what it did until then, and why it stopped.
        const [{ id: runId }] = (await human('GET', `${pr.base}/reviewers/codex`)).runs;
        const runPath = `/acme/widgets/pull/${pr.number}/runs/${runId}`;
        const html = await pr.page();
        assert.doesNotMatch(html, /js-run-progress/);
        assert.ok(html.includes(`<a class="agent-state" href="${runPath}" title="Review of `), 'the sidebar links to its transcript');
        assert.equal((await fetch(server.url + runPath + '/progress')).status, 204);
        const transcript = await (await fetch(server.url + runPath)).text();
        assert.doesNotMatch(transcript, /data-run-live/);
        assert.match(transcript, /Cancelled \(closed here\) <relative-time/);
        // The read it finished, and the diff it was running, which never finished.
        assert.match(transcript, /Read <a class="run-location"[^>]*><code>math\.js:2<\/code><\/a><\/span> <svg[^>]*octicon-check/);
        assert.match(transcript, /<code class="run-command">git diff HEAD~1 HEAD<\/code><\/span> <svg[^>]*octicon-circle-slash[^>]*aria-label="Did not finish"/);
      });

      await t.test('merged on GitHub, after which it can not be asked for again', async () => {
        const pr = await stage('feature/cancel-merge', 'cancel-merge.js');
        await human('POST', `${pr.base}/publish`, { sign: false });
        // Published, it can still be reviewed, to check an update.
        await ask(pr, 'codex');
        const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: null, timelineItems: { nodes: [] } };
        writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
        await server.service.followGithub();
        assert.equal(reviewer('codex').atWork(row(pr)), null);
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'merged']]);
        assert.match(await pr.page(), /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Merged on GitHub<\/span>/);
        const again = await fetch(`${server.url}${pr.base}/reviewers/codex`, { method: 'POST' });
        assert.equal(again.status, 422);
        assert.match((await again.json()).message, /merged on GitHub/);
      });

      await t.test('pushed to: the review of the earlier commit stops, and the waiting author gets one of the new commit', async () => {
        const pr = await stage('feature/cancel-push', 'cancel-push.js', ['--reviewer', 'codex:2']);
        const first = git('rev-parse', 'HEAD');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => reviewer('codex').atWork(row(pr))?.status === 'IN_PROGRESS', 'Codex reviews');
        writeFileSync(join(repo, 'cancel-push.js'), 'export const pushed = true;\n');
        git('commit', '-qam', 'Change cancel-push.js');
        const second = git('rev-parse', 'HEAD');
        // The push to galley cancels the review of the first commit and starts one of the second.
        await send('feature/cancel-push');
        const reviewing = () => reviewer('codex').atWork(row(pr));
        await until(() => reviewing()?.head_sha === second, 'Codex reviews the second commit');
        writeFileSync(gates.codex, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed/);
        await reviewer('codex').settle(pr.id);
        const all = (await human('GET', `${pr.base}/reviewers/codex`)).runs;
        assert.deepEqual(all.map((x: any) => [x.head_sha, x.status, x.reason]), [[first, 'cancelled', 'pushed'], [second, 'done', null]]);
        // The cancelled review did not count.
        const reviews = await human('GET', `${pr.base}/reviews`);
        assert.match(reviews.at(-1).body, /automatic review 1 of 2\./);
      });

      await t.test('pushed to while the author waits for two reviewers: the cancelled one reviews the new commit before the wait returns', async () => {
        for (const gate of Object.values(gates)) rmSync(gate, { force: true });
        const pr = await stage('feature/cancel-both', 'cancel-both.js', ['--reviewer', 'codex', '--reviewer', 'claude']);
        const first = git('rev-parse', 'HEAD');
        const at = (engine: 'codex' | 'claude') => reviewer(engine).atWork(row(pr));
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => at('codex')?.status === 'IN_PROGRESS' && at('claude')?.status === 'IN_PROGRESS', 'Codex and Claude review');
        // Codex's review of the first commit is in, and the wait waits for Claude's.
        writeFileSync(gates.codex, '');
        await reviewer('codex').settle(pr.id);
        writeFileSync(join(repo, 'cancel-both.js'), 'export const both = true;\n');
        git('commit', '-qam', 'Change cancel-both.js');
        const second = git('rev-parse', 'HEAD');
        await send('feature/cancel-both');
        await until(() => at('claude')?.head_sha === second, 'Claude reviews the second commit');
        const returned = await Promise.race([waiting.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
        assert.equal(returned, false, 'the wait goes on for Claude');
        writeFileSync(gates.claude, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed/);
        assert.match(r.stdout, /claude-review reviewed/);
        await reviewer('claude').settle(pr.id);
        const all = (await human('GET', `${pr.base}/reviewers/claude`)).runs;
        assert.deepEqual(all.map((x: any) => [x.head_sha, x.status, x.reason]), [[first, 'cancelled', 'pushed'], [second, 'done', null]]);
      });

      await t.test('published while a review of a newer commit runs: that review goes on', async () => {
        rmSync(gates.codex, { force: true });
        const pr = await stage('feature/cancel-newer', 'cancel-newer.js');
        const ghGate = join(dir, 'gh-gate');
        try {
          await withFakes({ FAKE_GH_GATE: ghGate }, async () => {
            // Publishing the first commit waits in `gh pr create` while a second is pushed and reviewed.
            const publishing = human('POST', `${pr.base}/publish`, { sign: false });
            const creating = () => readFileSync(join(dir, 'gh.log'), 'utf8').includes('--head feature/cancel-newer');
            await until(creating, 'publishing runs gh pr create');
            writeFileSync(join(repo, 'cancel-newer.js'), 'export const newer = true;\n');
            git('commit', '-qam', 'Change cancel-newer.js');
            const newer = git('rev-parse', 'HEAD');
            await send('feature/cancel-newer');
            await until(() => row(pr).head_sha === newer, 'the server has the second commit');
            await ask(pr, 'codex');
            writeFileSync(ghGate, '');
            assert.equal((await publishing).staging_state, 'published');
          });
        } finally {
          rmSync(ghGate, { force: true });
        }
        assert.equal(reviewer('codex').headStatus(row(pr)).state, 'reviewing');
        writeFileSync(gates.codex, '');
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['done', null]]);
      });

      await t.test('closed while its review is being posted: nothing is posted, and it stays cancelled', async () => {
        rmSync(gates.codex, { force: true });
        const pr = await stage('feature/cancel-posting', 'cancel-posting.js');
        await ask(pr, 'codex');
        // Codex has answered, and galley is placing its comments when the pull request is closed.
        const createReview = server.service.createReview;
        server.service.createReview = async (...args: Parameters<Service['createReview']>) => {
          await human('PATCH', pr.base, { state: 'closed' });
          return createReview.apply(server.service, args);
        };
        try {
          writeFileSync(gates.codex, '');
          await reviewer('codex').settle(pr.id);
        } finally {
          server.service.createReview = createReview;
        }
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'closed']]);
        assert.deepEqual(await human('GET', `${pr.base}/reviews`), []);
      });
    } finally {
      for (const gate of Object.values(gates)) rmSync(gate, { force: true });
      rmSync(join(dir, 'gh-pulls.json'), { force: true });
    }
  });
});

test('pr create --reviewer and --no-review decide Codex reviews for that pull request', async (t) => {
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }) }, async () => {
    const branch = (name: string, file: string) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', name);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
    };
    const create = (args: string[]) => cli(['pr', 'create', '--title', 'Review options', '--body', 'x', ...args]);
    const numberOf = (r: { stdout: string }) => Number(r.stdout.trim().split('/').pop());
    const api = (n: number) => `/api/repos/acme/widgets/pulls/${n}`;
    const page = async (n: number) => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
    const authorWaiting = async (n: number) => {
      await until(async () => (await human('GET', api(n))).author_waiting, 'the author waits');
    };
    /** What Codex reports the moment it starts deciding about the pull request, as when its author waits. */
    const considered = async (n: number) => {
      const { id } = await human('GET', api(n));
      const codex = server.service.codex!;
      codex.consider(id);
      return codex.atWork(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id));
    };

    await t.test('--reviewer codex:2 gets two reviews when automatic reviews are off in settings', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      branch('feature/two-loops', 'two.js');
      // Repeated and comma-separated, as in gh; logins without a reviewer agent are ignored.
      const r = await create(['-r', 'octocat,codex:2', '--reviewer', 'alice']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /Ignored reviewer octocat: galley has no reviewer agent by that name/);
      assert.match(r.stderr, /Ignored reviewer alice/);
      assert.match(r.stderr, /^When you wait, codex-review reviews the code\.$/m);
      const n = numberOf(r);
      const { enabled, max_iterations, overrides } = await human('GET', `${api(n)}/reviewers/codex`);
      assert.deepEqual({ enabled, max_iterations, overrides }, { enabled: true, max_iterations: 2, overrides: { enabled: true, max_iterations: 2 } });
      const html = await page(n);
      assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">Off in Settings<\/span>/);
      assert.match(html, /<span class="agent-chunk">Automatic: 0 of 2<\/span>/);
      assert.match(html, /class="reviewer-limit"[^>]*data-limit="2"/);
      // Queued as soon as Codex considers it, although automatic reviews are off in settings.
      assert.equal((await considered(n))?.status, 'QUEUED');
      for (const i of [1, 2]) {
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, new RegExp(`automatic review ${i} of 2`));
        writeFileSync(join(repo, 'two.js'), `export const n = ${i};\n`);
        git('commit', '-qam', `Change two.js (${i})`);
      }
      const capped = await cli(['pr', 'wait', String(n), '--timeout', '2s']);
      assert.equal(capped.code, 0, capped.stderr);
      assert.match(capped.stdout, /\(codex-review used 2 of 2 automatic reviews\); ask the user to review it/);
      assert.equal((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 2);
    });

    await t.test('--reviewer codex follows the limit in settings, raised while the author waits', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 1 });
      branch('feature/settings-limit', 'limit.js');
      const r = await create(['--reviewer', 'codex']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^When you wait, codex-review reviews the code\.$/m);
      const n = numberOf(r);
      const first = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /automatic review 1 of 1/);
      writeFileSync(join(repo, 'limit.js'), 'export const n = 1;\n');
      git('commit', '-qam', 'Change limit.js');
      // Codex finds the cap reached, so the reviewer agents are done with the new commit.
      assert.match(await handedOver(n), /codex-review used 1 of 1 automatic reviews/);
      const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 1);
      await human('PUT', '/api/settings/codex', { maxIterations: 2 });
      const second = await waiting;
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /automatic review 2 of 2/);
      await human('PUT', '/api/settings/codex', { maxIterations: 3 });
    });

    await t.test('--no-review gets no reviews when automatic reviews are on in settings', async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      branch('feature/no-review', 'none.js');
      const r = await create(['--no-review']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      const n = numberOf(r);
      assert.match(await handedOver(n), /^No reviewer agent reviews /);
      assert.equal(await considered(n), null, 'nothing queued, although automatic reviews are on in settings');
      const config = await human('GET', `${api(n)}/reviewers/codex`);
      assert.deepEqual(config.runs, []);
      assert.equal(config.enabled, false);
      assert.equal(config.overrides.enabled, false);
      const html = await page(n);
      assert.match(html, /<span class="agent-state" title="Off for this pull request"><span>Off<\/span><\/span>/);
      assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">On in Settings<\/span>/);
      assert.match(html, /js-reviewer-reset"[^>]* data-field="enabled"/);
      // Back to the setting (the page's reset) while the author waits: Codex starts at once.
      const resumed = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      const reset = await human('PATCH', `${api(n)}/reviewers/codex`, { enabled: null });
      assert.deepEqual(reset, { enabled: true, max_iterations: 3, overrides: { enabled: null, max_iterations: null } });
      const second = await resumed;
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /codex-review reviewed: commented/);
    });

    await t.test('without either flag, the setting decides', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false });
      branch('feature/default-review', 'default.js');
      const r = await create([]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      const n = numberOf(r);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).overrides, { enabled: null, max_iterations: null });
      assert.match(await handedOver(n), /^No reviewer agent reviews /);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs, []);
      assert.doesNotMatch(await page(n), /for this pull request/);
      // Turned on in Settings while the author waits, Codex reviews this one too.
      const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      await human('PUT', '/api/settings/codex', { enabled: true });
      const w = await waiting;
      assert.equal(w.code, 0, w.stderr);
      assert.match(w.stdout, /codex-review reviewed: commented/);
      await human('PUT', '/api/settings/codex', { enabled: false });
    });

    await t.test('on with a limit of 0, it reviews nothing on its own, and galley reviewers and pr create say so', async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 0 });
      try {
        const list = await cli(['reviewers', '--json', 'name,automatic,limit']);
        assert.deepEqual(JSON.parse(list.stdout)[0], { name: 'codex-review', automatic: false, limit: 0 });
        branch('feature/limit-zero', 'zero.js');
        const r = await create([]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      } finally {
        await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      }
    });

    await t.test('flags that cannot work stage nothing', async () => {
      branch('feature/refused', 'refused.js');
      const bad = await create(['-r', 'codex:two']);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /invalid reviewer "codex:two"/);
      const both = await create(['--no-review', '-r', 'codex:2']);
      assert.equal(both.code, 1);
      assert.match(both.stderr, /codex was asked to review, but automatic reviews are turned off/);
      const tooMany = await create(['-r', 'codex:99']);
      assert.equal(tooMany.code, 1);
      assert.match(tooMany.stderr, /from 0 to 20/);
      assert.deepEqual(await human('GET', '/api/repos/acme/widgets/pulls?state=all&head=feature/refused'), []);
    });

    await t.test('the API takes logins as GitHub does, and turns every reviewer agent on or off', async () => {
      const post = async (body: object) => {
        const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
          body: JSON.stringify({ title: 'Through the API', head: 'feature/refused', base: 'main', ...body }),
        });
        assert.equal(res.status, 201);
        const pr = await res.json();
        const config = await human('GET', `${api(pr.number)}/reviewers/codex`);
        await human('DELETE', api(pr.number));
        return { pr, config };
      };
      const byLogin = await post({ reviewers: ['Codex', 'octocat'] });
      assert.deepEqual(byLogin.pr.ignored_reviewers, ['octocat']);
      assert.deepEqual(byLogin.config.overrides, { enabled: true, max_iterations: null });
      assert.deepEqual((await post({ automatic_reviews: true })).config.overrides, { enabled: true, max_iterations: null });
      const plain = await post({});
      assert.equal(plain.pr.ignored_reviewers, undefined);
      assert.deepEqual(plain.config.overrides, { enabled: null, max_iterations: null });
    });
  });
});

test('findings the author answers without a new commit: the reviewer agents are done with it, and the reviewer has it', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/answered');
  writeFileSync(join(repo, 'answered.js'), 'export const value = 1;\n');
  git('add', 'answered.js');
  git('commit', '-qm', 'Add answered.js');
  const created = await cli(['pr', 'create', '--title', 'Add answered.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const review = { summary: 'One thing.', comments: [{ path: 'answered.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] };
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      assert.match((await cli(['pr', 'wait', String(number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
      await server.service.codex!.settle(id);
      // Unanswered, the finding holds the reviewer agents up: no wait says they are done, and one that times out says why.
      const held = await cli(['pr', 'wait', String(number), '--timeout', '1s']);
      assert.equal(held.code, 124);
      assert.match(held.stderr, new RegExp(`^codex-review commented on ${sha()}: reply to or resolve each of its threads, or push a commit\\. The reviewer agents are not done with it until then\\.$`, 'm'));
      // Its row in the sidebar: what it found, and whether it is answered (as GitHub marks a reviewer, a check is for an approval).
      const agentState = async () => (await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text()).match(/<li class="agent" id="agent-codex">[^]*?(<a class="agent-state"[^>]*>[^]*?<\/a>)/)![1];
      assert.match(await agentState(), new RegExp(`title="Found 1 problem in ${sha()}; agent has not answered it"><svg class="octicon octicon-comment color-fg-attention"[^>]*>[^]*?</svg><span>1 finding · <code>${sha()}</code></span>`));

      // Answered without a new commit: Codex reviews each commit once, so it has nothing more to say.
      const [thread] = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads;
      assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread.databaseId), '--resolve', '-b', 'The name says what it is.'])).code, 0);
      const answered = `codex-review's findings in ${sha()} are answered`;
      assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(${answered}\\); ask the user to review it: `, 'm'));
      const { turn } = await human('GET', base);
      assert.equal(turn.whose, 'reviewer');
      assert.ok(turn.reasons.some((r: any) => r.kind === 'reviewer_agent' && r.state === 'answered' && r.text === answered), JSON.stringify(turn.reasons));
      assert.match(await agentState(), new RegExp(`title="Found 1 problem in ${sha()}; agent answered it"><svg class="octicon octicon-comment color-fg-muted"[^>]*>[^]*?</svg><span>Answered · <code>${sha()}</code></span>`));
      // The list says it shorter, in full as its tooltip.
      assert.match(await (await fetch(`${server.url}/`)).text(), new RegExp(`<span class="turn-reason" title="${answered.replace("'", '&#39;')}">codex-review&#39;s findings answered</span>`));

      // A new commit still gets a review of its own.
      writeFileSync(join(repo, 'answered.js'), 'export const answer = 1;\n');
      git('commit', '-qam', 'Rename the value');
      const fine = await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, () => cli(['pr', 'wait', String(number), '--timeout', '20s']));
      assert.match(fine.stdout, /Fine now\./);
      assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, 2);
      assert.match(await agentState(), new RegExp(`title="Found nothing in ${sha()}"><svg class="octicon octicon-check color-fg-muted"[^>]*>[^]*?</svg><span>No findings · <code>${sha()}</code></span>`));
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });
});

test("a comment after the author's reply in a reviewer agent's thread waits for the author: the findings are not answered until it answers again", async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/answered-again');
  writeFileSync(join(repo, 'again.js'), 'export const value = 1;\n');
  git('add', 'again.js');
  git('commit', '-qm', 'Add again.js');
  const created = await cli(['pr', 'create', '--title', 'Add again.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const reply = async (thread: number, body: string) => assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', body])).code, 0);
  const review = { summary: 'One thing.', comments: [{ path: 'again.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] };
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      assert.match((await cli(['pr', 'wait', String(number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
      await server.service.codex!.settle(id);
      const thread = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
      await reply(thread, 'The name says what it is.');
      await human('POST', `${base}/comments/${thread}/replies`, { body: 'It does not say what it counts.' });
      const told = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.match(told.stdout, /It does not say what it counts\./);
      assert.match(told.stdout, /^Address the feedback\./m);
      // Seen and not answered: Codex's findings are not answered either, so no wait says the reviewer agents are done.
      const held = await cli(['pr', 'wait', String(number), '--timeout', '1s']);
      assert.equal(held.code, 124, held.stdout);
      assert.match(held.stderr, new RegExp(`^codex-review commented on ${sha()}: reply to or resolve each of its threads, or push a commit\\.`, 'm'));
      await reply(thread, 'It counts nothing; it is the value.');
      assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review's findings in ${sha()} are answered\\); `, 'm'));

      // The user's approval without comments asks nothing, as it does for the turn: with the thread answered, open or not, nothing is left to address.
      await human('POST', `${base}/reviews`, { event: 'APPROVE' });
      const approved = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.match(approved.stdout, new RegExp(`^Unresolved threads: ${thread}$`, 'm'));
      assert.match(approved.stdout, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again\\.$`, 'm'));
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
      await human('PATCH', base, { state: 'closed' });
    }
  });
});

test('a reviewer agent is told what its earlier reviews found, resolved or not, and the commit it left off at', async () => {
  // On a base of its own, which can move on without moving main under the other tests.
  git('checkout', '-q', 'main');
  git('branch', 'history-base');
  git('checkout', '-qb', 'feature/history');
  writeFileSync(join(repo, 'history.js'), 'export const value = 1;\n');
  git('add', 'history.js');
  git('commit', '-qm', 'Add history.js');
  const created = await cli(['pr', 'create', '--title', 'Add history.js', '--body', 'x', '--base', 'history-base', '--reviewer', 'codex:3']);
  assert.equal(created.code, 0, created.stderr);
  const n = created.stdout.trim().split('/').pop()!;
  const calls = () => (existsSync(process.env.FAKE_CODEX_LOG!) ? readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n') : []);
  /** The prompt of the review the author's wait brings, which answers `review`. */
  const reviewed = (review: object) =>
    withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async (): Promise<string> => {
      const before = calls().length;
      const r = await cli(['pr', 'wait', n, '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /codex-review reviewed: commented/);
      assert.equal(calls().length, before + 1);
      return JSON.parse(calls().at(-1)!).prompt;
    });
  const first = await reviewed({
    summary: 'Three things.',
    comments: [
      { path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it.' },
      { path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Add a test.' },
      { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' },
    ],
  });
  assert.doesNotMatch(first, /Your last review|earlier reviews of this pull request/);
  const firstSha = git('rev-parse', 'HEAD');

  // The author fixes one finding and resolves its thread, and answers the other without resolving it.
  const threads = JSON.parse((await cli(['pr', 'view', n, '--json', 'reviewThreads'])).stdout).reviewThreads;
  writeFileSync(join(repo, 'history.js'), 'export const answer = 1;\n');
  git('commit', '-qam', 'Name the value');
  assert.equal((await cli(['pr', 'comment', n, '--reply-to', String(threads[0].databaseId), '--resolve', '-b', 'Renamed it.'])).code, 0);
  assert.equal((await cli(['pr', 'comment', n, '--reply-to', String(threads[1].databaseId), '-b', 'Out of scope.'])).code, 0);
  const oneMore = { summary: 'Fine now.', comments: [{ path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'One more.' }] };
  const second = await reviewed(oneMore);
  assert.match(second, /Check that each resolved comment was really fixed, and comment again only on one that was not/);
  assert.match(
    second,
    new RegExp(
      `Your last review, of ${firstSha.slice(0, 7)}, said: Three things\\.\n- history\\.js:1 \\(outdated\\) \\[resolved by agent\\]\n  codex-review: Name it\\.\n  agent: Renamed it\\.\n- history\\.js:1 \\(outdated\\) \\[open\\]\n  codex-review: Add a test\\.\n  agent: Out of scope\\.\nIts comments outside threads, which nobody resolves:\n- \`math\\.js:1\` \\(low priority\\): Not in this diff\\.\n`,
    ),
  );
  assert.match(second, new RegExp(`\nYou last reviewed ${firstSha}\\. Run \`git diff ${firstSha} HEAD\` to see what changed since\\.\n`));
  // Its own open thread is among its earlier reviews, not among the others' threads.
  assert.doesNotMatch(second, /Open review threads/);

  // Rebased onto a newer base, the commit it last reviewed is no starting point.
  const secondSha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'history-base');
  writeFileSync(join(repo, 'history-base.js'), 'export {};\n');
  git('add', 'history-base.js');
  git('commit', '-qm', 'Add history-base.js');
  await send('history-base');
  git('checkout', '-q', 'feature/history');
  git('rebase', '-q', 'history-base');
  const third = await reviewed(oneMore);
  assert.match(third, new RegExp(`\nYou last reviewed ${secondSha}, but the branch has been rebased onto a newer base since, so a diff from it would show the base's changes too: review the whole change\\.\n`));
  assert.doesNotMatch(third, new RegExp(`git diff ${secondSha}`));
  assert.match(third, new RegExp(`Your last review, of ${secondSha.slice(0, 7)}, said: Fine now\\.\n- history\\.js:1 \\[open\\]\n  codex-review: One more\\.\n`));
  assert.match(third, new RegExp(`Comments of your reviews before that, a line each:\n- ${firstSha.slice(0, 7)} history\\.js:1 \\(outdated\\) \\[resolved by agent\\]: Name it\\.\n- ${firstSha.slice(0, 7)} history\\.js:1 \\(outdated\\) \\[open\\]: Add a test\\.\n- ${firstSha.slice(0, 7)} \`math\\.js:1\` \\(low priority\\): Not in this diff\\.\n`));
});
