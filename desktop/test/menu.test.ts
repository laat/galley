// The desktop app's menu-bar status: the counts next to the icon, and the menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubTarget, groupOf, rankedReasons, trayMenu, trayTitle, trayToolTip, type MenuActions } from '../menu.ts';
import type { Pull } from '../turns.ts';

const pull = (id: number, o: Partial<Pull>): Pull => ({
  id,
  repo: 'acme/widgets',
  number: id,
  title: `Pull ${id}`,
  path: `/acme/widgets/pull/${id}`,
  api: `/api/repos/acme/widgets/pulls/${id}`,
  published: null,
  whose: 'reviewer',
  reasons: [],
  updated: '2026-10-18T10:00:00.000Z',
  ...o,
});

// Your turn: staged, the agents done with it; and published, ready to merge, waiting longer.
const retry = pull(4, {
  title: 'Add retry to the uploader',
  updated: '2026-10-18T10:05:00.000Z',
  reasons: [
    { kind: 'author', state: 'waiting', text: 'claude is waiting for review' },
    { kind: 'changes', text: 'no review from laat yet' },
    { kind: 'reviewer_agent', state: 'clean', to_review: false, text: 'codex-review found nothing in 1a2b3c4' },
  ],
});
const merge = pull(31, {
  repo: 'acme/app',
  path: '/acme/app/pull/31',
  title: 'A title much longer than a menu should be wide, which the menu cuts short',
  published: 'https://github.com/acme/app/pull/7',
  updated: '2026-10-18T09:00:00.000Z',
  reasons: [
    { kind: 'author', state: 'stopped', text: 'claude is not waiting' },
    { kind: 'approved', text: 'approved' },
    { kind: 'github', text: 'ready to merge on GitHub' },
  ],
});
// With the agents: a reviewer agent reviewing, and the author working on its findings.
const reviewing = pull(5, {
  whose: 'reviewer_agents',
  title: 'Cache the thumbnails',
  reasons: [
    { kind: 'author', state: 'waiting', text: 'claude is waiting for review' },
    { kind: 'reviewer_agent', state: 'reviewing', to_review: true, text: 'codex-review is reviewing 1a2b3c4' },
  ],
});
const working = pull(6, {
  whose: 'author',
  title: 'Fix the login redirect',
  reasons: [
    { kind: 'author', state: 'working', text: 'claude is working on the feedback' },
    { kind: 'reviewer_agent', state: 'findings', to_review: false, text: 'codex-review commented on 9f8e7d6' },
  ],
});
// Nobody's: staged, auto-publish publishes it; published, GitHub has the next move.
const publishing = pull(8, { whose: 'none', title: 'Bump the parser', reasons: [{ kind: 'auto_publish', text: 'auto-publish is publishing it' }] });
const onGithub = pull(12, { whose: 'none', title: 'Drop the old API', published: 'https://github.com/acme/widgets/pull/40', reasons: [{ kind: 'github', text: 'waiting for review from bob' }] });

function actions() {
  const done: string[] = [];
  const a: MenuActions = {
    open: (path) => done.push(`open ${path ?? '(as it was)'}`),
    openOutside: (url) => done.push(`browser ${url}`),
    dismiss: (p, dismissed) => done.push(`${dismissed ? 'dismiss' : 'undo dismissing'} ${p.api}`),
    setOpenAtLogin: (on) => done.push(`start at login ${on}`),
    quit: () => done.push('quit'),
  };
  return { a, done };
}

