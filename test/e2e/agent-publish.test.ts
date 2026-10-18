// The author agent publishes when the user asks it to: now, or with auto-publish, which then
// publishes as the agent. Other agents are refused, and the timeline names the agent.
import '../helpers/env.ts';
import { cli, dir, git, human, inClone, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../../src/server/service.ts';

startHarness();

test('the author agent publishes its own pull request', async (t) => {
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
    return {
      n: String(number),
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      event: async (type: string) => (await human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`)).findLast((e: any) => e.event === type),
      created: () => existsSync(join(dir, 'gh.log')) && new RegExp(`^pr create .* --head ${branch} `, 'm').test(readFileSync(join(dir, 'gh.log'), 'utf8')),
    };
  };
  const url = 'https://github.com/acme/widgets/pull/7';
  /** The agent's name as the timeline shows it, before what it did. */
  const agent = '<a class="author" href="#" title="agent">agent</a><span class="Label Label--bot">bot</span>';

  await t.test('now, and the timeline names it', async () => {
    const pr = await stage('feature/agent-now');
    const r = await cli(['pr', 'publish', pr.n]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), url);
    const published = await pr.event('published');
    assert.deepEqual([published.actor.login, published.auto, published.signed], ['agent', false, 1]);
    assert.ok((await pr.page()).includes(`${agent} published this pull request to <a href="${url}"`));
    // Its wait says so, without saying the user is done with it.
    const waited = await cli(['pr', 'wait', pr.n, '--timeout', '20s']);
    assert.equal(waited.code, 0, waited.stderr);
    assert.match(waited.stdout, new RegExp(`^Published to GitHub: ${url}\n`, 'm'));
    assert.match(waited.stdout, /^Its review in galley is over\.$/m);
  });

  await t.test('with auto-publish and auto-merge, which publish as it once the reviewer agents are done, with the merge method it named', async () => {
    const pr = await stage('feature/agent-auto');
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
      try {
        // Not the merge method in settings (squash).
        const on = await cli(['pr', 'publish', pr.n, '--auto', '--auto-merge', 'rebase']);
        assert.equal(on.code, 0, on.stderr);
        assert.match(on.stderr, /will be published when the reviewer agents are done and the author has answered them, with auto-merge on GitHub/);
        const { autoPublishRequest } = JSON.parse((await cli(['pr', 'view', pr.n, '--json', 'autoPublishRequest'])).stdout);
        assert.deepEqual(
          { ...autoPublishRequest, enabledAt: undefined },
          { enabledAt: undefined, enabledBy: { login: 'agent', is_bot: true }, sign: true, draft: false, force: true, autoMerge: 'rebase' },
        );
        assert.ok((await pr.page()).includes(`${agent} enabled auto-publish (signed, with force if needed, with auto-merge (rebase) on GitHub)`));

        // Codex reviews when the agent waits, and finds nothing; nobody asks the user to review.
        const reviewed = await cli(['pr', 'wait', pr.n, '--timeout', '20s']);
        assert.equal(reviewed.code, 0, reviewed.stderr);
        assert.match(reviewed.stdout, /Looks right\./);
        assert.doesNotMatch(reviewed.stdout, /ask the user to review/);
        assert.equal(pr.created(), false);
        // The next wait is the one auto-publish publishes during, as the agent: it hears of it at
        // once, not only when it times out, though the agent made no change of its own.
        const start = Date.now();
        const published = await cli(['pr', 'wait', pr.n, '--timeout', '30s']);
        assert.equal(published.code, 0, published.stderr);
        assert.ok(Date.now() - start < 20_000, `the wait heard of the publish after ${Date.now() - start} ms`);
        assert.match(published.stdout, new RegExp(`^Published to GitHub: ${url}\n`, 'm'));
        const event = await pr.event('published');
        assert.deepEqual([event.actor.login, event.auto], ['agent', true]);
        const merge = await pr.event('auto_merge_enabled');
        assert.deepEqual([merge.actor.login, merge.method], ['agent', 'rebase']);
        assert.ok(readFileSync(join(dir, 'gh.log'), 'utf8').includes(`pr merge ${url} --auto --rebase --match-head-commit `));
        const page = await pr.page();
        assert.ok(page.includes(`${agent} published this pull request to <a href="${url}"`));
        assert.match(page, /\(signed 1 commit\) with auto-publish/);
        assert.ok(page.includes(`${agent} enabled auto-merge (rebase) on <a`));
      } finally {
        await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
      }
    });
  });

  await t.test('not by another agent, nor a reviewer agent', async () => {
    const pr = await stage('feature/agent-other');
    for (const [args, what] of [
      [[], 'publish it'],
      [['--auto'], 'turn on auto-publish'],
      [['--disable-auto'], 'turn off auto-publish'],
    ] as const) {
      const r = await cli(['pr', 'publish', pr.n, ...args], { actor: 'observer' });
      assert.equal(r.code, 1, what);
      assert.match(r.stderr, new RegExp(`only the user or the author of this pull request \\(agent\\) can ${what}, not observer`));
    }
    // A reviewer agent's name is refused at the API, and its actor in Service.
    const named = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-galley-actor': 'codex-review' }, body: '{}' });
    assert.equal(named.status, 409);
    const s = server.service;
    const x = await s.ctx('acme', 'widgets', Number(pr.n));
    const reviewer = s.codex!.actor();
    for (const f of [() => s.publish(x, { sign: false }, reviewer), () => s.enableAutoPublish(x, { sign: false }, reviewer), async () => s.disableAutoPublish(x, reviewer)]) {
      await assert.rejects(f(), (e) => e instanceof HttpError && e.status === 403);
    }
    assert.equal(pr.created(), false);
    assert.equal((await human('GET', pr.base)).auto_publish, null);
  });

  await t.test('and hears what to do when signing fails', async () => {
    const pr = await stage('feature/agent-signing');
    // Signing fails as 1Password's op-ssh-sign does: a prompt nobody answered, then a key it does not have.
    const program = join(dir, 'failing-ssh-keygen');
    /** Make signing fail with `message`, or sign without one. */
    const fail = (message?: string) => {
      const failing = message ? `if [ "$1 $2" = "-Y sign" ]; then echo "${message}" >&2; exit 1; fi\n` : '';
      writeFileSync(program, `#!/bin/sh\n${failing}exec ssh-keygen "$@"\n`);
      chmodSync(program, 0o755);
    };
    inClone('config', 'gpg.ssh.program', program);
    try {
      fail('1Password: failed to fill whole buffer');
      const unanswered = await cli(['pr', 'publish', pr.n, '-R', 'acme/widgets', '--auto-merge', 'rebase']);
      assert.equal(unanswered.code, 1);
      assert.match(unanswered.stderr, /signing commit [0-9a-f]{7} failed/);
      assert.ok(
        unanswered.stderr.includes(`Nothing was published. Turn on auto-publish with \`galley pr publish s${pr.n} -R acme/widgets --auto --auto-merge rebase\` and wait: it publishes once it can, and tries signing again over the next hour. Or tell the user.`),
        unanswered.stderr,
      );
      fail('1Password: No SSH private key found for the specified public key');
      const noKey = await cli(['pr', 'publish', pr.n]);
      assert.equal(noKey.code, 1);
      assert.match(noKey.stderr, /Nothing was published\. Trying again fails the same way: tell the user\.$/m);
      assert.equal(pr.created(), false);

      // Published, auto-publish is no more, and the next wait would push as the last publish did: the user's to decide.
      fail();
      assert.equal((await cli(['pr', 'publish', pr.n])).code, 0);
      writeFileSync(join(repo, 'agent-signing.js'), 'export const again = 1;\n');
      git('commit', '-qam', 'Change agent-signing.js');
      fail('1Password: failed to fill whole buffer');
      const update = await cli(['pr', 'publish', pr.n, '--sign', '--auto-merge']);
      assert.equal(update.code, 1);
      assert.ok(
        update.stderr.includes(`Nothing was published. Tell the user, and run \`galley pr publish s${pr.n} --sign --auto-merge\` again when they can answer the signing prompt.`),
        update.stderr,
      );
    } finally {
      inClone('config', '--unset', 'gpg.ssh.program');
    }
  });
});
