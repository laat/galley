import type { Actor, CommentRow, Priority, PullRow, RepoRow } from '../db.ts';
import type { Service, Thread } from '../service.ts';
import { avatarUrl } from '../github.ts';
import { avatar, html, icon, raw, relTime, shortSha, type Safe } from './html.ts';
import { highlightLines, languageFor, renderMarkdown } from './markdown.ts';
import type { ReferenceContext } from './references.ts';

export function layout(s: Service, opts: { title: string; crumbs?: Safe; subnav?: Safe; body: Safe; live?: number | 'all'; data?: Record<string, string | number> }): string {
  const viewer = s.viewer();
  const data = Object.entries(opts.data ?? {}).map(([k, v]) => html` data-${raw(k)}="${v}"`);
  return (
    '<!doctype html>' +
    html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body data-live="${opts.live ?? ''}" data-viewer="${viewer.login}">
<header class="app-header-wrap">
<div class="app-header">
  <a class="app-header-logo" href="/" title="All staged pull requests">${icon('git-pull-request', { size: 24 })}</a>
  <nav class="app-header-context">${opts.crumbs ?? html`<a href="/"><strong>laatsux</strong></a>`}</nav>
  <div class="app-header-actions">
    <a class="app-header-button" href="/settings" title="Settings" aria-label="Settings">${icon('gear')}</a>
    ${avatar(avatarUrl(s, viewer), viewer.login, 32, 'avatar-circle')}
  </div>
</div>
${opts.subnav ?? ''}
</header>
<div id="main"${data}>${opts.body}</div>
<div id="toast" class="toast" hidden></div>
</body>
</html>`.value
  );
}

/**
 * The repository's tabs, as on GitHub: the staged pull requests here, and the pull requests
 * and issues of the repository on GitHub (opening there).
 */
export function repoNav(s: Service, repo: RepoRow, selected: 'staged' | null = 'staged'): Safe {
  const staged = s.pulls(repo, { state: 'open' }).length;
  const slug = repo.github_slug;
  const counts = slug ? s.githubRepo(slug) : null;
  const counter = (n: number | undefined) => (n === undefined ? '' : html` <span class="Counter">${n}</span>`);
  const external = (path: string, iconName: string, label: string, n: number | undefined) =>
    html`<a class="UnderlineNav-item" href="https://github.com/${slug}/${path}" target="_blank" rel="noopener" title="${label} on GitHub">${icon(iconName)} ${label}${counter(n)} ${icon('link-external', { cls: 'UnderlineNav-external' })}</a>`;
  return html`<nav class="UnderlineNav" aria-label="Repository">
  <a class="UnderlineNav-item${selected === 'staged' ? ' selected' : ''}" href="/${repo.owner}/${repo.name}">${icon('git-pull-request')} Staged${counter(staged)}</a>
  ${slug ? external('pulls', 'mark-github', 'Pull requests', counts?.pulls) : ''}
  ${slug ? external('issues', 'issue-opened', 'Issues', counts?.issues) : ''}
</nav>`;
}

export function repoCrumbs(repo: RepoRow, extra?: Safe): Safe {
  return html`<a href="/">laatsux</a><span class="crumb-sep">/</span><a href="/${repo.owner}/${repo.name}"><strong>${repo.owner}/${repo.name}</strong></a>${extra ?? ''}`;
}

/** `unpublished`: published, with changes GitHub does not have yet (Service.unpublishedChanges), which shows as open. */
export function stateBadge(pull: PullRow, size: 'md' | 'sm' = 'md', unpublished = false): Safe {
  const cls = size === 'sm' ? ' State--small' : '';
  if (pull.state === 'closed') return html`<span class="State State--closed${cls}">${icon('git-pull-request-closed')} Closed</span>`;
  if (pull.state === 'published' && unpublished) return html`<span class="State State--open${cls}">${icon('git-pull-request')} Update not published</span>`;
  if (pull.state === 'published') return html`<span class="State State--published${cls}">${icon('mark-github')} Published</span>`;
  if (pull.draft) return html`<span class="State State--draft${cls}">${icon('git-pull-request-draft')} Draft</span>`;
  return html`<span class="State State--open${cls}">${icon('git-pull-request')} Open</span>`;
}

export function pullIcon(pull: PullRow, unpublished = false): Safe {
  if (pull.state === 'closed') return icon('git-pull-request-closed', { cls: 'color-fg-closed' });
  if (pull.state === 'published' && unpublished) return icon('git-pull-request', { cls: 'color-fg-open' });
  if (pull.state === 'published') return icon('mark-github', { cls: 'color-fg-done' });
  if (pull.draft) return icon('git-pull-request-draft', { cls: 'color-fg-muted' });
  return icon('git-pull-request', { cls: 'color-fg-open' });
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
  markdownCtx?: Parameters<typeof renderMarkdown>[1];
  deletable?: boolean;
}

const PRIORITY_TEXT = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function priorityPill(priority: Priority | null): Safe {
  return priority ? html`<span class="Label Label--priority Label--priority-${priority}" title="Priority">${PRIORITY_TEXT[priority]}</span>` : raw('');
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
        ${c.editPath ? commentMenu(c) : ''}
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
      <button type="button" class="dropdown-item js-comment-edit">Edit</button>
      ${c.deletable !== false ? html`<button type="button" class="dropdown-item dropdown-item-danger js-comment-delete" data-path="${c.editPath}">Delete</button>` : ''}
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
    ${c.editPath ? commentMenu(c) : ''}
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
    markdownCtx: { suggestionLines, suggestionLang: lang, references: o.references },
  });
  const range = root.start_line && root.start_line !== root.line ? `lines ${root.start_line} to ${root.line}` : root.line ? `line ${root.line}` : '';
  let title: Safe;
  if (root.subject_type === 'commit') {
    const headline = o.commitTitle?.(root.commit_id!) ?? '';
    title = html`${icon('git-commit')} <span class="review-thread-path">Commit <code>${shortSha(root.commit_id)}</code> ${headline}</span>`;
  } else {
    title = html`${icon('file')} <span class="review-thread-path">${root.path}</span>${range && o.standalone ? html` <span class="color-fg-muted">${range}</span>` : ''}`;
  }
  const badges = html`${t.placement.outdated ? html`<span class="Label Label--attention">Outdated</span>` : ''}${priorityPill(root.priority)}${t.pending ? html`<span class="Label Label--attention">Pending</span>` : ''}`;
  const resolvedBy = root.resolved_by_id ? s.db.actorById(root.resolved_by_id).login : null;
  return html`<details class="review-thread${t.resolved ? ' is-resolved' : ''}${t.placement.outdated ? ' is-outdated' : ''}" id="thread-${root.id}" data-thread="${root.id}"${root.subject_type === 'line' ? html` data-suggestion="${JSON.stringify(suggestionLines)}"` : ''}${t.resolved ? '' : raw(' open')}>
  <summary class="review-thread-header">
    ${o.standalone || t.resolved ? title : participants(s, comments)}
    ${badges}
    <span class="flex-auto"></span>
    ${t.resolved ? html`<span class="color-fg-muted review-thread-resolved-note">${resolvedBy} marked this conversation as resolved.</span>` : ''}
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
  return html`<span class="review-thread-participants">${people.map((a) => avatar(avatarUrl(s, a), a.login, 16, a.type === 'Bot' ? 'avatar-bot' : 'avatar-circle'))} <span>${people.map((a) => a.login).join(', ')} · ${comments.length === 1 ? '1 comment' : `${comments.length} comments`}</span></span>`;
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
