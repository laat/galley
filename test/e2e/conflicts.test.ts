// Conflicts with the base branch, and fetching the base branches from GitHub.
import '../helpers/env.ts';
import { cli, dir, gitToGalley, human, scratchRepo, server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Repo } from '../../src/server/git.ts';

startHarness();

/** git in galley's clone of the repository `fullName`. */
function inClone(fullName: string) {
  const [owner, name] = fullName.split('/');
  const gitDir = server.service.gitDir(server.service.repo(owner, name));
  return (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' }).trim();
}

/**
 * main as it is in the scratch repository at `g`, pushed to GitHub and fetched by galley, as it
 * fetches the base when a page opens: the base moved on GitHub.
 */
async function baseMoved(fullName: string, g: (...args: string[]) => string): Promise<void> {
  g('push', '-q', '--force', 'origin', 'main');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  const [owner, name] = fullName.split('/');
  await server.service.fetchBases(server.service.repo(owner, name), { base: 'main' });
}

test('a pull request that conflicts with its base: the reviewer sees it, the author is told to rebase, and auto-publish waits', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('conflicts');
  const moved = () => baseMoved(fullName, g);
  const agent = { 'content-type': 'application/json', 'x-galley-actor': 'agent' };
  /** Hold up the checks for conflicts, as a slow git would, until the function returned is called. */
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.service.conflictChecks = server.service.conflictChecks.then(() => held);
    return release;
  };
  /** Stage `branch`, made from `from` with `file` (a.js) changed to `text`, as the agent. */
  const stage = async (branch: string, from: string, text: string, file = 'a.js') => {
    g('checkout', '-q', '-b', branch, from);
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file} in ${branch}`);
    await send(branch);
    const res = await fetch(server.url + api, { method: 'POST', headers: agent, body: JSON.stringify({ title: `Set a in ${branch}`, head: branch, base: 'main', automatic_reviews: false }) });
    assert.equal(res.status, 201);
    const { id, number } = await res.json();
    return {
      n: String(number),
      row: () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id),
      published: async () => (await human('GET', `/api/repos/${fullName}/issues/${number}/timeline`)).filter((e: any) => e.event === 'published').map((e: any) => e.source),
      page: async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text(),
      view: async () => JSON.parse((await cli(['pr', 'view', String(number), '--json', 'mergeable,mergeStateStatus,baseConflicts'], { cwd: path })).stdout),
      json: () => human('GET', `${api}/${number}`),
      wait: () => cli(['pr', 'wait', String(number), '--timeout', '20s'], { cwd: path }),
    };
  };
  const pr = await stage('shared', 'main', 'export const a = 1;\n');

  await t.test('a head that merges cleanly says so', async () => {
    await until(async () => (await pr.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    assert.deepEqual(await pr.view(), { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: false, files: [], messages: [], behindBy: 0 } });
    assert.match(await pr.page(), new RegExp(`<strong>This branch has no conflicts with <span class="branch-name branch-name-sm">origin/main</span></strong><div class="color-fg-muted">Checked against <code>${g('rev-parse', '--short=7', 'main')}</code>`));
    const first = await pr.wait();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    assert.doesNotMatch(first.stdout, /This branch conflicts/);
  });

  await t.test('the base moves while the author waits: the wait says the head conflicts', async () => {
    const waiting = pr.wait();
    await until(async () => (await pr.json()).author_waiting, 'the author waits');
    // Another pull request is merged, and fetched: main changes the same line.
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'a.js'), 'export const a = 2;\n');
    g('commit', '-qam', 'Set a to 2');
    await moved();
    const told = await waiting;
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.match(told.stdout, /Rebase onto origin\/main, resolve the conflicts and run the tests, then run `galley pr wait s\d+` again\./);
    assert.deepEqual(await pr.view(), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: true, files: ['a.js'], messages: [], behindBy: 1 } });
    assert.match((await cli(['pr', 'view', pr.n], { cwd: path })).stdout, /^conflicts:\twith origin\/main in a\.js; rebase onto origin\/main\.$/m);
  });

  await t.test('the reviewer sees the conflict, and that the author is rebasing', async () => {
    const { turn } = await pr.json();
    assert.equal(turn.whose, 'author');
    assert.equal(turn.reasons[0].text, 'agent is working on the feedback');
    assert.equal(turn.reasons.find((r: any) => r.kind === 'conflicts').text, 'conflicts with origin/main in a.js');
    const list = await (await fetch(`${server.url}/${fullName}`)).text();
    assert.match(list, /<span class="turn-reason"><svg class="octicon octicon-alert[^>]*>.*?<\/svg>conflicts with origin\/main in a\.js<\/span>/);
    const box = await pr.page();
    assert.match(box, /<strong>This branch has conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong>/);
    assert.match(box, /conflicts in 1 file\. agent was told to rebase it\./);
    assert.match(box, new RegExp(`<a href="/${fullName}/pull/${pr.n}/files#diff-[0-9a-f]+"><code>a\\.js</code></a>`));
    // Said once per commit: the author waiting again without a rebase is not told again.
    const again = await fetch(`${server.url}${api}/${pr.n}/wait?timeout=1`, { headers: agent });
    assert.equal((await again.json()).status, 'timeout');
  });

  await t.test('a head that conflicts when staged: the first wait says so, before the reviewer agents are done', async () => {
    // Until it is known, the wait does not say the reviewer agents are done.
    const release = hold();
    let late: Awaited<ReturnType<typeof stage>>;
    try {
      late = await stage('late', 'main~1', 'export const a = 3;\n');
      const early = await fetch(`${server.url}${api}/${late.n}/wait?timeout=1`, { headers: agent });
      assert.equal((await early.json()).status, 'timeout');
    } finally {
      release();
    }
    const first = await late.wait();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.doesNotMatch(first.stdout, /ask the user/);
    // The author waits again without rebasing: the reviewer is asked, and still hears of the conflict.
    const second = await late.wait();
    assert.match(second.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.\nNo reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    await human('PATCH', `${api}/${late.n}`, { state: 'closed' });
  });

  await t.test('auto-publish waits for the rebase', async () => {
    await human('PUT', `${api}/${pr.n}/auto-publish`, {});
    const publishing = pr.wait();
    await until(async () => (await pr.json()).author_waiting, 'the author waits');
    assert.equal(server.service.autoPublishReady(pr.row()), false);
    assert.match(await pr.page(), /Conflicts with origin\/main: nothing is published until agent rebases it/);
    // The agent rebases onto main, resolving the conflict.
    g('checkout', '-q', 'shared');
    g('reset', '-q', '--hard', 'main');
    writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
    g('commit', '-qam', 'Set a to 1');
    await send('shared');
    const published = await publishing;
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /^Published to GitHub: /m);
    assert.doesNotMatch(published.stdout, /This branch conflicts/);
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/conflicts --base main --head shared /m);
    // Only the rebased head was published.
    assert.deepEqual(await pr.published(), [g('rev-parse', 'shared')]);
  });

  await t.test('auto-publish goes by the answer for the base as it is now, not as it was', async () => {
    const moving = await stage('moving', 'main', 'export const a = 4;\n');
    await until(async () => (await moving.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    const release = hold();
    let waiting: ReturnType<typeof moving.wait> | undefined;
    try {
      // main moves on to a commit that conflicts, and galley sees it while it works out the merge.
      g('checkout', '-q', 'main');
      writeFileSync(join(path, 'a.js'), 'export const a = 5;\n');
      g('commit', '-qam', 'Set a to 5');
      await moved();
      await server.service.sync(moving.row());
      await human('PUT', `${api}/${moving.n}/auto-publish`, {});
      waiting = moving.wait();
      await until(async () => (await moving.json()).author_waiting, 'the author waits');
      // All else is ready, but the answer for the old base does not count.
      assert.deepEqual(server.service.autoPublishChecklist(moving.row()).filter((i) => !i.ok).map((i) => i.key), ['conflicts']);
      assert.equal(server.service.autoPublishReady(moving.row()), false);
      const box = await moving.page();
      assert.match(box, /This branch has no conflicts with .*origin\/main has moved since; checking again\./);
      assert.match(box, /Checking for conflicts with main/);
    } finally {
      release();
    }
    const told = await waiting!;
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.deepEqual(await moving.published(), []);
    // The agent waits again without rebasing: the user's turn, and still while the conflict is
    // checked again for a base that moved since.
    const again = await fetch(`${server.url}${api}/${moving.n}/wait?timeout=1`, { headers: agent });
    assert.equal((await again.json()).status, 'timeout');
    assert.equal((await moving.json()).turn.whose, 'reviewer');
    const tip = g('rev-parse', 'main');
    const releaseAgain = hold();
    try {
      g('checkout', '-q', 'main');
      writeFileSync(join(path, 'moved.js'), 'export const moved = 1;\n');
      g('add', 'moved.js');
      g('commit', '-qm', 'Add moved.js');
      await moved();
      await server.service.sync(moving.row());
      assert.deepEqual(server.service.autoPublishChecklist(moving.row()).find((i) => i.key === 'conflicts'), { key: 'conflicts', blocking: true, ok: false, failed: false, text: 'Checking for conflicts with main' });
      assert.equal((await moving.json()).turn.whose, 'reviewer');
    } finally {
      releaseAgain();
      // main as the tests below expect it.
      g('reset', '-q', '--hard', tip);
      await moved();
    }
    await human('PATCH', `${api}/${moving.n}`, { state: 'closed' });
  });

  await t.test('a check git could not do holds up auto-publish, says why, and is tried again', async () => {
    const retried = await stage('retried', 'main', 'export const a = 5;\nexport const b = 1;\n');
    await until(async () => (await retried.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    // A setting git merge-tree can not use makes it fail, in galley's clone; nothing else reads it.
    const clone = inClone(fullName);
    clone('config', 'merge.conflictStyle', 'bogus');
    try {
      await human('PUT', `${api}/${retried.n}/auto-publish`, {});
      writeFileSync(join(path, 'b.js'), 'export const b = 2;\n');
      g('add', 'b.js');
      g('commit', '-qm', 'Add b');
      const publishing = retried.wait();
      await until(async () => /Could not check for conflicts with/.test(await retried.page()), 'the failed check is shown');
      await until(async () => (await retried.json()).author_waiting, 'the author waits');
      assert.deepEqual(server.service.autoPublishChecklist(retried.row()).filter((i) => !i.ok).map((i) => i.key), ['conflicts']);
      assert.equal(server.service.autoPublishReady(retried.row()), false);
      const box = await retried.page();
      assert.match(box, /<pre class="merge-error">git merge-tree failed: error: unknown style /);
      assert.match(box, /Could not check for conflicts with origin\/main: git merge-tree failed: error: unknown style /);
      assert.deepEqual(await retried.published(), []);
      // Fixed, the next poll tries again, finds nothing in the way, and auto-publish publishes.
      clone('config', '--unset', 'merge.conflictStyle');
      const published = await publishing;
      assert.match(published.stdout, /^Published to GitHub: /m);
      assert.deepEqual(await retried.published(), [g('rev-parse', 'retried')]);
    } finally {
      // Unset already, unless an assertion failed first.
      try {
        clone('config', '--unset', 'merge.conflictStyle');
      } catch {}
    }
  });

  await t.test('a commit sent that conflicts wakes the waiting author, with nothing else asking about the new head', async () => {
    // From before main set a to 5, with a file of its own: it merges cleanly.
    const pushed = await stage('pushed', 'main~1', 'export const c = 1;\n', 'c.js');
    const first = await pushed.wait();
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    // No reviewer agent and no auto-publish: only the push can bring news of the new head, and
    // the author does not wake for its own push.
    const waiting = cli(['pr', 'wait', pushed.n, '--timeout', '10s'], { cwd: path });
    await until(async () => (await pushed.json()).author_waiting, 'the author waits');
    writeFileSync(join(path, 'a.js'), 'export const a = 7;\n');
    g('commit', '-qam', 'Set a to 7');
    await send('pushed');
    const told = await waiting;
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    await human('PATCH', `${api}/${pushed.n}`, { state: 'closed' });
  });

  await t.test('a conflict told along with an approval is the author\'s to rebase, and its turn', async () => {
    const approved = await stage('approved', 'main', 'export const d = 1;\n', 'd.js');
    const first = await approved.wait();
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    // The reviewer approves, and main adds a d.js of its own before the author waits again.
    await human('POST', `${api}/${approved.n}/reviews`, { event: 'APPROVE' });
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'd.js'), 'export const d = 2;\n');
    g('add', 'd.js');
    g('commit', '-qm', 'Add d');
    await moved();
    await until(async () => (await approved.view()).mergeable === 'CONFLICTING', 'it conflicts with main');
    const waited = approved.row().author_waited_at;
    const told = await approved.wait();
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^reviewer reviewed: approved /m);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in d\.js; rebase onto origin\/main\.$/m);
    assert.match(told.stdout, /^Rebase onto origin\/main, resolve the conflicts and run the tests, then run `galley pr wait s\d+` again\.$/m);
    assert.doesNotMatch(told.stdout, /nothing left open/);
    // The wait that hands it the conflict is not an action on it: it is the author's turn until it acts.
    assert.equal(approved.row().author_waited_at, waited);
    const { turn } = await approved.json();
    assert.equal(turn.whose, 'author');
    assert.equal(turn.reasons[0].text, 'agent is working on the feedback');
    await human('PATCH', `${api}/${approved.n}`, { state: 'closed' });
  });

  await t.test('a conflict in no file, such as a directory renamed two ways, is a conflict all the same', async () => {
    g('checkout', '-q', 'main');
    mkdirSync(join(path, 'old'));
    writeFileSync(join(path, 'old', 'a.js'), 'export {};\n');
    writeFileSync(join(path, 'old', 'b.js'), 'export {};\n');
    g('add', 'old');
    g('commit', '-qm', 'Add old');
    await moved();
    // The branch moves old/a.js to left/ and old/b.js to right/: no one place old/ went.
    g('checkout', '-q', '-b', 'split');
    mkdirSync(join(path, 'left'));
    mkdirSync(join(path, 'right'));
    g('mv', 'old/a.js', 'left/a.js');
    g('mv', 'old/b.js', 'right/b.js');
    g('commit', '-qm', 'Split old');
    await send('split');
    const res = await fetch(server.url + api, { method: 'POST', headers: agent, body: JSON.stringify({ title: 'Split old', head: 'split', base: 'main', automatic_reviews: false }) });
    const { number } = await res.json();
    const n = String(number);
    const view = async () => JSON.parse((await cli(['pr', 'view', n, '--json', 'mergeable,mergeStateStatus,baseConflicts'], { cwd: path })).stdout);
    await until(async () => (await view()).mergeable === 'MERGEABLE', 'the split merges cleanly at first');
    // main adds a file to old/, which git can not tell where to put.
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'old', 'new.js'), 'export {};\n');
    g('add', 'old');
    g('commit', '-qm', 'Add old/new.js');
    await moved();
    await until(async () => (await view()).mergeable === 'CONFLICTING', 'the split conflicts with main');
    const said = 'CONFLICT (directory rename split): Unclear where to rename old to; it was renamed to multiple other directories, with no destination getting a majority of the files.';
    assert.deepEqual(await view(), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: true, files: [], messages: [said], behindBy: 1 } });
    const told = await cli(['pr', 'wait', n, '--timeout', '10s'], { cwd: path });
    assert.equal(told.code, 0, told.stderr);
    assert.ok(told.stdout.includes(`This branch conflicts with origin/main; rebase onto origin/main. git says: ${said}\n`), told.stdout);
    const box = await (await fetch(`${server.url}/${fullName}/pull/${n}`)).text();
    assert.match(box, /<strong>This branch has conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong>\s*<div class="color-fg-muted">Merging it into <code>[0-9a-f]{7}<\/code>, its tip in this repository, conflicts\. /);
    assert.ok(box.includes(`<span>${said}</span>`), 'git says why in the merge box');
    const { turn } = await human('GET', `${api}/${n}`);
    assert.equal(turn.reasons.find((r: any) => r.kind === 'conflicts').text, 'conflicts with origin/main');
    // Auto-publish does not take it for clean.
    await human('PUT', `${api}/${n}/auto-publish`, {});
    assert.equal(server.service.autoPublishReady(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', (await human('GET', `${api}/${n}`)).id)), false);
    await human('PATCH', `${api}/${n}`, { state: 'closed' });
  });
});

/** Run git in `cwd` as a developer, without signing. */
function gitIn(cwd: string) {
  return (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
}

/** Another clone of `bare`, where other pull requests are merged: `merge` commits a file on a branch there (main) and pushes it. */
function otherClone(bare: string, name: string) {
  const path = join(dir, name);
  execFileSync('git', ['clone', '-q', '-b', 'main', bare, path]);
  const g = gitIn(path);
  return (file: string, text: string, branch = 'main'): string => {
    g('checkout', '-q', branch);
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file}`);
    g('push', '-q', 'origin', branch);
    return g('rev-parse', 'HEAD');
  };
}

