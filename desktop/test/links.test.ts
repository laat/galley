// galley links in the desktop app: what page a galley:// link opens, and when a page opened in the
// browser hands off to the app (public/app.js, run in a VM against stand-ins for the DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { networkInterfaces } from 'node:os';
import { appLink, appLinkPath } from '../../src/app-link.ts';
import { computerOf, THIS_COMPUTER } from '../../src/server/computer.ts';

const base = 'http://localhost:24823';

test('a galley:// link opens the page at its path, query and fragment, on the server the app is a window onto', () => {
  assert.equal(appLinkPath('galley://acme/widgets/pull/4', base), '/acme/widgets/pull/4');
  assert.equal(appLinkPath('galley://acme/widgets/pull/4/files?w=1#discussion_r12', base), '/acme/widgets/pull/4/files?w=1#discussion_r12');
  assert.equal(appLinkPath('galley:///acme/widgets', base), '/acme/widgets');
  assert.equal(appLinkPath('GALLEY://acme/widgets', base), '/acme/widgets');
  assert.equal(appLinkPath('galley://acme/widgets/blob/abc/a%20b.ts#L3', base), '/acme/widgets/blob/abc/a%20b.ts#L3');
  for (const front of ['galley://', 'galley:', 'galley:/', 'galley://?state=all']) assert.equal(appLinkPath(front, base)?.replace(/\?.*/, ''), '/', front);
  // At a public URL, as with tailscale serve.
  assert.equal(appLinkPath('galley://settings', 'https://galley.tailnet-1234.ts.net'), '/settings');
});

test('a galley:// link is a path whatever it says: it never opens anything outside galley', () => {
  // What looks like a host is the path's first segment.
  assert.equal(appLinkPath('galley://example.com/x', base), '/example.com/x');
  assert.equal(appLinkPath('galley://user:pass@example.com:80/x', base), '/user:pass@example.com:80/x');
  assert.equal(appLinkPath('galley://%2F%2Fexample.com', base), '/%2F%2Fexample.com');
  // More slashes, or backslashes, as a URL parser reads them on http.
  for (const link of ['galley:////example.com/x', 'galley://\\\\example.com/x', 'galley:/\\/example.com/x']) assert.equal(appLinkPath(link, base), '/example.com/x', JSON.stringify(link));
  // A tab or newline among them, which URL parsers drop, would name a host: such a link opens nothing.
  for (const link of ['galley://\t//example.com/x', 'galley://\n/\\example.com']) assert.equal(appLinkPath(link, base), null, JSON.stringify(link));
  // Other links are not galley's.
  for (const link of ['https://example.com/', 'http://localhost:24823/acme/widgets', 'javascript:alert(1)', 'file:///etc/passwd', 'galleys://x', '']) {
    assert.equal(appLinkPath(link, base), null, link);
  }
});

test("a page's galley:// link has its path, query and fragment, and opens that page again", () => {
  assert.equal(appLink(`${base}/acme/widgets/pull/4/files?w=1#discussion_r12`), 'galley://acme/widgets/pull/4/files?w=1#discussion_r12');
  assert.equal(appLink(`${base}/`), 'galley://');
  assert.equal(appLink('https://galley.tailnet-1234.ts.net/settings/desktop'), 'galley://settings/desktop');
  for (const path of ['/', '/acme/widgets/pull/4#issuecomment-3', '/acme/widgets/blob/abc/a%20b.ts?plain=1#L3-L5']) {
    assert.equal(appLinkPath(appLink(base + path), base), path);
  }
});

test("a page hands off only to an app on the browser's computer: a request's computer is its connection's, or the one its proxy names", () => {
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1', undefined]) assert.equal(computerOf(remote, undefined), THIS_COMPUTER, String(remote));
  // tailscale serve, on this computer, passes on a request from another with its address last.
  assert.equal(computerOf('127.0.0.1', '100.101.102.103'), '100.101.102.103');
  assert.equal(computerOf('127.0.0.1', '10.0.0.1, 100.101.102.103'), '100.101.102.103');
  assert.equal(computerOf('127.0.0.1', 'FD7A:115C:A1E0::1'), 'fd7a:115c:a1e0::1');
  // Or from this one, at this computer's own address on the tailnet.
  const own = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal);
  if (own) assert.equal(computerOf('127.0.0.1', own.address), THIS_COMPUTER, own.address);
  // Without a proxy, from another computer when galley listens on more than loopback, which has no
  // say in where it comes from.
  assert.equal(computerOf('192.0.2.7', undefined), '192.0.2.7');
  assert.equal(computerOf('192.0.2.7', '127.0.0.1'), '192.0.2.7');
  assert.equal(computerOf('::ffff:192.0.2.7', '100.101.102.103'), '192.0.2.7');
});

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const APP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) galley/0.1.0 Chrome/146.0.0.0 Electron/44.9.0 Safari/537.36';

/**
 * public/app.js loading a pull request's page in a VM: what the server said of the desktop app
 * (data-desktop-app), how the page was reached, in what, and what this browser chose before.
 */
