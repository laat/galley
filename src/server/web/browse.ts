// The repository at a commit, read from git's objects (no checkout): directories, files and
// their bytes, at GitHub's URLs (/tree, /blob, /raw), with a file tree beside them, and the lines
// behind a diff's unfold arrows.
import type { Repo, TreeEntry } from '../git.ts';
import type { RepoRow } from '../db.ts';
import { lineInDiff, withContext, type DiffLine, type FileDiff, type Hunk, type Span } from '../diff.ts';
import { HttpError, type Service } from '../service.ts';
import { rendersByDefault } from '../../rendered.ts';
import { avatar, esc, html, icon, raw, relTime, shortSha, type Safe } from './html.ts';
import { highlightLines, languageFor, renderMarkdown } from './markdown.ts';
import { copyButton, layout, repoCrumbs, repoNav } from './components.ts';
import { browseUrl, lineRows, type DiffMode } from './diffview.ts';

/** A commit and a path in it, from a URL. */
export interface Location {
  repo: RepoRow;
  git: Repo;
  /** The full SHA of the commit. */
  sha: string;
  /** "" for the root directory. */
  path: string;
  /** The repository's URL in the web UI. */
  base: string;
}

/** Resolve a URL's commit and path. Paths are looked up in git's objects only, never on disk. */
export async function locate(s: Service, owner: string, name: string, ref: string, path = ''): Promise<Location> {
  const repo = s.repo(owner, name);
  const git = s.git(repo);
  const sha = /^[0-9a-f]{4,40}$/.test(ref) ? await git.resolve(ref) : null;
  if (!sha) throw new HttpError(404, `No commit ${ref} in ${owner}/${name}`);
  const parts = path.replace(/\/$/, '').split('/');
  if (path && parts.some((p) => p === '' || p === '.' || p === '..')) throw new HttpError(404, `No path ${path} at ${shortSha(sha)}`);
  return { repo, git, sha, path: parts.join('/'), base: `/${owner}/${name}` };
}

const MAX_SHOWN = 1024 * 1024;
const MAX_HIGHLIGHTED = 256 * 1024;

/** Served with their own type by /raw; everything else is text or a download. SVG is text: it can carry script. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

const extension = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** git's test: a NUL byte in the first 8000 bytes. */
const isBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);
const isMarkdown = (path: string) => /^(md|markdown|mdown|mkd)$/.test(extension(path));

