// The open pull requests with whose turn each is, for the menu-bar status, and which of them
// became the user's turn (the API's turn.whose "reviewer", as the front page lists them first),
// for a notification each.

/** One reason for whose turn it is, as the API says it (the server's TurnReason). */
export interface Reason {
  kind: string;
  /** A few words. */
  text: string;
  /** The author's state, or a reviewer agent's. */
  state?: string;
  /** A reviewer agent's: it still has the head to review. */
  to_review?: boolean;
}

/** An open pull request: staged, or published and open on GitHub. */
export interface Pull {
  id: number;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  /** Where it is in the web UI, on the server's origin: /owner/name/pull/4. */
  path: string;
  /** Where it is in the API, on the server's origin: /api/repos/owner/name/pulls/4. */
  api: string;
  /** Where it is on GitHub once published; null while staged. */
  published: string | null;
  /** Whose move it waits for: the author agent's, the reviewer agents', the user's (reviewer) or nobody's, also once the user dismissed their turn (a reason of kind `dismissed`). */
  whose: 'author' | 'reviewer_agents' | 'reviewer' | 'none';
  /** Why, as the front page's rows and notifications say it. */
  reasons: Reason[];
  updated: string;
}

/** Every open pull request with its turn, from the API, in one request: latest update first. */
export async function openPulls(base: string): Promise<Pull[]> {
  const res = await fetch(`${base}/api/pulls?state=open`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/pulls answered ${res.status}`);
  type Json = { id: number; number: number; title: string; url: string; html_url: string; published_url: string | null; updated_at: string; repository: { full_name: string }; turn: { whose: Pull['whose']; reasons: Reason[] } };
  return ((await res.json()) as Json[]).map((p) => ({
    id: p.id,
    repo: p.repository.full_name,
    number: p.number,
    title: p.title,
    path: new URL(p.html_url).pathname,
    api: new URL(p.url).pathname,
    published: p.published_url,
    whose: p.turn.whose,
    reasons: p.turn.reasons,
    updated: p.updated_at,
  }));
}

/** Where it is the user's turn, waiting longest first, as the front page has them. */
export function yourTurns(pulls: Pull[]): Pull[] {
  return pulls.filter((p) => p.whose === 'reviewer').sort((a, b) => a.updated.localeCompare(b.updated));
}

/**
 * How long a pull request has to stay the user's turn before it is told, so a turn that is the
 * user's for a moment (on its way from the agents to auto-publish, say) tells nothing. The front
 * page's Notify me waits as long (NOTIFY_AFTER_MS in public/app.js).
 */
export const NOTIFY_AFTER_MS = 10_000;

/** How long, at most, a pull request the user made their turn again themselves tells nothing, should no look come (Turns.madeYours). */
const UNDONE_MS = 60_000;

/**
 * The open pull requests as last fetched (`pulls`), and those where it is the user's turn (`list`),
 * fetched again on each change. What became the user's turn since the fetch before is `turned`
 * once it has stayed so for `delayMs`, as a fetch then says too, once per change; the first fetch
 * only says what is, as the front page's Notify me does. A fetch that fails (the server stopping)
 * changes nothing, so what changed while the server was away is told once it is back. What the
 * user made their turn again themselves (madeYours) is not told.
 */
export class Turns {
  pulls: Pull[] = [];
  list: Pull[] = [];
  private known: Set<number> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  /** Fetches that worked, so a look again can tell whether it saw anything new. */
  private loads = 0;
  /** What became the user's turn, until it has been for delayMs or is not any more. */
  private held = new Map<number, ReturnType<typeof setTimeout>>();
  /** Fetches begun, so an Undo can tell the looks that began after it from those in flight. */
  private begun = 0;
  /** When the user made each pull request their turn again themselves (madeYours), and how many fetches had begun then. */
  private undone = new Map<number, { at: number; begun: number }>();
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  private load: () => Promise<Pull[]>;
  private on: { list(turns: Pull[]): void; turned(t: Pull): void };
  private delayMs: number;

  constructor(load: () => Promise<Pull[]>, on: { list(turns: Pull[]): void; turned(t: Pull): void }, delayMs = NOTIFY_AFTER_MS) {
    this.load = load;
    this.on = on;
    this.delayMs = delayMs;
  }

  /** Fetch again: one fetch at a time, and one more after it for changes during it. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        let pulls: Pull[];
        const begun = ++this.begun;
        try {
          pulls = await this.load();
        } catch {
          continue;
        }
        this.update(pulls, begun);
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /**
   * Fetch again in `ms`, for a change: the changes until then, which come in bursts (a review and
   * its comments, a publish), make one fetch.
   */
  soon(ms = 300): void {
    this.soonTimer ??= setTimeout(() => {
      this.soonTimer = null;
      void this.refresh();
    }, ms);
  }

  /**
   * The user made pull request `id` their turn again themselves, undoing its dismissal: nothing to
   * tell of it becoming their turn, in the looks in flight and the first that begins after, which
   * sees what the Undo did. A turn after that is news again. Within UNDONE_MS, should no look come.
   */
  madeYours(id: number): void {
    clearTimeout(this.held.get(id));
    this.held.delete(id);
    this.undone.set(id, { at: Date.now(), begun: this.begun });
  }

  private update(pulls: Pull[], begun = this.begun): void {
    const list = yourTurns(pulls);
    const before = this.known;
    this.known = new Set(list.map((t) => t.id));
    this.pulls = pulls;
    this.list = list;
    this.loads++;
    this.on.list(list);
    // No longer the user's turn: nothing to tell, and becoming it again starts the wait again.
    for (const [id, timer] of this.held) {
      if (this.known.has(id)) continue;
      clearTimeout(timer);
      this.held.delete(id);
    }
    const quiet = (id: number) => Date.now() - (this.undone.get(id)?.at ?? -Infinity) < UNDONE_MS;
    if (before) for (const t of list) if (!before.has(t.id) && !quiet(t.id)) this.hold(t.id);
    // A look that began after the Undo saw what it did.
    for (const [id, u] of this.undone) if (begun > u.begun) this.undone.delete(id);
  }

  private hold(id: number): void {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => void this.confirm(id, timer), this.delayMs);
    this.held.set(id, timer);
  }

  /**
   * Look again, and tell of it if it has been the user's turn all along. When the look fails, wait
   * again. Not when it stopped being the user's turn meanwhile, even if it is again (a wait of its own).
   */
  private async confirm(id: number, timer: ReturnType<typeof setTimeout>): Promise<void> {
    const loads = this.loads;
    await this.refresh();
    if (this.held.get(id) !== timer) return;
    if (this.loads === loads) return this.hold(id);
    this.held.delete(id);
    const t = this.list.find((x) => x.id === id);
    if (t) this.on.turned(t);
  }
}
