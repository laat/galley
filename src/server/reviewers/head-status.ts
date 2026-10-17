import type { CancelReason } from '../db.ts';

/**
 * Where a reviewer agent stands with a pull request's head commit (Reviewer.headStatus).
 * `approved`: it found nothing and approved (custom reviewers that may), which counts as done like `clean`, and for nobody's decision.
 * `answered`: it found problems in the code, and the author answered them without a new commit (Reviewer.answered), which counts as done too.
 * A reviewer of the description stays at `findings` until it reviews a new version of it.
 */
export type HeadState = 'reviewing' | 'queued' | 'interrupted' | 'unreviewed' | 'findings' | 'answered' | 'failed' | 'cancelled' | 'clean' | 'approved' | 'capped' | 'off';

export interface HeadStatus {
  state: HeadState;
  /** The commit this is about: the head, or the earlier commit a running review started on. */
  commit: string;
  /** When the running review started. */
  startedAt?: string | null;
  /** When the failed review ended. */
  failedAt?: string | null;
  /** Why the review of the head was cancelled. */
  cancelled?: CancelReason | null;
  /** Automatic reviews of the pull request so far, and how many it gets. */
  automatic?: { used: number; limit: number };
  /** It reviews the title, description and commit messages the head has, not the commit's code. */
  description?: boolean;
}

/**
 * What is left for the reviewer agent to do with the head, in each state, which the rules below
 * read: the head to review, findings for the author to answer, a failed review for someone to
 * retry, or nothing. A new state fails typecheck until it is placed here.
 */
const LEFT: Record<HeadState, 'review' | 'answer' | 'retry' | 'nothing'> = {
  reviewing: 'review',
  queued: 'review',
  interrupted: 'review',
  unreviewed: 'review',
  findings: 'answer',
  failed: 'retry',
  answered: 'nothing',
  cancelled: 'nothing',
  clean: 'nothing',
  approved: 'nothing',
  capped: 'nothing',
  off: 'nothing',
};

/**
 * It still has the head to review: at it, about to, to run it again after a restart, or when the
 * author waits. Until none has, it is the reviewer agents' turn, or the author's to start them
 * (Service.turn). The API says so with each reviewer agent's turn reason (`to_review`).
 */
export function toReview(state: HeadState): boolean {
  return LEFT[state] === 'review';
}

/**
 * It reviews the head whether the author waits or not: at it, about to, or to run it again after a
 * restart. An `unreviewed` head waits for the author to wait (Service.turn).
 */
export function busy(state: HeadState): boolean {
  return toReview(state) && state !== 'unreviewed';
}

/**
 * Done with the head for `pr wait` to hand it to the user (Service.agentsDone): nothing left to
 * review, and no findings the author has not answered. A failed review counts as done here: nothing
 * more comes from it unless someone asks for another, which the user can.
 */
export function doneForHandover(state: HeadState): boolean {
  return LEFT[state] === 'nothing' || LEFT[state] === 'retry';
}

/**
 * Done with the head for auto-publish (Service.readiness): as doneForHandover, except that a failed
 * review holds it up, since no reviewer agent got to look at the head. Someone asks for another
 * review, or publishes by hand.
 */
export function doneForAutoPublish(state: HeadState): boolean {
  return LEFT[state] === 'nothing';
}