function size(n: number): string {
  if (n < 1024) return `${n} Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

// ---------------------------------------------------------------- pages

async function page(s: Service, loc: Location, kind: 'tree' | 'blob', title: string, body: Safe): Promise<string> {
  return layout(s, {
    title: `${title} at ${shortSha(loc.sha)} · ${loc.repo.owner}/${loc.repo.name}`,
    crumbs: repoCrumbs(loc.repo),
    subnav: repoNav(s, loc.repo, null),
    body: html`<div class="container container-full browse-layout">${await browseTree(loc, kind)}<div class="browse">${body}</div></div>`,
  });
}

/** The commit being browsed and the path to here, each directory a link up the tree. */
async function header(loc: Location): Promise<Safe> {
  const parts = loc.path ? loc.path.split('/') : [];
  const crumbs = parts.map((p, i) => (i === parts.length - 1 ? html`<strong>${p}</strong>` : html`<a href="${browseUrl(loc.base, 'tree', loc.sha, parts.slice(0, i + 1).join('/'))}">${p}</a>`));
  const commit = await loc.git.commit(loc.sha);
  return html`<div class="browse-header">
    <button type="button" class="btn-octicon js-tree-toggle" data-tree="browse" aria-label="Toggle file tree" title="Toggle file tree">${icon('sidebar-collapse')}</button>
    <span class="browse-ref" title="${loc.sha}">${icon('git-commit')} <code>${shortSha(loc.sha)}</code></span>${copyButton(loc.sha, 'Copy full SHA')}
    <nav class="browse-crumbs" aria-label="Path">
      ${parts.length ? html`<a href="${browseUrl(loc.base, 'tree', loc.sha, '')}">${loc.repo.name}</a>` : html`<strong>${loc.repo.name}</strong>`}${crumbs.map((c) => html`<span class="crumb-sep">/</span>${c}`)}
    </nav>
    ${loc.path ? copyButton(loc.path, 'Copy path') : ''}
  </div>
  ${
    commit
      ? html`<div class="Box browse-commit">
    ${avatar(`/avatars/${encodeURIComponent(commit.authorName)}.svg`, commit.authorName, 20, 'avatar-circle')}
    <strong>${commit.authorName}</strong>
    <span class="browse-commit-title" title="${commit.message}">${commit.message.split('\n')[0]}</span>
    <span class="flex-auto"></span>
    <code class="color-fg-muted">${shortSha(commit.sha)}</code> · ${relTime(commit.committerDate)}
  </div>`
      : ''
  }`;
}

/** SVG images in Markdown go inline up to this size; a bigger one becomes a link. */
const MAX_INLINE_SVG = 256 * 1024;

/**
 * Point the links and images of a rendered Markdown file at this commit, as GitHub does:
 * relative ones from the file's directory, "/docs/x.md" from the repository's root. Links open
 * the file, images load from /raw. /raw serves SVG as text, so SVG images go inline as data:
 * URLs, which an <img> renders without running their scripts. Other images stay only when they
 * come from the web, as in comments. Render with `keepImageUrls`, so the URLs are still there.
 */
async function relativeLinks(htmlText: string, loc: Location, dir: string): Promise<string> {
  const unesc = (v: string) => v.replace(/&(amp|quot|lt|gt|#39);/g, (_, e: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[e]!);
  // The path a reference names in the repository; null for other sites ("//host/x"), schemes and anchors.
  const resolve = (ref: string): { path: string; hash: string } | null => {
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
    try {
      const url = new URL(ref, `http://repo/${dir ? dir.split('/').map(encodeURIComponent).join('/') + '/' : ''}`);
      return url.host === 'repo' ? { path: decodeURIComponent(url.pathname.slice(1)).replace(/\/$/, ''), hash: url.hash } : null;
    } catch {
      return null; // Not a URL we can follow ("100%.md").
    }
  };
  const rewrite = async (tag: string, name: string): Promise<string> => {
    const attr = tag.match(name === 'img' ? / src="([^"]*)"/ : / href="([^"]*)"/);
    if (!attr) return tag;
    const ref = unesc(attr[1]);
    const target = resolve(ref);
    const set = (url: string | null) => tag.replace(attr[0], () => (url === null ? '' : ` ${name === 'img' ? 'src' : 'href'}="${esc(url)}"`));
    // The root ("/", "../" from one level down) is a directory: its URL is /tree.
    if (name === 'a') return target ? set(browseUrl(loc.base, target.path ? 'blob' : 'tree', loc.sha, target.path) + target.hash) : tag;
    if (!target) return /^https?:\/\//i.test(ref) ? tag : set(null);
    if (!target.path) return set(null);
    if (extension(target.path) !== 'svg') return set(browseUrl(loc.base, 'raw', loc.sha, target.path));
    const bytes = await loc.git.blob(loc.sha, target.path);
    if (bytes && bytes.length <= MAX_INLINE_SVG) return set(`data:image/svg+xml;base64,${bytes.toString('base64')}`);
    const alt = unesc(tag.match(/ alt="([^"]*)"/)?.[1] ?? '') || baseName(target.path);
    return html`<a href="${browseUrl(loc.base, 'blob', loc.sha, target.path)}">${alt}</a>`.value;
  };
  let out = '';
  let at = 0;
  for (const m of htmlText.matchAll(/<(a|img)\b[^>]*>/g)) {
    out += htmlText.slice(at, m.index) + (await rewrite(m[0], m[1]));
    at = m.index + m[0].length;
  }
  return out + htmlText.slice(at);
}

function entryIcon(e: TreeEntry): Safe {
  if (e.type === 'tree') return icon('file-directory-fill', { cls: 'tree-dir-icon' });
  if (e.type === 'commit') return icon('file-submodule', { cls: 'tree-dir-icon' });
  if (e.mode === '120000') return icon('file-symlink-file');
  return icon('file');
}

