// The desktop app's notifications: which pull requests are the user's turn, and which became it.
import '../../test/helpers/env.ts';
import { human, scratchRepo, server, startHarness } from '../../test/helpers/harness.ts';
import { until } from '../../test/helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { follow } from '../live.ts';
import { Turns, yourTurns, type YourTurn } from '../turns.ts';

startHarness();

const turn = (id: number): YourTurn => ({ id, repo: 'acme/widgets', number: id, title: `Pull ${id}`, path: `/acme/widgets/pull/${id}`, reasons: '' });

/** Turns over a list the test sets, with what it said. */
function following(load: () => Promise<YourTurn[]>) {
  const told: YourTurn[] = [];
  let lists = 0;
  const turns = new Turns(load, { list: () => lists++, turned: (t) => told.push(t) });
  return { turns, told, turned: () => told.map((t) => t.id), lists: () => lists };
}

test('tells once of each pull request that becomes your turn, and not of those that were', async () => {
  let list = [turn(1)];
  const { turns, turned } = following(async () => list);
  // The first look only says what is.
  await turns.refresh();
  assert.deepEqual(turned(), []);
  assert.deepEqual(turns.list, [turn(1)]);
  list = [turn(1), turn(2)];
  await turns.refresh();
  assert.deepEqual(turned(), [2]);
  // Other changes to them tell nothing more.
  await turns.refresh();
  assert.deepEqual(turned(), [2]);
  // Your turn again after the agent's is a new change.
  list = [turn(1)];
  await turns.refresh();
  list = [turn(1), turn(2)];
  await turns.refresh();
  assert.deepEqual(turned(), [2, 2]);
});

test('a fetch that fails changes nothing, and what changed meanwhile is told once one works', async () => {
  let list: YourTurn[] | null = [turn(1)];
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
  assert.deepEqual(turned(), [3]);
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
  const { turns, told, lists } = following(() => yourTurns(server.url));
  const refresh = () => void turns.refresh();
  const live = follow(server.url, { up: refresh, down() {}, change: refresh });
  try {
    await until(() => lists() > 0, 'the first look');
    assert.deepEqual(turns.list, []);
    const { id, number } = await stage('notify');
    await until(() => told.length > 0, 'it is told');
    assert.deepEqual({ ...told[0], reasons: undefined }, { id, repo: fullName, number, title: 'Add notify', path: `/${fullName}/pull/${number}`, reasons: undefined });
    assert.match(told[0].reasons, /^agent is not waiting/);
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
