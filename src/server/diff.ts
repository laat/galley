export type LineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: LineType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewline?: boolean;
}

export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface Hunk extends HunkRange {
  /** The function/section heading git prints after the second @@. */
  section: string;
  lines: DiffLine[];
}

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** The path to show and to anchor comments on: the new path, or the old one for deletions. */
  path: string;
  status: FileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  oldBlob?: string;
  newBlob?: string;
  similarity?: number;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  /** The hunks as text, the way GitHub's API returns `patch`. */
  patch: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style quoting of unusual paths ("a/foo\tbar"). */
export function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = body[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string): string | null {
  const s = unquote(p.trim());
  if (s === '/dev/null') return null;
  return s.replace(/^[ab]\//, '');
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split('\n');
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let patchLines: string[] = [];

  const finish = () => {
    if (!file) return;
    file.patch = patchLines.join('\n');
    file.path = file.newPath ?? file.oldPath ?? '';
    files.push(file);
    file = null;
    hunk = null;
    patchLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      finish();
      const rest = line.slice('diff --git '.length);
      let oldPath: string | null = null;
      let newPath: string | null = null;
      if (rest.startsWith('"')) {
        const m = rest.match(/^("(?:[^"\\]|\\.)*") (.*)$/);
        if (m) {
          oldPath = stripPrefix(m[1]);
          newPath = stripPrefix(m[2]);
        }
      } else {
        // "a/<p> b/<p>": unambiguous when both halves are equal, which holds for everything but renames,
        // and renames are corrected by the "rename from/to" lines below.
        const half = (rest.length - 5) / 2;
        if (Number.isInteger(half) && rest.slice(2, 2 + half) === rest.slice(half + 5)) {
          oldPath = newPath = rest.slice(2, 2 + half);
        } else {
          const m = rest.match(/^a\/(.*) b\/(.*)$/);
          if (m) {
            oldPath = m[1];
            newPath = m[2];
          }
        }
      }
      file = { oldPath, newPath, path: '', status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0, patch: '' };
      continue;
    }
    if (!file) continue;
    const f: FileDiff = file;

    if (hunk === null) {
      // Extended header lines.
      if (line.startsWith('new file mode ')) {
        f.status = 'added';
        f.oldPath = null;
        f.newMode = line.slice(14);
      } else if (line.startsWith('deleted file mode ')) {
        f.status = 'removed';
        f.newPath = null;
        f.oldMode = line.slice(18);
      } else if (line.startsWith('old mode ')) {
        f.oldMode = line.slice(9);
        if (f.status === 'modified') f.status = 'changed';
      } else if (line.startsWith('new mode ')) {
        f.newMode = line.slice(9);
      } else if (line.startsWith('rename from ')) {
        f.oldPath = unquote(line.slice(12));
        f.status = 'renamed';
      } else if (line.startsWith('rename to ')) {
        f.newPath = unquote(line.slice(10));
      } else if (line.startsWith('copy from ')) {
        f.oldPath = unquote(line.slice(10));
        f.status = 'copied';
      } else if (line.startsWith('copy to ')) {
        f.newPath = unquote(line.slice(8));
      } else if (line.startsWith('similarity index ')) {
        f.similarity = parseInt(line.slice(17), 10);
      } else if (line.startsWith('index ')) {
        const m = line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/);
        if (m) {
          f.oldBlob = m[1];
          f.newBlob = m[2];
          if (m[3]) f.oldMode = f.newMode = f.newMode ?? m[3];
        }
      } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        f.binary = true;
      } else if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) f.oldPath = null;
      } else if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p === null) f.newPath = null;
      }
    }

    const hm = line.match(HUNK_RE);
    if (hm) {
      hunk = {
        oldStart: +hm[1],
        oldLines: hm[2] === undefined ? 1 : +hm[2],
        newStart: +hm[3],
        newLines: hm[4] === undefined ? 1 : +hm[4],
        section: hm[5] ?? '',
        lines: [],
      };
      f.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      patchLines.push(line);
      continue;
    }
    if (!hunk) continue;
    const h: Hunk = hunk;
    const oldLeft = h.oldStart + h.oldLines - oldNo;
    const newLeft = h.newStart + h.newLines - newNo;
    if (line.startsWith('\\')) {
      const last = h.lines[h.lines.length - 1];
      if (last) last.noNewline = true;
    } else if (oldLeft <= 0 && newLeft <= 0) {
      continue;
    } else if (line.startsWith('+')) {
      h.lines.push({ type: 'add', oldLine: null, newLine: newNo++, text: line.slice(1) });
      f.additions++;
    } else if (line.startsWith('-')) {
      h.lines.push({ type: 'del', oldLine: oldNo++, newLine: null, text: line.slice(1) });
      f.deletions++;
    } else if (line.startsWith(' ') || line === '') {
      h.lines.push({ type: 'context', oldLine: oldNo++, newLine: newNo++, text: line.slice(1) });
    } else {
      continue;
    }
    patchLines.push(line);
  }
  finish();
  return files;
}

