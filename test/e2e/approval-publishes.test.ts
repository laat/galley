// Approving and publishing. The user's approval of the head publishes the pull request when
// nothing else is left: it turns on auto-publish, which publishes at once. With something left, it
// is an approval and nothing more. And the user's publish counts as their approval.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, send, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

/** Stage a branch with one commit, as the agent, without reviewer agents. */
async function stage(branch: string) {
  const file = `${branch.split('/').pop()}.js`;
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, file), 'export {};\n');
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', '--no-review']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pull = async () => human('GET', base);
  return {
    n: String(number),
    base,
    pull,
    head: git('rev-parse', 'HEAD'),
    /** The agent asks the user to review (once per commit), and waits with all feedback seen. */
    waits: async (handOver = true) => {
      if (handOver) await handedOver(number);
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      await until(async () => (await pull()).author_waiting, 'the agent waits');
      // In an object, or awaiting this would wait for the wait to end.
      return { waiting };
    },
    timeline: async () => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
    page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
  };
}

test('an approval with nothing else left publishes, as the user, through auto-publish', async () => {
  const pr = await stage('feature/approve-publishes');
  const { waiting } = await pr.waits();
  await human('POST', `${pr.base}/reviews`, { event: 'APPROVE' });
  const r = await waiting;
  assert.match(r.stdout, /reviewer reviewed: approved/);
  await until(async () => (await pr.pull()).staging_state === 'published', 'it is published');
  const timeline = await pr.timeline();
  const enabled = timeline.find((e: any) => e.event === 'auto_publish_enabled');
  assert.deepEqual([enabled.actor.login, enabled.approved], ['reviewer', pr.head]);
  assert.equal(timeline.find((e: any) => e.event === 'published').actor.login, 'reviewer');
  assert.match(await pr.page(), new RegExp(`reviewer</a> enabled auto-publish \\(signed\\) by approving <code>${pr.head.slice(0, 7)}</code> with nothing else left`));
  // The agent hears of it at its next wait.
  const next = await cli(['pr', 'wait', pr.n, '--timeout', '20s']);
  assert.match(next.stdout, /^Published to GitHub: /m);
});

test('a pending review submitted as an approval publishes too, with the commit the page showed', async () => {
  const pr = await stage('feature/approve-pending');
  // The review form sends the commit the page shows.
  assert.ok((await (await fetch(`${server.url}/acme/widgets/pull/${pr.n}/files`)).text()).includes(`<input type="hidden" name="commit_id" value="${pr.head}">`));
  const { waiting } = await pr.waits();
  const pending = await human('POST', `${pr.base}/reviews`, {});
  await human('POST', `${pr.base}/reviews/${pending.id}/events`, { event: 'APPROVE', commit_id: pr.head });
  await waiting;
  await until(async () => (await pr.pull()).staging_state === 'published', 'it is published');
});