test('the base branch is fetched when a page opens, at most once a minute per repository, and right before publishing', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('fetched');
  const merge = otherClone(join(dir, 'fetched.git'), 'fetched-other');
  const clone = inClone(fullName);
  const tracking = () => clone('rev-parse', 'refs/remotes/origin/main');
  const stage = async (branch: string, file: string, text: string) => {
    g('checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file} in ${branch}`);
    await send(branch);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Set ${file}`, head: branch, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    const view = () => human('GET', `/api/repos/${fullName}/gh/pulls/${number}?fields=mergeable,mergeStateStatus,baseConflicts`);
    await until(async () => (await view()).mergeable === 'MERGEABLE', `${branch} merges cleanly into main`);
    return { n: number as number, view, page: async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text(), json: () => human('GET', `${api}/${number}`) };
  };
  const mine = await stage('mine', 'a.js', 'export const a = 1;\n');
  const theirs = await stage('theirs', 'c.js', 'export const c = 1;\n');
  const main = g('rev-parse', 'main');
  let merged = '';

  await t.test('opening a pull request fetches its base, and the merge box says how far behind it is', async () => {
    merged = merge('b.js', 'export const b = 1;\n');
    assert.equal(tracking(), main);
    await mine.page();
    await until(() => tracking() === merged, 'origin/main is fetched');
    await until(async () => (await mine.view()).mergeStateStatus === 'BEHIND', 'the head is behind the new base');
    assert.deepEqual(await mine.view(), {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      baseConflicts: { ref: 'origin/main', oid: merged, conflicting: false, files: [], messages: [], behindBy: 1 },
    });
    const json = await mine.json();
    assert.deepEqual([json.mergeable, json.mergeable_state], [true, 'behind']);
    // For information only: nobody is asked to rebase it.
    assert.equal(json.turn.reasons.find((r: any) => r.kind === 'conflicts'), undefined);
    const box = await mine.page();
    assert.match(box, /<strong>1 commit behind <span class="branch-name branch-name-sm">origin\/main<\/span>, no conflicts<\/strong>/);
    // A fetch that worked says nothing: its time would be out of date by the next one.
    assert.match(box, new RegExp(`Checked against <code>${merged.slice(0, 7)}</code>, its tip in this repository\\.</div>`));
    assert.doesNotMatch(box, /data-confirm/);
    // Only origin/main moved, in galley's clone: no FETCH_HEAD there, and nothing in the agent's repository.
    assert.equal(existsSync(join(clone('rev-parse', '--absolute-git-dir'), 'FETCH_HEAD')), false);
    assert.equal(g('rev-parse', 'refs/remotes/origin/main'), main);
  });

  await t.test('pages opened again, of any pull request in the repository, wait a minute to fetch', async () => {
    merge('a.js', 'export const a = 2;\n');
    for (const pr of [mine, theirs, mine]) await pr.page();
    // The poll would have seen a fetch by now.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(tracking(), merged);
    assert.equal((await mine.view()).mergeable, 'MERGEABLE');
  });

  await t.test('publishing fetches first, and a head that conflicts takes a second click', async () => {
    const expected = (await mine.page()).match(/name="expected" value="([^"]+)"/)![1];
    const refused = await fetch(`${server.url}${api}/${mine.n}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected, sign: false }) });
    assert.equal(refused.status, 428);
    assert.deepEqual(await refused.json(), {
      message: 'This branch conflicts with origin/main in a.js: GitHub can not merge it until the conflicts are resolved.',
      status: '428',
      acknowledge: ['during_conflict'],
    });
    assert.notEqual(tracking(), merged);
    const box = await mine.page();
    assert.match(box, /class="btn btn-primary btn-publish" data-confirm="Click again to publish anyway" data-acknowledge="during_conflict"/);
    assert.match(box, /GitHub can not merge it until the conflicts are resolved, so publishing takes a second click\./);
    const url = `${server.url}/${fullName}/pull/${mine.n}`;
    const asked = await cli(['pr', 'publish', url, '--no-sign'], { actor: 'reviewer' });
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, new RegExp(`in a\\.js: GitHub can not merge it until the conflicts are resolved\\.\\nRun \`galley pr publish s${mine.n} --during-conflict\` to publish anyway\\.`));
    const published = await cli(['pr', 'publish', url, '--no-sign', '--during-conflict'], { actor: 'reviewer' });
    assert.equal(published.code, 0, published.stderr);
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/fetched --base main --head mine /m);
    assert.equal((await mine.json()).staging_state, 'published');
    await human('PATCH', `${api}/${theirs.n}`, { state: 'closed' });
  });
});

