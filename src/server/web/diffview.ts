import type { DiffLine, FileDiff, Hunk } from '../diff.ts';
import type { Side } from '../db.ts';
import type { Thread } from '../service.ts';
import { fileAnchor, html, icon, raw, type Safe } from './html.ts';
import { highlightLines, languageFor } from './markdown.ts';
import { copyButton } from './components.ts';

export type DiffMode = 'unified' | 'split';

export interface DiffViewOpts {
  mode: DiffMode;
  /** Threads keyed by threadKey(path, side, line). */
  threadsAt: Map<string, Thread[]>;
  renderThread: (t: Thread, suggestionLines: string[]) => Safe;
  viewed: Map<string, string>;
  /** Threads about a whole file, keyed by path. */
  fileThreads?: Map<string, Thread[]>;
}

export const threadKey = (path: string, side: Side, line: number) => `${path}\0${side}\0${line}`;

const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock|uv\.lock|bun\.lockb?)$/;

export function fileBlob(f: FileDiff): string {
  return f.newBlob ?? f.oldBlob ?? `${f.additions}-${f.deletions}`;
}

export function diffstatBlocks(add: number, del: number): Safe {
  const total = add + del;
  const g = total === 0 ? 0 : Math.round((add / total) * 5);
  const r = total === 0 ? 0 : Math.min(5 - g, Math.round((del / total) * 5));
  const blocks = [...Array(g).fill('add'), ...Array(r).fill('del'), ...Array(5 - g - r).fill('neutral')];
  return html`<span class="diffstat-blocks">${blocks.map((b) => html`<span class="diffstat-block-${b}"></span>`)}</span>`;
}

/** Highlight each side of a hunk as one block, so multi-line constructs colour correctly. */
function highlightHunk(h: Hunk, lang: string | undefined): Map<DiffLine, string> {
  const out = new Map<DiffLine, string>();
  const oldSide = h.lines.filter((l) => l.type !== 'add');
  const newSide = h.lines.filter((l) => l.type !== 'del');
  const oldHtml = highlightLines(oldSide.map((l) => l.text), lang);
  const newHtml = highlightLines(newSide.map((l) => l.text), lang);
  oldSide.forEach((l, i) => l.type === 'del' && out.set(l, oldHtml[i]));
  newSide.forEach((l, i) => out.set(l, newHtml[i]));
  return out;
}

const MARK = { add: '+', del: '-', context: ' ' } as const;

function codeCell(l: DiffLine | null, side: Side | null, code: string, path: string, extraCls = ''): Safe {
  if (!l || !side) return html`<td class="blob-code blob-code-empty ${extraCls}"></td>`;
  const line = side === 'RIGHT' ? l.newLine : l.oldLine;
  return html`<td class="blob-code blob-code-${l.type} ${extraCls}" data-side="${side}" data-line="${line}" data-path="${path}"><button type="button" class="add-line-comment" aria-label="Comment on line ${side === 'RIGHT' ? 'R' : 'L'}${line}">${icon('plus')}</button><span class="blob-marker">${MARK[l.type]}</span><span class="blob-code-inner">${raw(code)}</span>${l.noNewline ? html`<span class="no-newline" title="No newline at end of file">${icon('no-entry')}</span>` : ''}</td>`;
}

function threadsFor(o: DiffViewOpts, path: string, l: DiffLine): { left: Thread[]; right: Thread[] } {
  const right = l.type !== 'del' && l.newLine !== null ? (o.threadsAt.get(threadKey(path, 'RIGHT', l.newLine)) ?? []) : [];
  const left = l.type !== 'add' && l.oldLine !== null ? (o.threadsAt.get(threadKey(path, 'LEFT', l.oldLine)) ?? []) : [];
  return { left, right };
}

function suggestionSource(f: FileDiff, t: Thread): string[] {
  const side = t.root.side;
  const end = t.placement.line ?? t.root.line;
  const start = t.placement.startLine ?? t.root.start_line ?? end;
  if (side === null || end === null || start === null) return [];
  const out: string[] = [];
  for (const h of f.hunks) {
    for (const l of h.lines) {
      const n = side === 'RIGHT' ? (l.type === 'del' ? null : l.newLine) : l.type === 'add' ? null : l.oldLine;
      if (n !== null && n >= start && n <= end) out.push(l.text);
    }
  }
  return out;
}

