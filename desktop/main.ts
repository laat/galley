// galley's desktop app: a window onto the galley server the CLI uses, a notification when it
// becomes the user's turn on a pull request, and a menu-bar status of what waits for the user and
// what the agents are at.
// It is never a second server, and quitting it leaves the server running for the agents. It opens
// galley:// links (src/app-link.ts), which pages opened in the browser hand off to while it runs.
import { app, BrowserWindow, Menu, nativeImage, Notification, session, shell, Tray, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_SCHEME, appLinkPath } from '../src/app-link.ts';
import { serverUrl } from '../src/config.ts';
import { follow, type Follower } from './live.ts';
import { githubTarget, trayMenu, trayTitle, trayToolTip } from './menu.ts';
import { notAPage } from './pages.ts';
import { attach, awayText, findNode, loginShellEnv, noAutostart, startServer } from './server.ts';
import { openPulls, Turns, type Pull } from './turns.ts';

const root = join(import.meta.dirname, '..');
const icons = join(import.meta.dirname, 'icons');

let base = '';
let origin = '';
/** Whether the live-update stream is open: whether galley answers. */
let connected = false;
/** What the app last found at the server's URL, said while the stream is down; empty when it has not looked. */
let away = '';
let tray: Tray;
let turns: Turns;
let live: Follower;
let settings: Settings;
/** Windows that show the waiting page, and where each goes once galley answers. */
const waiting = new Map<BrowserWindow, string>();
/** The page each window last failed to load as galley did not answer, and how often in a row since the stream last opened. */
const failed = new Map<BrowserWindow, { path: string; tries: number }>();
let lastFocused: BrowserWindow | null = null;
/** On macOS galley's header is a window's title bar (public/app.css). */
const headerIsTitleBar = process.platform === 'darwin';
/** Windows showing an uploaded image or a raw file, with no header: they keep a title bar of their own, and show no page. */
const headerless = new WeakSet<BrowserWindow>();
/** Whether start has run; until then, a window asked for opens once it has, and so does a link, at its page. */
let started = false;
let openWhenStarted = false;
let linkWhenStarted: string | null = null;
/** Kept until clicked or closed: a notification that is garbage-collected no longer hears its click. */
const notifications = new Set<Notification>();

