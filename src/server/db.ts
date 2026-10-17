import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type ActorType = 'User' | 'Bot';

export interface Actor {
  id: number;
  login: string;
  type: ActorType;
}

export interface RepoRow {
  id: number;
  git_dir: string;
  work_dir: string | null;
  owner: string;
  name: string;
  remote: string;
  github_slug: string | null;
  created_at: string;
}

/** Staged here and never published, published to GitHub, or closed here. Merged or closed on GitHub is github_state. */
export type PullState = 'staged' | 'published' | 'closed';

export interface PullRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  draft: number;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  base_sha: string;
  author_id: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  published_url: string | null;
  published_at: string | null;
  /** The commit on GitHub; a signed copy of published_source_sha when publishing signed. */
  published_head_sha: string | null;
  /** The staged head that was published. */
  published_source_sha: string | null;
  /** This pull request's cap on automatic Codex reviews; null uses the setting. */
  codex_max_iterations: number | null;
  /** Whether Codex reviews this pull request automatically (1 or 0); null uses the setting. */
  codex_enabled: number | null;
  /** Auto-publish, when it is on: an AutoPublish as JSON (see Service.autoPublish). */
  auto_publish: string | null;
  published_title: string | null;
  published_body: string | null;
  author_seen_at: string;
  /** When the author last waited for review with all feedback seen: the latest `pr wait` that had nothing to return, or only what asks nothing of it (an approval). */
  author_waited_at: string | null;
  /** When the author was last handed feedback that asks something of it (`pr wait`, `pr view --comments`); its turn until its next action. */
  author_handed_at: string | null;
  /** The published pull request on GitHub, as last seen there; null until laatsux has asked. */
  github_state: GithubState | null;
  /** When it was merged or closed on GitHub, and by whom (a GitHub login). */
  github_closed_at: string | null;
  github_closed_by: string | null;
  /** The commit GitHub merged it as. */
  github_merge_sha: string | null;
  /** How it stands on GitHub while open there: a GithubStatus as JSON (see Service.githubStatus). */
  github_status: string | null;
  /** When the reviewer pinned it to the top of the front page; null when it is not pinned. */
  pinned_at: string | null;
}

export type GithubState = 'open' | 'merged' | 'closed';

export interface RevisionRow {
  id: number;
  pull_id: number;
  seq: number;
  head_sha: string;
  base_sha: string;
  before_sha: string | null;
  forced: number;
  actor_id: number;
  created_at: string;
}

export type ReviewState = 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';

export interface ReviewRow {
  id: number;
  pull_id: number;
  author_id: number;
  state: ReviewState;
  body: string;
  commit_id: string;
  created_at: string;
  submitted_at: string | null;
}

export type Side = 'LEFT' | 'RIGHT';
export type Priority = 'high' | 'medium' | 'low';
export const PRIORITIES: readonly Priority[] = ['high', 'medium', 'low'];
export type SubjectType = 'line' | 'file' | 'commit';

export interface CommentRow {
  id: number;
  pull_id: number;
  kind: 'issue' | 'review';
  review_id: number | null;
  author_id: number;
  body: string;
  created_at: string;
  updated_at: string;
  // Review comments only:
  subject_type: SubjectType | null;
  path: string | null;
  line: number | null;
  side: Side | null;
  start_line: number | null;
  start_side: Side | null;
  commit_id: string | null;
  base_commit_id: string | null;
  diff_hunk: string | null;
  in_reply_to_id: number | null;
  resolved_at: string | null;
  resolved_by_id: number | null;
  /** How much a review comment matters, when its author said so. */
  priority: Priority | null;
}