test('publishing fetches its base also while a fetch of the other base branches runs', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('releases');
  g('push', '-q', 'origin', 'main:release');
  g('update-ref', 'refs/remotes/origin/release', 'main');
  // galley has it already, as staging onto it waits for the fetch held up below.
  await server.service.fetchBases(server.service.repo('acme', 'releases'), { base: 'release' });
  const merge = otherClone(join(dir, 'releases.git'), 'releases-other');
  const stage = async (branch: string, base: string, file: string) => {
    g('checkout', '-q', '-b', branch, `origin/${base}`);
    writeFileSync(join(path, file), `export const ${branch.replace('-', '_')} = 1;\n`);
    g('add', file);
    g('commit', '-qm', `Set ${file}`);
    await send(branch);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Set ${file}`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).number as number;
  };
  // Fetching main is held up, as a slow network would, until released.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const fetchBranch = Repo.prototype.fetchBranch;
  t.mock.method(Repo.prototype, 'fetchBranch', async function (this: Repo, ...args: Parameters<Repo['fetchBranch']>) {
    if (args[1] === 'main') await held;
    return fetchBranch.apply(this, args);
  });
  try {
    const onMain = await stage('on-main', 'main', 'b.js');
    // Opening its page starts fetching main, the only base so far.
    await fetch(`${server.url}/${fullName}/pull/${onMain}`);
    // A pull request into release is staged, and release moves on GitHub to a commit it conflicts with.
    const onRelease = await stage('on-release', 'release', 'a.js');
    merge('a.js', 'export const a = 2;\n', 'release');
    const publishing = fetch(`${server.url}${api}/${onRelease}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: false }) });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const refused = await publishing;
    assert.equal(refused.status, 428);
    assert.equal((await refused.json()).message, 'This branch conflicts with origin/release in a.js: GitHub can not merge it until the conflicts are resolved.');
  } finally {
    release();
  }
});

