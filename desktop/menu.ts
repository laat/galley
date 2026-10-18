// The menu-bar status: next to the icon, how many pull requests wait for the user and how many are
// in motion without them; in the menu, the open pull requests in the front page's groups, which
// open in galley, or on GitHub when GitHub has the next move, and where ⌥-click dismisses one of
// the user's turns until something new happens, or undoes that.
import { yourTurns, type Pull, type Reason } from './turns.ts';

/** A menu item as Electron's Menu.buildFromTemplate takes it. */
export interface MenuItem {
  label?: string;
  /** A second line, smaller (macOS 14.4 and later). */
  sublabel?: string;
  /** `header`: a section's title (macOS 14 and later). */
  type?: 'normal' | 'separator' | 'checkbox' | 'header';
  enabled?: boolean;
  checked?: boolean;
  /** Shown on hover (macOS). */
  toolTip?: string;
  /** Electron passes the item, the window and the keys held (`event`); the tests pass what they need. */
  click?: (item?: unknown, window?: unknown, event?: { altKey?: boolean }) => void;
}

export interface MenuState {
  /** What the menu says about the server while the app does not hear from it; null while it does. */
  status: string | null;
  /** The open pull requests, staged and published. */
  pulls: Pull[];
  /** Whether the app starts at login; null where it cannot say (not a built app, or not macOS or Windows). */
  openAtLogin: boolean | null;
}

export interface MenuActions {
  /** Show the web UI at `path`, or as it was. */
  open(path?: string): void;
  /** Open `url` in the default browser: a pull request on GitHub. */
  openOutside(url: string): void;
  /** Dismiss the user's turn on the pull request until something new happens, or undo that (`dismissed` false). */
  dismiss(p: Pull, dismissed: boolean): void;
  setOpenAtLogin(on: boolean): void;
  quit(): void;
}

/**
 * The front page's groups: the user's turn; the agents' (the reviewer agents reviewing, the author
 * working on feedback or yet to wait); staged and nobody's turn, auto-publish's, which publishes
 * it on its own; published and nobody's turn, GitHub's (its review, checks, the merge); and the
 * user's turns they dismissed until something new happens.
 */
export type Group = 'yours' | 'agents' | 'auto_publish' | 'github' | 'dismissed';

const GROUPS: { group: Group; title: string }[] = [
  { group: 'yours', title: 'Your turn' },
  { group: 'agents', title: 'Agents at work' },
  { group: 'auto_publish', title: 'Auto-publish' },
  { group: 'github', title: 'Waiting on GitHub' },
  { group: 'dismissed', title: 'Dismissed' },
];

export function groupOf(p: Pull): Group {
  if (p.whose === 'reviewer') return 'yours';
  if (p.reasons.some((r) => r.kind === 'dismissed')) return 'dismissed';
  if (p.whose === 'author' || p.whose === 'reviewer_agents') return 'agents';
  return p.published ? 'github' : 'auto_publish';
}

/** The pull requests of each group: the user's turn waiting longest first, the others latest update first, as the API lists them. */
export function grouped(pulls: Pull[]): Record<Group, Pull[]> {
  const out: Record<Group, Pull[]> = { yours: yourTurns(pulls), agents: [], auto_publish: [], github: [], dismissed: [] };
  for (const p of pulls) {
    const group = groupOf(p);
    if (group !== 'yours') out[group].push(p);
  }
  return out;
}

const MAX_TITLE = 60;
const MAX_SUBLABEL = 72;
/** A group lists this many, then how many more there are, which opens the front page. */
const MAX_PER_GROUP = 10;

/**
 * The menu: what it says about the server, or that nothing waits for the user, then each group
 * with pull requests in it (repository, s#N and title, ↗ when it opens on GitHub, and under it the
 * main reasons), then the app's own items. ⌥-click on one of the user's turns dismisses it, and on
 * a dismissed one undoes that: Electron has no items that show while ⌥ is held, as macOS's own
 * menus do, so hovering says so.
 */
export function trayMenu(s: MenuState, a: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  if (s.status) items.push({ label: s.status, enabled: false });
  const groups = grouped(s.pulls);
  if (!groups.yours.length && !s.status) items.push({ label: 'Nothing waits for you', enabled: false });
  for (const { group, title } of GROUPS) {
    const pulls = groups[group];
    if (!pulls.length) continue;
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: title, type: 'header', enabled: false });
    for (const p of pulls.slice(0, MAX_PER_GROUP)) {
      const name = p.title.length > MAX_TITLE ? p.title.slice(0, MAX_TITLE - 1) + '…' : p.title;
      const ranked = rankedReasons(p);
      const github = githubTarget(p);
      const option = group === 'yours' ? '⌥-click to dismiss it until something new happens' : group === 'dismissed' ? '⌥-click to make it your turn again' : null;
      items.push({
        label: `${p.repo} s#${p.number}  ${name}${github ? ' ↗' : ''}`,
        sublabel: sublabel(p, ranked),
        toolTip: [ranked.map((r) => r.text).join(' · '), option].filter(Boolean).join('\n'),
        click: (_item, _window, event) => (option && event?.altKey ? a.dismiss(p, group === 'yours') : github ? a.openOutside(github) : a.open(p.path)),
      });
    }
    // The rest, on the front page's tab that has them all: staged, published, or both.
    const rest = pulls.slice(MAX_PER_GROUP);
    if (rest.length) {
      const tab = rest.every((p) => p.published) ? '/?state=published' : rest.some((p) => p.published) ? '/?state=all' : '/';
      items.push({ label: `${rest.length} more…`, click: () => a.open(tab) });
    }
  }
  items.push({ type: 'separator' }, { label: 'Open galley', click: () => a.open() });
  if (s.openAtLogin !== null) {
    const on = s.openAtLogin;
    items.push({ label: 'Start at login', type: 'checkbox', checked: on, click: () => a.setOpenAtLogin(!on) });
  }
  items.push({ type: 'separator' }, { label: 'Quit galley', click: () => a.quit() });
  return items;
}

