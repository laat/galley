import type { Commit } from '../git.ts';
import type { FileDiff } from '../diff.ts';
import type { Actor, CommentRow, EventRow, PullRow, RepoRow, ReviewRow, RevisionRow } from '../db.ts';
import { githubStatus, publishFingerprint, type AutoMerge, type AutoPublish, type Ctx, type HeadStatus, type Service, type Thread, type Turn, type TurnReason } from '../service.ts';
import { checkName, checksSummary, type GithubCheck } from '../github-follow.ts';
import { avatarUrl, reasonText, reviewDecision } from '../github.ts';
import { MAX_ITERATIONS_LIMIT } from '../settings.ts';
import { uploadsIn } from '../uploads.ts';
import { avatar, fileAnchor, html, icon, plural, raw, relTime, shortSha, since, type Safe } from './html.ts';
import { renderMarkdown } from './markdown.ts';
import { closingIssues, pullReferences, type ReferenceContext } from './references.ts';
import {
  authorLink,
  checksIndicator,
  copyButton,
  layout,
  markdownEditor,
  pullIcon,
  repoCrumbs,
  repoNav,
  reviewThread,
  stateBadge,
  timelineBadge,
  timelineComment,
} from './components.ts';
import { browseUrl, diffstatBlocks, fileTree, renderFile, threadKey, type DiffMode } from './diffview.ts';
import { withThreadContext } from './browse.ts';
import type { Span } from '../diff.ts';

// ------------------------------------------------------------------ lists

export function pullList(s: Service, opts: { repo: RepoRow | null; state: string }): string {
  const all = s.pulls(opts.repo, { state: 'all' });
  // "Open" means not closed: publishing does not end the review loop.
  const counts = {
    open: all.filter((p) => p.state !== 'closed').length,
    published: all.filter((p) => p.state === 'published').length,
    closed: all.filter((p) => p.state === 'closed').length,
  };
  const state = ['open', 'published', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const shown = state === 'all' ? all : state === 'open' ? all.filter((p) => p.state !== 'closed') : all.filter((p) => p.state === state);
  const base = opts.repo ? `/${opts.repo.owner}/${opts.repo.name}` : '/';
  const tab = (key: string, iconName: string, label: string, n: number) =>
    html`<a class="list-tab${state === key ? ' selected' : ''}" href="${base}?state=${key}">${icon(iconName)} ${n} ${label}</a>`;
  const turns = new Map(all.map((p) => [p.id, s.turn(p)]));
  const turn = (p: PullRow) => turns.get(p.id)!;
  const yours = all.filter((p) => turn(p).whose === 'reviewer');
  const href = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return `/${repo.owner}/${repo.name}/pull/${p.number}`;
  };
  const apiBase = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return `/api/repos/${repo.owner}/${repo.name}/pulls/${p.number}`;
  };
  // What notifications follow (notifyTurns in app.js): your turn in every repository, whatever this page lists.
  const notify = (opts.repo ? s.pulls(null, { state: 'open' }) : all)
    .map((p) => ({ p, t: turns.get(p.id) ?? s.turn(p) }))
    .filter(({ t }) => t.whose === 'reviewer')
    .map(({ p, t }) => ({ id: p.id, title: p.title, url: href(p), reasons: t.reasons.map(reasonText).join(' · ') }));
  const heading = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return html`${opts.repo ? '' : html`<a class="pr-row-repo" href="/${repo.owner}/${repo.name}">${repo.owner}/${repo.name}</a>`}
    <a class="pr-row-title" href="${href(p)}">${p.title}</a> ${checksIndicator(p)}`;
  };
  const published = (p: PullRow) =>
    p.published_url ? html`<a href="${p.published_url}" target="_blank" rel="noopener">${icon('mark-github')} ${p.published_url.replace('https://github.com/', '').replace('/pull/', '#')}</a>` : '';
  /** Merged or closed on GitHub, once published. */
  const onGithub = (p: PullRow) =>
    p.github_state === 'merged' ? html`<span class="Label Label--merged">Merged</span>` : p.github_state === 'closed' && p.state !== 'closed' ? html`<span class="Label">Closed on GitHub</span>` : '';

  /** A pull request with what it waits for: whose turn it is and why, the decision, and what GitHub does not have yet. */
  const row = (p: PullRow) => {
    const t = turn(p);
    const author = s.db.actorById(p.author_id);
    const unpublished = t.reasons.find((r) => r.kind === 'unpublished');
    const comments = s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE pull_id = ? AND ' + "(review_id IS NULL OR review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))", p.id)!.n;
    return html`<div class="Box-row pr-row">
  <span class="pr-row-icon">${pullIcon(p, !!unpublished)}</span>
  <div class="pr-row-main">
    ${heading(p)}
    ${p.draft && p.state === 'open' ? html`<span class="Label">Draft</span>` : ''}
    ${t.reasons.some((r) => r.kind === 'approved') ? html`<span class="Label Label--success">${icon('check')} Approved</span>` : ''}
    ${t.reasons.some((r) => r.kind === 'changes_requested') ? html`<span class="Label Label--danger">${icon('file-diff')} Changes requested</span>` : ''}
    ${unpublished ? html`<span class="Label Label--attention">${icon('mark-github')} ${capitalize(unpublished.text)}</span>` : ''}
    ${onGithub(p)}
    ${turnReasons(t, apiBase(p))}
    <div class="pr-row-meta">#${p.number} opened ${relTime(p.created_at)} by ${author.login} · <span class="branch-name branch-name-sm">${p.head_ref}</span> ${icon('arrow-right')} <span class="branch-name branch-name-sm">${p.base_ref}</span>${p.published_url ? html` · ${published(p)}` : ''}</div>
  </div>
  <div class="pr-row-side">${comments ? html`<a class="link-muted" href="${href(p)}">${icon('comment')} ${comments}</a>` : ''}</div>
</div>`;
  };

  /** One line: the title, and what the agents are doing. */
  const compactRow = (p: PullRow) => {
    const t = turn(p);
    const unpublished = t.reasons.some((r) => r.kind === 'unpublished');
    return html`<div class="Box-row pr-row pr-row--compact">
  <span class="pr-row-icon">${pullIcon(p, unpublished)}</span>
  <div class="pr-row-main">
    <span class="pr-row-heading">${heading(p)} <span class="pr-row-number">#${p.number}</span></span>
    ${t.whose === 'none' ? html`<span class="pr-row-turn">${onGithub(p)} ${published(p)}</span>` : turnReasons(t, apiBase(p), ['author', 'reviewer_agent', 'unpublished'])}
  </div>
</div>`;
  };

  let rows: Safe[] = shown.map(row);
  if (state === 'open' && shown.length) {
    const group = (iconName: string, title: string, n: number, note = '') =>
      html`<div class="Box-row turn-group">${icon(iconName)} <h2 class="turn-group-title">${title}</h2> <span class="Counter">${n}</span>${note ? html` <span class="turn-group-note">${note}</span>` : ''}</div>`;
    const mine = shown.filter((p) => turn(p).whose === 'reviewer').sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const agents = shown.filter((p) => turn(p).whose === 'author' || turn(p).whose === 'reviewer_agents');
    const done = shown.filter((p) => turn(p).whose === 'none');
    rows = [
      group('inbox', 'Your turn', mine.length, mine.length > 1 ? 'oldest first' : ''),
      ...(mine.length ? mine.map(row) : [html`<div class="Box-row turn-empty">Nothing is waiting for you.</div>`]),
      ...(agents.length ? [group('hubot', 'With agents', agents.length), ...agents.map(compactRow)] : []),
      ...(done.length ? [group('mark-github', 'Published', done.length, 'nothing new since'), ...done.map(compactRow)] : []),
    ];
  }
  const empty = html`<div class="blankslate">
  ${icon('git-pull-request', { size: 24 })}
  <h3>No ${state === 'all' ? '' : state + ' '}staged pull requests${opts.repo ? html` in ${opts.repo.owner}/${opts.repo.name}` : ''}</h3>
  <p>Agents stage pull requests with <code>laatsux pr create</code>, the same way they would use <code>gh pr create</code>.</p>
</div>`;
  const body = html`<div class="container container-lg">
  <div class="list-header-row"><h1 class="page-title">${opts.repo ? html`${opts.repo.owner}/${opts.repo.name}` : 'Staged pull requests'}</h1>
    <button type="button" class="btn btn-sm notify-toggle js-notify" hidden title="A desktop notification when a pull request becomes your turn, while a page like this is open">${icon('bell')} <span class="js-notify-label">Notify me</span></button></div>
  <div class="Box pr-list" data-your-turn="${JSON.stringify(notify)}">
    <div class="Box-header list-tabs">
      ${tab('open', 'git-pull-request', 'Open', counts.open)}
      ${tab('published', 'mark-github', 'Published', counts.published)}
      ${tab('closed', 'git-pull-request-closed', 'Closed', counts.closed)}
    </div>
    ${rows.length ? rows : empty}
  </div>
</div>`;
  // The tab's title counts the pull requests waiting for you, as a mail client counts unread mail.
  const title = opts.repo ? `Pull requests · ${opts.repo.owner}/${opts.repo.name}` : 'Staged pull requests · laatsux';
  return layout(s, {
    title: yours.length ? `(${yours.length}) ${title}` : title,
    crumbs: opts.repo ? repoCrumbs(opts.repo) : undefined,
    subnav: opts.repo ? repoNav(s, opts.repo) : undefined,
    body,
    live: 'all',
  });
}