test('publishing fetches its own base alone, and a repository with nothing to fetch does not hold up the next fetch', async () => {
  const { fullName, api, path, g, send } = await scratchRepo('quiet');
  g('push', '-q', 'origin', 'main:release');
  g('update-ref', 'refs/remotes/origin/release', 'main');
  const merge = otherClone(join(dir, 'quiet.git'), 'quiet-other');
  const tracking = (base: string) => inClone(fullName)('rev-parse', `refs/remotes/origin/${base}`);
  const stage = async (branch: string, base: string, file: string) => {
    g('checkout', '-q', '-b', branch, `origin/${base}`);
    writeFileSync(join(path, file), 'export {};\n');
    g('add', file);
    g('commit', '-qm', `Add ${file}`);
    await send(branch);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${file}`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    return { n: number as number, page: () => fetch(`${server.url}/${fullName}/pull/${number}`).then((r) => r.text()) };
  };
  const intoRelease = await stage('into-release', 'release', 'r.js');
  const published = await stage('published', 'main', 'p.js');
  // Publishing fetches main, its base, and not release: a slow GitHub costs it one fetch.
  const before = tracking('release');
  merge('r2.js', 'export {};\n', 'release');
  const mainNow = merge('m.js', 'export {};\n');
  assert.equal((await human('POST', `${api}/${published.n}/publish`, { sign: false })).staging_state, 'published');
  assert.equal(tracking('main'), mainNow);
  assert.equal(tracking('release'), before);
  // With no pull request open, a page has nothing to fetch, and fetches nothing.
  await human('PATCH', `${api}/${intoRelease.n}`, { state: 'closed' });
  await human('PATCH', `${api}/${published.n}`, { state: 'closed' });
  await published.page();
  // So a pull request staged next is fetched when its page opens, not a minute later.
  const next = await stage('next', 'main', 'n.js');
  const merged = merge('m2.js', 'export {};\n');
  await next.page();
  await until(() => tracking('main') === merged, 'origin/main is fetched');
});

test('a page whose base is a branch staged here asks GitHub for it once a minute, and does not hold up fetching the bases staged after it', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('stacked');
  const asked: string[] = [];
  const fetchBranch = Repo.prototype.fetchBranch;
  t.mock.method(Repo.prototype, 'fetchBranch', function (this: Repo, ...args: Parameters<Repo['fetchBranch']>) {
    if (args[2].startsWith('refs/remotes/origin/') && this.gitDir.endsWith(`/${server.service.repo('acme', 'stacked').git_dir}`)) asked.push(args[1]);
    return fetchBranch.apply(this, args);
  });
  const row = server.service.repo('acme', 'stacked');
  const merge = otherClone(join(dir, 'stacked.git'), 'stacked-other');
  const stage = async (branch: string, base: string, from: string) => {
    g('checkout', '-q', '-b', branch, from);
    writeFileSync(join(path, `${branch}.js`), 'export {};\n');
    g('add', `${branch}.js`);
    g('commit', '-qm', `Add ${branch}.js`);
    await send(branch);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${branch}.js`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    return () => fetch(`${server.url}/${fullName}/pull/${number}`).then((r) => r.text());
  };
  // Stacked on a branch that is not on GitHub: its base is the branch sent to galley, which GitHub does not have.
  g('branch', 'stack', 'main');
  await send('stack');
  const onStack = await stage('on-stack', 'stack', 'stack');
  await onStack();
  await server.service.fetchBases(row);
  // Its page again: GitHub was asked a moment ago.
  await onStack();
  await server.service.fetchBases(row);
  assert.deepEqual(asked, ['stack']);
  const onMain = await stage('on-main', 'main', 'origin/main');
  const merged = merge('m.js', 'export {};\n');
  await onMain();
  await until(() => inClone(fullName)('rev-parse', 'refs/remotes/origin/main') === merged, 'origin/main is fetched');
});

