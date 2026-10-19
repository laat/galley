import { PRIORITIES, type Actor, type CommentRow, type Priority, type PullRow, type RepoRow } from '../db.ts';
import { githubStatus, type Service, type Thread } from '../service.ts';
import { checksSummary } from '../github-follow.ts';
import { avatarUrl, commentUrl } from '../github.ts';
import { avatar, html, icon, plural, raw, relTime, shortSha, type Safe } from './html.ts';
import { highlightLines, languageFor, renderMarkdown } from './markdown.ts';
import type { ReferenceContext } from './references.ts';
import { askingComputer } from '../computer.ts';

/** galley's logo in the header: the app's icon (desktop/icons/icon.svg) without its margin, so that its tile fills the 28px. */
const LOGO = raw(
  `<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">` +
    `<path fill="#3d73b6" d="M22.01 0L41.99 0C48.33 0 51.49 0 54.91 1.08C58.63 2.43 61.57 5.37 62.92 9.09C64 12.51 64 15.67 64 22.01L64 41.99C64 48.33 64 51.49 62.92 54.91C61.57 58.63 58.63 61.57 54.91 62.92C51.49 64 48.33 64 41.99 64L22.01 64C15.67 64 12.51 64 9.09 62.92C5.37 61.57 2.43 58.63 1.08 54.91C0 51.49 0 48.33 0 41.99L0 22.01C0 15.67 0 12.51 1.08 9.09C2.43 5.37 5.37 2.43 9.09 1.08C12.51 0 15.67 0 22.01 0Z"/>` +
    `<path fill="#fbf7ef" d="M33.6 34.39L51.6 34.39L51.6 42.72L47.53 45.59C44.16 50.14 38.88 52.8 32.4 52.8C21.82 52.8 14.44 45.71 13.34 34.87L22.51 34.29C23.17 41.39 26.98 46 32.4 46C36.05 46 38.96 43.91 40.68 40.39L33.6 40.39ZM14.63 23.38C17.36 15.85 23.83 11.2 32.4 11.2C36.26 11.2 39.7 12.14 42.56 13.87L42.56 13.85L48 13.85L48 21.69L39.52 21.69C37.78 19.34 35.32 18 32.4 18C28.92 18 26.11 19.9 24.36 23.14L14.63 23.38Z"/>` +
    `<path fill="#f05a42" d="M11.41 32.58C11.34 32.59 11.27 32.59 11.2 32.59C10.31 32.59 9.45 32.23 8.82 31.6C8.19 30.97 7.84 30.12 7.84 29.23C7.84 28.34 8.19 27.48 8.82 26.85C9.43 26.24 10.26 25.89 11.12 25.87L53.53 24.82L53.54 24.82C53.56 24.82 53.58 24.82 53.6 24.82C54.28 24.82 54.93 25.09 55.41 25.57C55.89 26.05 56.16 26.7 56.16 27.38C56.16 28.06 55.89 28.71 55.41 29.19C54.97 29.63 54.38 29.89 53.76 29.93Z"/>` +
    `</svg>`,
);

