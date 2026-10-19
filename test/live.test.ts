// The browser side of live updates, run in a VM against stand-ins for the DOM: the shared worker
// that holds the one connection to the server, and how a page refreshes on what it hears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const PUBLIC = join(import.meta.dirname, '..', 'public');
/** Objects made in the VM, compared with ours: deepStrictEqual compares their prototypes too. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('the shared worker passes every message on to every tab, whatever its type', () => {
  let connect: (e: { ports: unknown[] }) => void = () => {};
  const sources: { url: string; listeners: Map<string, (e: { data?: string }) => void> }[] = [];
  class EventSource {
    url: string;
    listeners = new Map<string, (e: { data?: string }) => void>();
    constructor(url: string) {
      this.url = url;
      sources.push(this);
    }
    addEventListener(type: string, fn: (e: { data?: string }) => void) {
      this.listeners.set(type, fn);
    }
  }
  const self = { addEventListener: (type: string, fn: typeof connect) => type === 'connect' && (connect = fn) };
  runInNewContext(readFileSync(join(PUBLIC, 'live-worker.js'), 'utf8'), { self, EventSource });
  const tab = () => {
    const got: unknown[] = [];
    return { got, postMessage: (m: unknown) => got.push(m), addEventListener() {}, start() {} };
  };
  const [a, b] = [tab(), tab()];
  connect({ ports: [a] });
  connect({ ports: [b] });
  assert.deepEqual(sources.map((s) => s.url), ['/events'], 'one connection for all tabs');
  const send = (message: object) => sources[0].listeners.get('message')!({ data: JSON.stringify(message) });
  send({ type: 'change', event: { pullId: 1, type: 'comment', actor: 'agent' } });
  send({ type: 'progress', event: { pullId: 1, runId: 2 } });
  // A kind of message it has never heard of needs no new worker.
  send({ type: 'something-new', event: { x: 1 } });
  for (const t of [a, b]) {
    assert.deepEqual(plain(t.got), [
      { type: 'change', event: { pullId: 1, type: 'comment', actor: 'agent' } },
      { type: 'progress', event: { pullId: 1, runId: 2 } },
      { type: 'something-new', event: { x: 1 } },
    ]);
  }
});

/**
 * public/app.js on a transcript page following run 5 of pull request 1, in a VM against
 * stand-ins for the DOM. The page's fetches wait for an answer from the test, and its timers
 * run when the test says. `live: ''` makes it a page without live updates of its own (Settings).
 * Fetches of the page are in `fetches`, answered with its #main and after a "|" the header's count
 * of reviews running, if any; those of the count alone in `counts`.
 */