test("the menu groups the open pull requests as the front page does, each with its repository, number, title and main reasons, and opens each in galley or on GitHub", () => {
  const { a, done } = actions();
  // As the API lists them: latest update first.
  const items = trayMenu({ status: null, pulls: [onGithub, publishing, working, reviewing, retry, merge], openAtLogin: false }, a);
  assert.deepEqual(
    items.map((i) => (i.sublabel ? `${i.label} | ${i.sublabel}` : (i.label ?? i.type))),
    [
      'Your turn',
      'acme/app s#31  A title much longer than a menu should be wide, which the m… ↗ | ready to merge on GitHub · approved',
      'acme/widgets s#4  Add retry to the uploader | no review from laat yet · codex-review found nothing in 1a2b3c4',
      'separator',
      'Agents at work',
      'acme/widgets s#6  Fix the login redirect | claude is working on the feedback · codex-review commented on 9f8e7d6',
      'acme/widgets s#5  Cache the thumbnails | codex-review is reviewing 1a2b3c4 · claude is waiting for review',
      'separator',
      'Auto-publish',
      'acme/widgets s#8  Bump the parser | auto-publish is publishing it',
      'separator',
      'Waiting on GitHub',
      'acme/widgets s#12  Drop the old API ↗ | acme/widgets#40 · waiting for review from bob',
      'separator',
      'Open galley',
      'Start at login',
      'separator',
      'Quit galley',
    ],
  );
  for (const header of items.filter((i) => i.type === 'header')) assert.equal(header.enabled, false);
  // On hover, all the reasons, and on the user's turn, what ⌥-click does.
  assert.equal(items[2].toolTip, 'no review from laat yet · codex-review found nothing in 1a2b3c4 · claude is waiting for review\n⌥-click to dismiss it until something new happens');
  assert.equal(items[5].toolTip, 'claude is working on the feedback · codex-review commented on 9f8e7d6');
  for (const i of items) i.click?.();
  assert.deepEqual(done, [
    'browser https://github.com/acme/app/pull/7',
    'open /acme/widgets/pull/4',
    'open /acme/widgets/pull/6',
    'open /acme/widgets/pull/5',
    'open /acme/widgets/pull/8',
    'browser https://github.com/acme/widgets/pull/40',
    'open (as it was)',
    'start at login true',
    'quit',
  ]);
});

test('which group a pull request is in: whose turn it is, and on nobody\'s, whether it is published', () => {
  assert.deepEqual([retry, merge, reviewing, working, publishing, onGithub].map(groupOf), ['yours', 'yours', 'agents', 'agents', 'auto_publish', 'github']);
});

// Your turn, dismissed until something new happens: nobody's, published or staged.
const dismissal = { kind: 'dismissed', text: 'laat dismissed it until something new happens' };
const dismissed = pull(9, { whose: 'none', title: 'Publish to the registry', published: 'https://github.com/acme/widgets/pull/41', reasons: [dismissal, { kind: 'changes', text: 'no review from laat yet' }, { kind: 'github', text: 'ready to merge on GitHub' }] });
const dismissedStaged = pull(10, { whose: 'none', title: 'Rename the flag', reasons: [dismissal, { kind: 'author', state: 'stopped', text: 'claude is not waiting' }] });

test('a dismissed pull request is under Dismissed, last, with why it was your turn, and is not counted', () => {
  const { a } = actions();
  assert.deepEqual([dismissed, dismissedStaged].map(groupOf), ['dismissed', 'dismissed']);
  const items = trayMenu({ status: null, pulls: [dismissed, onGithub, retry, dismissedStaged], openAtLogin: null }, a);
  assert.deepEqual(
    items.map((i) => (i.sublabel ? `${i.label} | ${i.sublabel}` : (i.label ?? i.type))),
    [
      'Your turn',
      'acme/widgets s#4  Add retry to the uploader | no review from laat yet · codex-review found nothing in 1a2b3c4',
      'separator',
      'Waiting on GitHub',
      'acme/widgets s#12  Drop the old API ↗ | acme/widgets#40 · waiting for review from bob',
      'separator',
      'Dismissed',
      'acme/widgets s#9  Publish to the registry ↗ | ready to merge on GitHub · no review from laat yet',
      'acme/widgets s#10  Rename the flag | claude is not waiting · laat dismissed it until something new happens',
      'separator',
      'Open galley',
      'separator',
      'Quit galley',
    ],
  );
  assert.equal(items[7].toolTip, 'ready to merge on GitHub · no review from laat yet · laat dismissed it until something new happens\n⌥-click to make it your turn again');
  assert.deepEqual([dismissed, dismissedStaged].map(githubTarget), ['https://github.com/acme/widgets/pull/41', null]);
  assert.equal(trayTitle([dismissed, dismissedStaged]), '');
  assert.equal(trayTitle([retry, dismissed]), '1');
  assert.equal(trayToolTip({ status: null, pulls: [retry, dismissed] }), 'galley: 1 pull request waits for you · 1 dismissed');
  // Nothing waits for you when all of yours are dismissed.
  assert.equal(trayMenu({ status: null, pulls: [dismissed], openAtLogin: null }, a)[0].label, 'Nothing waits for you');
});