export function parseHunkRanges(text: string): HunkRange[] {
  const out: HunkRange[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(HUNK_RE);
    if (m) {
      out.push({ oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4] });
    }
  }
  return out;
}

/**
 * Carry a line number from the old side of a zero-context diff to the new side.
 * Returns null when the line itself was changed or removed.
 */
export function mapLine(ranges: HunkRange[], line: number): number | null {
  let offset = 0;
  for (const r of ranges) {
    if (r.oldLines === 0) {
      // Pure insertion after line oldStart.
      if (line <= r.oldStart) break;
    } else {
      if (line < r.oldStart) break;
      if (line < r.oldStart + r.oldLines) return null;
    }
    offset += r.newLines - r.oldLines;
  }
  return line + offset;
}

/** Whether a zero-context diff changes any line in [first, last] of the old side, or inserts lines inside it. */
export function rangeTouched(ranges: HunkRange[], first: number, last: number): boolean {
  return ranges.some((r) => (r.oldLines === 0 ? r.oldStart >= first && r.oldStart < last : r.oldStart <= last && r.oldStart + r.oldLines - 1 >= first));
}

/**
 * The "diff_hunk" GitHub stores with a review comment: the hunk header followed by
 * the lines of the hunk up to and including the commented line (at most `max` lines).
 */
export function diffHunkFor(
  file: FileDiff,
  side: 'LEFT' | 'RIGHT',
  line: number,
  start?: { side: 'LEFT' | 'RIGHT'; line: number } | null,
  context = 4,
): string | null {
  const find = (h: Hunk, s: 'LEFT' | 'RIGHT', n: number) =>
    h.lines.findIndex((l) => (s === 'RIGHT' ? l.newLine === n && l.type !== 'del' : l.oldLine === n && l.type !== 'add'));
  for (const h of file.hunks) {
    const idx = find(h, side, line);
    if (idx === -1) continue;
    const startIdx = start ? find(h, start.side, start.line) : -1;
    const from = Math.max(0, Math.min(idx, startIdx === -1 ? idx : startIdx) - context);
    // The header describes the slice, so line numbers can be recovered from it.
    const before = h.lines.slice(0, from);
    const slice = h.lines.slice(from, idx + 1);
    const oldStart = h.oldStart + before.filter((l) => l.type !== 'add').length;
    const newStart = h.newStart + before.filter((l) => l.type !== 'del').length;
    const header = `@@ -${oldStart},${slice.filter((l) => l.type !== 'add').length} +${newStart},${slice.filter((l) => l.type !== 'del').length} @@${h.section ? ' ' + h.section : ''}`;
    const body = slice.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
    return [header, ...body].join('\n');
  }
  return null;
}

/** Whether a line on the given side is part of the diff (and so can carry a comment). */
export function lineInDiff(file: FileDiff, side: 'LEFT' | 'RIGHT', line: number): boolean {
  return file.hunks.some((h) => h.lines.some((l) => (side === 'RIGHT' ? l.newLine === line && l.type !== 'del' : l.oldLine === line && l.type !== 'add')));
}

// ------------------------------------------------------- expanded context

type Side = 'LEFT' | 'RIGHT';

/** Unchanged lines between hunks, or before the first or after the last: what a reviewer can expand. */
export interface Gap {
  /** First and last line on the new side. */
  newFrom: number;
  newTo: number;
  /** First line on the old side. */
  oldFrom: number;
}

/** Where a hunk's lines begin on one side; a hunk with no lines on a side sits after `start`. */
const begin = (start: number, count: number) => (count === 0 ? start + 1 : start);

/** The gaps around a file's hunks. The one after the last hunk needs `total`, the new side's line count. */
export function gaps(file: FileDiff, total: number | null): Gap[] {
  const out: Gap[] = [];
  let oldNext = 1;
  let newNext = 1;
  for (const h of file.hunks) {
    const nb = begin(h.newStart, h.newLines);
    if (nb > newNext) out.push({ newFrom: newNext, newTo: nb - 1, oldFrom: oldNext });
    newNext = nb + h.newLines;
    oldNext = begin(h.oldStart, h.oldLines) + h.oldLines;
  }
  if (file.hunks.length && total !== null && total >= newNext) out.push({ newFrom: newNext, newTo: total, oldFrom: oldNext });
  return out;
}