/** Directories (and submodules) first, as GitHub lists them. */
const sortEntries = (entries: TreeEntry[]) => [...entries].sort((a, b) => (a.type === 'blob' ? 1 : 0) - (b.type === 'blob' ? 1 : 0) || a.name.localeCompare(b.name));

export async function treePage(s: Service, loc: Location, entries: TreeEntry[]): Promise<string> {
  const sorted = sortEntries(entries);
  const child = (e: TreeEntry) => (loc.path ? `${loc.path}/${e.name}` : e.name);
  const rows = sorted.map((e) =>
    e.type === 'commit'
      ? html`<tr><td class="tree-icon">${entryIcon(e)}</td><td class="tree-entry"><span title="Submodule">${e.name} @ <code>${shortSha(e.oid)}</code></span></td></tr>`
      : html`<tr><td class="tree-icon">${entryIcon(e)}</td><td class="tree-entry"><a href="${browseUrl(loc.base, e.type === 'tree' ? 'tree' : 'blob', loc.sha, child(e))}">${e.name}</a></td></tr>`,
  );
  const up = loc.path ? html`<tr><td class="tree-icon">${icon('file-directory-fill', { cls: 'tree-dir-icon' })}</td><td class="tree-entry"><a href="${browseUrl(loc.base, 'tree', loc.sha, dirName(loc.path))}" title="Up to the parent directory">..</a></td></tr>` : '';
  const readme = sorted.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name) && (e.size ?? 0) <= MAX_SHOWN);
  let readmeBox: Safe = raw('');
  if (readme) {
    const text = (await loc.git.blob(loc.sha, child(readme)))?.toString('utf8') ?? '';
    const body = isMarkdown(readme.name) ? html`<div class="markdown-body">${raw(await relativeLinks(renderMarkdown(text, { keepImageUrls: true }), loc, loc.path))}</div>` : html`<pre class="readme-text">${text}</pre>`;
    readmeBox = html`<div class="Box readme"><div class="Box-header readme-header">${icon('book')} <a href="${browseUrl(loc.base, 'blob', loc.sha, child(readme))}">${readme.name}</a></div><div class="readme-body">${body}</div></div>`;
  }
  return page(
    s,
    loc,
    'tree',
    loc.path ? `${loc.repo.name}/${loc.path}` : `${loc.repo.owner}/${loc.repo.name}`,
    html`${await header(loc)}
    <div class="Box tree-box"><table class="tree-table"><tbody>${up}${rows}</tbody></table></div>
    ${readmeBox}`,
  );
}