/**
 * The reasons of a Turn as a line of the list, those of the given kinds (by default all but the
 * labels). A failed reviewer agent gets a Retry button, which asks it to review at `apiBase`.
 */
function turnReasons(t: Turn, apiBase: string, kinds: TurnReason['kind'][] = ['author', 'changes', 'reviewer_agent', 'threads', 'github']): Safe {
  const shown = t.reasons.filter((r) => kinds.includes(r.kind));
  if (!shown.length) return raw('');
  return html`<div class="pr-row-turn">${shown.map((r) => {
    const cls = reasonClass(r);
    const mark =
      cls === 'failed'
        ? icon('x-circle-fill')
        : cls === 'running' || cls === 'waiting'
          ? icon('dot-fill', { cls: 'turn-pulse' })
          : cls === 'working'
            ? icon('dot-fill')
            : cls === 'github'
              ? icon('mark-github')
              : '';
    return html`<span class="turn-reason${cls ? ` turn-reason--${cls}` : ''}">${mark}${r.text}${r.since ? html`<span class="turn-since">, ${since(r.since)}</span>` : ''}${
      cls === 'failed' && r.engine ? html` <button type="button" class="btn-link js-run-codex" data-api="${apiBase}/reviewers/${r.engine}">Retry</button>` : ''
    }</span>`;
  })}</div>`;
}

