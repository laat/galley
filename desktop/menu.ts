// The menu-bar status: how many pull requests wait for the user, and a menu listing them.
import type { YourTurn } from './turns.ts';

/** A menu item as Electron's Menu.buildFromTemplate takes it. */
export interface MenuItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  /** Shown on hover (macOS). */
  toolTip?: string;
  click?: () => void;
}

export interface MenuState {
  /** What the menu says about the server while the app does not hear from it; null while it does. */
  status: string | null;
  turns: YourTurn[];
  /** Whether the app starts at login; null where it cannot say (not a built app, or not macOS or Windows). */
  openAtLogin: boolean | null;
}

export interface MenuActions {
  /** Show the web UI at `path`, or as it was. */
  open(path?: string): void;
  setOpenAtLogin(on: boolean): void;
  quit(): void;
}

const MAX_TITLE = 60;

/** The menu: the pull requests where it is the user's turn (repo, s#N, title), then the app's own items. */
export function trayMenu(s: MenuState, a: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (s.status) items.push({ label: s.status, enabled: false });
  if (s.turns.length) items.push({ label: 'Your turn', enabled: false });
  else if (!s.status) items.push({ label: 'Nothing waits for you', enabled: false });
  for (const t of s.turns) {
    const title = t.title.length > MAX_TITLE ? t.title.slice(0, MAX_TITLE - 1) + '…' : t.title;
    items.push({ label: `${t.repo} s#${t.number}  ${title}`, toolTip: t.reasons, click: () => a.open(t.path) });
  }
  items.push({ type: 'separator' }, { label: 'Open galley', click: () => a.open() });
  if (s.openAtLogin !== null) {
    const on = s.openAtLogin;
    items.push({ label: 'Start at login', type: 'checkbox', checked: on, click: () => a.setOpenAtLogin(!on) });
  }
  items.push({ type: 'separator' }, { label: 'Quit galley', click: () => a.quit() });
  return items;
}

/** Next to the icon: how many wait for the user, nothing when none do. */
export function trayTitle(turns: YourTurn[]): string {
  return turns.length ? String(turns.length) : '';
}

/** On hover over the icon. */
export function trayToolTip(s: Pick<MenuState, 'status' | 'turns'>): string {
  if (s.status) return `galley: ${s.status}`;
  const n = s.turns.length;
  return n ? `galley: ${n} pull request${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for you` : 'galley';
}