function transcriptPage({ live = '1' } = {}) {
  const page = (html: string) => ({ html, dataset: html.includes('running') ? { runLive: '5' } : {}, replaceWith: (next: unknown) => (main = next as typeof main) });
  let main = page('running: 2 steps');
  // The header's count of reviews running, and what a template makes of the markup it is given.
  const node = (html: string) => ({ html, replaceWith: (next: unknown) => (indicator = next as typeof indicator) });
  let indicator = node('0 running');
  const template = () => ({
    content: { firstElementChild: null as ReturnType<typeof node> | null },
    set innerHTML(html: string) {
      this.content.firstElementChild = node(html);
    },
  });
  const fetches: { url: string; answer: (html: string) => void; fail: () => void }[] = [];
  const counts: typeof fetches = [];
  const fetch = (url: string) =>
    new Promise((resolve, reject) =>
      (url === '/runs/indicator' ? counts : fetches).push({ url, answer: (html) => resolve({ ok: true, status: 200, text: async () => html }), fail: () => reject(new TypeError('Failed to fetch')) }),
    );
  const toast = { hidden: true, innerHTML: '', buttons: [] as { textContent?: string }[], append(b: { textContent?: string }) { this.buttons.push(b); } };
  const document = {
    body: { dataset: { live, viewer: 'reviewer' } },
    activeElement: null as unknown,
    title: '',
    hidden: false,
    addEventListener() {},
    createElement: (tag: string) => (tag === 'template' ? template() : {}),
    getElementById: (id: string) => (id === 'main' ? main : id === 'toast' ? toast : id === 'runs-indicator' ? indicator : null),
    querySelector: (sel: string) => (sel === '#main[data-run-live="5"]' && main.dataset.runLive === '5' ? main : null),
    querySelectorAll: () => [],
    adoptNode: (node: unknown) => node,
  };
  class DOMParser {
    parseFromString(html: string) {
      const [body, count] = html.split('|');
      return { getElementById: (id: string) => (id === 'main' ? page(body) : id === 'runs-indicator' && count ? node(count) : null), querySelector: () => null, title: body };
    }
  }
  let port: { onmessage: ((m: { data: unknown }) => void) | null } = { onmessage: null };
  class SharedWorker {
    port = { onmessage: null, start() {}, postMessage() {} };
    constructor() {
      port = this.port;
    }
  }
  const timers: (() => void)[] = [];
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  runInNewContext(readFileSync(join(PUBLIC, 'app.js'), 'utf8'), {
    document,
    window: { addEventListener() {}, SharedWorker },
    SharedWorker,
    DOMParser,
    fetch,
    location: { href: 'http://localhost/acme/widgets/pull/1/runs/5', hash: '', pathname: '/acme/widgets/pull/1/runs/5' },
    navigator: { userAgent: 'Mozilla/5.0' },
    localStorage: storage,
    sessionStorage: storage,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout() {},
    setInterval() {},
    console,
  });
  return {
    fetches,
    counts,
    toast,
    document,
    main: () => main,
    indicator: () => indicator,
    hear: (data: unknown) => port.onmessage!({ data }),
    /** Run the timers due, the short delay before a refresh among them. */
    tick: () => {
      for (const run of timers.splice(0)) run();
    },
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const progress = { type: 'progress', event: { pullId: 1, runId: 5 } };
const finished = { type: 'change', event: { pullId: 1, type: 'reviewer_finished', actor: 'codex-review' } };
const elsewhere = (type: string) => ({ type: 'change', event: { pullId: 2, type, actor: 'claude-review' } });

test('a refresh asked for while one is under way runs once more after it, so the page ends up current', async () => {
  const p = transcriptPage();
  // Progress: the page fetches itself, and the run finishes before the answer comes, which the
  // page hears of while the first refresh is under way.
  p.hear(progress);
  p.tick();
  assert.equal(p.fetches.length, 1);
  p.hear(finished);
  p.tick();
  await p.settle();
  assert.equal(p.fetches.length, 1, 'not two at once');
  p.fetches[0].answer('running: 3 steps');
  await p.settle();
  assert.equal(p.fetches.length, 2, 'once more after the one under way');
  p.fetches[1].answer('done: posted its review');
  await p.settle();
  assert.equal(p.main().html, 'done: posted its review');
  assert.equal(p.fetches.length, 2);
});

test('a refresh that fails while another is queued still lets that one, and later ones, run', async () => {
  const p = transcriptPage();
  p.hear(progress);
  p.tick();
  p.hear(finished);
  p.tick();
  await p.settle();
  // The server is away for the first: the one queued runs all the same.
  p.fetches[0].fail();
  await p.settle();
  assert.equal(p.fetches.length, 2, 'the queued refresh runs after one that failed');
  // And overlapping ones are queued again, not answered with the old failure.
  p.hear(progress);
  p.tick();
  await p.settle();
  p.fetches[1].answer('running: 4 steps');
  await p.settle();
  assert.equal(p.fetches.length, 3);
  p.fetches[2].answer('done: posted its review');
  await p.settle();
  assert.equal(p.main().html, 'done: posted its review');
});

test('progress does not refresh a transcript page under someone typing in a field, as changes do not', async () => {
  const p = transcriptPage();
  // Editing the pull request's title in the page's header, which a refresh would replace.
  p.document.activeElement = { tagName: 'INPUT', type: 'text', value: 'A better title' };
  p.hear(progress);
  p.tick();
  await p.settle();
  assert.equal(p.fetches.length, 0, 'the edit stays');
  assert.equal(p.toast.innerHTML, '<span>There are updates</span>');
  assert.equal(p.toast.buttons[0]?.textContent, 'Refresh');
  // Done typing, the next progress refreshes.
  p.document.activeElement = null;
  p.hear(progress);
  p.tick();
  assert.equal(p.fetches.length, 1);
});

test("a review starting or ending on another pull request updates only the header's count of reviews running", async () => {
  const p = transcriptPage();
  p.hear(elsewhere('reviewer_started'));
  // Two at once: the count is fetched once more after the one under way, not twice side by side.
  p.hear(elsewhere('reviewer_finished'));
  await p.settle();
  assert.equal(p.counts.length, 1);
  p.counts[0].answer('1 running');
  await p.settle();
  assert.equal(p.indicator().html, '1 running');
  assert.equal(p.counts.length, 2);
  p.counts[1].answer('0 running');
  await p.settle();
  assert.equal(p.indicator().html, '0 running');
  // Other changes there fetch nothing, and the page stays as it is.
  p.hear(elsewhere('comment'));
  p.tick();
  await p.settle();
  assert.equal(p.counts.length, 2);
  assert.equal(p.fetches.length, 0);
  assert.equal(p.main().html, 'running: 2 steps');
});

test("the header's count is the one asked for last, whichever answer comes first, and follows a review while someone types", async () => {
  const p = transcriptPage();
  // The page refreshes, and a review starts elsewhere while it does: the page's count, asked for
  // first and answered last, does not replace the count fetched alone.
  p.hear(progress);
  p.tick();
  p.hear(elsewhere('reviewer_started'));
  await p.settle();
  p.counts[0].answer('2 running');
  await p.settle();
  p.fetches[0].answer('running: 3 steps|1 running');
  await p.settle();
  assert.equal(p.main().html, 'running: 3 steps');
  assert.equal(p.indicator().html, '2 running');
  // A later page's does.
  p.hear(progress);
  p.tick();
  await p.settle();
  p.fetches[1].answer('running: 4 steps|1 running');
  await p.settle();
  assert.equal(p.indicator().html, '1 running');
  // This pull request's review ends while someone types a comment: the page waits, the count does not.
  p.document.activeElement = { tagName: 'TEXTAREA', value: 'Looks good' };
  p.hear(finished);
  p.tick();
  await p.settle();
  assert.equal(p.fetches.length, 2, 'the comment stays');
  p.counts[1].answer('0 running');
  await p.settle();
  assert.equal(p.indicator().html, '0 running');
});

test('a page without live updates of its own follows the count of reviews running, and nothing else', async () => {
  const p = transcriptPage({ live: '' });
  // A change for every page (pullId null), and catching up after the server was away, refresh nothing.
  p.hear({ type: 'change', event: { pullId: null, type: 'settings', actor: null } });
  p.tick();
  p.hear({ type: 'reconnected' });
  await p.settle();
  assert.equal(p.counts.length, 1);
  p.counts[0].answer('0 running');
  await p.settle();
  p.hear({ type: 'change', event: { pullId: 1, type: 'reviewer_started', actor: 'codex-review' } });
  p.hear(progress);
  p.tick();
  await p.settle();
  assert.equal(p.counts.length, 2);
  assert.equal(p.fetches.length, 0);
  assert.equal(p.main().html, 'running: 2 steps');
});
