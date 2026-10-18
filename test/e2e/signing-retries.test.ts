// Signing that fails for now, as when nobody answers a 1Password prompt: auto-publish and the pushes
// after publishing try again later, whether the agent still waits or not, up to the setting.
import '../helpers/env.ts';
import { cli, dir, git, human, remote, repo, server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRow } from '../../src/server/db.ts';
import { SIGNING_RETRY_MS } from '../../src/server/service.ts';

startHarness();

test('a signing that fails for now is tried again later, up to the limit', async (t) => {
  /** Stage a branch with one commit, as the agent. */
  const stage = async (branch: string) => {
    const file = `${branch.split('/').pop()}.js`;
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    const { id } = await human('GET', base);
    return {
      number,
      id,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      events: async (type: string): Promise<any[]> => (await human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`)).filter((e: any) => e.event === type),
      /** A new commit, as the agent; its short SHA. */
      commit: (text: string) => {
        writeFileSync(join(repo, file), text);
        git('commit', '-qam', `Change ${file}`);
        return git('rev-parse', '--short=7', 'HEAD');
      },
      /** Wait as the agent until `done`, then stop, as an agent whose session ended. */
      waitUntil: async (done: () => Promise<unknown>, what: string) => {
        const ctx = await server.service.ctx('acme', 'widgets', number);
        const stop = new AbortController();
        const waiting = server.service.wait(ctx, server.service.db.actorById(ctx.pull.author_id), 20_000, stop.signal);
        try {
          await until(done, what);
        } finally {
          stop.abort();
          await waiting;
        }
        await server.autoPublisher.settle(id);
      },
      created: () => existsSync(join(dir, 'gh.log')) && new RegExp(`^pr create .* --head ${branch} `, 'm').test(readFileSync(join(dir, 'gh.log'), 'utf8')),
    };
  };
  /**
   * Make signing fail the first `times` times from now with `message` on stderr, as 1Password's
   * op-ssh-sign does when nobody answers its prompt, and sign after that; with `gated`, once
   * `open()` is called. `tries()`: how many times signing was asked for since.
   */
  const failSigning = (times: number, message = '1Password: failed to fill whole buffer', { gated = false } = {}) => {
    const count = join(dir, 'sign-count');
    const gate = join(dir, 'sign-gate');
    const program = join(dir, 'failing-ssh-keygen');
    rmSync(count, { force: true });
    rmSync(gate, { force: true });
    rmSync(`${gate}.started`, { force: true });
    const wait = gated ? `  touch "${gate}.started"\n  while [ ! -f "${gate}" ]; do sleep 0.02; done\n` : '';
    writeFileSync(
      program,
      `#!/bin/sh\nif [ "$1 $2" = "-Y sign" ]; then\n  n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 ))\n  echo $n > "${count}"\n  if [ $n -le ${times} ]; then echo "${message}" >&2; exit 1; fi\n${wait}fi\nexec ssh-keygen "$@"\n`,
    );
    chmodSync(program, 0o755);
    git('config', 'gpg.ssh.program', program);
    return {
      tries: () => (existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0),
      started: () => existsSync(`${gate}.started`),
      open: () => writeFileSync(gate, ''),
    };
  };
  const comment = (number: number, body: string) => human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body });
  /** Make the retry of the latest signing failure of `type` due now. */
  const due = (id: number, type: 'auto_publish_retry' | 'github_push') => {
    const row = server.service.db.get<{ id: number }>('SELECT id FROM events WHERE pull_id = ? AND type = ? ORDER BY id DESC LIMIT 1', id, type)!;
    server.service.db.run("UPDATE events SET data = json_set(data, '$.signing.next_at', ?) WHERE id = ?", new Date().toISOString(), row.id);
  };
  const restore = async () => {
    // A gated signer still waiting goes on, and fails or signs a commit nobody waits for.
    writeFileSync(join(dir, 'sign-gate'), '');
    git('config', '--unset', 'gpg.ssh.program');
    server.service.signingRetryMs = SIGNING_RETRY_MS;
    await human('PUT', '/api/settings/publish', { signingRetries: 3 });
  };

  await t.test('auto-publish stays on and tries again later, also once the agent stopped waiting, and publishes', async () => {
    const pr = await stage('feature/sign-later');
    const signer = failSigning(2);
    server.service.signingRetryMs = 60_000;
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      await pr.waitUntil(async () => (await pr.events('auto_publish_retry')).length === 1, 'the first try fails');
      const [first] = await pr.events('auto_publish_retry');
      assert.equal(first.head, git('rev-parse', 'HEAD'));
      assert.match(first.error, /^signing commit [0-9a-f]{7} failed:\nerror: 1Password: failed to fill whole buffer$/);
      assert.deepEqual({ ...first.signing, next_at: undefined }, { why: '1Password prompt not answered', failures: 1, retries: 3, next_at: undefined });
      assert.ok(Math.abs(Date.parse(first.signing.next_at) - Date.parse(first.created_at) - 60_000) < 1000, first.signing.next_at);
      // Still on, and the merge box and the timeline say when it tries again, and which retry that is.
      assert.ok((await human('GET', pr.base)).auto_publish);
      const page = await pr.page();
      assert.match(page, /<strong>Auto-publish is on<\/strong>/);
      assert.match(page, /Signing failed <relative-time [^>]*>[^<]*<\/relative-time> \(1Password prompt not answered\); trying again at <time datetime="[^"]+"[^>]*>[^<]*\d\d:\d\d<\/time>, retry 1 of 3/);
      assert.match(page, /agent waited for review with this commit, with all feedback seen/);
      assert.match(page, /Auto-publish could not sign <code>[0-9a-f]{7}<\/code> \(1Password prompt not answered\) <relative-time [^]*?<\/relative-time>; it stays on and tries again at <time [^>]*>[^<]*<\/time>, retry 1 of 3/);
      // The agent stopped waiting, and nothing tries again before it is time.
      await server.autoPublisher.settle(pr.id);
      assert.deepEqual([signer.tries(), pr.created()], [1, false]);

      // Its time comes: it fails once more, and the retry after that publishes, with the agent away.
      server.service.signingRetryMs = 50;
      due(pr.id, 'auto_publish_retry');
      await until(async () => (await human('GET', pr.base)).staging_state === 'published', 'published');
      assert.equal(signer.tries(), 3);
      assert.deepEqual((await pr.events('auto_publish_retry')).map((e) => e.signing.failures), [1, 2]);
      const [published] = await pr.events('published');
      assert.deepEqual([published.auto, published.signed], [true, 1]);
      assert.equal((await human('GET', pr.base)).author_waiting, false);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    } finally {
      await restore();
    }
  });

  await t.test('after the last retry it turns itself off and says why, and the waiting agent asks the user', async () => {
    const pr = await stage('feature/sign-never');
    failSigning(1000);
    server.service.signingRetryMs = 20;
    try {
      assert.equal((await human('PUT', '/api/settings/publish', { signingRetries: 1 })).publish.signingRetries, 1);
      await human('PUT', `${pr.base}/auto-publish`, {});
      const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(r.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.deepEqual((await pr.events('auto_publish_retry')).map((e) => e.signing.failures), [1]);
      const [failed] = await pr.events('auto_publish_failed');
      assert.match(failed.error, /^signing commit [0-9a-f]{7} failed:\nerror: 1Password: failed to fill whole buffer$/);
      assert.deepEqual(failed.signing, { why: '1Password prompt not answered', failures: 2, retries: 1, next_at: null });
      const page = await pr.page();
      assert.match(page, /<strong>Auto-publish failed [^]*?Signing failed \(1Password prompt not answered\) after 1 retry, and it turned itself off\./);
      assert.match(page, /Auto-publish failed and turned itself off <relative-time [^]*?<\/relative-time>: signing failed \(1Password prompt not answered\) after 1 retry/);
      assert.equal(pr.created(), false);
    } finally {
      await restore();
    }
  });

  await t.test('a failure trying again can not get past turns it off at once', async () => {
    const pr = await stage('feature/sign-no-key');
    failSigning(1000, '1Password: No SSH private key found for the specified public key');
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(r.stdout, /ask the user to review it/);
      assert.deepEqual(await pr.events('auto_publish_retry'), []);
      const [failed] = await pr.events('auto_publish_failed');
      assert.deepEqual(failed.signing, { why: null, failures: 1, retries: 3, next_at: null });
      assert.match(await pr.page(), /Signing failed, in a way trying again can not get past, and it turned itself off\./);
    } finally {
      await restore();
    }
  });

  await t.test('feedback handed to the agent after signing failed holds the retry until the agent waits again', async () => {
    const pr = await stage('feature/sign-feedback');
    const signer = failSigning(1);
    server.service.signingRetryMs = 60_000;
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      await pr.waitUntil(async () => (await pr.events('auto_publish_retry')).length === 1, 'the first try fails');
      await comment(pr.number, 'Rename the file.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Rename the file\./);
      // Its time comes while the agent works on the feedback: nothing is published.
      due(pr.id, 'auto_publish_retry');
      server.autoPublisher.considerAll();
      await server.autoPublisher.settle(pr.id);
      assert.deepEqual([signer.tries(), pr.created()], [1, false]);
      assert.match(await pr.page(), /agent is working \(not waiting for review\)/);
      // The agent answers, and waits again: the retry publishes.
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
      assert.equal(signer.tries(), 2);
    } finally {
      await restore();
    }
  });

  await t.test('a new commit, or turning auto-publish off and on, starts the count again', async () => {
    const pr = await stage('feature/sign-count');
    failSigning(1000);
    server.service.signingRetryMs = 60_000;
    const failures = async () => (await pr.events('auto_publish_retry')).map((e) => e.signing.failures);
    try {
      await human('PUT', `${pr.base}/auto-publish`, {});
      await pr.waitUntil(async () => (await failures()).length === 1, 'the first try fails');
      // A second try, when its time comes.
      due(pr.id, 'auto_publish_retry');
      await until(async () => (await failures()).length === 2, 'the second try fails');
      await server.autoPublisher.settle(pr.id);
      assert.deepEqual(await failures(), [1, 2]);
      assert.match(await pr.page(), /retry 2 of 3/);
      // Turned off and on: a new approval, and no retry until the agent waits again.
      await human('DELETE', `${pr.base}/auto-publish`);
      await human('PUT', `${pr.base}/auto-publish`, {});
      assert.doesNotMatch(await pr.page(), /Signing failed/);
      await pr.waitUntil(async () => (await failures()).length === 3, 'the try under the new approval fails');
      assert.deepEqual(await failures(), [1, 2, 1]);
      // A new commit.
      const sha = pr.commit('export const value = 2;\n');
      await pr.waitUntil(async () => (await failures()).length === 4, 'the try of the new commit fails');
      const latest = (await pr.events('auto_publish_retry')).at(-1);
      assert.deepEqual([latest.head.slice(0, 7), latest.signing.failures], [sha, 1]);
    } finally {
      await human('DELETE', `${pr.base}/auto-publish`);
      await restore();
    }
  });

  await t.test('a push after publishing follows the same rule: tried again later whether the agent waits or not, and final after the limit or at once', async () => {
    const pr = await stage('feature/sign-push');
    await human('POST', `${pr.base}/publish`, { sign: true });
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    const tip = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/sign-push'], { encoding: 'utf8' }).trim();
    const failedPushes = async () => (await pr.events('github_push')).filter((e) => e.result === 'failed');
    const before = tip();
    let signer = failSigning(1);
    server.service.signingRetryMs = 60_000;
    try {
      // The agent waits with a commit; signing it fails for now. The agent hears nothing of it.
      const sha = pr.commit('export const pushed = 1;\n');
      await pr.waitUntil(async () => (await failedPushes()).length === 1, 'the push fails');
      const [push] = await failedPushes();
      assert.deepEqual([push.retry, push.signing.why, push.signing.failures, push.signing.retries], [true, '1Password prompt not answered', 1, 3]);
      assert.match(
        await pr.page(),
        /Signing failed \(1Password prompt not answered\)\. It is tried again at <time [^>]*>[^<]*<\/time>, retry 1 of 3, whether agent waits or not\. Publish the update yourself to push it now\./,
      );
      // Waiting again does not try it before its time, as each wait would have before.
      await pr.waitUntil(async () => true, 'the agent waits');
      assert.deepEqual([signer.tries(), tip()], [1, before]);
      // Its time comes, with the agent away: it is pushed, signed.
      due(pr.id, 'github_push');
      await until(() => tip() !== before, 'pushed');
      assert.equal(signer.tries(), 2);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));

      // Failing every time: after the last retry it is not tried again, and the waiting agent hears so.
      await human('PUT', '/api/settings/publish', { signingRetries: 1 });
      server.service.signingRetryMs = 20;
      signer = failSigning(1000);
      const next = pr.commit('export const pushed = 2;\n');
      const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(r.stdout, new RegExp(`^Could not push ${next} to GitHub: signing commit [0-9a-f]{7} failed:\nerror: 1Password: failed to fill whole buffer$`, 'm'));
      assert.match(r.stdout, /Signing it as the user failed; the user can publish it by hand\. Your next commit is pushed when you wait\./);
      assert.deepEqual(
        (await failedPushes()).slice(1).map((p) => [p.retry, p.signing.failures, p.signing.next_at === null]),
        [
          [true, 1, false],
          [false, 2, true],
        ],
      );
      assert.equal(signer.tries(), 2);
      assert.match(await pr.page(), /Signing failed \(1Password prompt not answered\) after 1 retry\. agent was told, and it is not tried again/);

      // A failure trying again can not get past is final at once.
      failSigning(1000, '1Password: No SSH private key found for the specified public key');
      pr.commit('export const pushed = 3;\n');
      const final = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(final.stdout, /^Could not push [0-9a-f]{7} to GitHub: signing commit/m);
      const last = (await failedPushes()).at(-1);
      assert.deepEqual([last.retry, last.signing], [false, { why: null, failures: 1, retries: 1, next_at: null }]);
      assert.match(await pr.page(), /Signing failed, in a way trying again can not get past\. agent was told/);
      const row = server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pr.id)!;
      assert.equal(server.service.pushReady(row), false);
    } finally {
      await restore();
    }
  });

  await t.test("a push's retry waits for the agent once it was handed feedback, and one that feedback stopped is tried again", async () => {
    const pr = await stage('feature/sign-push-feedback');
    await human('POST', `${pr.base}/publish`, { sign: true });
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    const tip = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/sign-push-feedback'], { encoding: 'utf8' }).trim();
    const before = tip();
    const signer = failSigning(1, undefined, { gated: true });
    server.service.signingRetryMs = 60_000;
    try {
      const sha = pr.commit('export const fed = 1;\n');
      await pr.waitUntil(async () => (await pr.events('github_push')).some((e) => e.result === 'failed'), 'the push fails');
      await comment(pr.number, 'Rename the file.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Rename the file\./);
      // Its time comes while the agent works on the feedback: nothing is pushed.
      due(pr.id, 'github_push');
      server.autoPublisher.considerAll();
      await server.autoPublisher.settle(pr.id);
      assert.deepEqual([signer.tries(), tip()], [1, before]);
      // The agent waits again, and the retry signs; feedback that comes meanwhile stops the push.
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signer.started, 'signing started');
      await comment(pr.number, 'One more thing.');
      assert.match((await waiting).stdout, /One more thing\./);
      signer.open();
      await server.autoPublisher.settle(pr.id);
      assert.equal(tip(), before);
      // The next wait tries it again.
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
      assert.notEqual(tip(), before);
    } finally {
      await restore();
    }
  });
});
