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
 * run when the test says.
 */
function transcriptPage() {
  const page = (html: string) => ({ html, dataset: html.includes('running') ? { runLive: '5' } : {}, replaceWith: (next: unknown) => (main = next as typeof main) });
  let main = page('running: 2 steps');
  const fetches: { url: string; answer: (html: string) => void; fail: () => void }[] = [];
  const fetch = (url: string) =>
    new Promise((resolve, reject) => fetches.push({ url, answer: (html) => resolve({ ok: true, status: 200, text: async () => html }), fail: () => reject(new TypeError('Failed to fetch')) }));
  const toast = { hidden: true, innerHTML: '', buttons: [] as { textContent?: string }[], append(b: { textContent?: string }) { this.buttons.push(b); } };
  const document = {
    body: { dataset: { live: '1', viewer: 'reviewer' } },
    activeElement: null as unknown,
    title: '',
    hidden: false,
    addEventListener() {},
    createElement: () => ({}),
    getElementById: (id: string) => (id === 'main' ? main : id === 'toast' ? toast : null),
    querySelector: (sel: string) => (sel === '#main[data-run-live="5"]' && main.dataset.runLive === '5' ? main : null),
    querySelectorAll: () => [],
    adoptNode: (node: unknown) => node,
  };
  class DOMParser {
    parseFromString(html: string) {
      return { getElementById: (id: string) => (id === 'main' ? page(html) : null), querySelector: () => null, title: html };
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
    localStorage: storage,
    sessionStorage: storage,
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout() {},
    setInterval() {},
    console,
  });
  return {
    fetches,
    toast,
    document,
    main: () => main,
    hear: (data: unknown) => port.onmessage!({ data }),
    /** Run the timers due, the short delay before a refresh among them. */
    tick: () => {
      for (const run of timers.splice(0)) run();
    },
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const progress = { type: 'progress', event: { pullId: 1, runId: 5 } };
const finished = { type: 'change', event: { pullId: 1, type: 'codex_finished', actor: 'codex-review' } };

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