/** How a reason looks: an agent at work or waiting, an author working on feedback, a failure, unresolved threads, or something on GitHub. */
function reasonClass(r: TurnReason): string {
  if (r.kind === 'author') return r.state === 'waiting' ? 'waiting' : r.state === 'stopped' ? '' : 'working';
  if (r.kind === 'reviewer_agent') return r.state === 'reviewing' || r.state === 'queued' ? 'running' : r.state === 'failed' ? 'failed' : '';
  return r.kind === 'threads' ? 'threads' : r.kind === 'github' ? 'github' : '';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ------------------------------------------------------------ pull pages

interface PullPage {
  s: Service;
  ctx: Ctx;
  repo: RepoRow;
  pull: PullRow;
  viewer: Actor;
  author: Actor;
  files: FileDiff[];
  commits: Commit[];
  threads: Thread[];
  reviews: ReviewRow[];
  pending: ReviewRow | undefined;
  /** What `#N`, `@user` and SHAs in the page's Markdown link to. */
  references: ReferenceContext;
  apiBase: string;
  htmlBase: string;
}

export async function loadPull(s: Service, owner: string, name: string, number: number): Promise<PullPage> {
  const ctx = await s.ctx(owner, name, number);
  const viewer = s.viewer();
  const files = await s.files(ctx);
  const commits = await s.commits(ctx);
  const threads = await s.threads(ctx, viewer, files, commits);
  const reviews = s.reviews(ctx.pull, viewer);
  // Every Markdown text the pull request's pages show, for the commit SHAs in them.
  const texts = [ctx.pull.body, ...s.issueComments(ctx.pull).map((c) => c.body), ...reviews.map((r) => r.body), ...threads.flatMap((t) => [t.root, ...t.replies].map((c) => c.body))];
  return {
    s,
    ctx,
    repo: ctx.repo,
    pull: ctx.pull,
    viewer,
    author: s.db.actorById(ctx.pull.author_id),
    files,
    commits,
    threads,
    reviews,
    pending: s.pendingReview(ctx.pull, viewer),
    references: await pullReferences(s, ctx, commits, texts),
    apiBase: `/api/repos/${owner}/${name}/pulls/${number}`,
    htmlBase: `/${owner}/${name}/pull/${number}`,
  };
}

function pullLayout(p: PullPage, tab: 'conversation' | 'commits' | 'files', content: Safe, extraData: Record<string, string | number> = {}): string {
  const { s, repo, pull, author, files, commits } = p;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const conversationCount = s.issueComments(pull).length + p.threads.filter((t) => !t.pending).reduce((n, t) => n + 1 + t.replies.length, 0);
  const unpublished = s.unpublishedChanges(pull).length > 0;
  const tabLink = (key: string, href: string, iconName: string, label: string, count: number) =>
    html`<a class="tabnav-tab${tab === key ? ' selected' : ''}" href="${href}">${icon(iconName)} ${label} <span class="Counter">${count}</span></a>`;
  const header = html`<div class="pr-header">
  <div class="container container-xl">
    <div class="gh-header-title-row js-title-view">
      <h1 class="gh-header-title"><bdi>${pull.title}</bdi> <span class="gh-header-number">#${pull.number}</span></h1>
      <div class="gh-header-actions">
        <button type="button" class="btn btn-sm js-title-edit">Edit</button>
        ${pull.published_url ? html`<a class="btn btn-sm" href="${pull.published_url}" target="_blank" rel="noopener">${icon('mark-github')} View on GitHub</a>` : ''}
      </div>
    </div>
    <form class="gh-header-edit js-api-form js-title-form" hidden data-api="${p.apiBase}" data-method="PATCH">
      <input class="form-control gh-header-edit-input" name="title" value="${pull.title}" aria-label="Title" autocomplete="off">
      <button type="submit" class="btn btn-sm">Save</button>
      <button type="button" class="btn-link js-title-cancel">Cancel</button>
    </form>
    <div class="gh-header-meta">
      ${stateBadge(pull, 'md', unpublished)}
      <div class="gh-header-meta-text">
        ${pull.github_state === 'merged' ? html`${githubUser(pull.github_closed_by)} merged` : html`${authorLink(s, author)} ${pull.state === 'published' && !unpublished ? 'published' : 'wants to merge'}`} ${plural(commits.length, 'commit')} into
        <span class="branch-name">${pull.base_ref}</span> from <span class="branch-name">${pull.head_ref}</span> ${copyButton(pull.head_ref, 'Copy head branch name')}
      </div>
    </div>
    <nav class="tabnav">
      ${tabLink('conversation', p.htmlBase, 'comment-discussion', 'Conversation', conversationCount)}
      ${tabLink('commits', `${p.htmlBase}/commits`, 'git-commit', 'Commits', commits.length)}
      ${tabLink('files', `${p.htmlBase}/files`, 'file-diff', 'Files changed', files.length)}
      <span class="tabnav-extra diffstat"><span class="color-fg-success">+${additions}</span> <span class="color-fg-danger">−${deletions}</span> ${diffstatBlocks(additions, deletions)}</span>
    </nav>
  </div>
</div>`;
  return layout(s, {
    title: `${pull.title} by ${author.login} · Pull Request #${pull.number} · ${repo.owner}/${repo.name}`,
    crumbs: repoCrumbs(repo, html`<span class="crumb-sep">/</span><a href="${p.htmlBase}">#${pull.number}</a>`),
    subnav: repoNav(s, repo),
    body: html`${header}${content}`,
    live: pull.id,
    data: { 'api-base': p.apiBase, 'pull-id': pull.id, ...extraData },
  });
}

function threadOpts(p: PullPage, standalone: boolean) {
  const titles = new Map(p.commits.map((c) => [c.sha, c.message.split('\n')[0]]));
  return { standalone, apiBase: p.apiBase, viewer: p.viewer, pull: p.pull, commitTitle: (sha: string) => titles.get(sha), references: p.references };
}

// ----------------------------------------------------------- conversation

const REVIEW_TEXT: Record<string, { text: string; icon: string; cls: string }> = {
  APPROVED: { text: 'approved these changes', icon: 'check', cls: 'timeline-badge--success' },
  CHANGES_REQUESTED: { text: 'requested changes', icon: 'file-diff', cls: 'timeline-badge--danger' },
  COMMENTED: { text: 'reviewed', icon: 'eye', cls: '' },
  DISMISSED: { text: 'had a review dismissed', icon: 'x', cls: '' },
};

function commitList(p: PullPage, commits: Commit[]): Safe {
  return html`<div class="timeline-commits">${commits.map(
    (c) => html`<div class="timeline-commit">
    ${icon('git-commit', { cls: 'timeline-commit-icon' })}
    <a class="timeline-commit-title" href="${p.htmlBase}/files?commit=${c.sha}" title="${c.message}">${c.message.split('\n')[0]}</a>
    <a class="timeline-commit-sha" href="${p.htmlBase}/files?commit=${c.sha}"><code>${shortSha(c.sha)}</code></a>
  </div>`,
  )}</div>`;
}

/** A pull request on GitHub, as owner/repo#7. */
function githubPull(url: string): Safe {
  return html`<a href="${url}" target="_blank" rel="noopener">${url.replace('https://github.com/', '').replace('/pull/', '#')}</a>`;
}

/** Someone on GitHub, known by login only: whoever merged or closed a published pull request there. */
function githubUser(login: string | null, withAvatar = false): Safe {
  if (!login) return html`Someone`;
  const link = html`<a class="author" href="https://github.com/${login}" target="_blank" rel="noopener">${login}</a>`;
  return withAvatar ? html`${avatar(`https://github.com/${login}.png?size=40`, login, 20, 'avatar-circle avatar-small')} ${link}` : link;
}

const AUTO_PUBLISH_OFF: Record<string, string> = {
  closed: ' by closing the pull request',
  changes_requested: ' by requesting changes',
  base_changed: ' by changing the base branch',
};

async function eventItem(p: PullPage, e: EventRow): Promise<Safe | null> {
  const actor = p.s.db.actorById(e.actor_id);
  const who = html`${avatar(avatarUrl(p.s, actor), actor.login, 20, actor.type === 'Bot' ? 'avatar-bot avatar-small' : 'avatar-circle avatar-small')} ${authorLink(p.s, actor)}`;
  const data = JSON.parse(e.data);
  const when = relTime(e.created_at);
  switch (e.type) {
    case 'pushed': {
      if (data.forced) {
        return timelineBadge(
          'repo-push',
          html`${who} force-pushed the <span class="branch-name branch-name-sm">${p.pull.head_ref}</span> branch from <code>${shortSha(data.before)}</code> to <code>${shortSha(data.after)}</code> ${when}
          <a class="btn btn-sm btn-compare" href="${p.htmlBase}/files?range=${data.before}..${data.after}">Compare</a>`,
          { id: `event-${e.id}` },
        );
      }
      const commits = await p.ctx.git.log(data.before, data.after).catch(() => [] as Commit[]);
      return html`${timelineBadge('repo-push', html`${who} added ${plural(commits.length, 'commit')} ${when}`, { id: `event-${e.id}` })}${commitList(p, commits)}`;
    }
    case 'renamed':
      return timelineBadge('pencil', html`${who} changed the title <del class="color-fg-muted">${data.from}</del> <ins class="title-ins">${data.to}</ins> ${when}`);
    case 'body_edited':
      return timelineBadge(
        'pencil',
        html`${who} edited the description ${when}
        <details class="body-diff"><summary class="btn-link">Show changes</summary>${lineDiff(data.from, data.to)}</details>`,
      );
    case 'base_changed':
      return timelineBadge('git-branch', html`${who} changed the base branch from <span class="branch-name branch-name-sm">${data.from}</span> to <span class="branch-name branch-name-sm">${data.to}</span> ${when}`);
    case 'closed':
      return timelineBadge('git-pull-request-closed', html`${who} closed this pull request ${when}`, { cls: 'timeline-badge--closed' });
    case 'reopened':
      return timelineBadge('git-pull-request', html`${who} reopened this pull request ${when}`, { cls: 'timeline-badge--open' });
    case 'published':
      return timelineBadge(
        'mark-github',
        html`${who} ${data.first ? 'published this pull request to' : 'published an update to'} <a href="${data.url}" target="_blank" rel="noopener">${String(data.url).replace('https://github.com/', '').replace('/pull/', '#')}</a> at <code>${shortSha(data.head)}</code>${data.signed ? ` (signed ${plural(data.signed, 'commit')})` : ''}${data.force ? ' (force-pushed)' : ''}${data.auto ? ' with auto-publish' : ''} ${when}`,
        { cls: 'timeline-badge--done' },
      );
    case 'auto_publish_enabled': {
      const options = [data.sign ? 'signed' : null, data.draft ? 'as a draft' : null, data.force ? 'with force if needed' : null, data.auto_merge ? `with auto-merge (${data.auto_merge}) on GitHub` : null].filter(Boolean);
      return timelineBadge('clock', html`${who} enabled auto-publish${options.length ? ` (${options.join(', ')})` : ''} ${when}`);
    }
    case 'auto_merge_enabled':
      if (data.merged === true) {
        return timelineBadge('git-merge', html`${who} merged ${githubPull(data.url)} on GitHub (${data.method}) ${when}: auto-merge had nothing to wait for`, { cls: 'timeline-badge--done' });
      }
      return data.merged === false
        ? timelineBadge('git-merge', html`${who} enabled auto-merge (${data.method}) on ${githubPull(data.url)} ${when}`)
        : timelineBadge('git-merge', html`${who} requested auto-merge (${data.method}) on ${githubPull(data.url)} ${when}; whether GitHub merged it at once could not be checked`);
    case 'auto_merge_failed':
      return timelineBadge(
        'x',
        html`Enabling auto-merge on ${githubPull(data.url)} failed ${when}
        <details class="codex-error"><summary class="btn-link">Show error</summary><pre>${data.error}</pre></details>`,
        { cls: 'timeline-badge--danger' },
      );
    case 'auto_publish_disabled':
      if (data.reason === 'merged') return timelineBadge('clock', html`Auto-publish turned itself off when the pull request was merged on GitHub ${when}`);
      return timelineBadge('clock', html`${who} disabled auto-publish${AUTO_PUBLISH_OFF[data.reason] ?? ''} ${when}`);
    case 'auto_publish_failed':
      return timelineBadge(
        'x',
        html`Auto-publish failed and turned itself off ${when}
        <details class="codex-error"><summary class="btn-link">Show error</summary><pre>${data.error}</pre></details>`,
        { cls: 'timeline-badge--danger' },
      );
    case 'merged': {
      // `at` is when GitHub merged it; the event is from when laatsux learned of it.
      const commit = data.commit
        ? html`commit <a class="commit-link" href="${String(data.url).replace(/\/pull\/\d+$/, '')}/commit/${data.commit}" target="_blank" rel="noopener"><code>${shortSha(data.commit)}</code></a>`
        : 'this pull request';
      return timelineBadge('git-merge', html`${githubUser(data.by, true)} merged ${commit} into <span class="branch-name branch-name-sm">${p.pull.base_ref}</span> on GitHub ${relTime(data.at)}`, { cls: 'timeline-badge--done' });
    }
    case 'closed_on_github':
      return timelineBadge('git-pull-request-closed', html`${githubUser(data.by, true)} closed this pull request on GitHub ${relTime(data.at)}`, { cls: 'timeline-badge--closed' });
    case 'convert_to_draft':
      return timelineBadge('git-pull-request-draft', html`${who} marked this pull request as draft ${when}`);
    case 'ready_for_review':
      return timelineBadge('eye', html`${who} marked this pull request as ready for review ${when}`);
    default:
      return null;
  }
}

/** A small line-based LCS diff, for showing how the description changed. */
function lineDiff(a: string, b: string): Safe {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: Safe[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      rows.push(html`<tr class="line context"><td class="blob-code blob-code-context"><span class="blob-marker"> </span>${x[i]}</td></tr>`);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push(html`<tr class="line add"><td class="blob-code blob-code-add"><span class="blob-marker">+</span>${y[j++]}</td></tr>`);
    } else {
      rows.push(html`<tr class="line del"><td class="blob-code blob-code-del"><span class="blob-marker">-</span>${x[i++]}</td></tr>`);
    }
  }
  return html`<table class="diff-table diff-snippet diff-text"><tbody>${rows}</tbody></table>`;
}

