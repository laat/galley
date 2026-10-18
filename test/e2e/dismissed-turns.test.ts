// Dismissing your turn until something new happens: then it is nobody's, not counted and not told,
// until a commit, a review or comment, an edit, or a change on GitHub ends it by itself.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, send, server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { follow } from '../../desktop/live.ts';
import { groupOf, trayTitle } from '../../desktop/menu.ts';
import { openPulls, Turns, type Pull } from '../../desktop/turns.ts';
import { WAIT_GRACE_MS } from '../../src/server/service.ts';

startHarness();

/** Stage `branch` with one commit adding `file`, as the agent, with no reviewer agent: the reviewer's turn. */
async function stage(branch: string, file: string) {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, file), 'export {};\n');
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', '--no-review']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  /** Whose turn it is, the reasons' text, and when it was dismissed, as the API has them. */
  const turn = async (): Promise<{ whose: string; reasons: string[]; dismissed: string | null }> => {
    const pull = await human('GET', base);
    return { whose: pull.turn.whose, reasons: pull.turn.reasons.map((r: any) => r.text), dismissed: pull.dismissed_at };
  };
  return {
    number,
    id,
    base,
    turn,
    dismiss: () => human('PUT', `${base}/dismissed`),
    undo: () => human('DELETE', `${base}/dismissed`),
    /** Whether it is dismissed now. */
    dismissed: async () => (await turn()).dismissed !== null,
  };
}

const page = async (path: string) => (await fetch(server.url + path)).text();

/** The tab and the group the front page shows pull request `number` in. */
async function group(number: number): Promise<string | undefined> {
  for (const tab of ['staged', 'published']) {
    const groups = (await page(`/?state=${tab}`)).split('<div class="Box-row turn-group">').slice(1);
    const title = groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
    if (title) return `${tab}: ${title}`;
  }
}

/** Pull request `number`'s row on a list page. */
const rowOf = (html: string, number: number) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${number}"`))!;