test('⌥-click dismisses one of your turns, and undoes it on a dismissed one; a click opens either, and ⌥ does nothing elsewhere', () => {
  const { a, done } = actions();
  const items = trayMenu({ status: null, pulls: [dismissed, reviewing, retry], openAtLogin: null }, a);
  const item = (n: number) => items.find((i) => i.label?.startsWith(`acme/widgets s#${n} `))!;
  const option = { altKey: true };
  item(4).click!(null, null, option);
  item(9).click!(null, null, option);
  item(5).click!(null, null, option);
  item(4).click!(null, null, { altKey: false });
  item(9).click!();
  assert.deepEqual(done, ['dismiss /api/repos/acme/widgets/pulls/4', 'undo dismissing /api/repos/acme/widgets/pulls/9', 'open /acme/widgets/pull/5', 'open /acme/widgets/pull/4', 'browser https://github.com/acme/widgets/pull/41']);
});

test("the main reason first: on your turn what to see to, then what changed since your review; on the reviewer agents', who has the head to review", () => {
  const texts = (p: Pull) => rankedReasons(p).map((r) => r.text);
  assert.deepEqual(texts(merge), ['ready to merge on GitHub', 'approved', 'claude is not waiting']);
  const stalled = pull(1, {
    reasons: [
      { kind: 'changes', text: '2 pushes since laat\'s review' },
      { kind: 'threads', text: '1 unresolved thread' },
      { kind: 'author', state: 'stalled', text: 'claude stopped without asking for review' },
    ],
  });
  assert.deepEqual(texts(stalled), ['claude stopped without asking for review', '2 pushes since laat\'s review', '1 unresolved thread']);
  const held = pull(3, {
    reasons: [
      { kind: 'changes', text: 'no review from laat yet' },
      { kind: 'auto_publish', text: 'auto-publish could not check for conflicts with main' },
    ],
  });
  assert.deepEqual(texts(held), ['auto-publish could not check for conflicts with main', 'no review from laat yet']);
  assert.deepEqual(texts(reviewing), ['codex-review is reviewing 1a2b3c4', 'claude is waiting for review']);
  // The author's turn to start them: the author first.
  const toStart = pull(2, {
    whose: 'author',
    reasons: [
      { kind: 'reviewer_agent', state: 'unreviewed', to_review: true, text: 'codex-review reviews 1a2b3c4 when claude waits for review' },
      { kind: 'author', state: 'stopped', text: 'claude has not asked for review yet (pr wait)' },
    ],
  });
  assert.deepEqual(texts(toStart), ['claude has not asked for review yet (pr wait)', 'codex-review reviews 1a2b3c4 when claude waits for review']);
});

test('a published pull request opens on GitHub when its main reason is GitHub\'s, and in galley when it is something done in galley', () => {
  const published = (o: Partial<Pull>) => pull(1, { published: 'https://github.com/acme/widgets/pull/9', ...o });
  const kinds = ['author', 'reviewer_agent', 'changes', 'approved', 'changes_requested', 'threads', 'unpublished', 'conflicts', 'github', 'auto_publish'];
  // The user's turn with that reason alone.
  assert.deepEqual(
    kinds.filter((kind) => githubTarget(published({ reasons: [{ kind, text: kind }] })) !== null),
    ['github'],
  );
  // The main reason decides, not the first the API lists: on the user's turn GitHub's comes
  // before what changed since the review, the decision and the update not published.
  assert.equal(
    githubTarget(published({ reasons: [{ kind: 'changes', text: '1 push since laat\'s review' }, { kind: 'approved', text: 'approved' }, { kind: 'unpublished', text: 'update not published: title' }, { kind: 'github', text: '2 checks failed on GitHub' }] })),
    'https://github.com/acme/widgets/pull/9',
  );
  // A stalled author is the user's to see to as much as GitHub is, and comes first, as the API lists it.
  assert.equal(githubTarget(published({ reasons: [{ kind: 'author', state: 'stalled', text: 'claude stopped without waiting since its last commit' }, { kind: 'github', text: 'ready to merge on GitHub' }] })), null);
  // Auto-publish held up, the user's to see to.
  assert.equal(githubTarget(published({ reasons: [{ kind: 'auto_publish', text: 'auto-merge needs a merge method' }, { kind: 'github', text: 'ready to merge on GitHub' }] })), null);
  // The agents at work on a push since publishing.
  assert.equal(githubTarget(published({ whose: 'reviewer_agents', reasons: [{ kind: 'github', text: 'conflicts with main on GitHub' }, { kind: 'reviewer_agent', state: 'reviewing', to_review: true, text: 'codex-review is reviewing 1a2b3c4' }] })), null);
  assert.equal(githubTarget(published({ whose: 'author', reasons: [{ kind: 'author', state: 'working', text: 'claude is working on the feedback' }] })), null);
  // Waiting on GitHub: for a review there, or for nothing it says.
  assert.equal(githubTarget(published({ whose: 'none', reasons: [{ kind: 'github', text: 'waiting for review from bob' }] })), 'https://github.com/acme/widgets/pull/9');
  assert.equal(githubTarget(published({ whose: 'none', reasons: [] })), 'https://github.com/acme/widgets/pull/9');
  // Nobody's turn while the push waits to try signing again: galley's.
  assert.equal(githubTarget(published({ whose: 'none', reasons: [{ kind: 'unpublished', text: 'the push of 1a2b3c4 waits to try signing again' }, { kind: 'github', text: 'waiting for review from bob' }] })), null);
});