async function mergeBox(p: PullPage): Promise<Safe> {
  const { s, pull, repo, viewer } = p;
  if (pull.github_state === 'merged') {
    const sha = pull.github_merge_sha ? html` as <code>${shortSha(pull.github_merge_sha)}</code>` : '';
    return html`<div class="merge-box merge-box--merged">
      <span class="merge-box-icon">${icon('git-merge', { size: 24 })}</span>
      <div class="Box"><div class="merge-row merge-actions">${icon('git-merge', { cls: 'color-fg-done' })}<div class="flex-auto"><strong>Merged on GitHub</strong>
        <div class="color-fg-muted">${githubUser(pull.github_closed_by)} merged it${sha} ${relTime(pull.github_closed_at)}. Conversations stay in laatsux.</div></div>
        <a class="btn" href="${pull.published_url}" target="_blank" rel="noopener">View on GitHub</a></div></div>
    </div>`;
  }
  const submitted = p.reviews.filter((r) => r.state !== 'PENDING');
  const decision = submitted.length ? reviewDecision(submitted) : null;
  const unresolved = p.threads.filter((t) => !t.resolved && !t.pending).length;
  const waiting = (s.waiters.get(pull.id) ?? 0) > 0;
  // A review still to come may ask for changes, so publishing before it takes a second click.
  const work = pull.state === 'closed' ? null : (s.codex?.atWork(pull) ?? null);
  const rows: Safe[] = [];

  if (decision === 'CHANGES_REQUESTED') {
    rows.push(html`<div class="merge-row">${icon('x-circle-fill', { cls: 'color-fg-danger' })}<div><strong>Changes requested</strong><div class="color-fg-muted">${waiting ? `${p.author.login} is waiting for your next review.` : `${p.author.login} has the feedback.`}</div></div></div>`);
  } else if (decision === 'APPROVED') {
    rows.push(html`<div class="merge-row">${icon('check-circle-fill', { cls: 'color-fg-success' })}<div><strong>Changes approved</strong><div class="color-fg-muted">You approved the staged changes.</div></div></div>`);
  } else {
    rows.push(html`<div class="merge-row">${icon('dot-fill', { cls: 'color-fg-attention' })}<div><strong>Review pending</strong><div class="color-fg-muted">${waiting ? `${p.author.login} is waiting for your review.` : 'Nobody has reviewed these changes yet.'}</div></div></div>`);
  }
  rows.push(
    unresolved
      ? html`<div class="merge-row">${icon('comment-discussion', { cls: 'color-fg-attention' })}<div><strong>${plural(unresolved, 'unresolved conversation')}</strong><div class="color-fg-muted">Conversations stay in laatsux; they are not published.</div></div></div>`
      : html`<div class="merge-row">${icon('check-circle-fill', { cls: 'color-fg-success' })}<div><strong>All conversations resolved</strong></div></div>`,
  );

  if (pull.state === 'closed') {
    return html`<div class="merge-box merge-box--closed">
      <span class="merge-box-icon">${icon('git-pull-request-closed', { size: 24 })}</span>
      <div class="Box">${rows}<div class="merge-row merge-actions"><div><strong>This staged pull request is closed.</strong></div>
        <button type="button" class="btn js-set-state" data-state="open">Reopen pull request</button></div></div>
    </div>`;
  }

  rows.push(...githubRows(p));
  if (pull.github_state === 'closed') {
    rows.push(html`<div class="merge-row">${icon('git-pull-request-closed', { cls: 'color-fg-closed' })}<div><strong>Closed on GitHub</strong><div class="color-fg-muted">${githubUser(pull.github_closed_by)} closed it on GitHub without merging ${relTime(pull.github_closed_at)}. Publishing again updates it there, and laatsux follows it again in case it was reopened.</div></div></div>`);
  }

  const changed = s.unpublishedChanges(pull);
  const unsigned = await s.unsignedCommits(p.ctx, p.commits);
  const signer = unsigned.length ? await s.signer(p.ctx) : null;
  const signByDefault = unsigned.length ? await s.signsByDefault(p.ctx) : false;
  // For the signing checked by default; the server decides again on what it pushes.
  const forceNeeded = await s.forceNeeded(p.ctx, signByDefault);
  const target = repo.github_slug;
  const auto = s.autoPublish(pull);
  const closes = target ? closingIssues(pull.body, p.references) : [];
  if (closes.length) {
    const links = closes.map((c, i) => html`${i ? ', ' : ''}<a href="${c.href}" target="_blank" rel="noopener"${c.title ? html` title="${c.title}"` : ''}>${c.text}</a>`);
    const them = closes.length === 1 ? 'it' : 'them';
    rows.push(html`<div class="merge-row">${icon('issue-closed', { cls: 'color-fg-done' })}<div><strong>Merging on GitHub closes ${links}</strong><div class="color-fg-muted">The description names ${them} after a closing keyword. GitHub closes ${them} when it merges the pull request into the default branch.</div></div></div>`);
  }
  // The option shows only where GitHub allows auto-merge; what came of using it shows regardless.
  const mergeOption = s.autoMergeOption(repo);
  const merge = pull.published_url ? s.autoMerge(pull) : null;
  let publishRow: Safe;
  let publishable = false;
  if (!target) {
    publishRow = html`<div class="merge-row merge-actions">${icon('alert', { cls: 'color-fg-attention' })}<div><strong>No GitHub remote</strong><div class="color-fg-muted">Remote <code>${repo.remote}</code> is not a github.com repository, so this pull request can not be published.</div></div></div>`;
  } else if (pull.published_url && changed.length === 0) {
    publishRow = html`<div class="merge-row merge-actions">${icon('mark-github', { cls: 'color-fg-done' })}<div class="flex-auto"><strong>Published</strong><div class="color-fg-muted">GitHub has the same commits, title and description as this staged version.</div></div>
      <a class="btn" href="${pull.published_url}" target="_blank" rel="noopener">View on GitHub</a></div>`;
  } else {
    publishable = true;
    const verb = pull.published_url ? 'Publish update' : 'Publish pull request';
    const what = pull.published_url
      ? html`Staged changes not on GitHub yet: ${changed.join(', ')}. Pushes <span class="branch-name branch-name-sm">${pull.head_ref}</span> (<code>${shortSha(pull.head_sha)}</code>)${forceNeeded ? html` with <strong>force</strong>` : ''} and updates <a href="${pull.published_url}" target="_blank" rel="noopener">${pull.published_url.replace('https://github.com/', '').replace('/pull/', '#')}</a>.`
      : html`Pushes <span class="branch-name branch-name-sm">${pull.head_ref}</span> (<code>${shortSha(pull.head_sha)}</code>) to <code>${repo.remote}</code> and opens a pull request on <strong>${target}</strong> with this title and description.`;
    // Images pasted into the description live on this machine; GitHub has no API to upload them to.
    const images = uploadsIn(pull.body).length;
    const them = images === 1 ? 'it' : 'them';
    publishRow = html`<form class="merge-row merge-actions js-api-form js-publish-form" data-api="${p.apiBase}/publish" data-method="POST">
      <input type="hidden" name="expected" value="${publishFingerprint(pull)}">
      ${icon('rocket', { cls: 'color-fg-done' })}
      <div class="flex-auto">
        <strong>${pull.published_url ? 'Unpublished changes' : 'Ready to publish?'}</strong>
        <div class="color-fg-muted">${what}</div>
        <div class="merge-options">
          ${pull.published_url ? '' : html`<label><input type="checkbox" name="draft"${pull.draft ? raw(' checked') : ''}> Open as a draft on GitHub</label>`}
          ${
            unsigned.length
              ? html`<label><input type="checkbox" name="sign"${signByDefault ? raw(' checked') : ''}${signer ? '' : raw(' disabled')}> Sign ${unsigned.length < p.commits.length ? `the ${plural(unsigned.length, 'unsigned commit')}` : unsigned.length === 1 ? 'the commit' : `all ${unsigned.length} commits`} as ${signer ? html`<strong>${signer.name}</strong> &lt;${signer.email}&gt;` : html`you (set <code>user.name</code> and <code>user.email</code> in git first)`}</label>`
              : ''
          }
          <label class="js-force-option"${forceNeeded ? '' : raw(' hidden')}><input type="checkbox" name="force"${forceNeeded ? raw(' checked') : ''}> Force-push (this push replaces commits on GitHub)</label>
          ${
            !mergeOption
              ? ''
              : mergeOption.methodAllowed
                ? html`<label><input type="checkbox" name="auto_merge"> Enable auto-merge on GitHub (${mergeOption.method})</label><input type="hidden" name="merge_method" value="${mergeOption.method}">`
                : html`<label class="color-fg-muted"><input type="checkbox" name="auto_merge" disabled> Enable auto-merge on GitHub: ${target} does not allow ${mergeOption.method} merges. <a href="/settings/publishing">Change the merge method</a></label>`
          }
        </div>
        ${images ? html`<div class="flash flash-warn">${icon('alert')}<span>The description has ${plural(images, 'image')} stored in laatsux, which GitHub cannot show. Remove ${them}, or replace ${them} with ${images === 1 ? 'an image' : 'images'} uploaded to GitHub.</span></div>` : ''}
        <div class="flash flash-error js-form-error" hidden></div>
      </div>
      <div class="merge-buttons">
        ${auto ? '' : html`<button type="submit" class="btn" data-api="${p.apiBase}/auto-publish" data-method="PUT" data-toast="Auto-publish is on" title="Publish on its own once the reviewer agents are done with the latest commit and ${p.author.login} has answered them, with the options above">${icon('clock')} Publish when reviews are done</button>`}
        <button type="submit" class="btn btn-primary btn-publish"${work ? raw(' data-confirm="Click again to publish anyway"') : ''}>${icon('mark-github')} ${verb}</button>
      </div>
    </form>`;
  }
  if (work) {
    const what =
      work.status === 'QUEUED'
        ? 'Codex is about to review this commit'
        : work.head_sha === pull.head_sha
          ? 'Codex is still reviewing this commit'
          : html`Codex is still reviewing an earlier commit, <code>${shortSha(work.head_sha)}</code>`;
    const note = html`${work.started_at ? html`Started ${relTime(work.started_at)}. ` : ''}Its review will show up here.${publishable ? ' Publishing before it arrives takes a second click.' : ''}`;
    rows.push(html`<div class="merge-row">${icon('dot-fill', { cls: 'color-fg-attention' })}<div><strong>${what}</strong><div class="color-fg-muted">${note}</div></div></div>`);
  }
  if (auto) rows.push(autoPublishRow(p, auto));
  else if (publishable) {
    // Auto-publish turns itself off when publishing fails; say so until it is on again or the pull request is published.
    const last = s.events(pull).findLast((e) => e.type.startsWith('auto_publish_') || e.type === 'published');
    if (last?.type === 'auto_publish_failed') {
      rows.push(html`<div class="merge-row">${icon('x-circle-fill', { cls: 'color-fg-danger' })}<div class="flex-auto"><strong>Auto-publish failed ${relTime(last.created_at)}</strong>
        <div class="color-fg-muted">It turned itself off. Publish by hand, or turn it on again.</div>
        <pre class="merge-error">${JSON.parse(last.data).error}</pre></div></div>`);
    }
  }
  if (merge) rows.push(autoMergeRow(p, merge));
  const closedOnGithub = pull.github_state === 'closed';
  return html`<div class="merge-box${closedOnGithub ? ' merge-box--closed' : pull.state === 'published' ? ' merge-box--published' : ''}">
    <span class="merge-box-icon">${closedOnGithub ? icon('git-pull-request-closed', { size: 24 }) : pull.state === 'published' ? icon('mark-github', { size: 24 }) : icon('git-pull-request', { size: 24 })}</span>
    <div class="Box">${rows}${publishRow}</div>
  </div>`;
}