export interface EventRow {
  id: number;
  pull_id: number;
  actor_id: number;
  type: string;
  data: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'User'
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  git_dir TEXT NOT NULL UNIQUE,
  work_dir TEXT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  remote TEXT NOT NULL DEFAULT 'origin',
  github_slug TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (owner, name)
);
CREATE TABLE IF NOT EXISTS pulls (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'staged',
  draft INTEGER NOT NULL DEFAULT 0,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  published_url TEXT,
  published_at TEXT,
  published_head_sha TEXT,
  published_title TEXT,
  published_body TEXT,
  author_seen_at TEXT NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  before_sha TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  actor_id INTEGER NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE (pull_id, seq)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES actors(id),
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  commit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES actors(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  subject_type TEXT,
  path TEXT,
  line INTEGER,
  side TEXT,
  start_line INTEGER,
  start_side TEXT,
  commit_id TEXT,
  base_commit_id TEXT,
  diff_hunk TEXT,
  in_reply_to_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  resolved_at TEXT,
  resolved_by_id INTEGER REFERENCES actors(id)
);
CREATE INDEX IF NOT EXISTS comments_pull ON comments (pull_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id),
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_pull ON events (pull_id);
CREATE TABLE IF NOT EXISTS viewed (
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (pull_id, path)
);
-- Each time a reviewer agent (Codex) reviewed, or tried to review, a pull request.
CREATE TABLE IF NOT EXISTS review_runs (
  id INTEGER PRIMARY KEY,
  pull_id INTEGER NOT NULL REFERENCES pulls(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  error TEXT,
  review_id INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
-- The signed copy made of each agent commit when publishing, so publishing again reuses it.
CREATE TABLE IF NOT EXISTS signed_commits (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_sha TEXT NOT NULL,
  signed_sha TEXT NOT NULL,
  PRIMARY KEY (repo_id, source_sha)
);
`;

export interface ReviewRunRow {
  id: number;
  pull_id: number;
  reviewer: string;
  head_sha: string;
  trigger: 'auto' | 'manual';
  status: 'running' | 'done' | 'failed';
  model: string | null;
  effort: string | null;
  error: string | null;
  review_id: number | null;
  /** How many findings the review had, inline and in its body; null for runs without a review (and older ones). */
  findings: number | null;
  started_at: string;
  finished_at: string | null;
}

/** Columns added after a table was first created: [table, column, definition]. */
const ADDED_COLUMNS: [string, string, string][] = [
  ['pulls', 'published_source_sha', 'TEXT'],
  ['pulls', 'codex_max_iterations', 'INTEGER'],
  ['pulls', 'codex_enabled', 'INTEGER'],
  ['comments', 'priority', 'TEXT'],
  ['pulls', 'auto_publish', 'TEXT'],
  ['review_runs', 'findings', 'INTEGER'],
  ['pulls', 'author_waited_at', 'TEXT'],
  ['pulls', 'author_handed_at', 'TEXT'],
  ['pulls', 'github_state', 'TEXT'],
  ['pulls', 'github_closed_at', 'TEXT'],
  ['pulls', 'github_closed_by', 'TEXT'],
  ['pulls', 'github_merge_sha', 'TEXT'],
  ['pulls', 'github_status', 'TEXT'],
  ['pulls', 'pinned_at', 'TEXT'],
];

export class Db {
  sql: DatabaseSync;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.sql.exec(SCHEMA);
    for (const [table, column, def] of ADDED_COLUMNS) {
      const cols = this.sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    }
    // A staged pull request was stored as open, GitHub's word for what others can see.
    this.sql.exec("UPDATE pulls SET state = 'staged' WHERE state = 'open'");
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  run(query: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Insert a row from an object's keys; returns the new id. */
  insert(table: string, row: Record<string, SQLInputValue>): number {
    const keys = Object.keys(row);
    const q = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return this.run(q, ...keys.map((k) => row[k])).lastInsertRowid;
  }

  update(table: string, id: number, row: Record<string, SQLInputValue>): void {
    const keys = Object.keys(row);
    if (keys.length === 0) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => row[k]), id);
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  actor(login: string, type: ActorType = 'User'): Actor {
    const found = this.get<Actor>('SELECT * FROM actors WHERE login = ?', login);
    if (found) return found;
    const id = this.insert('actors', { login, type });
    return { id, login, type };
  }

  actorById(id: number): Actor {
    return this.get<Actor>('SELECT * FROM actors WHERE id = ?', id)!;
  }
}

export function now(): string {
  return new Date().toISOString();
}