export async function blobPage(s: Service, loc: Location, entry: TreeEntry, opts: { plain: boolean }): Promise<string> {
  const bytes = (await loc.git.blob(loc.sha, loc.path)) ?? Buffer.alloc(0);
  const ext = extension(loc.path);
  const rawUrl = browseUrl(loc.base, 'raw', loc.sha, loc.path);
  const here = browseUrl(loc.base, 'blob', loc.sha, loc.path);
  const binary = isBinary(bytes);
  const text = binary || bytes.length > MAX_SHOWN ? '' : bytes.toString('utf8');
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  // Markdown and SVG show rendered, with the source a click away, as on GitHub.
  const renderable = !binary && text !== '' && rendersByDefault(loc.path);
  const rendered = renderable && !opts.plain;

  let body: Safe;
  if (IMAGE_TYPES[ext]) body = html`<div class="blob-image"><img src="${rawUrl}" alt="${baseName(loc.path)}"></div>`;
  else if (bytes.length > MAX_SHOWN) body = html`<div class="blob-note">This file is too big to show (${size(bytes.length)}). <a href="${rawUrl}">View raw</a></div>`;
  else if (binary) body = html`<div class="blob-note">Binary file not shown. <a href="${rawUrl}">Download</a></div>`;
  else if (bytes.length === 0) body = html`<div class="blob-note">This file is empty.</div>`;
  else if (rendered && ext === 'svg') {
    // A data: URL in an <img> renders the picture without running any script in it.
    body = html`<div class="blob-image"><img src="data:image/svg+xml;base64,${bytes.toString('base64')}" alt="${baseName(loc.path)}"></div>`;
  } else if (rendered) {
    body = html`<div class="markdown-body blob-markdown">${raw(await relativeLinks(renderMarkdown(text, { keepImageUrls: true }), loc, dirName(loc.path)))}</div>`;
  } else {
    const code = bytes.length <= MAX_HIGHLIGHTED ? highlightLines(lines, languageFor(loc.path)) : lines.map(esc);
    body = html`<table class="blob-table"><tbody>${code.map((c, i) => html`<tr><td id="L${i + 1}" class="blob-num js-line-number" data-num="${i + 1}"></td><td class="blob-code">${raw(c)}</td></tr>`)}</tbody></table>`;
  }
  const toggle =
    renderable
      ? html`<div class="BtnGroup"><a class="btn btn-sm BtnGroup-item${opts.plain ? '' : ' selected'}" href="${here}">Preview</a><a class="btn btn-sm BtnGroup-item${opts.plain ? ' selected' : ''}" href="${here}?plain=1">Code</a></div>`
      : '';
  const meta = [entry.mode === '120000' ? 'Symbolic link' : entry.mode === '100755' ? 'Executable file' : '', text ? `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` : '', size(bytes.length)].filter(Boolean).join(' · ');
  return page(
    s,
    loc,
    'blob',
    `${loc.repo.name}/${loc.path}`,
    html`${await header(loc)}
    <div class="Box blob-box">
      <div class="Box-header blob-header">${toggle}<span class="blob-meta">${meta}</span><span class="flex-auto"></span><a class="btn btn-sm" href="${rawUrl}">Raw</a></div>
      <div class="blob-body"${rendered ? html` data-plain="${here}?plain=1"` : ''}>${body}</div>
    </div>`,
  );
}

// ------------------------------------------------------------ file tree

/**
 * The items of directory `dir` in the file tree beside a page. Directories in `open` come open
 * with their items; public/app.js loads the others' from /file-tree when they open. The entry at
 * `current`, the page's own path, is highlighted.
 */
async function treeItems(loc: Location, dir: string, open: Set<string>, current: string | null): Promise<Safe[]> {
  const entries = sortEntries((await loc.git.tree(loc.sha, dir)) ?? []);
  return Promise.all(
    entries.map(async (e) => {
      const path = dir ? `${dir}/${e.name}` : e.name;
      const here = path === current ? raw(' aria-current="page"') : '';
      if (e.type === 'tree') {
        const items = open.has(path) ? html`<ul>${await treeItems(loc, path, open, current)}</ul>` : '';
        return html`<li class="tree-dir"><details data-path="${path}"${items ? raw(' open') : ''}><summary>${icon('chevron-down', { cls: 'when-open' })}${icon('chevron-right', { cls: 'when-closed' })}${entryIcon(e)}<a class="tree-name" href="${browseUrl(loc.base, 'tree', loc.sha, path)}"${here}>${e.name}</a></summary>${items}</details></li>`;
      }
      if (e.type === 'commit') return html`<li class="tree-file" title="Submodule at ${shortSha(e.oid)}">${entryIcon(e)}<span class="tree-name">${e.name}</span></li>`;
      return html`<li class="tree-file"><a href="${browseUrl(loc.base, 'blob', loc.sha, path)}"${here}>${entryIcon(e)}<span class="tree-name">${e.name}</span></a></li>`;
    }),
  );
}

/**
 * The file tree beside a page, like GitHub's code view: the directories down to the page open,
 * the page highlighted, and a "Go to file" box over every path in the commit (/tree-list).
 */