/** What came of the last time laatsux turned on auto-merge on GitHub. */
function autoMergeRow(p: PullPage, merge: AutoMerge): Safe {
  const by = p.s.db.actorById(merge.by);
  if (merge.state === 'failed') {
    return html`<div class="merge-row">${icon('x-circle-fill', { cls: 'color-fg-danger' })}<div class="flex-auto"><strong>Auto-merge failed ${relTime(merge.at)}</strong>
      <div class="color-fg-muted">${githubPull(merge.url)} is published, but auto-merge is not on. Enable it on GitHub, or publish again with auto-merge.</div>
      <pre class="merge-error">${merge.error}</pre></div></div>`;
  }
  if (merge.state === 'requested') {
    return html`<div class="merge-row">${icon('git-merge', { cls: 'color-fg-attention' })}<div><strong>Auto-merge requested for ${githubPull(merge.url)}</strong>
      <div class="color-fg-muted">${by.login} requested it ${relTime(merge.at)}, and gh accepted it. Whether GitHub merged it at once (${merge.method}) or waits for its requirements could not be checked.</div></div></div>`;
  }
  if (merge.state === 'merged') {
    return html`<div class="merge-row">${icon('git-merge', { cls: 'color-fg-done' })}<div><strong>Merged on GitHub</strong>
      <div class="color-fg-muted">${by.login} enabled auto-merge ${relTime(merge.at)}, and GitHub had nothing left to wait for, so ${githubPull(merge.url)} was merged right away (${merge.method}).</div></div></div>`;
  }
  return html`<div class="merge-row">${icon('git-merge', { cls: 'color-fg-done' })}<div><strong>Auto-merge is on for ${githubPull(merge.url)}</strong>
    <div class="color-fg-muted">${by.login} enabled it ${relTime(merge.at)}. GitHub merges it (${merge.method}) once its requirements are met, such as required checks, with whatever the branch has then: a push by someone with write access, such as an update published from here, keeps auto-merge on, and one by someone without turns it off.</div></div></div>`;
}

const CHECK_ICON: Record<GithubCheck['result'], [string, string]> = {
  passed: ['check', 'color-fg-success'],
  failed: ['x', 'color-fg-danger'],
  pending: ['dot-fill', 'color-fg-attention'],
  skipped: ['skip', 'color-fg-muted'],
};

/** How the published pull request stands on GitHub, as merge box rows: review, checks, threads, conflicts. */
function githubRows(p: PullPage): Safe[] {
  const g = githubStatus(p.pull);
  if (!g) return [];
  const base = p.pull.base_ref;
  const row = (iconName: string, cls: string, title: Safe | string, text: Safe | string = '', more: Safe | string = '') =>
    html`<div class="merge-row">${icon(iconName, { cls })}<div class="flex-auto"><strong>${title}</strong>${text ? html`<div class="color-fg-muted">${text}</div>` : ''}${more}</div></div>`;
  const rows: Safe[] = [];
  if (g.reviewDecision === 'CHANGES_REQUESTED') rows.push(row('x-circle-fill', 'color-fg-danger', 'Changes requested on GitHub'));
  else if (g.reviewDecision === 'APPROVED') rows.push(row('check-circle-fill', 'color-fg-success', 'Approved on GitHub'));
  const s = checksSummary(g);
  const running = [g.runs.length ? `${plural(g.runs.length, 'workflow run')} still running` : null, g.copilotPending ? 'Copilot is reviewing' : null].filter(Boolean);
  if (s.result || running.length) {
    const counts = [s.failed ? `${s.failed} failing` : null, s.pending ? `${s.pending} in progress` : null, s.passed ? `${s.passed} successful` : null, s.skipped ? `${s.skipped} skipped` : null];
    const [iconName, cls, title] =
      s.result === 'failed'
        ? ['x-circle-fill', 'color-fg-danger', 'Some checks were not successful']
        : s.result === 'pending'
          ? ['dot-fill', 'color-fg-attention', "Some checks haven't completed yet"]
          : running.length
            ? ['dot-fill', 'color-fg-attention', 'Still running on GitHub']
            : ['check-circle-fill', 'color-fg-success', 'All checks have passed'];
    const list = g.checks.length
      ? html`<details class="github-checks"><summary class="btn-link">Show checks</summary><ul class="merge-checks">${g.checks.map((c) => {
          const [name, color] = CHECK_ICON[c.result];
          return html`<li>${icon(name, { cls: color })} <span class="flex-auto">${checkName(c)}</span>${c.url ? html` <a href="${c.url}" target="_blank" rel="noopener">Details</a>` : ''}</li>`;
        })}</ul></details>`
      : '';
    // More checks than one page: the counts are of those shown, the result is GitHub's for all.
    const partial = s.total > s.shown ? `of the first ${s.shown} of ${s.total} checks` : null;
    const text = [[counts.filter(Boolean).join(', '), partial].filter(Boolean).join(' '), running.join(', ')].filter(Boolean).join('; ');
    rows.push(row(iconName, cls, title, html`${text}. Checked on GitHub ${relTime(g.checkedAt)}.`, list));
  }
  if (g.threads.length) {
    const items = g.threads.map((t) => {
      const last = t.comments.at(-1);
      const line = t.line ?? t.originalLine;
      const said = last ? `${last.author}: ${last.body.replace(/\s+/g, ' ').slice(0, 120)}` : '';
      return html`<li>${icon('comment', { cls: 'color-fg-muted' })} <span><a href="${t.url}" target="_blank" rel="noopener"><code>${t.path}${line ? `:${line}` : ''}</code></a> ${said}</span></li>`;
    });
    rows.push(row('comment-discussion', 'color-fg-attention', `${plural(g.threads.length, 'unresolved conversation')} on GitHub`, '', html`<ul class="merge-checks">${items}</ul>`));
  }
  if (g.conflicting) rows.push(row('alert', 'color-fg-danger', html`This branch has conflicts with <span class="branch-name branch-name-sm">${base}</span> on GitHub`, `The agent rebases it; publishing that update force-pushes.`));
  else if (g.mergeStateStatus === 'BEHIND') rows.push(row('alert', 'color-fg-attention', html`This branch is behind <span class="branch-name branch-name-sm">${base}</span> on GitHub`));
  return rows;
}

/** Auto-publish while it is on: what it is waiting for, and a way to turn it off. */
function autoPublishRow(p: PullPage, auto: AutoPublish): Safe {
  const { s, pull, author } = p;
  const r = s.readiness(pull);
  const by = s.db.actorById(auto.by);
  const options = [auto.sign ? 'signed' : null, auto.draft && !pull.published_url ? 'as a draft' : null, auto.force ? 'with force if needed' : null].filter(Boolean);
  const item = (state: 'done' | 'waiting' | 'failed', text: Safe | string) =>
    html`<li>${state === 'done' ? icon('check', { cls: 'color-fg-success' }) : state === 'failed' ? icon('x', { cls: 'color-fg-danger' }) : icon('dot-fill', { cls: 'color-fg-attention' })} <span>${text}</span></li>`;
  const items = r.reviewers.map(({ login, status }) => item(status.done ? 'done' : status.state === 'failed' ? 'failed' : 'waiting', reviewerText(login, status, pull, author)));
  items.push(
    r.authorWaiting && !r.unseen
      ? item('done', `${author.login} is waiting for review, with all feedback seen`)
      : item('waiting', r.authorWaiting ? `${author.login} has feedback it has not seen yet` : `${author.login} is working (not waiting for review)`),
  );
  if (r.openThreads) items.push(item('waiting', `${plural(r.openThreads, 'conversation')} you started ${r.openThreads === 1 ? 'is' : 'are'} unresolved`));
  // GitHub's settings may have changed since it was turned on; publishing refuses then.
  const method = auto.autoMerge;
  const merging = method && p.repo.github_slug ? s.githubRepo(p.repo.github_slug)?.merging : null;
  if (merging && !merging.autoMerge) items.push(item('failed', `${p.repo.github_slug} does not allow auto-merge, so publishing will fail`));
  else if (merging && method && !merging.methods.includes(method)) items.push(item('failed', `${p.repo.github_slug} does not allow ${method} merges, so publishing will fail`));
  return html`<div class="merge-row">${icon('clock', { cls: 'color-fg-done' })}<div class="flex-auto">
    <strong>Auto-publish is on</strong>
    <div class="color-fg-muted">${by.login} turned it on ${relTime(auto.at)}. It publishes the latest commit${options.length ? ` ${options.join(', ')}` : ''} once the reviewer agents are done with it and ${author.login} has answered them.${auto.autoMerge ? ` Then it enables auto-merge on GitHub (${method}).` : ''}</div>
    <ul class="merge-checks">${items}</ul>
  </div>
  <button type="button" class="btn btn-sm js-auto-publish-cancel" data-api="${p.apiBase}/auto-publish">Cancel auto-publish</button></div>`;
}