/** The new-side number of an unchanged line outside the hunks, or null for a line of the diff or past the end. */
export function expandedLine(file: FileDiff, side: Side, line: number, total: number): number | null {
  for (const g of gaps(file, total)) {
    const n = side === 'RIGHT' ? line : line - g.oldFrom + g.newFrom;
    if (n >= g.newFrom && n <= g.newTo) return n;
  }
  return null;
}

/** Where a line sits on the new side: its number there, or for a removed line, the number of the line after it. */
function newPosition(file: FileDiff, gs: Gap[], side: Side, line: number): number | null {
  if (side === 'RIGHT') return line;
  for (const g of gs) {
    const n = line - g.oldFrom + g.newFrom;
    if (n >= g.newFrom && n <= g.newTo) return n;
  }
  for (const h of file.hunks) {
    let n = begin(h.newStart, h.newLines);
    for (const l of h.lines) {
      if (l.type !== 'add' && l.oldLine === line) return n;
      if (l.type !== 'del') n++;
    }
  }
  return null;
}

/** Lines a review comment covers: `line` on `side`, from `startLine` on `startSide` for a range. */
export interface Span {
  side: Side;
  line: number;
  startSide?: Side | null;
  startLine?: number | null;
}

/**
 * The diff with unchanged lines added as context, as when a reviewer expands a hunk: the lines
 * of each span that lie outside the hunks, with `context` lines around them. Hunks that end up
 * touching are joined. `text` is the file on the new side.
 */
export function withContext(file: FileDiff, text: string[], spans: Span[], context = 3): FileDiff {
  const gs = gaps(file, text.length);
  const inGap = (n: number) => gs.some((g) => n >= g.newFrom && n <= g.newTo);
  // New-side ranges to add, per gap, so that hunks with no new lines between two gaps are kept.
  const ranges: [number, number, Gap][] = [];
  for (const s of spans) {
    const a = newPosition(file, gs, s.startSide ?? s.side, s.startLine ?? s.line);
    const b = newPosition(file, gs, s.side, s.line);
    if (a === null || b === null) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const from = inGap(lo) ? lo - context : lo;
    const to = inGap(hi) ? hi + context : hi;
    for (const g of gs) if (Math.max(from, g.newFrom) <= Math.min(to, g.newTo)) ranges.push([Math.max(from, g.newFrom), Math.min(to, g.newTo), g]);
  }
  if (ranges.length === 0) return file;
  const extra: Hunk[] = ranges.map(([from, to, g]) => {
    const oldStart = from - g.newFrom + g.oldFrom;
    const lines = text.slice(from - 1, to).map((t, i): DiffLine => ({ type: 'context', oldLine: oldStart + i, newLine: from + i, text: t }));
    return { oldStart, oldLines: lines.length, newStart: from, newLines: lines.length, section: '', lines };
  });
  const sorted = [...file.hunks, ...extra].sort((x, y) => begin(x.newStart, x.newLines) - begin(y.newStart, y.newLines) || begin(x.oldStart, x.oldLines) - begin(y.oldStart, y.oldLines));
  const hunks: Hunk[] = [];
  for (const h of sorted) {
    const prev = hunks[hunks.length - 1];
    const prevOldEnd = prev ? begin(prev.oldStart, prev.oldLines) + prev.oldLines : 0;
    const prevNewEnd = prev ? begin(prev.newStart, prev.newLines) + prev.newLines : 0;
    if (prev && prevNewEnd >= begin(h.newStart, h.newLines) && prevOldEnd >= begin(h.oldStart, h.oldLines)) {
      // Overlapping context (two spans in one gap) is dropped; touching hunks are joined.
      const seen = new Set(prev.lines.map((l) => l.newLine));
      const add = h.lines.filter((l) => l.type !== 'context' || !seen.has(l.newLine));
      const oldLines = prev.oldLines + add.filter((l) => l.type !== 'add').length;
      const newLines = prev.newLines + add.filter((l) => l.type !== 'del').length;
      const ob = begin(prev.oldStart, prev.oldLines);
      const nb = begin(prev.newStart, prev.newLines);
      hunks[hunks.length - 1] = { oldStart: oldLines ? ob : ob - 1, oldLines, newStart: newLines ? nb : nb - 1, newLines, section: prev.section || h.section, lines: [...prev.lines, ...add] };
    } else hunks.push(h);
  }
  return { ...file, hunks };
}