if (!app.requestSingleInstanceLock()) {
  // Opened again (or at login, when it already runs): the running app shows its window instead.
  app.quit();
} else {
  // A galley:// link comes as an event on macOS, the one that opens the app before it is ready.
  // Elsewhere it is on the command line: the app's own, or a second one's, which hands it over.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    openLink(url);
  });
  linkWhenStarted = linkIn(process.argv);
  app.on('second-instance', (_e, argv) => {
    const link = linkIn(argv);
    if (link) openLink(link);
    else if (started) openWindow();
    else openWhenStarted = true;
  });
  // The menu-bar status and the notifications go on without a window.
  app.on('window-all-closed', () => {});
  app.on('web-contents-created', (_e, contents) => {
    // Only galley's pages: any other link opens in the default browser.
    const elsewhere = (e: { preventDefault(): void }, url: string) => {
      if (ours(url)) return;
      e.preventDefault();
      openOutside(url);
    };
    contents.on('will-navigate', (e, url) => {
      elsewhere(e, url);
      // Nor does a page's window show an uploaded image or a raw file, which has no header to drag
      // it by: a window with a title bar does.
      if (headerIsTitleBar && ours(url) && notAPage(url)) {
        e.preventDefault();
        const { pathname, search, hash } = new URL(url);
        newWindow(pathname + search + hash, true);
      }
    });
    contents.on('will-redirect', (e, url) => elsewhere(e, url));
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (ours(url)) return { action: 'allow', overrideBrowserWindowOptions: windowOptions(notAPage(url)) };
      openOutside(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (win, { url }) => {
      if (notAPage(url)) headerless.add(win);
      track(win);
    });
    contents.on('did-navigate', () => updateGoMenu());
    contents.on('did-navigate-in-page', () => updateGoMenu());
  });
  app.on('browser-window-focus', () => updateGoMenu());
  app.on('browser-window-blur', () => updateGoMenu());
  // Not awaited here: Electron is ready only once this module has run.
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  // Opened from the Finder, the Dock or at login, the app has launchd's environment: the server
  // it starts needs the user's PATH (Node, git, gh, the agents), and the URL may be in GALLEY_URL or GALLEY_PORT.
  if (app.isPackaged) Object.assign(process.env, await loginShellEnv());
  base = serverUrl();
  origin = new URL(base).origin;
  settings = readSettings();
  // galley:// links come here: the built app says it opens them (build.ts), and this makes it the
  // one that does. Not from the checkout, where it would make Electron's own app theirs.
  if (app.isPackaged && !app.isDefaultProtocolClient(APP_SCHEME)) app.setAsDefaultProtocolClient(APP_SCHEME);
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(icons, 'icon.png'));
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));

  // The pages may write to the clipboard (Copy link) and nothing else. They may not notify: the
  // app does, so their Notify me hides, and no change is told twice.
  const allowed = (permission: string) => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission));

  const image = nativeImage.createFromPath(join(icons, 'trayTemplate.png'));
  image.setTemplateImage(true);
  tray = new Tray(image);
  turns = new Turns(() => openPulls(base), { list: () => render(), turned: notify });
  render();

  let answered = () => {};
  const firstAnswer = new Promise<void>((resolve) => (answered = resolve));
  live = follow(base, {
    up() {
      connected = true;
      away = '';
      answered();
      failed.clear();
      for (const [win, path] of waiting) load(win, path);
      void turns.refresh();
      render();
    },
    down() {
      answered();
      if (!connected) return;
      connected = false;
      render();
    },
    change: () => turns.soon(),
  }, { path: eventsPath });
  // A window opened before the stream answers would show the waiting page for a moment.
  await Promise.race([firstAnswer, sleep(2000)]);
  if (!connected) void ensure();
  started = true;
  if (linkWhenStarted !== null && appLinkPath(linkWhenStarted, base) !== null) openLink(linkWhenStarted);
  else if (openWhenStarted || !app.getLoginItemSettings().wasOpenedAtLogin) openWindow();
  // The Dock icon, clicked. Not before: at launch, macOS activates the app too.
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().some((w) => !headerless.has(w))) openWindow();
  });
}

// ------------------------------------------------------------------ the server

let attaching: Promise<void> | null = null;

/** Attach to galley at its URL, or start it when nothing answers there, as the CLI does. */
function ensure(): Promise<void> {
  attaching ??= (async () => {
    let log = '';
    const { found, why } = await attach(base, {
      start: () => {
        const refused = noAutostart(base);
        const node = refused ? null : findNode();
        if (!node) return refused ?? 'no Node 24 or newer on PATH to start it with';
        log = startServer({ base, node, root });
        setAway(`Starting galley at ${base}…`);
        return null;
      },
    });
    // The stream says when it answers.
    if (found !== 'galley') setAway(awayText(base, found, why, log));
  })().finally(() => (attaching = null));
  return attaching;
}

function setAway(text: string): void {
  away = text;
  render();
}

/** What the app says about the server while galley does not answer; null while it does. */
function status(): string | null {
  return connected ? null : away || `Waiting for galley at ${base}…`;
}

// ------------------------------------------------------------------ windows