test('a staged pull request always opens in galley', () => {
  for (const kind of ['github', 'auto_publish', 'author']) assert.equal(githubTarget(pull(1, { reasons: [{ kind, text: kind }] })), null);
  for (const p of [retry, reviewing, working, publishing]) assert.equal(githubTarget(p), null);
});

test('ready to merge with no review from you yet, and waiting on GitHub with nothing more to say, open on GitHub', () => {
  const { a, done } = actions();
  const ready = pull(2, {
    repo: 'nrkno/pin-delta-auth',
    path: '/nrkno/pin-delta-auth/pull/2',
    title: 'feat!: publish to GitHub Packages as @nrkno/pin-delta-auth',
    published: 'https://github.com/nrkno/pin-delta-auth/pull/3',
    reasons: [
      { kind: 'changes', text: 'no review from laat yet' },
      { kind: 'github', text: 'ready to merge on GitHub' },
    ],
  });
  const waits = pull(1, {
    repo: 'nrkno/innlogging-integration-kit',
    path: '/nrkno/innlogging-integration-kit/pull/1',
    title: 'fix(client): remove shouldHandleComingFromAuthority',
    published: 'https://github.com/nrkno/innlogging-integration-kit/pull/388',
    whose: 'none',
  });
  const items = trayMenu({ status: null, pulls: [ready, waits], openAtLogin: null }, a).filter((i) => i.label?.includes('s#'));
  assert.deepEqual(
    items.map((i) => `${i.label} | ${i.sublabel}`),
    [
      'nrkno/pin-delta-auth s#2  feat!: publish to GitHub Packages as @nrkno/pin-delta-auth ↗ | ready to merge on GitHub · no review from laat yet',
      'nrkno/innlogging-integration-kit s#1  fix(client): remove shouldHandleComingFromAuthority ↗ | nrkno/innlogging-integration-kit#388',
    ],
  );
  for (const i of items) i.click!();
  assert.deepEqual(done, ['browser https://github.com/nrkno/pin-delta-auth/pull/3', 'browser https://github.com/nrkno/innlogging-integration-kit/pull/388']);
});

test('under the title, the main reason alone when the next does not fit, cut short when it is long itself', () => {
  const { a } = actions();
  const long = 'x'.repeat(80);
  const sublabels = trayMenu(
    {
      status: null,
      pulls: [
        pull(1, { reasons: [{ kind: 'github', text: '2 checks failed on GitHub' }, { kind: 'changes', text: `no review from ${'y'.repeat(50)} yet` }] }),
        pull(2, { reasons: [{ kind: 'github', text: long }] }),
        pull(3, {}),
      ],
      openAtLogin: null,
    },
    a,
  ).flatMap((i) => (i.label?.includes('s#') ? [i.sublabel] : []));
  assert.deepEqual(sublabels, ['2 checks failed on GitHub', 'x'.repeat(71) + '…', undefined]);
});