export function layout(s: Service, opts: { title: string; crumbs?: Safe; body: Safe; live?: number | 'all'; data?: Record<string, string | number> }): string {
  const viewer = s.viewer();
  const data = Object.entries(opts.data ?? {}).map(([k, v]) => html` data-${raw(k)}="${v}"`);
  // The server was asked to stop, and lets the running reviews post first. Live updates swap it along with #main.
  const running = s.stopping ? s.reviewsRunning() : 0;
  const waiting = `Waiting for ${plural(running, 'running review')} to finish before the server stops.`;
  // Whether the desktop app on the browser's computer follows the server and opens galley links,
  // for a page opened in the browser to hand off to it (public/app.js). Only on load: live updates
  // leave it as it was.
  const desktop = s.desktopApp(askingComputer());
  const desktopApp = desktop.openLinks ? 'open-links' : desktop.connected ? 'connected' : '';
  return (
    '<!doctype html>' +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<link rel="icon" href="/static/favicon.png" sizes="32x32" type="image/png">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body data-live="${opts.live ?? ''}" data-viewer="${viewer.login}" data-desktop-app="${desktopApp}">
<header class="app-header-wrap">
<div class="app-header">
  <a class="app-header-logo" href="/" title="All staged pull requests" aria-label="galley">${LOGO}</a>
  <nav class="app-header-context">${opts.crumbs ?? ''}</nav>
  <div class="app-header-actions">
    ${running ? html`<span id="server-stopping" class="stopping-indicator" role="status" title="${waiting}" aria-label="${waiting}">${icon('alert')}<span class="stopping-indicator-long">Stopping · ${plural(running, 'review')} running</span><span class="stopping-indicator-short">${running}</span></span>` : html`<span id="server-stopping" hidden></span>`}
    <a class="app-header-avatar" href="/settings" title="Settings" aria-label="Settings">${avatar(avatarUrl(s, viewer), viewer.login, 28, 'avatar-circle')}</a>
  </div>
</div>
</header>
<div id="main"${data}>${opts.body}</div>
<div id="toast" class="toast" hidden></div>
</body>
</html>`.value
  );
}

export function repoCrumbs(repo: RepoRow, extra?: Safe): Safe {
  return html`<a href="/${repo.owner}/${repo.name}"><strong>${repo.owner}/${repo.name}</strong></a>${extra ?? ''}`;
}

/**
 * Staged in a colour of its own, not GitHub's green for open: a staged pull request is not open
 * anywhere yet. Published, it is open on GitHub and takes GitHub's green; merged, GitHub's purple;
 * closed, here or on GitHub, red. `unpublished`: published, with changes GitHub does not have yet
 * (Service.unpublishedChanges), which are staged.
 */
export function stateBadge(pull: PullRow, size: 'md' | 'sm' = 'md', unpublished = false): Safe {
  const cls = size === 'sm' ? ' State--small' : '';
  if (pull.github_state === 'merged') return html`<span class="State State--merged${cls}" title="Merged on GitHub">${icon('git-merge')} Merged</span>`;
  if (pull.state === 'closed') return html`<span class="State State--closed${cls}">${icon('git-pull-request-closed')} Closed</span>`;
  if (pull.github_state === 'closed') return html`<span class="State State--closed${cls}" title="Closed on GitHub">${icon('git-pull-request-closed')} Closed on GitHub</span>`;
  if (pull.state === 'published' && unpublished) return html`<span class="State State--staged${cls}">${icon('git-pull-request')} Update not published</span>`;
  if (pull.state === 'published') return html`<span class="State State--published${cls}">${icon('mark-github')} Published</span>`;
  if (pull.draft) return html`<span class="State State--draft${cls}">${icon('git-pull-request-draft')} Draft</span>`;
  return html`<span class="State State--staged${cls}">${icon('git-pull-request')} Staged</span>`;
}

export function pullIcon(pull: PullRow, unpublished = false): Safe {
  if (pull.github_state === 'merged') return icon('git-merge', { cls: 'color-fg-done' });
  if (pull.state === 'closed' || pull.github_state === 'closed') return icon('git-pull-request-closed', { cls: 'color-fg-closed' });
  if (pull.state === 'published' && unpublished) return icon('git-pull-request', { cls: 'color-fg-staged' });
  if (pull.state === 'published') return icon('mark-github', { cls: 'color-fg-open' });
  if (pull.draft) return icon('git-pull-request-draft', { cls: 'color-fg-muted' });
  return icon('git-pull-request', { cls: 'color-fg-staged' });
}

/** A published pull request's checks on GitHub as one icon, as GitHub's lists show them. */
export function checksIndicator(pull: PullRow): Safe {
  const g = githubStatus(pull);
  const s = g ? checksSummary(g) : null;
  if (!s?.result) return raw('');
  // Counts are of the first page of checks; the result is GitHub's for all of them.
  const some = (n: number, what: string) => (n ? `${n} of ${s.total} checks ${what} on GitHub` : `Checks ${what} on GitHub`);
  const title = s.result === 'failed' ? some(s.failed, 'failed') : s.result === 'pending' ? some(s.pending, 'in progress') : `All ${s.total} checks passed on GitHub`;
  const [name, cls] = s.result === 'failed' ? ['x', 'color-fg-danger'] : s.result === 'pending' ? ['dot-fill', 'color-fg-attention'] : ['check', 'color-fg-success'];
  return html`<span class="checks-indicator" title="${title}">${icon(name, { cls, label: title })}</span>`;
}

/** An author's name. A reviewer agent's links to its settings, found by its actor since its name is a setting. */
export function authorLink(s: Service, a: Actor): Safe {
  const reviewer = s.reviewerAgents().find((r) => r.actor().id === a.id);
  const title = reviewer ? `Settings for ${a.login}` : a.type === 'Bot' ? 'agent' : 'reviewer';
  return html`<a class="author" href="${reviewer?.settingsUrl() ?? '#'}" title="${title}">${a.login}</a>${a.type === 'Bot' ? html`<span class="Label Label--bot">bot</span>` : ''}`;
}

export function markdownEditor(opts: { name?: string; value?: string; placeholder?: string; draftKey?: string; suggestion?: boolean; autofocus?: boolean; rows?: number }): Safe {
  return html`<div class="md-editor">
  <div class="md-editor-header">
    <div class="md-tabs" role="tablist">
      <button type="button" class="md-tab selected" data-tab="write">Write</button>
      <button type="button" class="md-tab" data-tab="preview">Preview</button>
    </div>
    <div class="md-toolbar">
      ${opts.suggestion ? html`<button type="button" class="md-toolbar-btn js-insert-suggestion" title="Insert a suggestion">${icon('file-diff')}</button>` : ''}
      <button type="button" class="md-toolbar-btn js-attach-image" title="Attach an image" aria-label="Attach an image">${icon('image')}</button>
    </div>
  </div>
  <textarea class="form-control md-input" name="${opts.name ?? 'body'}" rows="${opts.rows ?? 5}" placeholder="${opts.placeholder ?? 'Leave a comment'}"${opts.draftKey ? html` data-draft-key="${opts.draftKey}"` : ''}${opts.autofocus ? raw(' autofocus') : ''}>${opts.value ?? ''}</textarea>
  <div class="md-preview markdown-body" hidden></div>
  <p class="md-hint">${icon('markdown')} Markdown is supported. Paste or drop images. <kbd>⌘</kbd> <kbd>Enter</kbd> submits.</p>
</div>`;
}

export interface CommentView {
  id: number;
  author: Actor;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** API path for PATCH and DELETE, if the viewer may edit. */
  editPath?: string;
  /** PATCH field name when it is not "body" (e.g. the pull request body). */
  pending?: boolean;
  isAuthor?: boolean;
  anchor: string;
  /** Where its menu's Copy link points: the API's `html_url` (commentUrl). */
  link: string;
  markdownCtx?: Parameters<typeof renderMarkdown>[1];
  deletable?: boolean;
}

const PRIORITY_TEXT = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function priorityPill(priority: Priority | null): Safe {
  return priority ? html`<span class="Label Label--priority Label--priority-${priority}" title="Priority">${PRIORITY_TEXT[priority]}</span>` : raw('');
}

/** How many findings there are of each priority, highest first, as pills: "2 High", "1 unprioritized". */
export function priorityCounts(found: (Priority | null)[]): Safe[] {
  return [...PRIORITIES, null].flatMap((priority) => {
    const n = found.filter((f) => f === priority).length;
    return n ? [html`<span class="Label Label--priority${priority ? ` Label--priority-${priority}` : ''}">${n} ${priority ? PRIORITY_TEXT[priority] : 'unprioritized'}</span>`] : [];
  });
}

/** A full-width comment with avatar, as used in the conversation timeline. */
export function timelineComment(s: Service, c: CommentView, header?: Safe): Safe {
  const edited = c.updatedAt !== c.createdAt;
  return html`<div class="timeline-comment-group" id="${c.anchor}">
  <span class="timeline-avatar">${avatar(avatarUrl(s, c.author), c.author.login, 40, c.author.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')}</span>
  <div class="timeline-comment${c.author.type === 'User' ? ' timeline-comment--viewer' : ''}">
    <div class="timeline-comment-header">
      <h3 class="timeline-comment-header-text">${header ?? html`${authorLink(s, c.author)} commented <a href="#${c.anchor}" class="link-muted">${relTime(c.createdAt)}</a>`}${edited ? html` <span class="edited">· edited</span>` : ''}</h3>
      <div class="timeline-comment-actions">
        ${c.isAuthor ? html`<span class="Label">Author</span>` : ''}
        ${commentMenu(c)}
      </div>
    </div>
    ${commentBodyAndEditor(c)}
  </div>
</div>`;
}

function commentMenu(c: CommentView): Safe {
  return html`<details class="dropdown details-reset">
    <summary class="timeline-comment-action" aria-label="Show options">${icon('kebab-horizontal')}</summary>
    <div class="dropdown-menu dropdown-menu-sw">
      <button type="button" class="dropdown-item js-copy-link" data-copy="${c.link}">Copy link</button>
      ${
        c.editPath
          ? html`<div class="dropdown-divider"></div>
      <button type="button" class="dropdown-item js-comment-edit">Edit</button>
      ${c.deletable !== false ? html`<button type="button" class="dropdown-item dropdown-item-danger js-comment-delete" data-path="${c.editPath}">Delete</button>` : ''}`
          : ''
      }
    </div>
  </details>`;
}

function commentBodyAndEditor(c: CommentView): Safe {
  const body = renderMarkdown(c.body, c.markdownCtx);
  return html`<div class="comment-body markdown-body js-comment-body">${body ? raw(body) : html`<p class="color-fg-muted"><em>No description provided.</em></p>`}</div>
    ${
      c.editPath
        ? html`<form class="comment-edit-form js-api-form" hidden data-api="${c.editPath}" data-method="PATCH">
      ${markdownEditor({ value: c.body, draftKey: `edit:${c.anchor}` })}
      <div class="form-actions">
        <button type="button" class="btn js-comment-edit-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Update comment</button>
      </div>
    </form>`
        : ''
    }`;
}

/** A compact comment inside a review thread. */
export function threadComment(s: Service, c: CommentView): Safe {
  const edited = c.updatedAt !== c.createdAt;
  return html`<div class="review-comment" id="${c.anchor}">
  <div class="review-comment-header">
    ${avatar(avatarUrl(s, c.author), c.author.login, 24, c.author.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')}
    <span class="review-comment-meta">${authorLink(s, c.author)} <a href="#${c.anchor}" class="link-muted">${relTime(c.createdAt)}</a>${edited ? html` <span class="edited">· edited</span>` : ''}</span>
    ${c.pending ? html`<span class="Label Label--attention">Pending</span>` : ''}
    ${c.isAuthor ? html`<span class="Label">Author</span>` : ''}
    <span class="flex-auto"></span>
    ${commentMenu(c)}
  </div>
  <div class="review-comment-body">${commentBodyAndEditor(c)}</div>
</div>`;
}

/** The last few lines of the diff a thread points at, for the conversation view. */
export function hunkSnippet(hunk: string | null, path: string | null, highlightFrom: number | null, highlightTo: number | null): Safe {
  if (!hunk) return raw('');
  const [header, ...body] = hunk.split('\n');
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
  let oldNo = m ? Number(m[1]) : 0;
  let newNo = m ? Number(m[2]) : 0;
  const rows = body.map((l) => {
    const type = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'context';
    const row = { type, text: l.slice(1), old: type === 'add' ? null : oldNo, new: type === 'del' ? null : newNo };
    if (type !== 'add') oldNo++;
    if (type !== 'del') newNo++;
    return row;
  });
  const shown = rows.slice(-Math.max(4, highlightFrom && highlightTo ? highlightTo - highlightFrom + 1 : 4));
  const code = highlightLines(
    shown.map((r) => r.text),
    path ? languageFor(path) : undefined,
  );
  return html`<table class="diff-table diff-snippet"><tbody>
    ${shown.map((r, i) => {
      const n = r.new ?? r.old ?? 0;
      const sel = highlightFrom !== null && highlightTo !== null && n >= highlightFrom && n <= highlightTo;
      return html`<tr class="line ${r.type}${sel ? ' selected-line' : ''}"><td class="blob-num" data-num="${r.old ?? ''}"></td><td class="blob-num" data-num="${r.new ?? ''}"></td><td class="blob-code"><span class="blob-marker">${r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>${raw(code[i])}</td></tr>`;
    })}
  </tbody></table>`;
}

export interface ThreadOpts {
  /** Show the file header and code snippet (conversation view) rather than sitting inside a diff. */
  standalone: boolean;
  apiBase: string;
  /** Service.pullUrl, which the comments' links start from. */
  pullUrl: string;
  viewer: Actor;
  pull: PullRow;
  commitTitle?: (sha: string) => string | undefined;
  suggestionLines?: string[];
  references?: ReferenceContext;
}

/** The lines of one side of a stored diff hunk between two line numbers (what a suggestion replaces). */
export function hunkLines(hunk: string | null, side: 'LEFT' | 'RIGHT' | null, from: number | null, to: number | null): string[] {
  if (!hunk || !side || from === null || to === null) return [];
  const [header, ...body] = hunk.split('\n');
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
  if (!m) return [];
  let n = Number(side === 'RIGHT' ? m[2] : m[1]);
  const out: string[] = [];
  for (const l of body) {
    const skip = side === 'RIGHT' ? l.startsWith('-') : l.startsWith('+');
    if (skip) continue;
    if (n >= from && n <= to) out.push(l.slice(1));
    n++;
  }
  return out;
}

export function reviewThread(s: Service, t: Thread, o: ThreadOpts): Safe {
  const root = t.root;
  const comments = [root, ...t.replies];
  const lang = root.path ? languageFor(root.path) : undefined;
  const suggestionLines = o.suggestionLines?.length ? o.suggestionLines : hunkLines(root.diff_hunk, root.side, root.start_line ?? root.line, root.line);
  const view = (c: CommentRow): CommentView => ({
    id: c.id,
    author: s.db.actorById(c.author_id),
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    editPath: c.author_id === o.viewer.id ? `${o.apiBase.replace(/\/pulls\/\d+$/, '')}/pulls/comments/${c.id}` : undefined,
    pending: t.pending,
    isAuthor: c.author_id === o.pull.author_id,
    anchor: `discussion_r${c.id}`,
    link: commentUrl(o.pullUrl, c),
    markdownCtx: { suggestionLines, suggestionLang: lang, references: o.references },
  });
  const range = root.start_line && root.start_line !== root.line ? `L${root.start_line}–${root.line}` : root.line ? `L${root.line}` : '';
  let title: Safe;
  if (root.subject_type === 'commit') {
    const headline = o.commitTitle?.(root.commit_id!) ?? '';
    title = html`<span class="review-thread-title" title="${headline}">${icon('git-commit')} <span class="review-thread-path">Commit <code>${shortSha(root.commit_id)}</code> ${headline}</span></span>`;
  } else {
    // The path gives way from its start, so the file name stays: `…/reviewers/custom.ts`.
    const slash = root.path!.lastIndexOf('/') + 1;
    const dir = root.path!.slice(0, slash);
    title = html`<span class="review-thread-title" title="${root.path}">${icon('file')} <span class="review-thread-path is-file">${dir ? html`<span class="review-thread-dir"><bdi dir="ltr">${dir}</bdi></span>` : ''}<span class="review-thread-file">${root.path!.slice(slash)}</span></span>${range && o.standalone ? html` <span class="review-thread-range">${range}</span>` : ''}</span>`;
  }
  const badges = html`${t.placement.outdated ? html`<span class="Label Label--attention">Outdated</span>` : ''}${t.pending ? html`<span class="Label Label--attention">Pending</span>` : ''}`;
  const resolvedBy = root.resolved_by_id ? s.db.actorById(root.resolved_by_id).login : null;
  return html`<details class="review-thread${t.resolved ? ' is-resolved' : ''}${t.placement.outdated ? ' is-outdated' : ''}" id="thread-${root.id}" data-thread="${root.id}"${root.subject_type === 'line' ? html` data-suggestion="${JSON.stringify(suggestionLines)}"` : ''}${t.resolved ? '' : raw(' open')}>
  <summary class="review-thread-header">
    ${o.standalone || t.resolved ? title : participants(s, comments)}
    ${badges}
    ${t.resolved ? html`<span class="review-thread-resolved-note"><span>Resolved${resolvedBy ? ` by ${resolvedBy}` : ''}</span></span>` : html`<span class="flex-auto"></span>`}
    ${priorityPill(root.priority)}
    <span class="review-thread-toggle">${icon('fold', { cls: 'when-open' })}${icon('unfold', { cls: 'when-closed' })}</span>
  </summary>
  ${o.standalone && root.subject_type === 'line' ? hunkSnippet(root.diff_hunk, root.path, root.start_line ?? root.line, root.line) : ''}
  <div class="review-thread-comments">${comments.map((c) => threadComment(s, view(c)))}</div>
  ${
    t.pending
      ? ''
      : html`<div class="review-thread-reply">
    ${avatar(avatarUrl(s, o.viewer), o.viewer.login, 24, 'avatar-circle')}
    <button type="button" class="form-control review-thread-reply-placeholder js-reply-open">Reply…</button>
    <form class="review-thread-reply-form js-api-form" hidden data-api="${o.apiBase}/comments/${root.id}/replies" data-method="POST">
      ${markdownEditor({ placeholder: 'Reply…', draftKey: `reply:${root.id}`, suggestion: root.subject_type === 'line', rows: 3 })}
      <div class="form-actions">
        <button type="button" class="btn js-reply-cancel">Cancel</button>
        <button type="submit" class="btn btn-primary">Reply</button>
      </div>
    </form>
  </div>
  <div class="review-thread-footer">
    <button type="button" class="btn btn-sm js-resolve" data-api="${o.apiBase}/threads/${root.id}/resolved" data-method="${t.resolved ? 'DELETE' : 'PUT'}">${t.resolved ? 'Unresolve conversation' : 'Resolve conversation'}</button>
  </div>`
  }
</details>`;
}

function participants(s: Service, comments: CommentRow[]): Safe {
  const people = [...new Map(comments.map((c) => [c.author_id, s.db.actorById(c.author_id)])).values()];
  return html`<span class="review-thread-participants">${people.map((a) => avatar(avatarUrl(s, a), a.login, 16, a.type === 'Bot' ? 'avatar-bot' : 'avatar-circle'))} <span class="review-thread-participants-text">${people.map((a) => a.login).join(', ')} · ${comments.length === 1 ? '1 comment' : `${comments.length} comments`}</span></span>`;
}

export function copyButton(text: string, label = 'Copy'): Safe {
  return html`<button type="button" class="btn-octicon js-copy" data-copy="${text}" aria-label="${label}" title="${label}">${icon('copy')}</button>`;
}

export function timelineBadge(iconName: string, body: Safe, opts: { cls?: string; id?: string } = {}): Safe {
  return html`<div class="timeline-item"${opts.id ? html` id="${opts.id}"` : ''}>
  <span class="timeline-badge ${opts.cls ?? ''}">${icon(iconName)}</span>
  <div class="timeline-body">${body}</div>
</div>`;
}
