// After publishing, a head that would bring back a commit a rewrite on GitHub removed: refused,
// also in its signed copies, unless the user brings it back from the publish box.
import '../helpers/env.ts';
import { cli, dir, git, human, inClone, remote, send, server, startHarness } from '../helpers/harness.ts';
import { madeOnGithub, published } from '../helpers/pushes.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../../src/server/service.ts';

startHarness();

test('a head that would bring back what a rewrite on GitHub removed is refused, unless the user brings it back from the publish box', async (t) => {
  await t.test('signed, a head whose signed copies would bring back a commit the rewrite removed is refused too', async () => {
    const pr = await published('feature/push-recopied', { sign: true });
    const ref = 'origin/feature/push-recopied';
    const at = pr.tip().sha;
    // Someone force-pushes the unsigned commit to GitHub, and a commit on top: the signed copy galley pushed is gone.
    git('push', '-q', '--force', remote, 'HEAD:refs/heads/feature/push-recopied');
    const theirs = madeOnGithub(at, git('rev-parse', 'HEAD'), 'Commit suggestion');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-recopied', theirs]);
    // The agent's commit is signed on top of the signed copy, and then refused.
    pr.commit('export const recopied = 1;\n');
    assert.match((await pr.wait()).stdout, /stale info/);
    // Merged in, the head has nothing the rewrite removed, but signing reuses that copy, which is on top of what it removed.
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    const merge = git('rev-parse', '--short=7', 'HEAD');
    const r = await pr.wait();
    const refusal = `The branch on GitHub was rewritten there (galley fetched it into ${ref} at ${theirs.slice(0, 7)}), and its signed copies have a commit the rewrite removed, which pushing it would bring back: ${at.slice(0, 7)}.`;
    assert.ok(r.stdout.includes(`Could not push ${merge} to GitHub: ${refusal}`), r.stdout);
    assert.equal(pr.tip().sha, theirs);
    // The publish box finds it in the copies too, as publishing would.
    assert.ok((await pr.page()).includes(`would bring back a commit the rewrite removed: <code>${at.slice(0, 7)}</code>.`));
  });

  await t.test('only the user, from the publish box, can publish a head that brings back what the rewrite removed: not an agent, a CLI caller claiming to be the user, nor auto-publish', async () => {
    const pr = await published('feature/push-back');
    const ref = 'origin/feature/push-back';
    const at = pr.tip().sha;
    const theirs = madeOnGithub(at, git('rev-parse', 'main'), 'Add push-back.js, rebased');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-back', theirs]);
    pr.commit('export const back = 1;\n');
    assert.match((await pr.wait()).stdout, /stale info/);
    // The agent merges the rewritten branch in, which its wait refuses.
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    const merge = git('rev-parse', 'HEAD');
    assert.match((await pr.wait()).stdout, new RegExp(`^Could not push ${merge.slice(0, 7)} to GitHub: The branch on GitHub was rewritten there`, 'm'));

    // The publish box says so before any click: which commit, from which rewrite, and a box to bring it back, not a force-push.
    let page = await pr.page();
    const note = `The branch on GitHub was rewritten from <code>${at.slice(0, 7)}</code> to <code>${theirs.slice(0, 7)}</code> (galley fetched it into <code>${ref}</code>), and pushing this head would bring back a commit the rewrite removed: <code>${at.slice(0, 7)}</code>.`;
    assert.ok(page.includes(note), page);
    assert.ok(page.includes(`<input type="checkbox" name="bring_back" data-values="${at}"> Bring back the commit the rewrite removed</label>`), page);
    assert.match(page, /<label class="js-force-option" hidden>/);

    // The author agent, which may publish, is refused, through the CLI, also claiming to be the user, and through the API without the page's Origin, whoever it says it is.
    const asked = ['api', '-X', 'POST', `repos/acme/widgets/pulls/${pr.n}/publish`, '-F', 'sign=false', '-f', `bring_back[]=${at}`];
    const agent = await cli(asked);
    assert.notEqual(agent.code, 0);
    assert.match(agent.stderr, /only the user can bring back commits a rewrite on GitHub removed, from the publish box/);
    const claiming = await cli(asked, { actor: 'reviewer' });
    assert.notEqual(claiming.code, 0);
    assert.match(claiming.stderr, /only the user can bring back commits a rewrite on GitHub removed, from the publish box/);
    const publish = (headers: Record<string, string>, body: unknown = { sign: false, bring_back: [at] }) =>
      fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    for (const headers of [{}, { 'x-galley-actor': 'reviewer', 'x-galley-actor-type': 'User', origin: server.url }] as Record<string, string>[]) {
      const r = await publish(headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    // So is a caller inside the server that passes the user but not the page, and auto-publish.
    const s = server.service;
    const x = await s.ctx('acme', 'widgets', Number(pr.n));
    await assert.rejects(s.publish(x, { sign: false, bringBack: [at] }, s.viewer()), (e) => e instanceof HttpError && e.status === 403);
    await assert.rejects(s.publish(x, { sign: false, bringBack: [at], page: true, approval: 'its approval' }, s.viewer()), (e) => e instanceof HttpError && /^auto-publish never brings back/.test(e.message));
    assert.equal(pr.tip().sha, theirs);

    // The user at the page, without checking the box: refused, with what it would bring back.
    const unchecked = await publish({ origin: server.url }, { sign: false, bring_back: false });
    assert.equal(unchecked.status, 409);
    assert.deepEqual((await unchecked.json()).bring_back, [at]);
    assert.equal(pr.tip().sha, theirs);
    // Checked: published on top of the rewritten branch, with the commit back, as the timeline says.
    const checked = await publish({ origin: server.url });
    assert.equal(checked.status, 200, await checked.text());
    assert.equal(pr.tip().sha, merge);
    const event = (await human('GET', `/api/repos/acme/widgets/issues/${pr.n}/timeline`)).findLast((e: any) => e.event === 'published');
    assert.deepEqual([event.rewritten, event.brought_back, event.force], [{ from: at, to: theirs }, [at], false]);
    page = await pr.page();
    assert.match(page, new RegExp(`published an update to <a [^>]*>acme/widgets#7</a> at <code>${merge.slice(0, 7)}</code> on top of the branch rewritten on GitHub from <code>${at.slice(0, 7)}</code> to <code>${theirs.slice(0, 7)}</code>, and brought back 1 commit the rewrite on GitHub removed \\(<code>${at.slice(0, 7)}</code>\\) <relative-time `));
    assert.ok(!page.includes(note));
  });

  await t.test('signed, a head that brought in the rewritten branch before galley fetched it is signed again on top of it when the user brings back what the rewrite removed', async () => {
    const branch = 'feature/push-early';
    const pr = await published(branch, { sign: true });
    const ref = `origin/${branch}`;
    const at = pr.tip().sha;
    const since = git('rev-parse', 'HEAD');
    const theirs = madeOnGithub(at, git('rev-parse', 'main'), 'Add push-early.js, rebased');
    execFileSync('git', ['--git-dir', remote, 'update-ref', `refs/heads/${branch}`, theirs]);
    // The agent fetches the rewritten branch itself and merges it in before it waits: signing copies GitHub's commit too, and the lease refuses the push.
    pr.commit('export const early = 1;\n');
    git('fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${ref}`);
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    assert.match((await pr.wait()).stdout, /stale info/);
    // It adds a commit, which it sends without waiting with it.
    pr.commit('export const early = 2;\n');
    await send(branch);

    // The user brings back what the rewrite removed, but signing fails after the merge was signed again, before the commit on top was.
    const back = /name="bring_back" data-values="([0-9a-f ]+)"/.exec(await pr.page())![1].split(' ');
    assert.deepEqual([...back].sort(), [at, since].sort());
    const publish = () => fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url }, body: JSON.stringify({ sign: true, bring_back: back }) });
    const once = join(dir, 'signed-once');
    const program = join(dir, 'once-ssh-keygen');
    writeFileSync(program, `#!/bin/sh\nif [ -f "${once}" ]; then exit 1; fi\ntouch "${once}"\nexec ssh-keygen "$@"\n`);
    chmodSync(program, 0o755);
    inClone('config', 'gpg.ssh.program', program);
    try {
      const failed = await publish();
      assert.match((await failed.json()).message, /^signing commit [0-9a-f]{7} failed/);
    } finally {
      inClone('config', '--unset', 'gpg.ssh.program');
      for (const f of [once, program]) rmSync(f, { force: true });
    }
    assert.equal(pr.tip().sha, theirs);

    // Again: signed again on top of GitHub's commit as it is, and pushed on top of it.
    const r = await publish();
    assert.equal(r.status, 200, await r.text());
    const tip = pr.tip();
    const [mine, onTop] = execFileSync('git', ['--git-dir', remote, 'rev-list', '--parents', '-n', '1', tip.parent!], { encoding: 'utf8' }).trim().split(' ').slice(1);
    assert.deepEqual([tip.signed, onTop, execFileSync('git', ['--git-dir', remote, 'rev-parse', `${mine}^`], { encoding: 'utf8' }).trim()], [true, theirs, at]);
    // The ref that keeps the signed copies from garbage collection moved on to the commit pushed, from the copy signed again and the failed signing alike.
    assert.equal(inClone('rev-parse', `refs/galley/${server.service.db.instance}/pull/${pr.n}/published`), tip.sha);
    const event = (await human('GET', `/api/repos/acme/widgets/issues/${pr.n}/timeline`)).findLast((e: any) => e.event === 'published');
    assert.deepEqual([[...event.brought_back].sort(), event.rewritten, event.force], [[at, since].sort(), { from: at, to: theirs }, false]);
  });
});