/** The ids of the pull requests a list page notifies about (data-your-turn). */
const notified = (html: string): number[] => JSON.parse(html.match(/data-your-turn="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')).map((x: { id: number }) => x.id);

/** The desktop app's view of pull request `id`, and the count next to its icon. */
async function inTheMenu(id: number): Promise<{ pull: Pull; title: string }> {
  const pulls = await openPulls(server.url);
  return { pull: pulls.find((p) => p.id === id)!, title: trayTitle(pulls) };
}

test("dismissed: nobody's turn, under Dismissed and left out of the counts, until Undo; agents can not", async (t) => {
  const pr = await stage('feature/dismiss', 'dismiss.js');
  assert.deepEqual(await pr.turn(), { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet'], dismissed: null });
  assert.equal(await group(pr.number), 'staged: Your turn');
  const dismiss = `data-api="${pr.base}/dismissed" data-method="PUT"`;
  assert.ok(rowOf(await page('/'), pr.number).includes(dismiss));
  assert.match(await page(`/acme/widgets/pull/${pr.number}`), new RegExp(`<strong>Your turn</strong>\\s*<div class="color-fg-muted">agent is not waiting · no review from reviewer yet</div></div>\\s*<button type="button" class="btn btn-sm js-dismiss" ${dismiss} data-seen="[^"]*" data-toast="Dismissed until something new happens" title="Not yours to act on\\? Dismiss it until something new happens: a commit, a review or comment, or a change on GitHub"><svg[^]*?</svg> Dismiss</button>`));
  const before = await inTheMenu(pr.id);
  assert.equal(groupOf(before.pull), 'yours');
  // The page says what it showed; something new since, the user has not seen, so it is refused.
  const seen = rowOf(await page('/'), pr.number).match(/data-seen="([^"]*)"/)![1];
  assert.match(await page(`/acme/widgets/pull/${pr.number}`), new RegExp(`data-seen="${seen}"`));
  await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'Ping.' });
  const stale = await fetch(`${server.url}${pr.base}/dismissed`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seen }) });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /something new happened on s#\d+ since you looked/);
  assert.equal((await pr.turn()).dismissed, null);
  const now = rowOf(await page('/'), pr.number).match(/data-seen="([^"]*)"/)![1];
  assert.notEqual(now, seen);

  // The user's to do: an agent is refused, whether it says it is one or the CLI says so for it.
  const asAgent = await fetch(`${server.url}${pr.base}/dismissed`, { method: 'PUT', headers: { 'x-galley-actor': 'agent' } });
  assert.equal(asAgent.status, 403);
  assert.match(await asAgent.text(), /only the user can dismiss their turn/);
  assert.match((await (await fetch(`${server.url}${pr.base}/dismissed`, { method: 'DELETE', headers: { 'x-galley-actor': 'agent' } })).text()), /only the user can undo dismissing their turn/);
  const viaCli = await cli(['api', '-X', 'PUT', `repos/acme/widgets/pulls/${pr.number}/dismissed`]);
  assert.notEqual(viaCli.code, 0);
  assert.equal((await pr.turn()).whose, 'reviewer');

  await human('PUT', `${pr.base}/dismissed`, { seen: now });
  const dismissed = await pr.turn();
  assert.equal(dismissed.whose, 'none');
  assert.deepEqual(dismissed.reasons, ['reviewer dismissed it until something new happens', 'agent has not seen the latest feedback', 'agent is not waiting', 'no review from reviewer yet']);
  assert.ok(dismissed.dismissed);
  assert.equal((await human('GET', pr.base)).turn.reasons[0].kind, 'dismissed');
  assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^turn:\tnone\treviewer dismissed it until something new happens[^;\n]*; agent has not seen the latest feedback/m);
  // The front page has it under Dismissed, with Undo, and does not notify of it.
  assert.equal(await group(pr.number), 'staged: Dismissed');
  const front = await page('/');
  assert.ok(rowOf(front, pr.number).includes(`data-api="${pr.base}/dismissed" data-method="DELETE"`));
  assert.ok(!notified(front).includes(pr.id));
  // The menu has it under Dismissed, and counts one fewer of yours.
  const after = await inTheMenu(pr.id);
  assert.equal(groupOf(after.pull), 'dismissed');
  assert.equal(Number(after.title.split(' ')[0] || 0), Number(before.title.split(' ')[0] || 0) - 1);
  // Its page says so, with Undo, and so does its timeline.
  const html = await page(`/acme/widgets/pull/${pr.number}`);
  assert.match(html, new RegExp(`<strong>Dismissed until something new happens</strong>\\s*<div class="color-fg-muted">reviewer dismissed it <relative-time[^>]*>now</relative-time>\\. It is your turn again with a commit, a review or comment, or a change on GitHub\\.</div></div>\\s*<button type="button" class="btn btn-sm js-dismiss" data-api="${pr.base}/dismissed" data-method="DELETE">Undo</button>`));
  assert.match(html, /reviewer<\/a> dismissed this until something new happens/);
  const timeline: any[] = await human('GET', `/api/repos/acme/widgets/issues/${pr.number}/timeline`);
  assert.deepEqual(timeline.filter((e) => e.event?.startsWith('turn_')).map((e) => [e.event, e.actor.login]), [['turn_dismissed', 'reviewer']]);
  // Dismissed again: nothing more.
  await pr.dismiss();
  assert.equal((await human('GET', `/api/repos/acme/widgets/issues/${pr.number}/timeline`)).filter((e: any) => e.event === 'turn_dismissed').length, 1);

  // Undo: your turn again, in its place, and the desktop app hears that you did it.
  const heard: { type: string; pullId: number | null }[] = [];
  const live = follow(server.url, { up() {}, down() {}, change: (e) => heard.push(e) });
  t.after(() => live.stop());
  await until(() => server.service.bus.listenerCount('change') > 0, 'the stream is open');
  await pr.undo();
  await until(() => heard.some((e) => e.type === 'undismissed' && e.pullId === pr.id), 'the stream says so');
  assert.deepEqual(await pr.turn(), { whose: 'reviewer', reasons: ['agent has not seen the latest feedback', 'agent is not waiting', 'no review from reviewer yet'], dismissed: null });
  assert.equal(await group(pr.number), 'staged: Your turn');
  assert.ok(notified(await page('/')).includes(pr.id));
  assert.match(await page(`/acme/widgets/pull/${pr.number}`), /reviewer<\/a> undid dismissing this/);
  // Undone again, or by an agent: nothing.
  await pr.undo();
  assert.equal((await fetch(`${server.url}${pr.base}/dismissed`, { method: 'DELETE', headers: { 'x-galley-actor': 'agent' } })).status, 403);
  assert.deepEqual(
    (await human('GET', `/api/repos/acme/widgets/issues/${pr.number}/timeline`)).filter((e: any) => e.event?.startsWith('turn_')).map((e: any) => e.event),
    ['turn_dismissed', 'turn_undismissed'],
  );

  // Only your turn can be dismissed: not once closed.
  await human('PATCH', pr.base, { state: 'closed' });
  const closed = await fetch(`${server.url}${pr.base}/dismissed`, { method: 'PUT' });
  assert.equal(closed.status, 422);
  assert.match(await closed.text(), /it is not your turn on s#\d+/);
});

