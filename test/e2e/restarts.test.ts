// Servers that stop and start: reviews and waits across a restart, and the CLI starting a server.
import '../helpers/env.ts';
import { BIN, dir, exec, git, human, repo, reviewCheckouts, scratchRepo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { startServer } from '../../src/server/server.ts';
import { Db } from '../../src/server/db.ts';
import { Service, type ChangeEvent } from '../../src/server/service.ts';
import { CodexReviewer } from '../../src/server/reviewers/codex.ts';

startHarness();

test('a review the server stops under is interrupted, runs again when it starts, and does not count', async (t) => {
  const checkedOut = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/restart-review');
  writeFileSync(join(repo, 'restart.js'), 'export {};\n');
  git('add', 'restart.js');
  git('commit', '-qm', 'Add restart.js');
  const data = mkdtempSync(join(tmpdir(), 'galley-stop-'));
  const start = ({ port = 0, gh = 'false' } = {}) => startServer({ port, dataDir: data, ghBin: gh, codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  let s = await start();
  t.after(async () => {
    await s.close();
    rmSync(data, { recursive: true, force: true });
  });
  const port = s.port;
  // Later restarts take a new port: fetch would send its first request to one on the same port over a connection the old server closed.
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${s.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pulls = `/api/repos/${registered.full_name}/pulls`;
  // Codex gets one automatic review.
  const pr = await (
    await fetch(`${s.url}${pulls}`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Slow review', head: 'feature/restart-review', base: 'main', reviewers: [{ login: 'codex', max_iterations: 1 }] }),
    })
  ).json();
  const base = `${pulls}/${pr.number}`;
  const runs = async () => (await (await fetch(`${s.url}${base}/reviewers/codex`)).json()).runs.map((r: any) => [r.trigger, r.status, r.error]);
  const page = async () => (await fetch(`${s.url}/${registered.full_name}/pull/${pr.number}`)).text();
  const ask = async () => assert.equal((await fetch(`${s.url}${base}/reviewers/codex`, { method: 'POST' })).status, 202);
  // The fake Codex answers once the gate exists; until then its review runs.
  const gate = join(dir, 'stop-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'restart.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Export something.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    try {
      // The author waits, which starts the automatic review, and the server stops under it.
      const env = { ...process.env, GALLEY_URL: s.url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' };
      const waiting = exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env });
      await until(() => s.service.codex!.isRunning(pr.id), 'Codex reviews');
      // Until Codex is at work, with steps in its transcript.
      const pull = () => s.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
      await until(() => (s.service.codex!.live(pull())?.progress.total ?? 0) >= 2, 'Codex has two steps in its transcript');
      const started = Date.now();
      await s.close();
      assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
      assert.deepEqual(reviewCheckouts(), []);

      // Interrupted, not failed: it runs again once the author's wait is back (on the same port), and the wait gets its review.
      writeFileSync(gate, '');
      s = await start({ port });
      assert.deepEqual(await runs(), [['auto', 'interrupted', null]]);
      // Its transcript keeps what it did until the stop, and says why it ended.
      const [{ id: interrupted }] = (await (await fetch(`${s.url}${base}/reviewers/codex`)).json()).runs;
      const runPath = `/${registered.full_name}/pull/${pr.number}/runs/${interrupted}`;
      assert.match(await page(), new RegExp(`<a class="agent-state" href="${runPath}" title="Review of [0-9a-f]{7} interrupted by a restart">[^]*?<span class="agent-chunk">Runs again</span>`));
      const transcript = await (await fetch(s.url + runPath)).text();
      assert.match(transcript, /Interrupted by a restart <relative-time/);
      assert.match(transcript, /I will read math\.js and the diff\./);
      const r = await waiting;
      assert.match(r.stdout, /codex-review reviewed: commented/);
      await s.service.codex!.settle(pr.id);
      assert.deepEqual(await runs(), [['auto', 'interrupted', null], ['auto', 'done', null]]);
      const reviews = await (await fetch(`${s.url}${base}/reviews`)).json();
      assert.match(reviews.at(-1).body, /automatic review 1 of 1\./);

      // Asked for by hand, it runs again as soon as the server starts.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      s = await start();
      const row = () => s.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
      assert.ok(s.service.codex!.atWork(row()), 'about to review from the start');
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(2), [['manual', 'interrupted', null], ['manual', 'done', null]]);

      // Until it has run again, it holds things up: auto-publish does not publish while the server
      // stops, with the author waiting and nothing unseen, nor is the author told the agents are done.
      const asAgent = { 'x-galley-actor': 'agent' };
      const shown = await (await fetch(`${s.url}${base}/wait?timeout=5`, { headers: asAgent })).json();
      assert.equal((await fetch(`${s.url}${base}/seen`, { method: 'PUT', headers: { ...asAgent, ...json }, body: JSON.stringify({ at: shown.seen_at }) })).status, 204);
      assert.equal((await fetch(`${s.url}${base}/auto-publish`, { method: 'PUT', headers: json, body: JSON.stringify({ sign: false }) })).status, 200);
      rmSync(gate);
      await ask();
      const authorWaits = fetch(`${s.url}${base}/wait?timeout=30`, { headers: asAgent })
        .then((res) => res.json())
        .catch(() => null);
      await until(async () => (await (await fetch(`${s.url}${base}`)).json()).author_waiting, 'the author waits');
      await s.close();
      assert.notEqual((await authorWaits)?.status, 'agents_done');
      {
        const db = new Db(join(data, 'galley.db'));
        const pull = db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
        const service = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
        service.codex = new CodexReviewer(service, join(dir, 'codex'));
        const status = service.codex.headStatus(pull);
        assert.equal(status.state, 'interrupted');
        // It runs again without the author: the reviewer agents' turn, though the author does not wait.
        const { whose, reasons } = service.turn(pull);
        assert.deepEqual([whose, reasons[0].text], ['reviewer_agents', `codex-review's review of ${pull.head_sha.slice(0, 7)} was interrupted by a restart; it will run again`]);
        await service.conflictChecks;
        assert.deepEqual(db.all('SELECT type FROM events WHERE pull_id = ? AND type IN (?, ?)', pr.id, 'published', 'auto_publish_failed'), []);
        db.sql.close();
      }
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(4), [['manual', 'interrupted', null], ['manual', 'done', null]]);
      assert.ok(row().auto_publish, 'auto-publish is still on, never having tried');
      assert.equal((await fetch(`${s.url}${base}/auto-publish`, { method: 'DELETE' })).status, 204);

      // Not when the branch moved on while the server was down.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(join(repo, 'restart.js'), 'export const moved = true;\n');
      git('commit', '-qam', 'Change restart.js');
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.equal(row().head_sha, git('rev-parse', 'HEAD'));
      assert.deepEqual((await runs()).slice(6), [['manual', 'interrupted', null]]);

      // Nor when following GitHub, which starts with the server, finds it merged meanwhile.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      const ctx = Service.prototype.ctx;
      Service.prototype.ctx = async function (this: Service, ...args: Parameters<Service['ctx']>) {
        if (this !== server.service) {
          Service.prototype.ctx = ctx;
          this.db.run("UPDATE pulls SET github_state = 'merged' WHERE id = ?", pr.id);
        }
        return ctx.apply(this, args);
      };
      try {
        s = await start();
        await s.service.codex!.settle(pr.id);
      } finally {
        Service.prototype.ctx = ctx;
      }
      assert.deepEqual((await runs()).slice(7), [['manual', 'interrupted', null]]);
      s.service.db.run('UPDATE pulls SET github_state = NULL WHERE id = ?', pr.id);

      // When it can not run again, it failed: it does not keep the pull request with the reviewer agents.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      Service.prototype.ctx = async function (this: Service, ...args: Parameters<Service['ctx']>) {
        if (this !== server.service) {
          Service.prototype.ctx = ctx;
          throw new Error('the repository moved');
        }
        return ctx.apply(this, args);
      };
      try {
        s = await start();
        await s.service.codex!.settle(pr.id);
      } finally {
        Service.prototype.ctx = ctx;
      }
      assert.deepEqual((await runs()).slice(8), [['manual', 'failed', 'the repository moved']]);
      const failed = s.service.turn(row());
      assert.deepEqual([failed.whose, failed.reasons.find((x) => x.kind === 'reviewer_agent')?.text], ['reviewer', `codex-review's review of ${row().head_sha.slice(0, 7)} failed`]);

      // Given time, stopping waits for a running review to post, and pages say so meanwhile in the
      // header, which live updates refresh along with #main.
      rmSync(gate);
      await ask();
      const finishing = s.close({ graceMs: 60_000 });
      const stopping = await page();
      assert.match(stopping, /<header[^]*<span id="server-stopping" class="stopping-indicator" role="status" title="Waiting for 1 running review to finish before the server stops\."[^>]*>.*?Stopping · 1 review running.*?<\/span><\/span>[^]*<\/header>/);
      assert.doesNotMatch(stopping.slice(stopping.indexOf('<div id="main"')), /Waiting for/);
      assert.equal((await fetch(`${s.url}${base}/reviewers/codex`, { method: 'POST' })).status, 503);
      // Pages of other pull requests hear when the count changes.
      const heard: ChangeEvent[] = [];
      s.service.bus.on('change', (e: ChangeEvent) => e.type === 'stopping' && heard.push(e));
      writeFileSync(gate, '');
      await finishing;
      assert.deepEqual(heard, [{ pullId: null, type: 'stopping', actor: null, source: 'galley' }]);
      s = await start();
      assert.deepEqual((await runs()).slice(9), [['manual', 'done', null]]);

      // Stopping again while it waits interrupts at once.
      rmSync(gate);
      await ask();
      const waitingToStop = s.close({ graceMs: 60_000 });
      await new Promise((r) => setTimeout(r, 200));
      const again = Date.now();
      await s.close();
      await waitingToStop;
      assert.ok(Date.now() - again < 5000, `the second close took ${Date.now() - again} ms`);
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(10), [['manual', 'interrupted', null], ['manual', 'done', null]]);

      // Published, it is not run again when GitHub says it was merged meanwhile, even when GitHub answers late.
      rmSync(gate);
      await ask();
      await s.close();
      {
        const db = new Db(join(data, 'galley.db'));
        db.run("UPDATE pulls SET state = 'published', published_url = ?, published_head_sha = head_sha, published_source_sha = head_sha WHERE id = ?", 'https://github.com/acme/widgets/pull/7', pr.id);
        db.sql.close();
      }
      // A gh that tells what GitHub says about pull requests a second late, and fails at anything else.
      const lateGh = join(dir, 'gh-late');
      const merged = { state: 'MERGED', mergedAt: '2026-10-17T09:00:00Z', closedAt: '2026-10-17T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: null, timelineItems: { nodes: [] } };
      writeFileSync(join(dir, 'gh-late.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
      writeFileSync(lateGh, `#!/bin/sh\ncase "$*" in\n  *"pullRequest("*) sleep 1; cat "${join(dir, 'gh-late.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
      chmodSync(lateGh, 0o755);
      writeFileSync(gate, '');
      s = await start({ gh: lateGh });
      await s.service.codex!.settle(pr.id);
      await until(() => row().github_state === 'merged', 'the server hears of the merge');
      assert.deepEqual((await runs()).slice(12), [['manual', 'interrupted', null]]);
    } finally {
      rmSync(gate, { force: true });
      await s.close();
      git('checkout', '-q', checkedOut);
    }
  });
});

test('closing the server waits for a running poll before it closes the database', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'galley-poll-'));
  const second = await startServer({ port: 0, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 10 });
  t.after(async () => {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  });
  const errors = mock.method(console, 'error', () => {});
  // A slow poll: it reads the database once the server is closing.
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let polled = false;
  const pollAll = second.service.pollAll.bind(second.service);
  second.service.pollAll = async () => {
    started();
    await new Promise((r) => setTimeout(r, 200));
    await pollAll();
    polled = true;
  };
  try {
    await running;
    await second.close();
    assert.ok(polled, 'the poll finished before the server closed');
    assert.deepEqual(errors.mock.calls.map((c) => c.arguments.join(' ')), []);
  } finally {
    errors.mock.restore();
  }
});

test('a reviewer never takes the human reviewer\'s own name', async () => {
  // Known at startup: the human is set up first, and the reviewer takes another name.
  const data = mkdtempSync(join(tmpdir(), 'galley-viewer-'));
  const named = await startServer({ port: 0, dataDir: data, ghBin: 'false', codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'codex-review', pollMs: 60_000 });
  try {
    assert.equal(named.service.viewer().type, 'User');
    assert.notEqual(named.service.codex!.actor().id, named.service.viewer().id);
    const res = await fetch(`${named.url}/api/settings/codex`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxIterations: 2 }) });
    assert.equal(res.status, 200, 'settings stay the human\'s');
  } finally {
    await named.close();
    rmSync(data, { recursive: true, force: true });
  }

  // Learned later (from gh): the reviewer gives the name up.
  const data2 = mkdtempSync(join(tmpdir(), 'galley-viewer-'));
  const db = new Db(join(data2, 'galley.db'));
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'someone' });
    s.codex = new CodexReviewer(s, join(dir, 'codex'));
    assert.equal(s.codex.actor().login, 'codex-review');
    s.setViewerLogin('codex-review');
    assert.equal(s.viewer().type, 'User');
    assert.equal(s.codex.actor().login, 'codex-review-reviewer');
  } finally {
    db.sql.close();
    rmSync(data2, { recursive: true, force: true });
  }
});

test('pr wait keeps waiting when the server restarts under it', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'galley-restart-'));
  const first = await startServer({ port: 0, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  t.after(async () => {
    await first.close();
    rmSync(data, { recursive: true, force: true });
  });
  const port = first.port;
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Survives restarts', head: 'feature/mul', base: 'main' }),
    })
  ).json();
  const env = { ...process.env, GALLEY_URL: first.url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1' };
  // No reviewer agent reviews it, which the first wait says; the next one waits for the reviewer.
  assert.match((await exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env })).stdout, /ask the user to review it/);
  const waiting = exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env });
  // Close the server while the wait's request is open, then bring it back on the same port.
  await until(async () => (await (await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}`)).json()).author_waiting, 'the author waits');
  await first.close();
  const second = await startServer({ port, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  try {
    // The wait tries again every 3 seconds.
    await until(async () => (await (await fetch(`${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`)).json()).author_waiting, 'the wait is back');
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Still there?' }) });
    const r = await waiting;
    assert.match(r.stdout, /Still there\?/);

    // Delivered but never confirmed (the CLI died, say): the next wait brings it again.
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    const asAgent = { 'x-galley-actor': 'agent' };
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Second?' }) });
    const once = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    const twice = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    assert.equal(once.status, 'feedback');
    assert.deepEqual(twice.comments, once.comments);
    assert.ok(once.pr.comments.some((cm: any) => cm.body === 'Second?'), 'the wait carries what is needed to show the feedback');
    const confirm = await fetch(`${api}/seen`, { method: 'PUT', headers: { ...asAgent, ...json }, body: JSON.stringify({ at: once.seen_at }) });
    assert.equal(confirm.status, 204);
    assert.equal((await (await fetch(`${api}/wait?timeout=1`, { headers: asAgent })).json()).status, 'timeout');
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

/**
 * What `pr wait` in `cwd` has printed by the time its confirmation (`PUT …/seen`) reached the
 * server, whose answer is lost on the way back.
 */
async function waitLosingSeen(cwd: string, n: number): Promise<string> {
  // Between the CLI and the server: the server takes the confirmation, and its answer is lost.
  let confirmed = false;
  const proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers } as Record<string, string>;
    for (const h of ['host', 'connection', 'content-length']) delete headers[h];
    const answer = await fetch(server.url + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const body = Buffer.from(await answer.arrayBuffer());
    if (req.method === 'PUT' && req.url!.endsWith('/seen')) {
      confirmed = true;
      return;
    }
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const child = execFile(process.execPath, [BIN, 'pr', 'wait', String(n), '--timeout', '20s'], {
    cwd,
    env: { ...process.env, GALLEY_URL: `http://localhost:${(proxy.address() as AddressInfo).port}`, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' },
  });
  let stdout = '';
  child.stdout!.on('data', (d) => (stdout += d));
  try {
    await until(() => confirmed, 'the confirmation reaches the server');
    await until(() => stdout, 'the wait prints what it got');
    return stdout;
  } finally {
    child.kill();
    proxy.closeAllConnections();
    proxy.close();
  }
}

test('pr wait says the reviewer agents are done before it confirms that it said so', async () => {
  const { stage } = await scratchRepo('handover');
  const pr = await stage('handover');
  const head = execFileSync('git', ['-C', join(dir, 'handover'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Stopped while it waits for the answer, the agent was told all the same.
  assert.match(await waitLosingSeen(join(dir, 'handover'), pr.number), new RegExp(`^No reviewer agent reviews ${head.slice(0, 7)}; ask the user to review it: `));
  // The server will not say it again.
  const res = await fetch(`${server.url}/api/repos/acme/handover/pulls/${pr.number}/wait?timeout=1`, { headers: { 'x-galley-actor': 'agent' } });
  assert.equal((await res.json()).status, 'timeout');
});

test('pr wait says the pull request was published before it confirms that it said so', async () => {
  const { api, stage } = await scratchRepo('published-notice');
  const pr = await stage('published-notice');
  await human('POST', `${api}/${pr.number}/publish`, {});
  assert.match(await waitLosingSeen(join(dir, 'published-notice'), pr.number), /^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
  const res = await fetch(`${server.url}${api}/${pr.number}/wait?timeout=1`, { headers: { 'x-galley-actor': 'agent' } });
  assert.equal((await res.json()).status, 'timeout');
});

test('auto-publish stays on when the server restarts', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/auto-restart');
  writeFileSync(join(repo, 'restart.js'), 'export {};\n');
  git('add', 'restart.js');
  git('commit', '-qm', 'Add restart');
  const data = mkdtempSync(join(tmpdir(), 'galley-auto-restart-'));
  const options = { port: 0, dataDir: data, ghBin: join(dir, 'gh'), codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 };
  const json = { 'content-type': 'application/json' };
  const first = await startServer(options);
  t.after(async () => {
    await first.close();
    rmSync(data, { recursive: true, force: true });
  });
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Published after a restart', head: 'feature/auto-restart', base: 'main' }),
    })
  ).json();
  assert.equal((await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}/auto-publish`, { method: 'PUT', headers: json, body: '{}' })).status, 200);
  await first.close();
  const second = await startServer(options);
  try {
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    assert.equal((await (await fetch(api)).json()).auto_publish.enabled_by.login, 'reviewer');
    // The agent waits on the new server, which publishes.
    const r = await (await fetch(`${api}/wait?timeout=10`, { headers: { 'x-galley-actor': 'agent' } })).json();
    assert.equal(r.status, 'published');
    const timeline = await (await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/timeline`)).json();
    assert.equal(timeline.findLast((e: any) => e.event === 'published').auto, true);
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('the CLI starts a server when none is running', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const url = `http://localhost:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'galley-autostart-'));
  try {
    const r = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, GALLEY_URL: url, GALLEY_HOME: home, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '' } });
    assert.match(r.stderr, new RegExp(`Started the galley server at ${url}`));
    // It keeps running after the command that started it.
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
  } finally {
    // Stopped also when an assert failed, as long as it answers.
    const health = await fetch(`${url}/api/health`).then((res) => res.json(), () => null);
    if (health?.pid) process.kill(health.pid);
    rmSync(home, { recursive: true, force: true });
  }
  const off = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, GALLEY_URL: url, GALLEY_NO_AUTOSTART: '1' } }).catch((e) => e);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /not running/);
});

test('the server says it is galley, and serve says who has its port', async () => {
  assert.deepEqual(await (await fetch(`${server.url}/api/meta`)).json(), { name: 'galley', version: '0.1.0' });
  const home = mkdtempSync(join(tmpdir(), 'galley-taken-'));
  const other = createHttpServer((req, res) => res.end('hello'));
  try {
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    // Its data in a directory of its own, should it start after all.
    const env = { ...process.env, GALLEY_HOME: home, GALLEY_CONFIG_DIR: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home };
    const serve = (port: string) => exec(process.execPath, [BIN, 'serve', '--port', port], { env, timeout: 20_000 }).catch((e) => e);
    const port = new URL(server.url).port;
    const running = await serve(port);
    assert.equal(running.code, 1);
    assert.match(running.stderr, new RegExp(`galley is already running at http://localhost:${port}`));
    const taken = await serve(String((other.address() as AddressInfo).port));
    assert.equal(taken.code, 1);
    assert.match(taken.stderr, /port \d+ is taken by another program\. Run galley on another port with GALLEY_PORT=<port> or --port, and set GALLEY_PORT for your agents too\./);
  } finally {
    other.close();
    rmSync(home, { recursive: true, force: true });
  }
});