function unifiedRows(f: FileDiff, o: DiffViewOpts, lang: string | undefined): Safe[] {
  const rows: Safe[] = [];
  for (const h of f.hunks) {
    const hl = highlightHunk(h, lang);
    rows.push(html`<tr class="hunk-row"><td class="blob-num blob-num-hunk" colspan="2"></td><td class="blob-code blob-code-hunk">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}</td></tr>`);
    for (const l of h.lines) {
      const side: Side = l.type === 'del' ? 'LEFT' : 'RIGHT';
      rows.push(html`<tr class="line ${l.type}"><td class="blob-num blob-num-${l.type}" data-num="${l.oldLine ?? ''}"></td><td class="blob-num blob-num-${l.type}" data-num="${l.newLine ?? ''}"></td>${codeCell(l, side, hl.get(l) ?? '', f.path)}</tr>`);
      const { left, right } = threadsFor(o, f.path, l);
      const all = [...left, ...right];
      if (all.length) {
        rows.push(html`<tr class="inline-comments"><td class="inline-comments-cell" colspan="3">${all.map((t) => o.renderThread(t, suggestionSource(f, t)))}</td></tr>`);
      }
    }
  }
  return rows;
}

function splitRows(f: FileDiff, o: DiffViewOpts, lang: string | undefined): Safe[] {
  const rows: Safe[] = [];
  for (const h of f.hunks) {
    const hl = highlightHunk(h, lang);
    rows.push(html`<tr class="hunk-row"><td class="blob-num blob-num-hunk"></td><td class="blob-code blob-code-hunk" colspan="3">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}</td></tr>`);
    const pairs: [DiffLine | null, DiffLine | null][] = [];
    for (let i = 0; i < h.lines.length; ) {
      const l = h.lines[i];
      if (l.type === 'context') {
        pairs.push([l, l]);
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < h.lines.length && h.lines[i].type === 'del') dels.push(h.lines[i++]);
      while (i < h.lines.length && h.lines[i].type === 'add') adds.push(h.lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) pairs.push([dels[k] ?? null, adds[k] ?? null]);
    }
    for (const [left, right] of pairs) {
      const lt = left?.type === 'context' ? 'context' : left ? 'del' : 'empty';
      const rt = right?.type === 'context' ? 'context' : right ? 'add' : 'empty';
      rows.push(html`<tr class="line split">
        <td class="blob-num blob-num-${lt}" data-num="${left?.oldLine ?? ''}"></td>${codeCell(left, left ? 'LEFT' : null, left ? (hl.get(left) ?? '') : '', f.path, 'split-left')}
        <td class="blob-num blob-num-${rt}" data-num="${right?.newLine ?? ''}"></td>${codeCell(right, right ? 'RIGHT' : null, right ? (hl.get(right) ?? '') : '', f.path)}
      </tr>`);
      const lThreads = left ? threadsFor(o, f.path, left).left : [];
      const rThreads = right ? threadsFor(o, f.path, right).right : [];
      if (lThreads.length || rThreads.length) {
        rows.push(html`<tr class="inline-comments"><td class="inline-comments-cell" colspan="2">${lThreads.map((t) => o.renderThread(t, suggestionSource(f, t)))}</td><td class="inline-comments-cell" colspan="2">${rThreads.map((t) => o.renderThread(t, suggestionSource(f, t)))}</td></tr>`);
      }
    }
  }
  return rows;
}