test('a long group lists ten, then how many more, which opens the front page on the tab that has them', () => {
  const { a, done } = actions();
  const more = (pulls: Pull[]) => trayMenu({ status: null, pulls, openAtLogin: null }, a).find((i) => i.label?.endsWith(' more…'))!;
  const staged = Array.from({ length: 13 }, (_, i) => pull(i + 1, { whose: 'reviewer_agents' }));
  assert.equal(trayMenu({ status: null, pulls: staged, openAtLogin: null }, a).filter((i) => i.label?.includes('s#')).length, 10);
  assert.equal(more(staged).label, '3 more…');
  more(staged).click!();
  const published = (i: number, o: Partial<Pull> = {}) => pull(i, { whose: 'none', published: `https://github.com/acme/widgets/pull/${i}`, ...o });
  more(Array.from({ length: 11 }, (_, i) => published(i + 1))).click!();
  // Your turn has both, waiting longest first: the rest are the latest.
  const yours = (n: number) => `2026-10-18T10:${String(n).padStart(2, '0')}:00.000Z`;
  const mixed = Array.from({ length: 10 }, (_, i) => pull(i + 1, { updated: yours(i) }));
  more([...mixed, published(11, { whose: 'reviewer', updated: yours(20) })]).click!();
  more([...mixed, published(11, { whose: 'reviewer', updated: yours(20) }), pull(12, { updated: yours(21) })]).click!();
  assert.deepEqual(done, ['open /', 'open /?state=published', 'open /?state=published', 'open /?state=all']);
});

test('Start at login shows whether it is on, and only where the app can start at login', () => {
  const { a, done } = actions();
  const on = trayMenu({ status: null, pulls: [], openAtLogin: true }, a).find((i) => i.label === 'Start at login')!;
  assert.equal(on.type, 'checkbox');
  assert.equal(on.checked, true);
  on.click!();
  assert.deepEqual(done, ['start at login false']);
  assert.equal(
    trayMenu({ status: null, pulls: [], openAtLogin: null }, a).some((i) => i.label === 'Start at login'),
    false,
  );
});

test('the menu says when nothing waits, and why galley is not there', () => {
  const { a } = actions();
  assert.deepEqual(
    trayMenu({ status: null, pulls: [], openAtLogin: null }, a).map((i) => i.label ?? i.type),
    ['Nothing waits for you', 'separator', 'Open galley', 'separator', 'Quit galley'],
  );
  // The agents' are listed all the same.
  assert.deepEqual(
    trayMenu({ status: null, pulls: [reviewing], openAtLogin: null }, a).map((i) => i.label ?? i.type),
    ['Nothing waits for you', 'separator', 'Agents at work', 'acme/widgets s#5  Cache the thumbnails', 'separator', 'Open galley', 'separator', 'Quit galley'],
  );
  // What it knew before galley went away stays, under why.
  const away = trayMenu({ status: 'galley is not running at http://localhost:24823', pulls: [retry], openAtLogin: null }, a);
  assert.deepEqual(
    away.map((i) => i.label ?? i.type),
    ['galley is not running at http://localhost:24823', 'separator', 'Your turn', 'acme/widgets s#4  Add retry to the uploader', 'separator', 'Open galley', 'separator', 'Quit galley'],
  );
  assert.equal(away[0].enabled, false);
});

test('next to the icon, how many wait for you and how many are in motion; nothing when all is quiet', () => {
  // Nothing open, or only what waits on GitHub: the icon alone.
  assert.equal(trayTitle([]), '');
  assert.equal(trayTitle([onGithub]), '');
  assert.equal(trayTitle([retry, merge, onGithub]), '2');
  // The agents' and auto-publish's are in motion.
  assert.equal(trayTitle([reviewing, working, publishing]), '↻3');
  assert.equal(trayTitle([retry, merge, reviewing, working, publishing, onGithub]), '2 ↻3');
});

test('on hover over the icon, what the counts mean', () => {
  assert.equal(trayToolTip({ status: null, pulls: [] }), 'galley');
  assert.equal(trayToolTip({ status: null, pulls: [retry] }), 'galley: 1 pull request waits for you');
  assert.equal(
    trayToolTip({ status: null, pulls: [retry, merge, reviewing, working, publishing, onGithub] }),
    'galley: 2 pull requests wait for you · 2 with agents · 1 with auto-publish · 1 waiting on GitHub',
  );
  assert.equal(trayToolTip({ status: null, pulls: [reviewing] }), 'galley: 1 with agents');
  assert.equal(trayToolTip({ status: 'Starting galley at http://localhost:24823…', pulls: [retry] }), 'galley: Starting galley at http://localhost:24823…');
});