test("the author's wait, galley's own bookkeeping and a base that moved are nothing new; a comment, a review, an edit or a push from anyone is", async (t) => {
  const pr = await stage('feature/dismiss-news', 'news.js');
  // The wait that hands the commit to the reviewer comes first.
  await handedOver(pr.number);
  await pr.dismiss();
  // A wait that ended counts for a moment, not seconds.
  server.service.waitGraceMs = 100;
  t.after(() => (server.service.waitGraceMs = WAIT_GRACE_MS));

  await t.test("the author's wait does not hear of it, and waiting is nothing new", async () => {
    const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '2s']);
    await until(async () => (await human('GET', pr.base)).author_waiting, 'the author waits');
    assert.ok(await pr.dismissed());
    await pr.undo();
    await pr.dismiss();
    const r = await waiting;
    assert.equal(r.code, 124, r.stdout);
    assert.match(r.stderr, /No feedback yet/);
    await until(() => !server.service.authorWaiting(pr.id, { grace: true }), 'the wait is over');
    assert.ok(await pr.dismissed());
  });

  await t.test('a base that moved on GitHub is nothing new', async () => {
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'elsewhere.js'), 'export {};\n');
    git('add', 'elsewhere.js');
    git('commit', '-qm', 'Add elsewhere.js');
    git('push', '-q', 'origin', 'main');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    await server.service.fetchBases(server.service.repo('acme', 'widgets'), { base: 'main' });
    await page(`/acme/widgets/pull/${pr.number}`);
    await until(() => server.service.baseConflicts(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id)) !== null, 'galley checked for conflicts');
    assert.ok(await pr.dismissed());
  });

  await t.test("the author's comment ends it", async () => {
    const r = await cli(['pr', 'comment', String(pr.number), '--body', 'Nothing to add.']);
    assert.equal(r.code, 0, r.stderr);
    const { whose, dismissed } = await pr.turn();
    assert.deepEqual({ whose, dismissed }, { whose: 'reviewer', dismissed: null });
    assert.equal(await group(pr.number), 'staged: Your turn');
  });

  await t.test('your own comment ends it', async () => {
    await pr.dismiss();
    await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'Waiting for the team.' });
    assert.equal(await pr.dismissed(), false);
  });

  await t.test('a comment ends it for good: deleted again, it stays ended', async () => {
    await pr.dismiss();
    const comment = await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'Never mind.' });
    assert.equal(await pr.dismissed(), false);
    await human('DELETE', `/api/repos/acme/widgets/issues/comments/${comment.id}`);
    assert.equal(await pr.dismissed(), false);
    const [dismissal] = (await human('GET', `/api/repos/acme/widgets/issues/${pr.number}/timeline`)).filter((e: any) => e.event === 'turn_dismissed').slice(-1);
    assert.ok(dismissal.ended);
  });

  await t.test('a comment edited ends it', async () => {
    const comment = (await human('GET', `/api/repos/acme/widgets/issues/${pr.number}/comments`)).find((c: any) => c.user.login === 'reviewer');
    await pr.dismiss();
    await human('PATCH', `/api/repos/acme/widgets/issues/comments/${comment.id}`, { body: 'Waiting for the team, still.' });
    assert.equal(await pr.dismissed(), false);
  });

  await t.test('a review ends it once submitted, not while pending', async () => {
    await pr.dismiss();
    const pending = await human('POST', `${pr.base}/reviews`, { comments: [{ path: 'news.js', line: 1, side: 'RIGHT', body: 'Hm.' }] });
    assert.ok(await pr.dismissed());
    await human('POST', `${pr.base}/reviews/${pending.id}/events`, { event: 'COMMENT' });
    assert.equal(await pr.dismissed(), false);
  });

  await t.test('an edit of the title ends it', async () => {
    // Feedback the author does not wait for: the reviewer's to pass on.
    assert.equal((await pr.turn()).whose, 'reviewer');
    await pr.dismiss();
    await human('PATCH', pr.base, { title: 'Add news.js, renamed' });
    assert.equal(await pr.dismissed(), false);
  });

  await t.test("the author's push ends it", async () => {
    await pr.dismiss();
    git('checkout', '-q', 'feature/dismiss-news');
    writeFileSync(join(repo, 'news.js'), 'export const news = 1;\n');
    git('commit', '-qam', 'Say something');
    await send('feature/dismiss-news');
    assert.equal(await pr.dismissed(), false);
  });
});

