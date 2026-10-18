// galley's desktop app: a window onto the galley server the CLI uses, a notification when it
// becomes the user's turn on a pull request, and a menu-bar status of what waits for the user.
// It is never a second server, and quitting it leaves the server running for the agents.
import { app, BrowserWindow, Menu, nativeImage, Notification, session, shell, Tray, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serverUrl } from '../src/config.ts';
import { follow } from './live.ts';
import { trayMenu, trayTitle, trayToolTip } from './menu.ts';
import { attach, findNode, loginShellEnv, noAutostart, startServer, type Found } from './server.ts';
import { Turns, yourTurns, type YourTurn } from './turns.ts';

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
/** Windows that show the waiting page, and where each goes once galley answers. */
const waiting = new Map<BrowserWindow, string>();
/** The page each window last failed to load as galley did not answer, and how often in a row since the stream last opened. */
const failed = new Map<BrowserWindow, { path: string; tries: number }>();
let lastFocused: BrowserWindow | null = null;
/** Whether start has run; until then, a window asked for opens once it has. */
let started = false;
let openWhenStarted = false;
/** Kept until clicked or closed: a notification that is garbage-collected no longer hears its click. */
const notifications = new Set<Notification>();

if (!app.requestSingleInstanceLock()) {
  // Opened again (or at login, when it already runs): the running app shows its window instead.
  app.quit();
} else {
  app.on('second-instance', () => (started ? openWindow() : (openWhenStarted = true)));
  // The menu-bar status and the notifications go on without a window.
  app.on('window-all-closed', () => {});
  app.on('web-contents-created', (_e, contents) => {
    // Only galley's pages: any other link opens in the default browser.
    const elsewhere = (e: { preventDefault(): void }, url: string) => {
      if (ours(url)) return;
      e.preventDefault();
      openOutside(url);
    };
    contents.on('will-navigate', (e, url) => elsewhere(e, url));
    contents.on('will-redirect', (e, url) => elsewhere(e, url));
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (ours(url)) return { action: 'allow', overrideBrowserWindowOptions: windowOptions() };
      openOutside(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (win) => track(win));
  });
  // Not awaited here: Electron is ready only once this module has run.
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  // Opened from the Finder, the Dock or at login, the app has launchd's environment: the server
  // it starts needs the user's PATH (Node, git, gh, the agents), and the URL may be in GALLEY_URL or GALLEY_PORT.
  if (app.isPackaged) Object.assign(process.env, await loginShellEnv());
  base = serverUrl();
  origin = new URL(base).origin;
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
  turns = new Turns(() => yourTurns(base), { list: () => render(), turned: notify });
  render();

  let answered = () => {};
  const firstAnswer = new Promise<void>((resolve) => (answered = resolve));
  follow(base, {
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
    change: () => void turns.refresh(),
  });
  // A window opened before the stream answers would show the waiting page for a moment.
  await Promise.race([firstAnswer, sleep(2000)]);
  if (!connected) void ensure();
  started = true;
  if (openWhenStarted || !app.getLoginItemSettings().wasOpenedAtLogin) openWindow();
  // The Dock icon, clicked. Not before: at launch, macOS activates the app too.
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) openWindow();
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
    if (found !== 'galley') setAway(awayText(found, why, log));
  })().finally(() => (attaching = null));
  return attaching;
}

function awayText(found: Found, why: string | undefined, log: string): string {
  if (found === 'other') return `Another program answers at ${base}`;
  if (found === 'silent') return `Something at ${base} does not answer`;
  if (found === 'starting') return `galley is starting at ${base}…`;
  if (log) return `galley did not start at ${base}; see ${log}`;
  return `galley is not running at ${base}${why ? ` (${why})` : ''}`;
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

function windowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 900,
    title: 'galley',
    icon: join(icons, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
}

/** Show the web UI at `path` (by default as it was), in the window last used, or a new one. */
function openWindow(path?: string): void {
  if (!connected) void ensure();
  const win = BrowserWindow.getFocusedWindow() ?? (lastFocused && !lastFocused.isDestroyed() ? lastFocused : null) ?? BrowserWindow.getAllWindows()[0];
  if (!win) return void newWindow(path ?? '/');
  if (path !== undefined) load(win, path);
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

function newWindow(path: string): BrowserWindow {
  const win = new BrowserWindow(windowOptions());
  track(win);
  load(win, path);
  return win;
}

function track(win: BrowserWindow): void {
  win.on('focus', () => (lastFocused = win));
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

/** A page of the app's own, with no script, that says why galley's is not there. */
function waitingPage(): string {
  const text = (status() ?? `Waiting for galley at ${base}…`).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const page = `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>galley</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:GrayText}</style><p>${text}</p>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(page);
}

function appMenu(): MenuItemConstructorOptions[] {
  const mac = process.platform === 'darwin';
  const history = () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory;
  return [
    ...(mac ? [{ role: 'appMenu' } as const] : []),
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => newWindow('/') }, { role: 'close' }, ...(mac ? [] : [{ role: 'quit' } as const])] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => history()?.canGoBack() && history()!.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => history()?.canGoForward() && history()!.goForward() },
        { label: 'Front Page', accelerator: 'CmdOrCtrl+Shift+H', click: () => openWindow('/') },
      ],
    },
    { role: 'windowMenu' },
  ];
}

// ------------------------------------------------------------------ status and notifications

/** Starting at login is for the built app, on macOS and Windows; null where it is not. */
function openAtLogin(): boolean | null {
  return app.isPackaged && ['darwin', 'win32'].includes(process.platform) ? app.getLoginItemSettings().openAtLogin : null;
}

function render(): void {
  const state = { status: status(), turns: turns.list, openAtLogin: openAtLogin() };
  tray.setContextMenu(
    Menu.buildFromTemplate(
      trayMenu(state, {
        open: openWindow,
        setOpenAtLogin: (on) => {
          app.setLoginItemSettings({ openAtLogin: on });
          render();
        },
        quit: () => app.quit(),
      }),
    ),
  );
  tray.setTitle(trayTitle(turns.list));
  tray.setToolTip(trayToolTip(state));
  if (!connected) for (const [win] of waiting) void win.loadURL(waitingPage()).catch(() => {});
}

function notify(t: YourTurn): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `Your turn: ${t.title}`, subtitle: `${t.repo} s#${t.number}`, body: t.reasons });
  notifications.add(n);
  n.on('click', () => {
    notifications.delete(n);
    openWindow(t.path);
  });
  n.on('close', () => notifications.delete(n));
  n.show();
}