test('a fetch that fails shows in the merge box, is logged once, and does not hold up publishing', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('unfetched');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a');
  await send('mine');
  const res = await fetch(server.url + api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
    body: JSON.stringify({ title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false }),
  });
  const { number } = await res.json();
  // main is gone from GitHub, so fetching it fails.
  execFileSync('git', ['--git-dir', join(dir, 'unfetched.git'), 'update-ref', '-d', 'refs/heads/main']);
  const clone = server.service.repo('acme', 'unfetched').git_dir;
  const errors = t.mock.method(console, 'error');
  const logged = () => errors.mock.calls.filter((c) => String(c.arguments[0]).startsWith(`could not fetch origin/main into ${clone}: `)).map((c) => c.arguments[0]);
  const page = async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text();
  await page();
  await until(async () => /Could not fetch origin\/main: /.test(await page()), 'the merge box says the fetch failed');
  assert.match(await page(), /<strong>This branch has no conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong><div class="color-fg-muted">Checked against <code>[0-9a-f]{7}<\/code>, its tip in this repository\. Could not fetch origin\/main: fatal: couldn&#39;t find remote ref refs\/heads\/main<\/div>/);
  const published = await human('POST', `${api}/${number}/publish`, { sign: false });
  assert.equal(published.staging_state, 'published');
  assert.deepEqual(logged(), [`could not fetch origin/main into ${clone}: fatal: couldn't find remote ref refs/heads/main`]);
});

