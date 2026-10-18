// A pull request's timeline events (the events table), and what each type's JSON holds. Some of
// it also decides what galley does next: whether a push signs (Service.signsUpdates), whether a
// failed push is tried again (Service.pushFailed), whose edits of the title and description a wait
// publishes (Service.authorEdits, Service.editsLeft), when auto-publish tries signing again
// (Service.autoPublishRetry), whether a push goes on top of a branch rewritten on GitHub
// (Service.fetchedRewritten), and which merge method auto-merge asks for again after a push. So events are written and read back here, typed by their type, and
// reshaping one for the timeline fails typecheck where it is read.
import { now, type Actor, type CancelReason, type Db, type EventRow, type PullRow } from './db.ts';
import type { AutoPublishOff, GithubEdit, GithubPush, SigningFailure } from './service.ts';
import type { MergeMethod } from './settings.ts';

/** What each type of event holds. Fields marked optional are missing from events written before them. */
export interface EventData {
  /** New commits on the branch, or a force-push: `commits` are the new ones, none when forced. */
  pushed: { before: string; after: string; forced: boolean; commits: string[]; base_before: string; base_after: string };
  renamed: { from: string; to: string };
  body_edited: { from: string; to: string };
  base_changed: { from: string; to: string };
  convert_to_draft: Record<string, never>;
  ready_for_review: Record<string, never>;
  closed: Record<string, never>;
  reopened: Record<string, never>;
  /**
   * `head`: the commit GitHub got; `source`: the staged head it is (a copy of, when signed). `sign`:
   * what the pushes after it do. `rewritten`: on top of the branch as rewritten on GitHub (GithubPush).
   * `brought_back`: commits that rewrite removed, which the user confirmed bringing back.
   * `read_upto`: the edits the title and description it published include (GithubEdit.read_upto).
   */
  published: { url: string; head: string; source?: string; signed?: number; sign?: boolean; first: boolean; force: boolean; auto?: boolean; rewritten?: { from: string; to: string }; brought_back?: string[]; read_upto?: number };
  /** A push when the author waited (Service.pushUpdate). */
  github_push: Omit<GithubPush, 'at'>;
  /** The author's edits of the title and description, published when it waited (Service.publishEdits). */
  github_edit: Omit<GithubEdit, 'at'>;
  /** `at`: when GitHub merged or closed it; the event is from when galley learned of it. */
  merged: { url: string | null; by: string | null; at: string; commit: string | null };
  closed_on_github: { url: string | null; by: string | null; at: string; commit: string | null };
  /** `merged`: whether GitHub merged it at once; null when that could not be checked. */
  auto_merge_enabled: { url: string; method: MergeMethod; merged: boolean | null };
  auto_merge_failed: { url: string; method: MergeMethod; error: string };
  auto_publish_enabled: { sign: boolean; draft: boolean; force: boolean; auto_merge?: MergeMethod | null };
  /** Before auto-publish ended at the first publish, it also turned off when merged or closed on GitHub. */
  auto_publish_disabled: { reason: AutoPublishOff | 'merged' | 'closed_on_github' };
  /** `signing`: it could not sign, and did not try again (Service.autoPublishSigningFailed). */
  auto_publish_failed: { error: string; signing?: SigningFailure };
  /**
   * Auto-publish could not sign `head` under the approval turned on at `approval` (AutoPublish.at),
   * and stays on to try again at `signing.next_at` (Service.autoPublishSigningFailed).
   */
  auto_publish_retry: { error: string; head: string; approval: string; signing: SigningFailure };
  iterations_stopped: { round: number };
  iterations_resumed: Record<string, never>;
  review_cancelled: { head: string; reason: CancelReason };
}

export type EventType = keyof EventData;

/** An events row with its data read, typed by its type. */
export type TimelineEvent<T extends EventType = EventType> = { [K in T]: Omit<EventRow, 'type' | 'data'> & { type: K; data: EventData[K] } }[T];

export function addEvent<T extends EventType>(db: Db, pull: PullRow, actor: Actor, type: T, data: EventData[T], ts = now()): void {
  db.insert('events', { pull_id: pull.id, actor_id: actor.id, type, data: JSON.stringify(data), created_at: ts });
}

/** The latest event of the pull request of `type` (or one of several), or the latest after `since`; null when there is none. */
export function lastEvent<T extends EventType>(db: Db, pull: PullRow, type: T | T[], since = ''): TimelineEvent<T> | null {
  const types: string[] = Array.isArray(type) ? type : [type];
  const row = db.get<EventRow>(`SELECT * FROM events WHERE pull_id = ? AND type IN (${types.map(() => '?').join(', ')}) AND created_at > ? ORDER BY id DESC LIMIT 1`, pull.id, ...types, since);
  return row ? (readEvent(row) as TimelineEvent<T>) : null;
}

/** The events of the pull request of `type` after the event `id`, oldest first. */
export function eventsAfter<T extends EventType>(db: Db, pull: PullRow, type: T, id: number): TimelineEvent<T>[] {
  return db.all<EventRow>('SELECT * FROM events WHERE pull_id = ? AND type = ? AND id > ? ORDER BY id', pull.id, type, id).map((row) => readEvent(row) as TimelineEvent<T>);
}

/** The events of the pull request of `type` after `since`, oldest first. */
export function eventsSince<T extends EventType>(db: Db, pull: PullRow, type: T, since: string): TimelineEvent<T>[] {
  return db.all<EventRow>('SELECT * FROM events WHERE pull_id = ? AND type = ? AND created_at > ? ORDER BY id', pull.id, type, since).map((row) => readEvent(row) as TimelineEvent<T>);
}

/** The row with its data read. */
export function readEvent(row: EventRow): TimelineEvent {
  return { ...row, data: JSON.parse(row.data) } as TimelineEvent;
}
