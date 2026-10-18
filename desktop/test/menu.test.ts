// The desktop app's menu-bar status: the count, and the menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trayMenu, trayTitle, trayToolTip, type MenuActions } from '../menu.ts';
import type { YourTurn } from '../turns.ts';

const retry: YourTurn = { id: 1, repo: 'acme/widgets', number: 4, title: 'Add retry to the uploader', path: '/acme/widgets/pull/4', reasons: 'agent is waiting for review · 2 unresolved threads' };
const long: YourTurn = { id: 2, repo: 'acme/app', number: 12, title: 'A title much longer than a menu should be wide, which the menu cuts short', path: '/acme/app/pull/12', reasons: 'approved' };

function actions() {
  const done: string[] = [];
  const a: MenuActions = {
    open: (path) => done.push(`open ${path ?? '(as it was)'}`),
    setOpenAtLogin: (on) => done.push(`start at login ${on}`),
    quit: () => done.push('quit'),
  };
  return { a, done };
}

test('the menu lists the pull requests where it is your turn, by repository, number and title, and opens each', () => {
  const { a, done } = actions();
  const items = trayMenu({ status: null, turns: [retry, long], openAtLogin: false }, a);
  assert.deepEqual(
    items.map((i) => i.label ?? i.type),
    [
      'Your turn',
      'acme/widgets s#4  Add retry to the uploader',
      'acme/app s#12  A title much longer than a menu should be wide, which the m…',
      'separator',
      'Open galley',
      'Start at login',
      'separator',
      'Quit galley',
    ],
  );
  assert.equal(items[0].enabled, false);
  assert.equal(items[1].toolTip, 'agent is waiting for review · 2 unresolved threads');
  for (const i of items) i.click?.();
  assert.deepEqual(done, ['open /acme/widgets/pull/4', 'open /acme/app/pull/12', 'open (as it was)', 'start at login true', 'quit']);
});

test('Start at login shows whether it is on, and only where the app can start at login', () => {
  const { a, done } = actions();
  const on = trayMenu({ status: null, turns: [], openAtLogin: true }, a).find((i) => i.label === 'Start at login')!;
  assert.equal(on.type, 'checkbox');
  assert.equal(on.checked, true);
  on.click!();
  assert.deepEqual(done, ['start at login false']);
  assert.equal(
    trayMenu({ status: null, turns: [], openAtLogin: null }, a).some((i) => i.label === 'Start at login'),
    false,
  );
});

test('the menu says when nothing waits, and why galley is not there', () => {
  const { a } = actions();
  assert.deepEqual(
    trayMenu({ status: null, turns: [], openAtLogin: null }, a).map((i) => i.label ?? i.type),
    ['Nothing waits for you', 'separator', 'Open galley', 'separator', 'Quit galley'],
  );
  // What it knew before galley went away stays, under why.
  const away = trayMenu({ status: 'galley is not running at http://localhost:24823', turns: [retry], openAtLogin: null }, a);
  assert.deepEqual(
    away.map((i) => i.label ?? i.type),
    ['galley is not running at http://localhost:24823', 'Your turn', 'acme/widgets s#4  Add retry to the uploader', 'separator', 'Open galley', 'separator', 'Quit galley'],
  );
  assert.equal(away[0].enabled, false);
});

test('next to the icon, how many wait for you; on hover, what that means', () => {
  assert.equal(trayTitle([]), '');
  assert.equal(trayTitle([retry, long]), '2');
  assert.equal(trayToolTip({ status: null, turns: [] }), 'galley');
  assert.equal(trayToolTip({ status: null, turns: [retry] }), 'galley: 1 pull request waits for you');
  assert.equal(trayToolTip({ status: null, turns: [retry, long] }), 'galley: 2 pull requests wait for you');
  assert.equal(trayToolTip({ status: 'Starting galley at http://localhost:24823…', turns: [retry] }), 'galley: Starting galley at http://localhost:24823…');
});
