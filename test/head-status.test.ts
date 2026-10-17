import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busy, doneForAutoPublish, doneForHandover, toReview, type HeadState } from '../src/server/reviewers/head-status.ts';

// Every state (typecheck fails when one is missing): [toReview, busy, doneForHandover, doneForAutoPublish].
const RULES: Record<HeadState, [boolean, boolean, boolean, boolean]> = {
  reviewing: [true, true, false, false],
  queued: [true, true, false, false],
  interrupted: [true, true, false, false],
  unreviewed: [true, false, false, false],
  findings: [false, false, false, false],
  // pr wait hands a commit over after a failed review; auto-publish does not publish it.
  failed: [false, false, true, false],
  answered: [false, false, true, true],
  cancelled: [false, false, true, true],
  clean: [false, false, true, true],
  approved: [false, false, true, true],
  capped: [false, false, true, true],
  off: [false, false, true, true],
};
const STATES = Object.keys(RULES) as HeadState[];

test('each head state counts as its rules say', () => {
  for (const state of STATES) {
    assert.deepEqual([toReview(state), busy(state), doneForHandover(state), doneForAutoPublish(state)], RULES[state], state);
  }
});

test('the hand-over and auto-publish rules differ in a failed review only', () => {
  assert.deepEqual(STATES.filter((s) => doneForHandover(s) !== doneForAutoPublish(s)), ['failed']);
});