function ours(url: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openOutside(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/** A window's options; `noHeader` for an uploaded image or a raw file, which keeps macOS's title bar. */
function windowOptions(noHeader = false): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 900,
    // Until the page's own: the title bar does not show it, the Window menu and Mission Control do.
    title: 'galley',
    icon: join(icons, 'icon.png'),
    // On macOS, galley's header is the title bar: the traffic lights sit at its left end, 24px down
    // in its 64px, and the overlay tells the page where they are, so it makes room for them and
    // keeps the header at the top (public/app.css). In full screen there is no overlay.
    ...(headerIsTitleBar && !noHeader ? { titleBarStyle: 'hidden', titleBarOverlay: { height: 64 }, trafficLightPosition: { x: 20, y: 24 } } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

/** Show the web UI at `path` (by default as it was), in the page window last used, or a new one. */
function openWindow(path?: string): void {
  if (!connected) void ensure();
  const page = (w: BrowserWindow | null) => (w && !w.isDestroyed() && !headerless.has(w) ? w : null);
  const win = page(BrowserWindow.getFocusedWindow()) ?? page(lastFocused) ?? BrowserWindow.getAllWindows().find((w) => !headerless.has(w));
  if (!win) return void newWindow(path ?? '/');
  if (path !== undefined) load(win, path);
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

function newWindow(path: string, noHeader = false): BrowserWindow {
  const win = new BrowserWindow(windowOptions(noHeader));
  if (noHeader) headerless.add(win);
  track(win);
  load(win, path);
  return win;
}

function track(win: BrowserWindow): void {
  win.on('focus', () => (lastFocused = win));
  // The three-finger swipe, when System Settings > Trackpad has Swipe between pages with three
  // fingers: "left" goes back, as in Chrome and Firefox. A two-finger swipe is the page's
  // (public/gestures.js).
  win.on('swipe', (_e, direction) => {
    if (direction === 'left') go(win, -1);
    else if (direction === 'right') go(win, 1);
  });
  win.on('closed', () => {
    waiting.delete(win);
    failed.delete(win);
  });
  win.webContents.on('did-fail-load', (_e, _code, description, url, isMainFrame) => {
    // Only when galley or the network does not answer. Any other failure keeps Chromium's error page: loading again would fail again.
    const network = /^ERR_(CONNECTION_[A-Z_]+|EMPTY_RESPONSE|ADDRESS_UNREACHABLE|TIMED_OUT|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED)$/;
    if (!isMainFrame || !ours(url) || !network.test(description)) return;
    const path = new URL(url).pathname + new URL(url).search + new URL(url).hash;
    const before = failed.get(win);
    const tries = before?.path === path ? before.tries + 1 : 0;
    failed.set(win, { path, tries });
    waiting.set(win, path);
    void win.loadURL(waitingPage()).catch(() => {});
    // The stream opening again loads it. Until then, it may not have heard yet that the server is
    // away, or the failure was the window's own (a proxy, say): tried again, less often each time.
    setTimeout(
      () => {
        if (connected && !win.isDestroyed() && waiting.get(win) === path) load(win, path);
      },
      Math.min(1000 * 2 ** tries, 30_000),
    );
  });
}

/** Load `path` from galley, or, while it does not answer, the waiting page until it does. */
function load(win: BrowserWindow, path: string): void {
  if (!connected) {
    waiting.set(win, path);
    void win.loadURL(waitingPage()).catch(() => {});
    return;
  }
  waiting.delete(win);
  // A failure is did-fail-load's.
  void win.loadURL(base + path).catch(() => {});
}

/** A page of the app's own, with no script, that says why galley's is not there. It has no header, so all of it drags the window. */
function waitingPage(): string {
  const text = (status() ?? `Waiting for galley at ${base}…`).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>galley</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:GrayText;app-region:drag}</style><p>${text}</p>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(page);
}

/**
 * Whether a window has one of galley's pages to go back (-1) or forward (1) to: not the waiting
 * page, as a page counts it (public/gestures.js).
 */
function canGo(win: BrowserWindow | null, by: -1 | 1): boolean {
  const history = win?.webContents.navigationHistory;
  const entry = history?.getEntryAtIndex(history.getActiveIndex() + by);
  return !!entry && ours(entry.url);
}

function go(win: BrowserWindow | null, by: -1 | 1): void {
  if (canGo(win, by)) win!.webContents.navigationHistory.goToOffset(by);
}

/** Go > Back and Forward, enabled when the window in front has a page to go to. */
function updateGoMenu(): void {
  const menu = Menu.getApplicationMenu();
  const win = BrowserWindow.getFocusedWindow();
  const [back, forward] = [menu?.getMenuItemById('back'), menu?.getMenuItemById('forward')];
  if (back) back.enabled = canGo(win, -1);
  if (forward) forward.enabled = canGo(win, 1);
}

function appMenu(): MenuItemConstructorOptions[] {
  const mac = process.platform === 'darwin';
  // Electron checks or unchecks it before the click.
  const links: MenuItemConstructorOptions = { label: 'Open galley links in the app', type: 'checkbox', checked: settings.openLinks, click: (item) => setOpenLinks(item.checked) };
  return [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              links,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ] satisfies MenuItemConstructorOptions[],
          },
        ]
      : []),
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => newWindow('/') }, { role: 'close' }, ...(mac ? [] : [{ type: 'separator' } as const, links, { type: 'separator' } as const, { role: 'quit' } as const])] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Go',
      submenu: [
        // ⌘← and ⌘→ too, outside a text field, which the page takes (public/gestures.js).
        { id: 'back', label: 'Back', accelerator: 'CmdOrCtrl+[', enabled: false, click: () => go(BrowserWindow.getFocusedWindow(), -1) },
        { id: 'forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', enabled: false, click: () => go(BrowserWindow.getFocusedWindow(), 1) },
        { label: 'Front Page', accelerator: 'CmdOrCtrl+Shift+H', click: () => openWindow('/') },
      ],
    },
    { role: 'windowMenu' },
  ];
}