/** A reviewer agent's progress with the head, for the auto-publish checklist. */
function reviewerText(login: string, status: HeadStatus, pull: PullRow, author: Actor): Safe {
  const sha = html`<code>${shortSha(status.commit)}</code>`;
  switch (status.state) {
    case 'reviewing':
      return status.commit === pull.head_sha ? html`${login} is reviewing ${sha}` : html`${login} is reviewing an earlier commit, ${sha}`;
    case 'queued':
      return html`${login} is about to review ${sha}`;
    case 'unreviewed':
      return html`${login} reviews ${sha} when ${author.login} waits for review`;
    case 'findings':
      return html`${login} found problems in ${sha}, and reviews the commit that addresses them`;
    case 'failed':
      return html`${login}'s review of ${sha} failed. Ask it to review again, or publish by hand.`;
    case 'clean':
      return html`${login} found nothing in ${sha}`;
    case 'capped':
      return html`${login} has used up its automatic reviews`;
    case 'off':
      return html`${login} does not review this pull request automatically`;
  }
}

function sidebar(p: PullPage): Safe {
  const { s, pull, repo } = p;
  const latest = new Map<number, ReviewRow>();
  for (const r of p.reviews) if (r.state !== 'PENDING' && r.author_id !== pull.author_id) latest.set(r.author_id, r);
  const reviewIcon: Record<string, Safe> = {
    APPROVED: icon('check', { cls: 'color-fg-success' }),
    CHANGES_REQUESTED: icon('file-diff', { cls: 'color-fg-danger' }),
    COMMENTED: icon('comment', { cls: 'color-fg-muted' }),
  };
  const reviewers = latest.size
    ? [...latest.values()].map((r) => {
        const a = s.db.actorById(r.author_id);
        return html`<li class="sidebar-person">${avatar(avatarUrl(s, a), a.login, 20, a.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')} <span class="flex-auto">${a.login}</span> ${reviewIcon[r.state] ?? ''}</li>`;
      })
    : html`<li class="color-fg-muted">No reviews yet</li>`;
  const waiting = (s.waiters.get(pull.id) ?? 0) > 0;
  const revisions = s.revisions(pull);
  return html`<aside class="layout-sidebar">
  <div class="sidebar-item"><h3 class="sidebar-heading">Reviewers</h3><ul class="sidebar-list">${reviewers}</ul></div>
  ${codexSidebar(p)}
  <div class="sidebar-item"><h3 class="sidebar-heading">Author</h3>
    <ul class="sidebar-list"><li class="sidebar-person">${avatar(avatarUrl(s, p.author), p.author.login, 20, p.author.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')} <span class="flex-auto">${p.author.login}</span></li></ul>
    <p class="agent-status ${waiting ? 'agent-status--waiting' : ''}">${icon('dot-fill')} ${waiting ? 'Waiting for your review' : 'Not waiting (working, or done)'}</p>
  </div>
  <div class="sidebar-item"><h3 class="sidebar-heading">Revisions</h3>
    <ol class="sidebar-list revision-list">${revisions.map((r, i) => {
      const prev = revisions[i - 1];
      return html`<li><a href="${p.htmlBase}/files${prev ? `?range=${prev.head_sha}..${r.head_sha}` : ''}" title="${prev ? 'Changes in this revision' : 'Files at the first revision'}"><code>${shortSha(r.head_sha)}</code></a> ${r.forced ? html`<span class="Label Label--small">force-push</span>` : ''} <span class="color-fg-muted">${relTime(r.created_at)}</span> <a class="revision-browse link-muted" href="${browseUrl(`/${repo.owner}/${repo.name}`, 'tree', r.head_sha, '')}" title="Browse the repository at this revision" aria-label="Browse files at ${shortSha(r.head_sha)}">${icon('code')}</a></li>`;
    })}</ol>
  </div>
  <div class="sidebar-item"><h3 class="sidebar-heading">Repository</h3>
    <p class="sidebar-text"><code class="wrap">${repo.work_dir ?? repo.git_dir}</code></p>
    <p class="sidebar-text color-fg-muted">${repo.github_slug ? html`Publishes to <a href="https://github.com/${repo.github_slug}" target="_blank" rel="noopener">${repo.github_slug}</a>` : 'No GitHub remote'} · compared with <code>${repo.remote}/${pull.base_ref}</code></p>
  </div>
  <div class="sidebar-item">
    <button type="button" class="btn-link color-fg-danger js-delete-pull" data-api="${p.apiBase}" data-next="/${repo.owner}/${repo.name}">${icon('trash')} Delete staged pull request</button>
  </div>
</aside>`;
}

/** Codex's state on this pull request: reviewing, last result or error, and a button to ask for a review. */
function codexSidebar(p: PullPage): Safe {
  const codex = p.s.codex;
  if (!codex) return raw('');
  const settings = codex.settings();
  const runs = codex.runs(p.pull);
  const last = runs[runs.length - 1];
  const running = codex.isRunning(p.pull.id);
  const work = codex.atWork(p.pull);
  const actor = codex.actor();
  let status: Safe;
  if (work?.status === 'IN_PROGRESS') {
    status = html`<p class="codex-status codex-status--running">${icon('dot-fill')} Reviewing <code>${shortSha(work.head_sha)}</code>, started ${relTime(work.started_at)}</p>`;
  } else if (work) {
    status = html`<p class="codex-status codex-status--running">${icon('dot-fill')} About to review <code>${shortSha(work.head_sha)}</code></p>`;
  } else if (last?.status === 'done') {
    status = html`<p class="codex-status">${icon('check', { cls: 'color-fg-success' })} <a href="#pullrequestreview-${last.review_id}">Reviewed <code>${shortSha(last.head_sha)}</code></a> ${relTime(last.finished_at)}</p>`;
  } else if (last?.status === 'failed') {
    status = html`<div class="codex-status">${icon('x-circle-fill', { cls: 'color-fg-danger' })} Review of <code>${shortSha(last.head_sha)}</code> failed ${relTime(last.finished_at)}
      <details class="codex-error"><summary class="btn-link">Show error</summary><pre>${last.error ?? ''}</pre></details></div>`;
  } else {
    status = html`<p class="codex-status color-fg-muted">Has not reviewed this pull request.</p>`;
  }
  const used = codex.automaticReviews(p.pull);
  const limit = codex.limit(p.pull);
  const enabled = codex.enabled(p.pull);
  const own = p.pull.codex_max_iterations !== null;
  const limitApi = `${p.apiBase}/reviewers/codex`;
  // The limit is changed in place: −/+ after the number, saved shortly after the last click.
  const auto = enabled
    ? html`Automatic reviews: ${used} of <span class="codex-limit" data-api="${limitApi}" data-limit="${limit}" data-max="${MAX_ITERATIONS_LIMIT}"><strong class="js-codex-limit">${limit}</strong><button type="button" class="codex-step js-codex-step" data-step="-1" aria-label="One automatic review fewer" title="One fewer"${limit <= 0 ? raw(' disabled') : ''}>${icon('dash')}</button><button type="button" class="codex-step js-codex-step" data-step="1" aria-label="One more automatic review" title="One more"${limit >= MAX_ITERATIONS_LIMIT ? raw(' disabled') : ''}>${icon('plus')}</button></span>${
        own ? html` <button type="button" class="btn-link js-codex-reset" data-api="${limitApi}" data-field="max_iterations" title="Use the default from Settings (${settings.maxIterations})">reset</button>` : ''
      }`
    : html`Automatic reviews are off`;
  // Staging can turn automatic reviews on or off for one pull request, whatever Settings say.
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  const scope =
    p.pull.codex_enabled === null
      ? ''
      : html`<p class="sidebar-text codex-scope">${icon('pin')} Turned ${onOff(enabled)} for this pull request${settings.enabled !== enabled ? ` (${onOff(settings.enabled)} in Settings)` : ''} <button type="button" class="btn-link js-codex-reset" data-api="${limitApi}" data-field="enabled" title="Follow Settings (automatic reviews ${onOff(settings.enabled)})">reset</button></p>`;
  return html`<div class="sidebar-item"><h3 class="sidebar-heading">Codex</h3>
    <a class="sidebar-person" href="${codex.settingsUrl()}" title="Settings for ${actor.login}">${avatar(avatarUrl(p.s, actor), actor.login, 20, 'avatar-bot')} <span class="flex-auto">${actor.login}</span></a>
    ${status}
    <p class="sidebar-text color-fg-muted">${auto} · <a href="${codex.settingsUrl()}">Settings</a></p>
    ${scope}
    <button type="button" class="btn btn-sm js-run-codex" data-api="${p.apiBase}/reviewers/codex"${running || p.pull.state === 'closed' ? raw(' disabled') : ''}>${icon('sync')} Ask Codex to review</button>
  </div>`;
}