test('a GitHub URL that git would turn into an ssh one is fetched over https with gh, and never over ssh', async () => {
  // GitHub's acme/sshremote, which the clone reaches at its https URL, turned into this path by the user's git config.
  const bare = join(dir, 'sshremote-on-github.git');
  const path = join(dir, 'sshremote');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = gitIn(path);
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', 'a.js');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', bare, 'main');
  g('remote', 'add', 'origin', 'https://github.com/acme/sshremote.git');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  // The user's git config, which the server's git reads.
  const global = (...args: string[]) => execFileSync('git', ['config', '--global', ...args]);
  global(`url.${bare}.insteadOf`, 'https://github.com/acme/sshremote.git');
  // ssh is a stand-in that says it ran: the agent behind the real one may ask for approval in a window.
  const sshLog = join(dir, 'ssh.log');
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\necho "$@" >> "${sshLog}"\nexit 255\n`);
  chmodSync(ssh, 0o755);
  global('core.sshCommand', ssh);
  try {
    const { full_name: fullName } = await human('POST', '/api/repos', { github: 'acme/sshremote' });
    g('checkout', '-q', '-b', 'mine');
    writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
    g('commit', '-qam', 'Set a');
    assert.equal((await gitToGalley(['push', `${server.url}/git/${fullName}.git`, 'mine'], { cwd: path })).code, 0);
    const res = await fetch(`${server.url}/api/repos/${fullName}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false }),
    });
    const { number } = await res.json();
    const page = async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text();
    const merged = otherClone(bare, 'sshremote-other')('b.js', 'export const b = 1;\n');

    // As some set up git: GitHub's https URLs turned into ssh ones. Also when the server was started
    // with ssh allowed, which git would put above its config.
    global('--unset', `url.${bare}.insteadOf`);
    global('url.ssh://git@github.com/.insteadOf', 'https://github.com/');
    process.env.GIT_ALLOW_PROTOCOL = 'ssh';
    try {
      await page();
      await until(async () => /Could not fetch origin\/main: fatal: transport &#39;ssh&#39; not allowed/.test(await page()), 'the fetch over ssh is refused');
    } finally {
      delete process.env.GIT_ALLOW_PROTOCOL;
    }
    assert.equal(existsSync(sshLog), false, 'ssh never ran');

    // Over https, which reaches the bare repository here, it is fetched.
    global('--unset', 'url.ssh://git@github.com/.insteadOf');
    global(`url.${bare}.insteadOf`, 'https://github.com/acme/sshremote.git');
    const every = server.service.fetchEveryMs;
    server.service.fetchEveryMs = 0;
    try {
      await page();
      await until(() => inClone(fullName)('rev-parse', 'refs/remotes/origin/main') === merged, 'origin/main is fetched over https');
    } finally {
      server.service.fetchEveryMs = every;
    }
    await until(async () => /1 commit behind .*, no conflicts/.test(await page()), 'the merge box has the fetched base');
    assert.doesNotMatch(await page(), /Could not fetch/);
    assert.equal(existsSync(sshLog), false, 'ssh never ran');
  } finally {
    for (const key of [`url.${bare}.insteadOf`, 'url.ssh://git@github.com/.insteadOf', 'core.sshCommand']) {
      try {
        global('--unset', key);
      } catch {}
    }
  }
});

