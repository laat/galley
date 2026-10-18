// After publishing, a branch that moved or was rewritten on GitHub: the push is refused, galley
// fetches the branch, and pushes what the author rebases onto it.
import '../helpers/env.ts';
import { git, human, remote, server, startHarness } from '../helpers/harness.ts';
import { madeOnGithub, published } from '../helpers/pushes.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

startHarness();

test('a branch that moved or was rewritten on GitHub is not overwritten: galley fetches it, and pushes what the author rebases onto it', async (t) => {
  await t.test('a branch that moved on GitHub is not overwritten: the author and the reviewer hear why, it is not tried again, and galley fetches the branch', async () => {
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
  });

  await t.test('a branch rewritten on GitHub is fetched, and the commits the author rebases onto it go on top of it, but not a merge of it, nor once it moved again', async () => {
    const pr = await published('feature/push-rewritten', { sign: true });
    const ref = 'origin/feature/push-rewritten';
    // GitHub's "Update with rebase", or a force-push there: a copy of the commit galley pushed (a signed copy of `since`), which the branch no longer has.
    const at = pr.tip().sha;
    const since = git('rev-parse', 'HEAD');
    const theirs = madeOnGithub(at, git('rev-parse', 'main'), 'Add push-rewritten.js, rebased');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-rewritten', theirs]);
    const mine = pr.commit('export const rewritten = 1;\n');
    let r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /stale info/);
    const told = `The branch on GitHub was rewritten there, and galley fetched it into ${ref}. Rebase the commits you made after ${since.slice(0, 7)} onto it, leaving out the ones before (\`git rebase --onto ${ref} ${since.slice(0, 7)}\`), and wait: galley pushes them on top of it. Do not merge ${ref} in`;
    assert.ok(r.stdout.includes(told), r.stdout);
    assert.equal(git('rev-parse', `refs/remotes/${ref}`), theirs);
    assert.deepEqual((await pr.pushes()).at(-1).fetched, { ref, sha: theirs, rewritten: true, since });

    // Merged in, the commit the rewrite removed would come back: refused before any push, also when publishing by hand.
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    const merge = git('rev-parse', '--short=7', 'HEAD');
    r = await pr.wait();
    const refusal = `The branch on GitHub was rewritten there (galley fetched it into ${ref} at ${theirs.slice(0, 7)}), and this head has a commit the rewrite removed, which pushing it would bring back: ${since.slice(0, 7)}.`;
    assert.ok(r.stdout.includes(`Could not push ${merge} to GitHub: ${refusal}`), r.stdout);
    assert.ok(r.stdout.includes(told), r.stdout);
    assert.equal(pr.tip().sha, theirs);
    const refused = (await pr.pushes()).at(-1);
    assert.deepEqual([refused.result, refused.retry, refused.fetched], ['failed', false, { ref, sha: theirs, rewritten: true, since }]);
    const byHand = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: true, force: true }) });
    assert.equal(byHand.status, 409);
    assert.equal((await byHand.json()).message, refusal);
    assert.equal(pr.tip().sha, theirs);

    // Rebased onto it without the commit from before, but the branch moved again on GitHub after the fetch: the lease on what galley fetched refuses it,
    // and the author's own commits now start after what it rebased onto.
    git('reset', '-q', '--hard', mine);
    git('rebase', '-q', '--onto', ref, since);
    const rebased = git('rev-parse', '--short=7', 'HEAD');
    const again = madeOnGithub(theirs, theirs, 'Commit suggestion');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-rewritten', again]);
    r = await pr.wait();
    assert.match(r.stdout, new RegExp(`^Could not push ${rebased} to GitHub: git push failed \\(the branch on GitHub changed since it was last published[^]*stale info`, 'm'));
    assert.equal(pr.tip().sha, again);
    const moved = (await pr.pushes()).at(-1);
    assert.deepEqual([moved.result, moved.before, moved.force, moved.fetched], ['failed', theirs, false, { ref, sha: again, rewritten: true, since: theirs }]);

    // Rebased onto where it is now: pushed on top of it, GitHub's commits as they are and the agent's signed, as the publish was.
    git('rebase', '-q', ref);
    const next = git('rev-parse', '--short=7', 'HEAD');
    r = await pr.wait();
    assert.match(r.stdout, new RegExp(`^Pushed ${next} to GitHub`, 'm'));
    const tip = pr.tip();
    assert.deepEqual([tip.signed, tip.parent], [true, again]);
    const pushed = (await pr.pushes()).at(-1);
    assert.deepEqual([pushed.result, pushed.before, pushed.force, pushed.signed, pushed.rewritten], ['pushed', again, false, 1, { from: at, to: again }]);
    // The user sees that it went on top of a rewritten branch.
    assert.match(await pr.page(), new RegExp(`Pushed an update to <a [^>]*>acme/widgets#7</a> at <code>${tip.sha.slice(0, 7)}</code> \\(signed 1 commit\\) on top of the branch rewritten on GitHub from <code>${at.slice(0, 7)}</code> to <code>${again.slice(0, 7)}</code> when`));

    // A remote-tracking branch merely behind what galley pushed (one git push does not move) is not taken for a rewrite.
    git('update-ref', `refs/remotes/${ref}`, again);
    const last = pr.commit('export const rewritten = 2;\n');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${last} to GitHub`, 'm'));
    assert.equal(pr.tip().parent, tip.sha);
  });

  await t.test('rewritten again before galley could push: the author rebases what it made after the first rewrite, and a merge that brings that one back is refused', async () => {
    const pr = await published('feature/push-twice');
    const ref = 'origin/feature/push-twice';
    const at = pr.tip().sha;
    const rewrite = (message: string) => {
      const sha = madeOnGithub(at, git('rev-parse', 'main'), message);
      execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-twice', sha]);
      return sha;
    };
    const first = rewrite('Add push-twice.js, rebased');
    pr.commit('export const twice = 1;\n');
    assert.match((await pr.wait()).stdout, /stale info/);
    // The agent rebases onto the first rewrite, but GitHub is rewritten again before its push.
    git('rebase', '-q', '--onto', ref, at);
    const mine = git('rev-parse', 'HEAD');
    const second = rewrite('Add push-twice.js, rebased again');
    let r = await pr.wait();
    assert.match(r.stdout, /stale info/);
    assert.ok(r.stdout.includes(`\`git rebase --onto ${ref} ${first.slice(0, 7)}\``), r.stdout);
    assert.deepEqual((await pr.pushes()).at(-1).fetched, { ref, sha: second, rewritten: true, since: first });

    // Merged in, the first rewrite would come back: refused.
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    r = await pr.wait();
    assert.ok(r.stdout.includes(`and this head has a commit the rewrite removed, which pushing it would bring back: ${first.slice(0, 7)}.`), r.stdout);
    assert.equal(pr.tip().sha, second);

    // Rebased as told: pushed on top of the second rewrite.
    git('reset', '-q', '--hard', mine);
    git('rebase', '-q', '--onto', ref, first);
    const next = git('rev-parse', '--short=7', 'HEAD');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${next} to GitHub`, 'm'));
    assert.equal(pr.tip().parent, second);
    assert.deepEqual((await pr.pushes()).at(-1).rewritten, { from: at, to: second });
  });

  await t.test('rewritten, and reset there to what galley pushed before galley could push: a merge that brings the rewrite back is refused', async () => {
    const pr = await published('feature/push-reset');
    const ref = 'origin/feature/push-reset';
    const at = pr.tip().sha;
    const first = madeOnGithub(at, git('rev-parse', 'main'), 'Add push-reset.js, rebased');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-reset', first]);
    pr.commit('export const reset = 1;\n');
    assert.match((await pr.wait()).stdout, /stale info/);
    // The agent rebases onto the rewrite, but GitHub is reset to what galley pushed before its push.
    git('rebase', '-q', '--onto', ref, at);
    const mine = git('rev-parse', 'HEAD');
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-reset', at]);
    let r = await pr.wait();
    assert.ok(r.stdout.includes(`\`git rebase --onto ${ref} ${first.slice(0, 7)}\``), r.stdout);
    assert.deepEqual((await pr.pushes()).at(-1).fetched, { ref, sha: at, rewritten: true, since: first });

    // Merged in, the rewrite would come back: refused.
    git('merge', '-q', '-s', 'ours', '--no-edit', ref);
    r = await pr.wait();
    assert.ok(r.stdout.includes(`(galley fetched it into ${ref} at ${at.slice(0, 7)}), and this head has a commit the rewrite removed, which pushing it would bring back: ${first.slice(0, 7)}.`), r.stdout);
    assert.equal(pr.tip().sha, at);

    // Rebased as told: pushed on top of what galley pushed, which no rewrite replaced in the end.
    git('reset', '-q', '--hard', mine);
    git('rebase', '-q', '--onto', ref, first);
    const next = git('rev-parse', '--short=7', 'HEAD');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${next} to GitHub`, 'm'));
    assert.equal(pr.tip().parent, at);
    const pushed = (await pr.pushes()).at(-1);
    assert.deepEqual([pushed.before, pushed.rewritten], [at, undefined]);
  });
});