test('published: following GitHub again with nothing new keeps it; a review, a comment, a check or a conflict there ends it', async () => {
  const pr = await stage('feature/dismiss-github', 'github.js');
  await human('POST', `${pr.base}/publish`, { sign: false });
  const head = server.service.db.get<{ sha: string }>('SELECT published_head_sha AS sha FROM pulls WHERE id = ?', pr.id)!.sha;
  const check = (status: string, conclusion: string | null) => ({ __typename: 'CheckRun', databaseId: 21, name: 'test', status, conclusion, detailsUrl: null, checkSuite: { workflowRun: { workflow: { name: 'CI' } } } });
  /** What GitHub says of it: open, checks passed, ready to merge, no auto-merge; then galley asks it. */
  const githubSays = async (more: object = {}) => {
    const node = {
      state: 'OPEN',
      timelineItems: { nodes: [] },
      headRefOid: head,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      autoMergeRequest: null,
      reviews: { totalCount: 0 },
      comments: { totalCount: 0 },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 1, nodes: [check('COMPLETED', 'SUCCESS')] } }, checkSuites: { nodes: [] } } }] },
      ...more,
    };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: node } } }));
    await server.service.followGithub();
  };
  // As the user found it: published, ready to merge on GitHub, not reviewed here, and for the team to review.
  await githubSays();
  assert.deepEqual(await pr.turn(), { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet', 'ready to merge on GitHub'], dismissed: null });
  await pr.dismiss();
  assert.equal(await group(pr.number), 'published: Dismissed');

  // Asked again: GitHub says the same, then works out mergeability again after a push to the base, then says the same again.
  await githubSays();
  assert.ok(await pr.dismissed());
  await githubSays({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.ok(await pr.dismissed());
  await githubSays({ mergeStateStatus: 'BEHIND' });
  // GitHub's move for now, with nothing new: still dismissed, with its Undo.
  assert.deepEqual((await pr.turn()).reasons, ['reviewer dismissed it until something new happens']);
  assert.equal(await group(pr.number), 'published: Dismissed');
  await githubSays();
  assert.ok(await pr.dismissed());
  assert.equal((await pr.turn()).whose, 'none');

  // A teammate's review, which GitHub does not require: your turn again, to merge it.
  await githubSays({ reviews: { totalCount: 1 } });
  assert.deepEqual(await pr.turn(), { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet', 'ready to merge on GitHub'], dismissed: null });
  await pr.dismiss();
  await githubSays({ reviews: { totalCount: 1 } });
  assert.ok(await pr.dismissed());
  // A comment there.
  await githubSays({ reviews: { totalCount: 1 }, comments: { totalCount: 1 } });
  assert.equal(await pr.dismissed(), false);
  await pr.dismiss();
  // Its check run again: running, then failed.
  await githubSays({ reviews: { totalCount: 1 }, comments: { totalCount: 1 }, mergeStateStatus: 'BLOCKED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 1, nodes: [check('IN_PROGRESS', null)] } }, checkSuites: { nodes: [] } } }] } });
  assert.equal(await pr.dismissed(), false);
  await githubSays({ reviews: { totalCount: 1 }, comments: { totalCount: 1 } });
  assert.equal((await pr.turn()).whose, 'reviewer');
  await pr.dismiss();
  // A conflict with its base.
  await githubSays({ reviews: { totalCount: 1 }, comments: { totalCount: 1 }, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  const conflicting = await pr.turn();
  assert.equal(conflicting.dismissed, null);
  assert.equal(conflicting.whose, 'reviewer');
  assert.ok(conflicting.reasons.includes('conflicts with main on GitHub'), conflicting.reasons.join('; '));
});

test('no notification while dismissed; once something new ends it, it is told again', async () => {
  const pr = await stage('feature/dismiss-notify', 'notify.js');
  const told: number[] = [];
  const turns = new Turns(() => openPulls(server.url), { list() {}, turned: (p) => told.push(p.id) }, 50);
  // The first look says what is: your turn already, nothing to tell.
  await turns.refresh();
  assert.ok(turns.list.some((p) => p.id === pr.id));
  await pr.dismiss();
  await turns.refresh();
  assert.ok(!turns.list.some((p) => p.id === pr.id));
  await sleep(150);
  await turns.refresh();
  assert.equal(told.length, 0);
  // Something new: your turn again, told once it has been for the wait.
  assert.equal((await cli(['pr', 'comment', String(pr.number), '--body', 'Rebased on nothing.'])).code, 0);
  await turns.refresh();
  await until(() => told.includes(pr.id), 'it is told');
  assert.deepEqual(told, [pr.id]);
});