export async function conversationPage(p: PullPage): Promise<string> {
  const { s, pull, viewer } = p;
  const items: { at: string; order: number; html: Safe }[] = [];
  const revisions = s.revisions(pull);

  if (revisions[0]) {
    const first = revisions[0];
    const commits = await p.ctx.git.log(first.base_sha, first.head_sha).catch(() => [] as Commit[]);
    const who = html`${avatar(avatarUrl(s, p.author), p.author.login, 20, 'avatar-bot avatar-small')} ${authorLink(s, p.author)}`;
    items.push({ at: first.created_at, order: 1, html: html`${timelineBadge('repo-push', html`${who} added ${plural(commits.length, 'commit')} ${relTime(first.created_at)}`)}${commitList(p, commits)}` });
  }
  for (const e of s.events(pull)) {
    const h = await eventItem(p, e);
    if (h) items.push({ at: e.created_at, order: 2, html: h });
  }
  for (const c of s.issueComments(pull)) {
    const a = s.db.actorById(c.author_id);
    items.push({
      at: c.created_at,
      order: 3,
      html: timelineComment(s, {
        id: c.id,
        author: a,
        body: c.body,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        editPath: c.author_id === viewer.id ? `/api/repos/${p.repo.owner}/${p.repo.name}/issues/comments/${c.id}` : undefined,
        isAuthor: c.author_id === pull.author_id,
        anchor: `issuecomment-${c.id}`,
        markdownCtx: { references: p.references },
      }),
    });
  }
  const opts = threadOpts(p, true);
  for (const r of p.reviews) {
    if (r.state === 'PENDING' || !r.submitted_at) continue;
    const a = s.db.actorById(r.author_id);
    const threads = p.threads.filter((t) => t.root.review_id === r.id);
    const meta = REVIEW_TEXT[r.state] ?? REVIEW_TEXT.COMMENTED;
    const single = r.state === 'COMMENTED' && !r.body.trim() && threads.length === 1;
    const text = single ? (threads[0].root.subject_type === 'commit' ? 'commented on a commit' : html`commented on <code>${threads[0].root.path}</code>`) : meta.text;
    const who = html`${avatar(avatarUrl(s, a), a.login, 20, a.type === 'Bot' ? 'avatar-bot avatar-small' : 'avatar-circle avatar-small')} ${authorLink(s, a)}`;
    items.push({
      at: r.submitted_at,
      order: 4,
      html: html`<div class="timeline-review" id="pullrequestreview-${r.id}">
        ${timelineBadge(single ? 'comment' : meta.icon, html`${who} ${text} <a class="link-muted" href="#pullrequestreview-${r.id}">${relTime(r.submitted_at)}</a>`, { cls: single ? '' : meta.cls })}
        <div class="timeline-review-body">
          ${r.body.trim() ? html`<div class="review-summary"><div class="comment-body markdown-body">${raw(renderMarkdown(r.body, { references: p.references }))}</div></div>` : ''}
          ${threads.map((t) => reviewThread(s, t, opts))}
        </div>
      </div>`,
    });
  }
  items.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);

  const description = timelineComment(
    s,
    {
      id: 0,
      author: p.author,
      body: pull.body,
      createdAt: pull.created_at,
      updatedAt: pull.created_at,
      editPath: p.apiBase,
      deletable: false,
      isAuthor: true,
      anchor: 'pullrequest-description',
      markdownCtx: { references: p.references },
    },
    html`${authorLink(s, p.author)} opened this pull request ${relTime(pull.created_at)}`,
  );

  const newComment = html`<div class="timeline-comment-group new-comment">
  <span class="timeline-avatar">${avatar(avatarUrl(s, viewer), viewer.login, 40, 'avatar-circle')}</span>
  <form class="timeline-comment js-api-form" data-api="/api/repos/${p.repo.owner}/${p.repo.name}/issues/${pull.number}/comments" data-method="POST" data-reset="true">
    <div class="timeline-comment-header"><h3 class="timeline-comment-header-text"><strong>Add a comment</strong></h3></div>
    <div class="new-comment-body">
      ${markdownEditor({ placeholder: 'Leave a comment. The agent reads it with `laatsux pr view --comments` or `laatsux pr wait`.', draftKey: 'new-comment' })}
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions">
        ${pull.state === 'closed' ? html`<button type="button" class="btn js-set-state" data-state="open">${icon('git-pull-request')} Reopen pull request</button>` : html`<button type="button" class="btn js-set-state" data-state="closed">${icon('git-pull-request-closed', { cls: 'color-fg-closed' })} Close pull request</button>`}
        <button type="submit" class="btn btn-primary">Comment</button>
      </div>
    </div>
  </form>
</div>`;

  const content = html`<div class="container container-xl layout">
  <div class="layout-main">
    <div class="timeline">
      ${description}
      ${items.map((i) => i.html)}
    </div>
    ${await mergeBox(p)}
    ${newComment}
  </div>
  ${sidebar(p)}
</div>`;
  return pullLayout(p, 'conversation', content);
}

// ---------------------------------------------------------------- commits

