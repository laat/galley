import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawCommit } from '../src/server/git.ts';
import { diffHunkFor, expandedLine, gaps, lineInDiff, mapLine, parseDiff, parseHunkRanges, rangeTouched, unquote, withContext } from '../src/server/diff.ts';

const DIFF = `diff --git a/math.js b/math.js
index 1111111..2222222 100644
--- a/math.js
+++ b/math.js
@@ -1,4 +1,5 @@ header
 a
-b
+B
+B2
 c
 d
@@ -10,2 +11,2 @@ fn()
 x
-y
\\ No newline at end of file
+y
diff --git a/new file.txt b/new file.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/renamed.txt
similarity index 90%
rename from old.txt
rename to renamed.txt
index 4444444..5555555 100644
--- a/old.txt
+++ b/renamed.txt
@@ -1 +1 @@
-one
+uno
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 6666666..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/img.png b/img.png
index 7777777..8888888 100644
Binary files a/img.png and b/img.png differ
`;

test('parseDiff reads statuses, paths and line numbers', () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]),
    [
      ['math.js', 'modified', 3, 2, false],
      ['new file.txt', 'added', 1, 0, false],
      ['renamed.txt', 'renamed', 1, 1, false],
      ['gone.txt', 'removed', 0, 1, false],
      ['img.png', 'modified', 0, 0, true],
    ],
  );
  const math = files[0];
  assert.equal(math.hunks.length, 2);
  assert.equal(math.hunks[0].section, 'header');
  assert.deepEqual(
    math.hunks[0].lines.map((l) => [l.type, l.oldLine, l.newLine, l.text]),
    [
      ['context', 1, 1, 'a'],
      ['del', 2, null, 'b'],
      ['add', null, 2, 'B'],
      ['add', null, 3, 'B2'],
      ['context', 3, 4, 'c'],
      ['context', 4, 5, 'd'],
    ],
  );
  assert.equal(math.hunks[1].lines[1].noNewline, true);
  assert.equal(files[2].oldPath, 'old.txt');
  assert.equal(files[3].newPath, null);
  assert.ok(math.patch.startsWith('@@ -1,4 +1,5 @@ header\n a\n-b'));
});

test('lineInDiff knows which side a line is on', () => {
  const [math] = parseDiff(DIFF);
  assert.equal(lineInDiff(math, 'RIGHT', 3), true);
  assert.equal(lineInDiff(math, 'LEFT', 2), true);
  assert.equal(lineInDiff(math, 'RIGHT', 7), false);
});

test('gaps are the unchanged lines around the hunks, and expandedLine finds lines in them', () => {
  // math.js: hunks at new lines 1-5 and 11-12; 15 lines in all on the new side.
  const [math] = parseDiff(DIFF);
  assert.deepEqual(gaps(math, 15), [
    { newFrom: 6, newTo: 10, oldFrom: 5 },
    { newFrom: 13, newTo: 15, oldFrom: 12 },
  ]);
  assert.deepEqual(gaps(math, null), [{ newFrom: 6, newTo: 10, oldFrom: 5 }]);
  assert.equal(expandedLine(math, 'RIGHT', 8, 15), 8);
  assert.equal(expandedLine(math, 'LEFT', 7, 15), 8);
  assert.equal(expandedLine(math, 'RIGHT', 3, 15), null);
  assert.equal(expandedLine(math, 'RIGHT', 16, 15), null);
  assert.equal(expandedLine(math, 'LEFT', 14, 15), 15);
});