function load(o: { desktopApp?: string; navigation?: string; referrer?: string; userAgent?: string; stays?: boolean; storage?: Map<string, string> } = {}) {
  const stored = o.storage ?? new Map<string, string>();
  if (o.stays) stored.set('galley:stay-in-browser', '1');
  const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k), key: () => null, length: 0 };
  const session = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const before: { innerHTML: string; removed: boolean }[] = [];
  const main = { dataset: {}, before: (el: { innerHTML: string; removed: boolean }) => before.push(el) };
  const toast = { hidden: true, innerHTML: '', buttons: [] as { textContent?: string; onclick?: () => void }[], append(b: { textContent?: string }) { this.buttons.push(b); } };
  const document = {
    body: { dataset: { live: '', viewer: 'reviewer', desktopApp: o.desktopApp ?? '' }, classList: { add() {} } },
    referrer: o.referrer ?? '',
    activeElement: null,
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    createElement: () => ({ setAttribute() {}, removed: false, remove() { this.removed = true; } }),
    getElementById: (id: string) => (id === 'main' ? main : id === 'toast' ? toast : null),
    querySelector: (sel: string) => (sel === '.handoff-notice' ? before.find((n) => !n.removed) ?? null : null),
    querySelectorAll: () => [],
  };
  const location = { href: `${base}/acme/widgets/pull/4?w=1#discussion_r12`, origin: base, pathname: '/acme/widgets/pull/4', search: '?w=1', hash: '#discussion_r12', replace() {} };
  runInNewContext(readFileSync(join(import.meta.dirname, '..', '..', 'public', 'app.js'), 'utf8'), {
    document,
    window: { addEventListener() {} },
    location,
    navigator: { userAgent: o.userAgent ?? CHROME },
    performance: { getEntriesByType: (type: string) => (type === 'navigation' ? [{ type: o.navigation ?? 'navigate' }] : []) },
    localStorage,
    sessionStorage: session,
    URL,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    console,
  });
  return {
    /** Where the page sent the tab: the galley:// link, or its own URL when it stayed. */
    went: () => location.href,
    notice: () => before.find((n) => !n.removed)?.innerHTML ?? null,
    stays: () => stored.get('galley:stay-in-browser') === '1',
    toast,
    /** A click on what `selector` finds, a link to `href` for one. */
    click: (selector: string, href?: string) => {
      const target = { closest: (sel: string) => (sel === selector ? { href } : null), matches: () => false };
      for (const fn of listeners.get('click') ?? []) fn({ target });
    },
  };
}

const page = `${base}/acme/widgets/pull/4?w=1#discussion_r12`;
const link = 'galley://acme/widgets/pull/4?w=1#discussion_r12';

test('a page opened in the browser hands off to the desktop app while it runs and opens galley links, and says so', () => {
  const p = load({ desktopApp: 'open-links' });
  assert.equal(p.went(), link);
  assert.match(p.notice()!, /Opened in the galley app\./);
  assert.match(p.notice()!, /href="galley:\/\/acme\/widgets\/pull\/4\?w=1#discussion_r12">Open it again</);
  assert.match(p.notice()!, /Stay in the browser/);
  // From another site (a link on GitHub) as from a terminal.
  assert.equal(load({ desktopApp: 'open-links', referrer: 'https://github.com/acme/widgets/pull/9' }).went(), link);
});

test('a page stays in the browser when the app is not running, or runs and leaves galley links to the browser', () => {
  for (const desktopApp of ['', 'connected']) {
    const p = load({ desktopApp });
    assert.equal(p.went(), page, desktopApp || 'not running');
    assert.equal(p.notice(), null);
  }
});

test("a page stays where it is in the app's own windows, after Stay in the browser, and when reached from galley, reloaded or gone back to", () => {
  const cases = {
    'in the app': { userAgent: APP },
    'after Stay in the browser': { stays: true },
    'from another galley page': { referrer: `${base}/acme/widgets` },
    reloaded: { navigation: 'reload' },
    'gone back or forward to': { navigation: 'back_forward' },
  };
  for (const [what, o] of Object.entries(cases)) {
    const p = load({ desktopApp: 'open-links', ...o });
    assert.equal(p.went(), page, what);
    assert.equal(p.notice(), null, what);
  }
});

test('a page a galley page opened in a tab of its own, which has no referrer, stays in the browser', () => {
  const storage = new Map<string, string>();
  // A link in a comment, which opens in a new tab with no referrer (markdown.ts).
  load({ desktopApp: 'open-links', referrer: `${base}/acme/widgets`, storage }).click('a[href]', `${base}/acme/widgets/pull/9`);
  assert.equal(load({ desktopApp: 'open-links', storage }).went(), page);
  // Said once: a link from a terminal after it hands off.
  assert.equal(load({ desktopApp: 'open-links', storage }).went(), link);
  // A link to GitHub says nothing of the kind.
  load({ desktopApp: 'open-links', referrer: `${base}/acme/widgets`, storage }).click('a[href]', 'https://github.com/acme/widgets/pull/9');
  assert.equal(load({ desktopApp: 'open-links', storage }).went(), link);
});

test('Stay in the browser keeps galley links in this browser from then on, and Undo hands them to the app again', () => {
  const p = load({ desktopApp: 'open-links' });
  p.click('.js-stay-in-browser');
  assert.ok(p.stays());
  assert.equal(p.notice(), null, 'the notice goes');
  assert.match(p.toast.innerHTML, /galley links stay in this browser/);
  assert.equal(p.toast.buttons[0]?.textContent, 'Undo');
  p.toast.buttons[0].onclick!();
  assert.equal(p.stays(), false);
});
