// The desktop app and the server: while the app's live-update stream is open, the server knows
// that it runs and whether it opens galley links, and says so to the pages, which hand off to it
// (public/app.js), to the CLI (/api/meta) and in Settings.
import '../helpers/env.ts';
import { server, startHarness } from '../helpers/harness.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { follow, type Follower } from '../../desktop/live.ts';

startHarness();

/** A request from another computer, as tailscale serve passes it on. */
const ANOTHER = { 'x-forwarded-for': '100.101.102.103' };

const meta = async (headers = {}) => (await (await fetch(`${server.url}/api/meta`, { headers })).json()).desktop_app;
/** What a page tells public/app.js of the desktop app. */
const page = async (path: string, headers = {}) => (await (await fetch(server.url + path, { headers })).text()).match(/<body[^>]* data-desktop-app="([^"]*)"/)?.[1];
const settings = async () => (await (await fetch(`${server.url}/settings/desktop`)).text()).match(/<p>(The desktop app [^<]*)<\/p>/)?.[1];

test("the server says the desktop app runs while the app's stream is open, and whether it opens galley links", async () => {
  // A browser's stream is not the app's.
  const tab = follow(server.url, { up() {}, down() {}, change() {} });
  let path = '/events?desktop=1&open_links=1';
  let app: Follower | null = null;
  try {
    await until(async () => server.service.bus.listenerCount('change') > 0, "the browser's stream is open");
    assert.deepEqual(await meta(), { connected: false, open_links: false });
    assert.equal(await page('/'), '');
    assert.equal(await settings(), 'The desktop app is not running on this computer.');

    app = follow(server.url, { up() {}, down() {}, change() {} }, { path: () => path });
    await until(async () => (await meta()).connected, 'the server hears of the app');
    assert.deepEqual(await meta(), { connected: true, open_links: true });
    for (const p of ['/', '/acme/widgets', '/settings']) assert.equal(await page(p), 'open-links', p);
    assert.equal(await settings(), 'The desktop app is running on this computer and opens galley links.');
    // A browser on another computer has no app to hand off to.
    assert.equal(await page('/', ANOTHER), '');
    assert.deepEqual(await meta(ANOTHER), { connected: false, open_links: false });

    // Open galley links in the app, turned off in its menu: its stream opens again, saying so.
    path = '/events?desktop=1';
    app.reopen();
    await until(async () => !(await meta()).open_links, 'the server hears that the app leaves links to the browser');
    assert.deepEqual(await meta(), { connected: true, open_links: false });
    assert.equal(await page('/'), 'connected');
    assert.match((await settings())!, /^The desktop app is running on this computer and leaves galley links to the browser/);

    // The app quits.
    app.stop();
    await until(async () => !(await meta()).connected, 'the server hears that the app is gone');
    assert.deepEqual(await meta(), { connected: false, open_links: false });
    assert.equal(await page('/'), '');
    assert.equal(await settings(), 'The desktop app is not running on this computer.');
  } finally {
    app?.stop();
    tab.stop();
  }
});

test("a desktop app on another computer is that computer's: its pages hand off to it, and this computer's do not", async () => {
  const stream = new AbortController();
  const res = await fetch(`${server.url}/events?desktop=1&open_links=1`, { headers: ANOTHER, signal: stream.signal });
  try {
    await until(async () => (await meta(ANOTHER)).connected, 'the server hears of the app');
    assert.deepEqual(await meta(ANOTHER), { connected: true, open_links: true });
    assert.equal(await page('/', ANOTHER), 'open-links');
    // Through a proxy that passes on what the browser sent, the address the proxy added counts.
    assert.equal(await page('/', { 'x-forwarded-for': '10.0.0.1, 100.101.102.103' }), 'open-links');
    assert.deepEqual(await meta(), { connected: false, open_links: false });
    assert.equal(await page('/'), '');
  } finally {
    stream.abort();
    await res.body?.cancel().catch(() => {});
  }
  await until(async () => !(await meta(ANOTHER)).connected, 'the server hears that the app is gone');
});
