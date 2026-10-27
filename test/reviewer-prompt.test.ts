// What a reviewer agent is told of its earlier reviews of a pull request (earlierText), and of its shell (shellText).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earlierText, ON_THE_DESCRIPTION, OUTSIDE_THE_DIFF, shellText, type EarlierReview } from '../src/server/reviewers/reviewer.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A review's body as Reviewer.post writes it. */
const body = (summary: string, heading?: string, loose: string[] = []) =>
  [summary, ...(heading ? [heading, loose.join('\n')] : []), `<sub>codex-review (default model) reviewed \`${A.slice(0, 7)}\`.</sub>`].join('\n\n');

const fixed: EarlierReview = {
  commit: A,
  body: body('Off by one.', OUTSIDE_THE_DIFF, ['- `math.js:1` (medium priority): Not in this diff.\n  Second line.']),
  threads: [
    {
      where: 'codex.js:1',
      resolvedBy: 'agent',
      comments: [
        { login: 'codex-review', body: 'Use 42.' },
        { login: 'agent', body: 'Fixed in bbbbbbb.' },
      ],
    },
    { where: 'codex.js:3', resolvedBy: null, comments: [{ login: 'codex-review', body: 'Name it.' }] },
  ],
};

test('before its first review, a reviewer is told nothing of earlier ones', () => {
  assert.deepEqual(earlierText([], null), []);
});

test('a resolved thread is listed with its replies and who resolved it, to check that it was fixed', () => {
  const text = earlierText([fixed], null).join('\n');
  assert.match(text, /Check that each resolved comment was really fixed, and comment again only on one that was not/);
  assert.match(text, /Your last review, of aaaaaaa, said: Off by one\.\n- codex\.js:1 \[resolved by agent\]\n  codex-review: Use 42\.\n  agent: Fixed in bbbbbbb\.\n- codex\.js:3 \[open\]\n  codex-review: Name it\./);
  // Findings in the body have no thread, so they are listed as they were posted.
  assert.match(text, /Its comments outside threads, which nobody resolves:\n- `math\.js:1` \(medium priority\): Not in this diff\.\n  Second line\./);
  assert.doesNotMatch(text, /<sub>/);
});

test('the commit it last reviewed comes with a diff from it, unless the branch was rebased since or it is gone', () => {
  assert.match(earlierText([fixed], { commit: A, diff: 'changes' }).join('\n'), new RegExp(`\nYou last reviewed ${A}\\. Run \`git diff ${A} HEAD\` to see what changed since\\.$`));
  const rebased = earlierText([fixed], { commit: A, diff: 'rebased' }).join('\n');
  assert.match(rebased, new RegExp(`You last reviewed ${A}, but the branch has been rebased onto a newer base since, so a diff from it would show the base's changes too: review the whole change\\.$`));
  assert.doesNotMatch(rebased, /git diff/);
  assert.match(earlierText([fixed], { commit: A, diff: 'gone' }).join('\n'), /which is no longer in the repository: review the whole change\.$/);
  assert.match(earlierText([fixed], { commit: A, diff: 'head' }).join('\n'), /Your last review was of this same commit, HEAD\.$/);
});

test('a reviewer of the description is told its findings on the title and description, which are in the body', () => {
  const review: EarlierReview = { commit: A, body: body('The title is not in the imperative.', ON_THE_DESCRIPTION, ['- Title (high priority): Say "Add", not "Added".']), threads: [] };
  const text = earlierText([review], null).join('\n');
  assert.match(text, /Check that each resolved comment was really fixed/);
  assert.match(text, /Its comments outside threads, which nobody resolves:\n- Title \(high priority\): Say "Add", not "Added"\./);
  assert.doesNotMatch(text, /You last reviewed/);
});

test('reviews before the last one are a line a comment, at most twenty', () => {
  const many: EarlierReview = {
    commit: A,
    body: body('Many things.', OUTSIDE_THE_DIFF, ['- `x.js:1`: Outside.']),
    threads: Array.from({ length: 21 }, (_, i) => ({ where: `x.js:${i + 2}`, resolvedBy: 'agent', comments: [{ login: 'codex-review', body: `Thing ${i}\n\nin detail.` }, { login: 'agent', body: 'Done.' }] })),
  };
  const clean: EarlierReview = { commit: B, body: body('Fine now.'), threads: [] };
  const text = earlierText([many, clean], { commit: B, diff: 'head' }).join('\n');
  assert.match(text, /Your last review, of bbbbbbb, said: Fine now\.\n\nComments of your reviews before that, a line each:\n- \(2 older ones left out\)\n- aaaaaaa x\.js:4 \[resolved by agent\]: Thing 2 in detail\.\n/);
  assert.match(text, /- aaaaaaa x\.js:22 \[resolved by agent\]: Thing 20 in detail\.\n- aaaaaaa `x\.js:1`: Outside\.\n/);
  assert.doesNotMatch(text, /Done\./);
  // Nothing found at all: nothing to check.
  assert.doesNotMatch(earlierText([clean], null).join('\n'), /Check that/);
});

test('a reviewer whose commands run in zsh is told what zsh does differently from bash; others are told nothing', () => {
  const text = shellText('zsh').join('\n');
  assert.match(text, /run in zsh, not bash/);
  assert.match(text, /`path` is PATH as an array/);
  assert.match(text, /A glob that matches nothing fails the whole command/);
  assert.match(text, /A heredoc needs a temporary file, and so does a here-string/);
  for (const shell of ['bash', 'sh', null, undefined]) assert.deepEqual(shellText(shell), []);
});
