// The desktop app's open pull requests and notifications: whose turn each is, and which became the user's.
import '../../test/helpers/env.ts';
import { human, scratchRepo, server, startHarness } from '../../test/helpers/harness.ts';
import { until } from '../../test/helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { follow } from '../live.ts';
import { openPulls, Turns, type Pull } from '../turns.ts';

startHarness();

const turn = (id: number, whose: Pull['whose'] = 'reviewer'): Pull => ({
  id,
  repo: 'acme/widgets',
  number: id,
  title: `Pull ${id}`,
  path: `/acme/widgets/pull/${id}`,
  api: `/api/repos/acme/widgets/pulls/${id}`,
  published: null,
  whose,
  reasons: [],
  updated: `2026-10-18T10:00:0${id}.000Z`,
});

/** How long a turn has to stay the user's here, in place of NOTIFY_AFTER_MS. */
const DELAY_MS = 50;

/** Turns over a list the test sets, with what it said. */
function following(load: () => Promise<Pull[]>) {
  const told: Pull[] = [];
  let lists = 0;
  const turns = new Turns(load, { list: () => lists++, turned: (t) => told.push(t) }, DELAY_MS);
  return { turns, told, turned: () => told.map((t) => t.id), lists: () => lists };
}

test('tells once of each pull request that becomes your turn and stays so, and not of those that were', async () => {
  let list = [turn(1)];
  const { turns, turned } = following(async () => list);
  // The first look only says what is.
  await turns.refresh();
  assert.deepEqual(turned(), []);
  assert.deepEqual(turns.list, [turn(1)]);
  list = [turn(1), turn(2)];
  await turns.refresh();
  // Not at once: once it has been your turn for a while.
  assert.deepEqual(turned(), []);
  assert.deepEqual(turns.list, [turn(1), turn(2)]);
  await until(() => turned().length, 'it is told');
  assert.deepEqual(turned(), [2]);
  // Other changes to them tell nothing more.
  await turns.refresh();
  await sleep(DELAY_MS * 3);
  assert.deepEqual(turned(), [2]);
  // Your turn again after the agent's is a new change.
  list = [turn(1)];
  await turns.refresh();
  list = [turn(1), turn(2)];
  await turns.refresh();
  await until(() => turned().length > 1, 'it is told again');
  assert.deepEqual(turned(), [2, 2]);
});

test('tells nothing of a turn that is yours for less than the wait, or flips back and forth', async () => {
  let list: Pull[] = [];
  const { turns, turned, lists } = following(async () => list);
  await turns.refresh();
  // On its way from the agents to auto-publish, say.
  list = [turn(1)];
  await turns.refresh();
  list = [];
  await turns.refresh();
  for (let i = 0; i < 3; i++) {
    list = [turn(1)];
    await turns.refresh();
    await sleep(DELAY_MS / 5);
    list = [];
    await turns.refresh();
  }
  await sleep(DELAY_MS * 3);
  assert.deepEqual(turned(), []);
  // It looks again before it tells: gone by then, with no change heard of, it tells nothing either.
  list = [turn(2)];
  await turns.refresh();
  list = [];
  const before = lists();
  await until(() => lists() > before, 'it looks again');
  await sleep(DELAY_MS * 2);
  assert.deepEqual(turns.list, []);
  assert.deepEqual(turned(), []);
});

test("tells nothing of what you made your turn again yourself, by undoing its dismissal, also when a look had it already", async () => {
  let list: Pull[] = [];
  const { turns, turned } = following(async () => list);
  await turns.refresh();
  turns.madeYours(1);
  list = [turn(1)];
  await turns.refresh();
  // A look that had it before the Undo was heard of.
  list = [turn(1), turn(2)];
  await turns.refresh();
  turns.madeYours(2);
  await sleep(DELAY_MS * 3);
  assert.deepEqual(turned(), []);
  // Your turn again later, by something new, is told, also soon after the Undo a look had seen.
  list = [];
  await turns.refresh();
  list = [turn(1), turn(2)];
  await turns.refresh();
  await until(() => turned().length > 1, 'they are told');
  assert.deepEqual(turned().sort(), [1, 2]);
});

test('an Undo heard while a look from before it is in flight: that look takes it away, and the next brings it back, telling nothing', async () => {
  let list = [turn(1)];
  let release = () => {};
  let gate: Promise<void> | null = null;
  const { turns, turned } = following(async () => {
    const seen = list;
    await gate;
    return seen;
  });
  await turns.refresh();
  // Dismissed: the look that says so is in flight when the Undo is heard.
  list = [];
  gate = new Promise((resolve) => (release = resolve));
  const inFlight = turns.refresh();
  await sleep(10);
  turns.madeYours(1);
  release();
  await inFlight;
  gate = null;
  assert.deepEqual(turns.list, []);
  list = [turn(1)];
  await turns.refresh();
  await sleep(DELAY_MS * 3);
  assert.deepEqual(turned(), []);
});