test('withContext adds the lines around a span as context, joining hunks that touch', () => {
  const [math] = parseDiff(DIFF);
  const text = ['a', 'B', 'B2', 'c', 'd', 'l6', 'l7', 'l8', 'l9', 'l10', 'x', 'y', 'l13', 'l14', 'l15'];
  const one = withContext(math, text, [{ side: 'RIGHT', line: 8 }], 1);
  assert.deepEqual(
    one.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
    [
      [1, 4, 1, 5],
      [6, 3, 7, 3],
      [10, 2, 11, 2],
    ],
  );
  assert.deepEqual(one.hunks[1].lines.map((l) => [l.oldLine, l.newLine, l.text]), [[6, 7, 'l7'], [7, 8, 'l8'], [8, 9, 'l9']]);
  // With three lines around line 8 the gap is gone: one hunk from line 1 to 12.
  const joined = withContext(math, text, [{ side: 'LEFT', line: 7 }]);
  assert.deepEqual(joined.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]), [[1, 11, 1, 12]]);
  assert.equal(diffHunkFor(joined, 'RIGHT', 8)!.split('\n')[0], '@@ -3,5 +4,5 @@ header');
  // A range from a removed line into the gap shows every line between them.
  const range = withContext(math, text, [{ startSide: 'LEFT', startLine: 2, side: 'RIGHT', line: 7 }], 0);
  assert.deepEqual(range.hunks.map((h) => [h.newStart, h.newLines]), [[1, 7], [11, 2]]);
  // Spans inside the hunks change nothing.
  assert.equal(withContext(math, text, [{ side: 'RIGHT', line: 3 }]), math);
});

test('mapLine carries lines across insertions and marks changed lines', () => {
  // Two lines inserted after line 0 (at the top), line 5 replaced.
  const ranges = parseHunkRanges('@@ -0,0 +1,2 @@\n+x\n+y\n@@ -5 +7 @@\n-old\n+new\n');
  assert.equal(mapLine(ranges, 1), 3);
  assert.equal(mapLine(ranges, 4), 6);
  assert.equal(mapLine(ranges, 5), null);
  assert.equal(mapLine(ranges, 9), 11);
  // A deletion before the line shifts it up.
  assert.equal(mapLine(parseHunkRanges('@@ -2,2 +1,0 @@\n-a\n-b\n'), 10), 8);
  assert.equal(mapLine([], 4), 4);
});

test('rangeTouched sees changes inside a commented range', () => {
  const changed4 = parseHunkRanges('@@ -4 +4 @@\n-a\n+b\n');
  assert.equal(rangeTouched(changed4, 3, 5), true);
  assert.equal(rangeTouched(changed4, 5, 7), false);
  const insertAfter4 = parseHunkRanges('@@ -4,0 +5 @@\n+x\n');
  assert.equal(rangeTouched(insertAfter4, 3, 5), true);
  assert.equal(rangeTouched(insertAfter4, 4, 4), false);
  assert.equal(rangeTouched(insertAfter4, 5, 6), false);
});

test('diffHunkFor rewrites the header to match the slice', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`).join('\n');
  const [f] = parseDiff(`diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1,12 @@\n${lines}\n`);
  const hunk = diffHunkFor(f, 'RIGHT', 10, { side: 'RIGHT', line: 8 })!;
  const [header, ...body] = hunk.split('\n');
  assert.equal(header, '@@ -0,0 +4,7 @@');
  assert.equal(body[0], '+line 4');
  assert.equal(body.at(-1), '+line 10');
});

test('parseRawCommit keeps what is needed to recreate a commit', () => {
  const raw = [
    'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    'parent 1111111111111111111111111111111111111111',
    'parent 2222222222222222222222222222222222222222',
    'author Agent Smith <agent@example.com> 1760630400 +0200',
    'committer Agent Smith <agent@example.com> 1760630400 +0200',
    'gpgsig -----BEGIN SSH SIGNATURE-----',
    ' U1NIU0lH',
    ' -----END SSH SIGNATURE-----',
    '',
    'Subject',
    '',
    'Body with a blank line above.',
    '',
  ].join('\n');
  const c = parseRawCommit(raw);
  assert.equal(c.tree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(c.parents.length, 2);
  assert.deepEqual(c.author, { name: 'Agent Smith', email: 'agent@example.com', date: '1760630400 +0200' });
  assert.equal(c.signed, true);
  assert.equal(c.message, 'Subject\n\nBody with a blank line above.\n');
});

test('unquote decodes git C-style quoting', () => {
  assert.equal(unquote('"a/tab\\there"'), 'a/tab\there');
  assert.equal(unquote('"\\303\\246\\303\\270\\303\\245"'), 'æøå');
  assert.equal(unquote('plain'), 'plain');
});