/**
 * A pull request's reasons, what says most about its group first, as the front page's rows have
 * them. The user's turn: something to see to (a stalled author, feedback to pass on, a review to
 * retry, GitHub, auto-publish held up, a conflict), then what changed since the user's review, then
 * the decision, threads and what GitHub does not have, then what the reviewer agents made of the
 * head, the author last. The reviewer agents': those with the head to review, then the author. The
 * author's: the author first. A dismissed one's as on the user's turn, and the dismissal last.
 */
export function rankedReasons(p: Pull): Reason[] {
  // Dismissed, as on the user's turn, with the dismissal, which its group says, last.
  const dismissed = groupOf(p) === 'dismissed';
  const rank = (r: Reason): number => {
    if (r.kind === 'dismissed') return 5;
    if (p.whose === 'reviewer' || dismissed) {
      if (r.state === 'stalled' || r.state === 'unseen' || r.state === 'failed' || ['github', 'auto_publish', 'conflicts'].includes(r.kind)) return 0;
      if (r.kind === 'changes') return 1;
      return r.kind === 'reviewer_agent' ? 3 : r.kind === 'author' ? 4 : 2;
    }
    if (p.whose === 'reviewer_agents' && r.to_review) return 0;
    return r.kind === 'author' ? 1 : 2;
  };
  return [...p.reasons].sort((a, b) => rank(a) - rank(b));
}

/**
 * Where a click on a pull request (in the menu, or its notification) opens it: on GitHub when it is
 * published and GitHub has the next move, as the front page's title opens it there. That is when
 * its main reason is GitHub's (checks, a review or a conflict there, the merge), or when it is
 * nobody's turn with nothing to say, waiting on GitHub. Otherwise in galley, where what it waits
 * for is done: an update to publish, auto-publish, signing, the agents, a review, a stall. Its URL
 * on GitHub, or null for its page in galley.
 */
export function githubTarget(p: Pull): string | null {
  if (!p.published) return null;
  const [main] = rankedReasons(p);
  return (main ? main.kind === 'github' : p.whose === 'none') ? p.published : null;
}

/**
 * Under a pull request's title: its main reason, and the next when both fit. Waiting on GitHub,
 * where it is there first, as owner/name#N.
 */
function sublabel(p: Pull, ranked: Reason[]): string | undefined {
  const texts = ranked.map((r) => r.text);
  if (p.published && groupOf(p) === 'github') texts.unshift(p.published.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#'));
  const [first, second] = texts;
  if (!first) return undefined;
  if (second && first.length + 3 + second.length <= MAX_SUBLABEL) return `${first} · ${second}`;
  return first.length > MAX_SUBLABEL ? first.slice(0, MAX_SUBLABEL - 1) + '…' : first;
}

/**
 * Next to the icon, short: how many are the user's turn, then, after ↻, how many are in motion
 * without the user, with the agents or auto-publish; nothing when neither, so all quiet is the icon
 * alone. What waits on GitHub is not counted.
 */
export function trayTitle(pulls: Pull[]): string {
  const g = grouped(pulls);
  const moving = g.agents.length + g.auto_publish.length;
  return [g.yours.length ? String(g.yours.length) : '', moving ? `↻${moving}` : ''].filter(Boolean).join(' ');
}

/** On hover over the icon. */
export function trayToolTip(s: Pick<MenuState, 'status' | 'pulls'>): string {
  if (s.status) return `galley: ${s.status}`;
  const g = grouped(s.pulls);
  const n = g.yours.length;
  const parts = [
    n ? `${n} pull request${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for you` : '',
    g.agents.length ? `${g.agents.length} with agents` : '',
    g.auto_publish.length ? `${g.auto_publish.length} with auto-publish` : '',
    g.github.length ? `${g.github.length} waiting on GitHub` : '',
    g.dismissed.length ? `${g.dismissed.length} dismissed` : '',
  ].filter(Boolean);
  return parts.length ? `galley: ${parts.join(' · ')}` : 'galley';
}