async function browseTree(loc: Location, kind: 'tree' | 'blob'): Promise<Safe> {
  const parts = loc.path ? loc.path.split('/') : [];
  const dirs = kind === 'tree' ? parts : parts.slice(0, -1);
  const open = new Set(dirs.map((_, i) => dirs.slice(0, i + 1).join('/')));
  return html`<nav class="file-tree browse-tree js-browse-tree" aria-label="Files" data-sha="${loc.sha}" data-items="${loc.base}/file-tree/${loc.sha}" data-paths="${loc.base}/tree-list/${loc.sha}" data-blob="${browseUrl(loc.base, 'blob', loc.sha, '')}">
    <div class="browse-tree-filter"><input type="search" class="form-control js-browse-filter" placeholder="Go to file" aria-label="Go to file" autocomplete="off" spellcheck="false"></div>
    <ul class="browse-tree-results js-browse-results" hidden></ul>
    <ul class="js-browse-items">${await treeItems(loc, '', open, loc.path)}</ul>
  </nav>`;
}

/** A directory's items in the file tree, for /file-tree; null when there is no directory at the path. */
export async function treeItemsHtml(loc: Location): Promise<string | null> {
  if (!(await loc.git.tree(loc.sha, loc.path))) return null;
  return html`<ul>${await treeItems(loc, loc.path, new Set(), null)}</ul>`.value;
}

// ------------------------------------------------------------------ raw

/**
 * The file's bytes. Nothing served here may run script on this origin, since the API can push
 * to GitHub: HTML, SVG and other text go out as text/plain, unknown binaries as downloads, and
 * every response carries `nosniff` and a sandboxing Content-Security-Policy. Other sites cannot
 * embed it either (Cross-Origin-Resource-Policy).
 */
export async function rawFile(loc: Location): Promise<Response> {
  const bytes = await loc.git.blob(loc.sha, loc.path);
  if (!bytes) throw new HttpError(404, `No file ${loc.path} at ${shortSha(loc.sha)}`);
  const image = IMAGE_TYPES[extension(loc.path)];
  const headers: Record<string, string> = {
    'content-type': image ?? (isBinary(bytes) ? 'application/octet-stream' : 'text/plain; charset=utf-8'),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
  };
  if (!image && isBinary(bytes)) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(baseName(loc.path))}`;
  return new Response(new Uint8Array(bytes), { headers });
}

// -------------------------------------------------------------- excerpt

/**
 * Lines `from`..`to` of a file as diff rows, for the unfold arrows: unchanged lines, so their
 * old numbers are the new ones minus `delta`. Like GitHub's /blob_excerpt.
 */
export async function excerpt(loc: Location, q: { from: number; to: number; delta: number; mode: DiffMode }): Promise<string> {
  const lines = await loc.git.lines(loc.sha, loc.path);
  if (!lines) throw new HttpError(404, `No file ${loc.path} at ${shortSha(loc.sha)}`);
  const from = Math.max(1, q.from);
  const to = Math.min(lines.length, q.to);
  if (to < from) return '';
  const hunkLines = lines.slice(from - 1, to).map((text, i): DiffLine => ({ type: 'context', oldLine: from - q.delta + i, newLine: from + i, text }));
  const hunk: Hunk = { oldStart: from - q.delta, oldLines: hunkLines.length, newStart: from, newLines: hunkLines.length, section: '', lines: hunkLines };
  return html`${lineRows({ path: loc.path } as FileDiff, hunk, { mode: q.mode, threadsAt: new Map(), renderThread: () => raw('') })}`.value;
}

/**
 * A diff's files ready for the Files changed tab: threads on lines outside the hunks (lines a
 * reviewer expanded to) show with the lines around them, and each file's length on the new
 * side tells the unfold arrows where it ends.
 */
export async function withThreadContext(git: Repo, head: string, files: FileDiff[], spans: Map<string, Span[]>): Promise<{ files: FileDiff[]; totals: Map<string, number> }> {
  const totals = await git.lineCounts(head, files.filter((f) => f.newPath && f.hunks.length).map((f) => f.newPath!));
  const shown = await Promise.all(
    files.map(async (f) => {
      const outside = (spans.get(f.path) ?? []).filter((sp) => !lineInDiff(f, sp.side, sp.line) || (sp.startLine && !lineInDiff(f, sp.startSide ?? sp.side, sp.startLine)));
      return outside.length && f.newPath ? withContext(f, (await git.lines(head, f.newPath)) ?? [], outside) : f;
    }),
  );
  return { files: shown, totals };
}