export function renderFile(f: FileDiff, o: DiffViewOpts): Safe {
  const lang = languageFor(f.path);
  const blob = fileBlob(f);
  const viewed = o.viewed.get(f.path) === blob;
  const changes = f.additions + f.deletions;
  const generated = LOCKFILES.test(f.path);
  const large = changes > 1500;
  const collapsed = viewed || generated || large;
  const maxLine = Math.max(1, ...f.hunks.map((h) => Math.max(h.oldStart + h.oldLines, h.newStart + h.newLines)));
  const numWidth = Math.max(3, String(maxLine).length) * 8 + 22;
  let body: Safe;
  if (f.binary) body = html`<div class="file-note">Binary file not shown.</div>`;
  else if (f.hunks.length === 0) {
    body = html`<div class="file-note">${f.status === 'renamed' ? 'File renamed without changes.' : f.status === 'changed' ? `File mode changed from ${f.oldMode} to ${f.newMode}.` : 'Empty file.'}</div>`;
  } else {
    const cols =
      o.mode === 'split'
        ? html`<colgroup><col style="width:${numWidth}px"><col><col style="width:${numWidth}px"><col></colgroup>`
        : html`<colgroup><col style="width:${numWidth}px"><col style="width:${numWidth}px"><col></colgroup>`;
    body = html`<table class="diff-table diff-${o.mode}">${cols}<tbody>${o.mode === 'split' ? splitRows(f, o, lang) : unifiedRows(f, o, lang)}</tbody></table>`;
  }
  const statusLabel =
    f.status === 'added' ? 'New file' : f.status === 'removed' ? 'Deleted' : f.status === 'renamed' ? 'Renamed' : f.status === 'copied' ? 'Copied' : f.status === 'changed' ? 'Mode changed' : '';
  return html`<div class="file" id="${fileAnchor(f.path)}" data-path="${f.path}" data-blob="${blob}">
  <div class="file-header">
    <button type="button" class="btn-octicon file-toggle js-file-toggle" aria-label="Toggle diff" aria-expanded="${!collapsed}">${icon('chevron-down', { cls: 'when-expanded' })}${icon('chevron-right', { cls: 'when-collapsed' })}</button>
    <span class="file-diffstat" title="${f.additions} additions & ${f.deletions} deletions">${changes} ${diffstatBlocks(f.additions, f.deletions)}</span>
    <a class="file-path" href="#${fileAnchor(f.path)}">${f.oldPath && f.newPath && f.oldPath !== f.newPath ? html`${f.oldPath} ${icon('arrow-right')} ${f.newPath}` : f.path}</a>
    ${copyButton(f.path, 'Copy file path')}
    ${statusLabel ? html`<span class="Label">${statusLabel}</span>` : ''}
    <span class="flex-auto"></span>
    <button type="button" class="btn btn-sm js-file-comment" title="Comment on this file">${icon('comment')}</button>
    <label class="viewed-check"><input type="checkbox" class="js-viewed"${viewed ? raw(' checked') : ''}> Viewed</label>
  </div>
  <div class="file-body"${collapsed ? raw(' hidden') : ''}>${body}</div>
  ${collapsed && !viewed ? html`<div class="file-note file-collapsed-note">${generated ? 'Generated files are not rendered by default.' : 'Large diffs are not rendered by default.'} <button type="button" class="btn-link js-file-toggle">Load diff</button></div>` : ''}
  <div class="file-threads">${(o.fileThreads?.get(f.path) ?? []).map((t) => o.renderThread(t, []))}</div>
</div>`;
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  file?: FileDiff;
}

export function fileTree(files: FileDiff[], viewed: Map<string, string>): Safe {
  const root: TreeNode = { name: '', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      let child = node.children.get(p);
      if (!child) {
        child = { name: p, children: new Map() };
        node.children.set(p, child);
      }
      if (i === parts.length - 1) child.file = f;
      node = child;
    });
  }
  const statusIcon: Record<string, string> = { added: 'diff-added', removed: 'diff-removed', renamed: 'diff-renamed', copied: 'diff-added', modified: 'diff-modified', changed: 'diff-modified' };
  const render = (node: TreeNode): Safe => {
    const entries = [...node.children.values()].sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name));
    return html`<ul>${entries.map((e) => {
      if (e.file) {
        const isViewed = viewed.get(e.file.path) === fileBlob(e.file);
        return html`<li class="tree-file${isViewed ? ' is-viewed' : ''}"><a href="#${fileAnchor(e.file.path)}" data-path="${e.file.path}">${icon('file')}<span class="tree-name">${e.name}</span>${icon(statusIcon[e.file.status], { cls: `tree-status tree-status-${e.file.status}` })}</a></li>`;
      }
      // Collapse chains of single directories ("src/server").
      let name = e.name;
      let dir = e;
      while (dir.children.size === 1 && ![...dir.children.values()][0].file) {
        dir = [...dir.children.values()][0];
        name += '/' + dir.name;
      }
      return html`<li class="tree-dir"><details open><summary>${icon('chevron-down', { cls: 'when-open' })}${icon('chevron-right', { cls: 'when-closed' })}${icon('file-directory-fill', { cls: 'tree-dir-icon' })}<span class="tree-name">${name}</span></summary>${render(dir)}</details></li>`;
    })}</ul>`;
  };
  return html`<nav class="file-tree" aria-label="Files">${render(root)}</nav>`;
}
