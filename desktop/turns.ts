// The pull requests where it is the user's turn (the API's turn.whose "reviewer", as the front
// page lists them first), for the menu-bar status, and which of them became the user's turn, for
// a notification each.

/** A pull request where it is the user's turn. */
export interface YourTurn {
  id: number;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  /** Where it is in the web UI, on the server's origin: /owner/name/pull/4. */
  path: string;
  /** Why it is the user's turn, as the front page's notifications say it. */
  reasons: string;
}

/**
 * Every pull request where it is the user's turn, from the API: each repository's open pull
 * requests with their turn. Waiting longest first, as the front page has them.
 */
export async function yourTurns(base: string): Promise<YourTurn[]> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(base + path, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
  type Pull = { id: number; number: number; title: string; html_url: string; updated_at: string; turn: { whose: string; reasons: { text: string }[] } };
  const repos = await get<{ full_name: string; owner: { login: string }; name: string }[]>('/api/repos');
  const lists = await Promise.all(repos.map(async (r) => ({ r, pulls: await get<Pull[]>(`/api/repos/${encodeURIComponent(r.owner.login)}/${encodeURIComponent(r.name)}/pulls?state=open`) })));
  return lists
    .flatMap(({ r, pulls }) => pulls.filter((p) => p.turn.whose === 'reviewer').map((p) => ({ r, p })))
    .sort((a, b) => a.p.updated_at.localeCompare(b.p.updated_at))
    .map(({ r, p }) => ({ id: p.id, repo: r.full_name, number: p.number, title: p.title, path: new URL(p.html_url).pathname, reasons: p.turn.reasons.map((x) => x.text).join(' · ') }));
}

/**
 * The user's turns as last fetched, fetched again on each change. What became the user's turn
 * since the fetch before is `turned`, once per change; the first fetch only says what is, as the
 * front page's Notify me does. A fetch that fails (the server stopping) changes nothing, so what
 * changed while the server was away is told once it is back.
 */
export class Turns {
  list: YourTurn[] = [];
  private known: Set<number> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private load: () => Promise<YourTurn[]>;
  private on: { list(turns: YourTurn[]): void; turned(t: YourTurn): void };

  constructor(load: () => Promise<YourTurn[]>, on: { list(turns: YourTurn[]): void; turned(t: YourTurn): void }) {
    this.load = load;
    this.on = on;
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
        let list: YourTurn[];
        try {
          list = await this.load();
        } catch {
          continue;
        }
        this.update(list);
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private update(list: YourTurn[]): void {
    const before = this.known;
    this.known = new Set(list.map((t) => t.id));
    this.list = list;
    this.on.list(list);
    if (before) for (const t of list) if (!before.has(t.id)) this.on.turned(t);
  }
}