test('the server fetches base branches on its timer, and a waiting author hears when its head conflicts with the new base', async () => {
  const bare = join(dir, 'timer.git');
  const path = join(dir, 'timer');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = gitIn(path);
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', 'a.js');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', bare, 'main');
  g('remote', 'add', 'origin', 'https://github.com/acme/timer.git');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  const merge = otherClone(bare, 'timer-other');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a');
  const head = g('rev-parse', 'HEAD');
  const timed = await startServer({ port: 0, dataDir: join(dir, 'timer-data'), ghBin: 'false', reviewersDir: join(dir, 'timer-data', 'reviewers'), viewerLogin: 'reviewer', pollMs: 50, followMs: 50, fetchMs: 100, githubUrl: () => bare });
  try {
    const agent = { 'content-type': 'application/json', 'x-galley-actor': 'agent' };
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(timed.url + p, { method, headers: agent, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      assert.ok(res.ok, `${method} ${p} -> ${res.status} ${text}`);
      return text ? JSON.parse(text) : null;
    };
    const { full_name } = await call('POST', '/api/repos', { github: 'acme/timer' });
    assert.equal((await gitToGalley(['push', `${timed.url}/git/${full_name}.git`, 'mine'], { cwd: path })).code, 0);
    const { number } = await call('POST', `/api/repos/${full_name}/pulls`, { title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false });
    const base = `/api/repos/${full_name}/pulls/${number}`;
    // The first wait hands the head to the reviewer; the author says so and waits again.
    const first = await call('GET', `${base}/wait?timeout=10`);
    assert.equal(first.status, 'agents_done');
    await call('PUT', `${base}/seen`, { at: first.seen_at, agents_done: first.agents_done.sha });
    const waiting = call('GET', `${base}/wait?timeout=10`);
    // Another pull request sets a too, and is merged on the remote. Nobody opens a page.
    const merged = merge('a.js', 'export const a = 2;\n');
    const told = await waiting;
    assert.equal(told.status, 'conflicts');
    assert.equal(told.conflicts, head);
    assert.deepEqual(told.pr.baseConflicts, { ref: 'origin/main', oid: merged, conflicting: true, files: ['a.js'], messages: [], behindBy: 1 });
  } finally {
    await timed.close();
  }
});

