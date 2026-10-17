// Feedback for a pull request's author: what anyone else posts on it, and what of it asks
// something of the author. What `pr wait` hands over and holds back (Service.wait), whose turn it
// is (Service.turn) and whether a reviewer agent's findings are answered (Reviewer.answered) all
// read it here.
import type { CommentRow, Db, PullRow, ReviewRow } from './db.ts';

/** Submitted reviews `r` of pull request ?1 by anyone but its author ?2. */
const REVIEWS = "FROM reviews r WHERE r.pull_id = ?1 AND r.author_id != ?2 AND r.state != 'PENDING'";
/** Comments `c` outside reviews (on the conversation, or replies in threads) by anyone but the author. */
const COMMENTS = 'FROM comments c WHERE c.pull_id = ?1 AND c.author_id != ?2 AND c.review_id IS NULL';
/**
 * Review `r` asks something of the author: anything but an approval without comments, or a
 * reviewer agent's review that found nothing. A comment outside a review always does.
 */
const ASKS = "(r.state != 'APPROVED' OR EXISTS (SELECT 1 FROM comments k WHERE k.review_id = r.id)) AND NOT EXISTS (SELECT 1 FROM review_runs x WHERE x.review_id = r.id AND x.findings = 0)";
/** Comment `alias` counts: it is not in a review still pending, which nobody but its author sees. */
const posted = (alias: string) => `(${alias}.review_id IS NULL OR ${alias}.review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))`;

export interface Feedback {
  /** Oldest first. */
  reviews: ReviewRow[];
  comments: CommentRow[];
  /** The reviews among them a reviewer agent posted (agentReviews). */
  byAgent: Set<number>;
  /** Some of it asks something of the author. */
  asks: boolean;
}

/** Feedback the author has not been shown yet. */
export function unseenFeedback(db: Db, pull: PullRow): Feedback {
  const since = pull.author_seen_at;
  const rows = db.all<ReviewRow & { asks: number }>(`SELECT r.*, ${ASKS} AS asks ${REVIEWS} AND r.submitted_at > ?3 ORDER BY r.submitted_at`, pull.id, pull.author_id, since);
  const comments = db.all<CommentRow>(`SELECT c.* ${COMMENTS} AND c.created_at > ?3 ORDER BY c.id`, pull.id, pull.author_id, since);
  const agents = agentReviews(db, pull);
  return {
    reviews: rows.map(({ asks, ...r }) => r),
    comments,
    byAgent: new Set(rows.filter((r) => agents.has(r.id)).map((r) => r.id)),
    asks: comments.length > 0 || rows.some((r) => r.asks),
  };
}

/** When feedback last asked something of the author, up to `until`; null when none has. */
export function askedAt(db: Db, pull: PullRow, until = '9999'): string | null {
  return db.get<{ at: string | null }>(`SELECT MAX(at) AS at FROM (SELECT r.submitted_at AS at ${REVIEWS} AND ${ASKS} UNION ALL SELECT c.created_at ${COMMENTS}) WHERE at <= ?3`, pull.id, pull.author_id, until)!.at;
}

/**
 * The reviews reviewer agents posted on the pull request: those their runs posted, also once a
 * custom reviewer's file is gone. They stand in for nobody's decision (Service.reviewDecision).
 */
export function agentReviews(db: Db, pull: PullRow): Set<number> {
  return new Set(db.all<{ id: number }>('SELECT review_id AS id FROM review_runs WHERE pull_id = ? AND review_id IS NOT NULL', pull.id).map((r) => r.id));
}

/**
 * How many threads wait for the author's answer, on the pull request or those one review opened:
 * unresolved, with someone else's comment the latest. A reply from the author answers a thread
 * until someone comments in it again.
 */
export function unansweredThreads(db: Db, pull: PullRow, reviewId: number | null = null): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comments t
     WHERE t.pull_id = ?1 AND t.kind = 'review' AND t.in_reply_to_id IS NULL AND t.resolved_at IS NULL AND ${posted('t')} AND (?3 IS NULL OR t.review_id = ?3)
       AND (SELECT a.author_id FROM comments a WHERE (a.id = t.id OR a.in_reply_to_id = t.id) AND ${posted('a')} ORDER BY a.id DESC LIMIT 1) != ?2`,
    pull.id,
    pull.author_id,
    reviewId,
  )!.n;
}