// ------------------------------------------------------------------ galley links

/** The galley:// link among command-line arguments, as Linux and Windows pass one. */
function linkIn(argv: string[]): string | null {
  return argv.find((a) => a.toLowerCase().startsWith(`${APP_SCHEME}:`)) ?? null;
}

/** Show a galley:// link's page in the page window last used: only galley's (appLinkPath). */
function openLink(link: string): void {
  if (!started) return void (linkWhenStarted = link);
  const path = appLinkPath(link, base);
  if (path === null) return;
  // An uploaded image or a raw file, which has no header, in a window of its own, as from a page.
  if (headerIsTitleBar && notAPage(base + path)) newWindow(path, true);
  else openWindow(path);
}

/**
 * The app's stream says it is the app's, and whether it opens galley links: its menu says so, and
 * galley:// links come to it (not to Electron's app when it runs from the checkout). Pages opened
 * in the browser then hand off to it (src/server/server.ts).
 */
function eventsPath(): string {
  return `/events?desktop=1${settings.openLinks && app.isDefaultProtocolClient(APP_SCHEME) ? '&open_links=1' : ''}`;
}

/** The app's own settings, in its data directory. */
interface Settings {
  /** Open galley links in the app: pages opened in the browser hand off to it. */
  openLinks: boolean;
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function readSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {}
  return { openLinks: saved.openLinks !== false };
}

function setOpenLinks(on: boolean): void {
  settings = { ...settings, openLinks: on };
  try {
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    console.error(e);
  }
  // The server hears it from the stream.
  live.reopen();
}

// ------------------------------------------------------------------ status and notifications

/** Starting at login is for the built app, on macOS and Windows; null where it is not. */
function openAtLogin(): boolean | null {
  return app.isPackaged && ['darwin', 'win32'].includes(process.platform) ? app.getLoginItemSettings().openAtLogin : null;
}

function render(): void {
  const state = { status: status(), pulls: turns.pulls, openAtLogin: openAtLogin() };
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(state, {
        open: openWindow,
        openOutside,
        setOpenAtLogin: (on) => {
          app.setLoginItemSettings({ openAtLogin: on });
          render();
        },
        quit: () => app.quit(),
      }),
    ),
  );
  tray.setTitle(trayTitle(turns.pulls), { fontType: 'monospacedDigit' });
  tray.setToolTip(trayToolTip(state));
  if (!connected) for (const [win] of waiting) void win.loadURL(waitingPage()).catch(() => {});
}

function notify(t: Pull): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `Your turn: ${t.title}`, subtitle: `${t.repo} s#${t.number}`, body: t.reasons.map((r) => r.text).join(' · ') });
  notifications.add(n);
  n.on('click', () => {
    notifications.delete(n);
    // Where the menu opens it.
    const github = githubTarget(t);
    if (github) openOutside(github);
    else openWindow(t.path);
  });
  n.on('close', () => notifications.delete(n));
  n.show();
}