export function commitsPage(p: PullPage): string {
  const { s } = p;
  const groups = Map.groupBy(p.commits, (c) => new Date(c.committerDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  const opts = threadOpts(p, false);
  const commitThreads = (sha: string) => p.threads.filter((t) => t.root.subject_type === 'commit' && t.root.commit_id === sha);
  const content = html`<div class="container container-xl commits-page" data-commit-id="${p.pull.head_sha}" data-pending-review="${p.pending?.id ?? ''}">
  ${[...groups].map(
    ([date, commits]) => html`<div class="commit-group">
    <h2 class="commit-group-title">${icon('git-commit')} Commits on ${date}</h2>
    <ol class="Box commit-list">${commits.map((c) => {
      const [headline, ...rest] = c.message.split('\n');
      const desc = rest.join('\n').trim();
      const threads = commitThreads(c.sha);
      return html`<li class="Box-row commit" id="commit-${c.sha}" data-commit="${c.sha}">
        <div class="commit-row">
          <div class="commit-main">
            <p class="commit-title"><a href="${p.htmlBase}/files?commit=${c.sha}">${headline}</a>${desc ? html` <button type="button" class="ellipsis-expander js-commit-expand" aria-label="Show description">…</button>` : ''}</p>
            ${desc ? html`<pre class="commit-desc" hidden>${desc}</pre>` : ''}
            <div class="commit-meta">${avatar(`/avatars/${encodeURIComponent(c.authorName)}.svg`, c.authorName, 16, 'avatar-circle')} <strong>${c.authorName}</strong> committed ${relTime(c.committerDate)}</div>
          </div>
          <div class="commit-actions">
            <button type="button" class="btn btn-sm js-commit-comment" title="Comment on this commit's message">${icon('comment')}${threads.length ? html` ${threads.length}` : ''}</button>
            <a class="btn btn-sm commit-sha" href="${p.htmlBase}/files?commit=${c.sha}"><code>${shortSha(c.sha)}</code></a>
            ${copyButton(c.sha, 'Copy full SHA')}
            <a class="btn btn-sm" href="${browseUrl(`/${p.repo.owner}/${p.repo.name}`, 'tree', c.sha, '')}" title="Browse the repository at this commit" aria-label="Browse files">${icon('code')}</a>
          </div>
        </div>
        <div class="commit-threads">${threads.map((t) => reviewThread(s, t, opts))}</div>
      </li>`;
    })}</ol>
  </div>`,
  )}
  <p class="color-fg-muted commits-hint">${icon('info')} Comments on a commit are about its message. The agent sees them as review threads and can reword the commit.</p>
</div>`;
  return pullLayout(p, 'commits', content);
}

// ------------------------------------------------------------------ files

export async function filesPage(p: PullPage, query: { commit?: string; range?: string }, mode: DiffMode): Promise<string> {
  const { s, pull, ctx } = p;
  let base = pull.base_sha;
  let head = pull.head_sha;
  let label: Safe = html`<strong>all commits</strong>`;
  let note: Safe | null = null;
  let files = p.files;
  if (query.commit) {
    const sha = await ctx.git.resolve(query.commit);
    if (sha) {
      const commit = p.commits.find((c) => c.sha === sha) ?? (await ctx.git.commit(sha));
      base = (await ctx.git.resolve(`${sha}^`)) ?? sha;
      head = sha;
      files = await ctx.git.diff(base === sha ? null : base, sha);
      label = html`<code>${shortSha(sha)}</code>`;
      note = html`Showing changes from commit <code>${shortSha(sha)}</code> <strong>${commit?.message.split('\n')[0] ?? ''}</strong>`;
    }
  } else if (query.range) {
    const [from, to] = query.range.split('..');
    const a = await ctx.git.resolve(from);
    const b = await ctx.git.resolve(to);
    if (a && b) {
      base = a;
      head = b;
      files = await ctx.git.diff(a, b);
      label = html`<code>${shortSha(a)}..${shortSha(b)}</code>`;
      note = html`Showing changes between <code>${shortSha(a)}</code> and <code>${shortSha(b)}</code>. After a rebase this includes changes from the base branch.`;
    }
  }
  const fullView = base === pull.base_sha && head === pull.head_sha;

  // Threads that belong in this view, keyed by where they sit.
  const threadsAt = new Map<string, Thread[]>();
  const fileThreads = new Map<string, Thread[]>();
  const spans = new Map<string, Span[]>();
  for (const t of p.threads) {
    const r = t.root;
    if (r.subject_type === 'commit') continue;
    let line: number | null = null;
    if (fullView) {
      if (t.placement.outdated) continue;
      line = t.placement.line;
    } else if (r.commit_id === head && r.base_commit_id === base) {
      line = r.line;
    } else continue;
    if (r.subject_type === 'file') {
      fileThreads.set(r.path!, [...(fileThreads.get(r.path!) ?? []), t]);
      continue;
    }
    const key = threadKey(r.path!, r.side!, line!);
    threadsAt.set(key, [...(threadsAt.get(key) ?? []), t]);
    spans.set(r.path!, [...(spans.get(r.path!) ?? []), { side: r.side!, line: line!, startSide: r.start_side, startLine: fullView ? t.placement.startLine : r.start_line }]);
  }
  const shown = await withThreadContext(ctx.git, head, files, spans);

  const viewed = s.viewed(pull);
  const opts = threadOpts(p, false);
  const browse = { repo: `/${p.repo.owner}/${p.repo.name}`, base, head };
  // Each file's unresolved conversations, as they render: what the file tree counts and goes to.
  const unresolved = new Map<string, number[]>();
  const renderThread = (t: Thread, lines: string[]) => {
    if (!t.resolved && !t.pending) unresolved.set(t.root.path!, [...(unresolved.get(t.root.path!) ?? []), t.root.id]);
    return reviewThread(s, t, { ...opts, suggestionLines: lines });
  };
  const rendered = shown.files.map((f) => renderFile(f, { mode, threadsAt, viewed, fileThreads, browse, totals: shown.totals, renderThread }));
  const viewedCount = fullView ? files.filter((f) => viewed.get(f.path) === (f.newBlob ?? f.oldBlob ?? `${f.additions}-${f.deletions}`)).length : 0;

  const lastReview = [...p.reviews].reverse().find((r) => r.author_id === p.viewer.id && r.state !== 'PENDING');
  const revisions = s.revisions(pull);
  const pendingCount = p.pending ? (s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE review_id = ?', p.pending.id)!.n) : 0;
  const qs = (extra: string) => {
    const params = new URLSearchParams();
    if (query.commit) params.set('commit', query.commit);
    if (query.range) params.set('range', query.range);
    params.set('diff', extra);
    return `?${params}`;
  };

  const menu = html`<details class="dropdown details-reset changes-menu">
    <summary class="btn btn-sm">Changes from ${label} ${icon('triangle-down')}</summary>
    <div class="dropdown-menu dropdown-menu-se changes-menu-list">
      <a class="dropdown-item${fullView ? ' selected' : ''}" href="${p.htmlBase}/files"><strong>Show all changes</strong><span class="dropdown-item-desc">${plural(p.commits.length, 'commit')}</span></a>
      ${lastReview && lastReview.commit_id !== pull.head_sha ? html`<a class="dropdown-item" href="${p.htmlBase}/files?range=${lastReview.commit_id}..${pull.head_sha}"><strong>Show changes since your last review</strong><span class="dropdown-item-desc">since <code>${shortSha(lastReview.commit_id)}</code></span></a>` : ''}
      ${revisions.length > 1 ? html`<div class="dropdown-divider"></div><div class="dropdown-header">Revisions (pushes)</div>` : ''}
      ${revisions.slice(1).map((r, i) => {
        const prev = revisions[i];
        return html`<a class="dropdown-item" href="${p.htmlBase}/files?range=${prev.head_sha}..${r.head_sha}">Revision ${r.seq}${r.forced ? ' (force-push)' : ''}<span class="dropdown-item-desc"><code>${shortSha(prev.head_sha)}..${shortSha(r.head_sha)}</code> · ${relTime(r.created_at)}</span></a>`;
      })}
      <div class="dropdown-divider"></div><div class="dropdown-header">Commits</div>
      ${p.commits.map((c) => html`<a class="dropdown-item${query.commit && head === c.sha ? ' selected' : ''}" href="${p.htmlBase}/files?commit=${c.sha}">${c.message.split('\n')[0]}<span class="dropdown-item-desc"><code>${shortSha(c.sha)}</code> · ${c.authorName}</span></a>`)}
    </div>
  </details>`;

  const reviewApi = p.pending ? `${p.apiBase}/reviews/${p.pending.id}/events` : `${p.apiBase}/reviews`;
  const reviewMenu = html`<details class="dropdown details-reset review-menu">
    <summary class="btn btn-sm btn-primary">${p.pending ? 'Finish your review' : 'Review changes'}${pendingCount ? html` <span class="Counter Counter--primary">${pendingCount}</span>` : ''} ${icon('triangle-down')}</summary>
    <div class="dropdown-menu dropdown-menu-sw review-dialog">
      <form class="js-api-form js-review-form" data-api="${reviewApi}" data-method="POST">
        <div class="review-dialog-header"><strong>Finish your review</strong></div>
        ${markdownEditor({ placeholder: 'Leave a comment', draftKey: 'review-body', rows: 4 })}
        <div class="review-dialog-options">
          <label class="review-option"><input type="radio" name="event" value="COMMENT" checked> <span><strong>Comment</strong><span class="color-fg-muted">Submit general feedback without explicit approval.</span></span></label>
          <label class="review-option"><input type="radio" name="event" value="APPROVE"> <span><strong>Approve</strong><span class="color-fg-muted">The changes are good to publish.</span></span></label>
          <label class="review-option"><input type="radio" name="event" value="REQUEST_CHANGES"> <span><strong>Request changes</strong><span class="color-fg-muted">The agent must address this feedback.</span></span></label>
        </div>
        <div class="flash flash-error js-form-error" hidden></div>
        <div class="form-actions">
          ${p.pending ? html`<button type="button" class="btn btn-sm btn-danger js-discard-review" data-api="${p.apiBase}/reviews/${p.pending.id}">Discard pending review</button>` : ''}
          <button type="submit" class="btn btn-sm btn-primary">Submit review</button>
        </div>
      </form>
    </div>
  </details>`;

  const content = html`<div class="files-toolbar">
  <div class="container container-full files-toolbar-inner">
    <button type="button" class="btn-octicon js-tree-toggle" aria-label="Toggle file tree">${icon('sidebar-collapse')}</button>
    ${menu}
    ${note ? html`<span class="files-note">${note}</span>` : ''}
    <span class="flex-auto"></span>
    <div class="BtnGroup">
      <a class="btn btn-sm BtnGroup-item${mode === 'unified' ? ' selected' : ''}" href="${qs('unified')}">Unified</a>
      <a class="btn btn-sm BtnGroup-item${mode === 'split' ? ' selected' : ''}" href="${qs('split')}">Split</a>
    </div>
    ${fullView ? html`<span class="viewed-progress"><span class="js-viewed-count">${viewedCount}</span> / ${files.length} files viewed</span>` : ''}
    ${reviewMenu}
  </div>
</div>
<div class="container container-full files-layout">
  ${files.length ? fileTree(files, fullView ? viewed : new Map(), unresolved) : ''}
  <div class="files">
    ${rendered.length ? rendered : html`<div class="blankslate"><h3>No changes</h3></div>`}
  </div>
</div>`;
  return pullLayout(p, 'files', content, {
    'commit-id': head,
    'base-commit-id': base,
    'pending-review': p.pending?.id ?? '',
    'full-view': fullView ? '1' : '',
  });
}

export function notFoundPage(s: Service, message: string): string {
  return layout(s, {
    title: 'Not found · laatsux',
    body: html`<div class="container container-lg"><div class="blankslate">${icon('alert', { size: 24 })}<h3>${message}</h3><p><a href="/">Back to all staged pull requests</a></p></div></div>`,
  });
}