test('a pending review discarded while its approval is being submitted publishes nothing', async () => {
  const pr = await stage('feature/approve-discarded');
  const { waiting } = await pr.waits();
  const pending = await human('POST', `${pr.base}/reviews`, {});
  // Discarded in another tab while the submission looks up how to sign.
  const signsByDefault = server.service.signsByDefault;
  server.service.signsByDefault = async (ctx) => {
    await human('DELETE', `${pr.base}/reviews/${pending.id}`);
    return signsByDefault.call(server.service, ctx);
  };
  try {
    const res = await fetch(`${server.url}${pr.base}/reviews/${pending.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'APPROVE', commit_id: pr.head }) });
    assert.equal(res.status, 404);
  } finally {
    server.service.signsByDefault = signsByDefault;
  }
  assert.equal((await pr.pull()).auto_publish, null);
  await human('POST', `/api/repos/acme/widgets/issues/${pr.n}/comments`, { body: 'Never mind.' });
  await waiting;
  assert.equal((await pr.pull()).staging_state, 'staged');
});

test('auto-publish an approval turned on publishes the head approved only, and a push turns it off', async () => {
  const pr = await stage('feature/approve-pushed');
  const { id } = await pr.pull();
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  // As an approval leaves it when its first try did not publish (signing to try again, say), and
  // feedback since keeps it from publishing now.
  const at = new Date(Date.now() - 1000).toISOString();
  const auto = JSON.stringify({ by: server.service.viewer().id, at, sign: false, draft: false, force: false, autoMerge: null, approved: pr.head });
  server.service.db.update('pulls', id, { auto_publish: auto, author_handed_at: new Date().toISOString() });
  writeFileSync(join(repo, 'approve-pushed.js'), 'export const pushed = true;\n');
  git('commit', '-qam', 'Change approve-pushed.js');
  await send('feature/approve-pushed');
  const pull = await pr.pull();
  assert.equal(pull.auto_publish, null);
  assert.equal(pull.staging_state, 'staged');
  const off = (await pr.timeline()).findLast((e: any) => e.event === 'auto_publish_disabled');
  assert.deepEqual([off.actor.login, off.reason], ['agent', 'pushed']);
  assert.match(await pr.page(), /agent<\/a><span class="Label Label--bot">bot<\/span> disabled auto-publish by pushing after the approval that turned it on/);
  // Left on for the earlier head, with the agent waiting with all feedback seen, it does not publish this one.
  const { waiting } = await pr.waits();
  server.service.db.update('pulls', id, { auto_publish: auto });
  assert.equal(server.service.autoPublishChecklist(row()).every((i) => i.ok || !i.blocking), true, 'all else is ready');
  assert.equal(server.service.autoPublishReady(row()), false);
  server.service.db.update('pulls', id, { auto_publish: null });
  await human('POST', `/api/repos/acme/widgets/issues/${pr.n}/comments`, { body: 'Done here.' });
  await waiting;
  assert.equal((await pr.pull()).staging_state, 'staged');
});

test('with something left, an approval only approves', async (t) => {
  await t.test('the agent is working, not waiting', async () => {
    const pr = await stage('feature/approve-working');
    await human('POST', `${pr.base}/reviews`, { event: 'APPROVE' });
    const pull = await pr.pull();
    assert.equal(pull.staging_state, 'staged');
    assert.equal(pull.auto_publish, null);
  });

  await t.test('the approval has a comment, which the agent is to address', async () => {
    const pr = await stage('feature/approve-comment');
    const { waiting } = await pr.waits();
    await human('POST', `${pr.base}/reviews`, { event: 'APPROVE', comments: [{ path: 'approve-comment.js', line: 1, body: 'Nit: name it.' }] });
    await waiting;
    assert.equal((await pr.pull()).auto_publish, null);
  });

  await t.test('a conversation the user started is unresolved', async () => {
    const pr = await stage('feature/approve-thread');
    await human('POST', `${pr.base}/comments`, { path: 'approve-thread.js', line: 1, body: 'Why this name?' });
    await cli(['pr', 'view', pr.n, '--comments']);
    const { waiting } = await pr.waits();
    await human('POST', `${pr.base}/reviews`, { event: 'APPROVE' });
    await waiting;
    assert.equal((await pr.pull()).auto_publish, null);
  });

  await t.test('an earlier commit is approved, in a new review or a pending one', async () => {
    const pr = await stage('feature/approve-earlier');
    writeFileSync(join(repo, 'approve-earlier.js'), 'export const later = true;\n');
    git('commit', '-qam', 'Change approve-earlier.js');
    const { waiting } = await pr.waits();
    await human('POST', `${pr.base}/reviews`, { event: 'APPROVE', commit_id: pr.head });
    await waiting;
    assert.equal((await pr.pull()).auto_publish, null);
    const again = await pr.waits(false);
    const pending = await human('POST', `${pr.base}/reviews`, {});
    const submitted = await human('POST', `${pr.base}/reviews/${pending.id}/events`, { event: 'APPROVE', commit_id: pr.head });
    assert.equal(submitted.commit_id, pr.head);
    await again.waiting;
    assert.equal((await pr.pull()).auto_publish, null);
  });
});

test('a request for changes while the user publishes counts over the publish', async () => {
  const pr = await stage('feature/publish-then-changes');
  const gate = join(dir, 'publish-changes-gate');
  try {
    await withFakes({ FAKE_GH_GATE: gate }, async () => {
      const publishing = human('POST', `${pr.base}/publish`, { sign: false });
      // Publishing waits in `gh pr create` when the request for changes comes.
      await until(() => readFileSync(join(dir, 'gh.log'), 'utf8').includes('--head feature/publish-then-changes'), 'publishing runs gh pr create');
      await human('POST', `${pr.base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Wait, one more thing.' });
      writeFileSync(gate, '');
      assert.equal((await publishing).staging_state, 'published');
    });
  } finally {
    rmSync(gate, { force: true });
  }
  const { reviewDecision } = await human('GET', `/api/repos/acme/widgets/gh/pulls/${pr.n}?fields=reviewDecision`);
  assert.equal(reviewDecision, 'CHANGES_REQUESTED');
});

test("the user's publish of a pull request they staged themselves approves nothing", async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/own');
  writeFileSync(join(repo, 'own.js'), 'export {};\n');
  git('add', 'own.js');
  git('commit', '-qm', 'Add own.js');
  await send('feature/own');
  const created = await human('POST', '/api/repos/acme/widgets/pulls', { title: 'Add own.js', head: 'feature/own', base: 'main', automatic_reviews: false });
  const base = `/api/repos/acme/widgets/pulls/${created.number}`;
  await human('POST', `${base}/publish`, { sign: false });
  const { reviewDecision } = await human('GET', `/api/repos/acme/widgets/gh/pulls/${created.number}?fields=reviewDecision`);
  assert.equal(reviewDecision, 'REVIEW_REQUIRED');
  assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${created.number}`)).text(), /<h3 class="sidebar-heading">Reviewers<\/h3><ul class="sidebar-list"><li class="color-fg-muted">No reviews yet<\/li>/);
});