test('a published pull request that comes to conflict with its base: the author is told, rebases, and its next wait force-pushes the rebase', async (t) => {
  const { fullName, api, path, g, send } = await scratchRepo('republished');
  const bare = join(dir, 'republished.git');
  const merge = otherClone(bare, 'republished-other');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a to 1');
  await send('mine');
  const res = await fetch(server.url + api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
    body: JSON.stringify({ title: 'Set a to 1', head: 'mine', base: 'main', automatic_reviews: false }),
  });
  assert.equal(res.status, 201);
  const { id, number } = await res.json();
  const url = `${server.url}/${fullName}/pull/${number}`;
  // By its URL, which counts as the checkout's: its branch is sent from there.
  const wait = () => cli(['pr', 'wait', url, '--timeout', '20s'], { cwd: path });
  const json = () => human('GET', `${api}/${number}`);
  const page = async () => (await fetch(url)).text();
  const onGithub = () => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'mine'], { encoding: 'utf8' }).trim();
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  /** What GitHub says of the pull request: its branch's commit, and whether it merges; and galley asking it. */
  const githubSays = async (head: string, mergeable: 'MERGEABLE' | 'CONFLICTING') => {
    const node = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] }, headRefOid: head, mergeable, mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'BLOCKED', commits: { nodes: [] } };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${id}`]: node } } }));
    try {
      await server.service.followGithub();
    } finally {
      rmSync(join(dir, 'gh-pulls.json'), { force: true });
    }
  };
  await human('POST', `${api}/${number}/publish`, { sign: false });
  assert.match((await wait()).stdout, /^Published to GitHub: /m);
  const published = g('rev-parse', 'mine');
  assert.equal(onGithub(), published);

  await t.test('another pull request is merged into main: the waiting author is told to rebase', async () => {
    const waiting = wait();
    await until(async () => (await json()).author_waiting, 'the author waits');
    const merged = merge('a.js', 'export const a = 2;\n');
    // Opening the page fetches the base of the published pull request too.
    await page();
    await until(() => inClone(fullName)('rev-parse', 'refs/remotes/origin/main') === merged, 'origin/main is fetched');
    const told = await waiting;
    // And into the checkout's, from galley.
    assert.equal(g('rev-parse', 'refs/remotes/origin/main'), merged);
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.ok(told.stdout.includes(`Rebase onto origin/main, resolve the conflicts and run the tests, then run \`galley pr wait ${url}\` again: it force-pushes the rebase to GitHub.\nIt is published: commit and wait, and galley pushes each commit you wait with to GitHub. Never push to GitHub yourself.\n`), told.stdout);
    // galley's check is for the author; mergeability stays GitHub's to say, which it has not yet.
    const view = await human('GET', `/api/repos/${fullName}/gh/pulls/${number}?fields=mergeable,mergeStateStatus,baseConflicts`);
    assert.deepEqual(view, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', baseConflicts: { ref: 'origin/main', oid: merged, conflicting: true, files: ['a.js'], messages: [], behindBy: 1 } });
  });

  await t.test('it is the author\'s turn, and GitHub\'s word on the conflict gives way to galley\'s', async () => {
    await githubSays(published, 'CONFLICTING');
    const { turn } = await json();
    assert.equal(turn.whose, 'author');
    assert.equal(turn.reasons[0].text, 'agent is working on the feedback');
    assert.deepEqual(turn.reasons.filter((r: any) => r.kind === 'conflicts' || r.kind === 'github').map((r: any) => r.text), ['conflicts with origin/main in a.js']);
    const box = await page();
    assert.match(box, /<strong>This branch has conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong>/);
    assert.match(box, /conflicts in 1 file\. agent was told to rebase it\. GitHub can not merge it until the conflicts are resolved; agent&#39;s next wait pushes the rebase\./);
    assert.doesNotMatch(box, /on GitHub<\/strong>/);
    // Publishing by hand (a new title, say) does not ask about it: GitHub has the head already.
    assert.deepEqual(server.service.publishAsks(row()), []);
  });

  await t.test('the author rebases, and its next wait force-pushes the rebase', async () => {
    g('reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
    g('commit', '-qam', 'Set a to 1');
    const rebased = g('rev-parse', 'mine');
    const pushed = await wait();
    assert.equal(pushed.code, 0, pushed.stderr);
    assert.match(pushed.stdout, new RegExp(`^Force-pushed ${rebased.slice(0, 7)} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
    assert.doesNotMatch(pushed.stdout, /This branch conflicts/);
    assert.equal(onGithub(), rebased);
    const timeline = await human('GET', `/api/repos/${fullName}/issues/${number}/timeline`);
    const push = timeline.filter((e: any) => e.event === 'github_push').at(-1);
    assert.deepEqual([push.result, push.source, push.before, push.force], ['pushed', rebased, published, true]);
    assert.equal((await json()).turn.reasons.find((r: any) => r.kind === 'conflicts'), undefined);
  });

  await t.test('once the branch moves on GitHub, a conflict resolved there say, galley\'s check of the head gives way to GitHub\'s', async () => {
    const rebased = row().published_head_sha;
    // A commit made on GitHub: a merge of main that resolves the conflict below there.
    await githubSays('f'.repeat(40), 'MERGEABLE');
    const merged = merge('a.js', 'export const a = 3;\n');
    await server.service.fetchBases(server.service.repoById(row().repo_id), { base: 'main' });
    assert.equal(inClone(fullName)('rev-parse', 'refs/remotes/origin/main'), merged);
    await server.service.sync(row());
    await server.service.conflictChecks;
    const agent = { 'x-galley-actor': 'agent' };
    const quiet = await fetch(`${server.url}${api}/${number}/wait?timeout=1`, { headers: agent });
    assert.equal((await quiet.json()).status, 'timeout');
    assert.equal((await json()).turn.reasons.find((r: any) => r.kind === 'conflicts'), undefined);
    // GitHub's branch is the commit galley pushed after all: the conflict is the author's again.
    await githubSays(rebased, 'CONFLICTING');
    const told = await fetch(`${server.url}${api}/${number}/wait?timeout=5`, { headers: agent });
    assert.equal((await told.json()).status, 'conflicts');
    assert.deepEqual((await json()).turn.reasons.filter((r: any) => r.kind === 'conflicts' || r.kind === 'github').map((r: any) => r.text), ['conflicts with origin/main in a.js']);
  });
});