test('a fetch that fails changes nothing, and what changed meanwhile is told once one works', async () => {
  let list: Pull[] | null = [turn(1)];
  const { turns, turned, lists } = following(async () => {
    if (!list) throw new Error('ECONNREFUSED');
    return list;
  });
  await turns.refresh();
  list = null;
  await turns.refresh();
  assert.equal(lists(), 1);
  assert.deepEqual(turns.list, [turn(1)]);
  list = [turn(1), turn(3)];
  await turns.refresh();
  await until(() => turned().length, 'it is told');
  assert.deepEqual(turned(), [3]);
  // The server away when it looks again: it looks again later, until it can.
  list = [turn(1)];
  await turns.refresh();
  list = [turn(1), turn(4)];
  await turns.refresh();
  list = null;
  await sleep(DELAY_MS * 3);
  assert.deepEqual(turned(), [3]);
  list = [turn(1), turn(4)];
  await until(() => turned().length > 1, 'it is told once it can look');
  assert.deepEqual(turned(), [3, 4]);
});

test('lists every open pull request, and tells only of those that become your turn, waiting longest first', async () => {
  let list = [turn(2), turn(1, 'reviewer_agents')];
  const { turns, turned } = following(async () => list);
  await turns.refresh();
  assert.deepEqual(turns.pulls, list);
  assert.deepEqual(turns.list, [turn(2)]);
  // The agents are done with it: it is your turn.
  list = [turn(1), turn(2)];
  await turns.refresh();
  assert.deepEqual(turns.list, [turn(1), turn(2)]);
  await until(() => turned().length, 'it is told');
  assert.deepEqual(turned(), [1]);
});

test('changes that come together make one fetch', async () => {
  let loads = 0;
  const { turns, lists } = following(async () => {
    loads++;
    return [];
  });
  for (let i = 0; i < 5; i++) turns.soon(20);
  await until(() => lists() > 0, 'it looks');
  turns.soon(20);
  await until(() => lists() > 1, 'it looks again');
  assert.equal(loads, 2);
});

test('fetches one at a time, and once more for the changes during one', async () => {
  let loads = 0;
  let release = () => {};
  const { turns } = following(async () => {
    loads++;
    if (loads === 1) await new Promise<void>((r) => (release = r));
    return [];
  });
  const first = turns.refresh();
  void turns.refresh();
  void turns.refresh();
  release();
  await first;
  assert.equal(loads, 2);
});

test("from galley's live updates: a staged pull request that becomes your turn is told once, with its title and why", async () => {
  const { stage, fullName } = await scratchRepo('desktop');
  const { turns, told, lists } = following(() => openPulls(server.url));
  const refresh = () => void turns.refresh();
  const live = follow(server.url, { up: refresh, down() {}, change: refresh });
  try {
    await until(() => lists() > 0, 'the first look');
    assert.deepEqual(turns.list, []);
    const { id, number } = await stage('notify');
    await until(() => told.length > 0, 'it is told');
    assert.deepEqual(
      { ...told[0], reasons: undefined, updated: undefined },
      { id, repo: fullName, number, title: 'Add notify', path: `/${fullName}/pull/${number}`, api: `/api/repos/${fullName}/pulls/${number}`, published: null, whose: 'reviewer', reasons: undefined, updated: undefined },
    );
    assert.match(told[0].reasons[0].text, /^agent is not waiting/);
    // Your comment changes it, but it stays your turn: nothing more is told.
    const before = lists();
    await human('POST', `/api/repos/${fullName}/issues/${number}/comments`, { body: 'Looks fine.' });
    await until(() => lists() > before, 'it looks again');
    await turns.refresh();
    assert.equal(told.length, 1);
    assert.equal(turns.list.length, 1);
  } finally {
    live.stop();
  }
});

test("one request lists every repository's open pull requests, latest update first, with whose turn each is", async () => {
  const a = await scratchRepo('desktop-a');
  const b = await scratchRepo('desktop-b');
  const first = await a.stage('first');
  const closed = await a.stage('closed');
  await human('PATCH', `/api/repos/${a.fullName}/pulls/${closed.number}`, { state: 'closed' });
  const second = await b.stage('second');
  const pulls = (await openPulls(server.url)).filter((p) => [a.fullName, b.fullName].includes(p.repo));
  assert.deepEqual(
    pulls.map((p) => ({ id: p.id, repo: p.repo, number: p.number, path: p.path, whose: p.whose })),
    [
      { id: second.id, repo: b.fullName, number: second.number, path: `/${b.fullName}/pull/${second.number}`, whose: 'reviewer' },
      { id: first.id, repo: a.fullName, number: first.number, path: `/${a.fullName}/pull/${first.number}`, whose: 'reviewer' },
    ],
  );
});
