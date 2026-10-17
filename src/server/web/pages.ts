import type { Commit } from '../git.ts';
import type { FileDiff } from '../diff.ts';
import type { Actor, CancelReason, CommentRow, EventRow, PullRow, RepoRow, ReviewRow, ReviewRunRow, RevisionRow } from '../db.ts';
import { afterRound, CANCELLED, githubStatus, HttpError, publishFingerprint, stagingState, TO_REVIEW, type AutoMerge, type AutoPublish, type BaseConflicts, type Ctx, type HeadStatus, type Readiness, type Service, type Thread, type Turn, type TurnReason } from '../service.ts';
import { customActorKey, onTheDescription, outsideTheDiff, runSubject, type OwnSettings, type Reviewer, type RunUsage } from '../reviewers/reviewer.ts';
import { hasTranscript, transcript } from '../reviewers/transcript.ts';
import { checkName, checksSummary, type GithubCheck } from '../github-follow.ts';
import { avatarUrl, reasonText } from '../github.ts';
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
  priorityCounts,
  pullIcon,
  repoCrumbs,
  reviewThread,
  stateBadge,
  timelineBadge,
  timelineComment,
} from './components.ts';
import { browseUrl, diffstatBlocks, fileTree, renderFile, threadKey, type DiffMode } from './diffview.ts';
import { withThreadContext } from './browse.ts';
import { dollars, runProgress, runUrl, tokens, transcriptContent, usageParts } from './runs.ts';
import type { Span } from '../diff.ts';

// ------------------------------------------------------------------ lists

export function pullList(s: Service, opts: { repo: RepoRow | null; state: string }): string {
  // Every repository's, for the sidebar and notifications; a repository's page lists its own.
  const everywhere = s.pulls(null, { state: 'all' });
  const current = opts.repo;
  const all = current ? everywhere.filter((p) => p.repo_id === current.id) : everywhere;
  // A tab per state, each pull request in one of them (stagingState), so the counts do not overlap.
  const staging = new Map(everywhere.map((p) => [p.id, stagingState(p)]));
  const state = ['staged', 'published', 'done', 'all'].includes(opts.state) ? opts.state : 'staged';
  // The front page has the pinned ones at the top, whatever their state, most recently pinned first, and not again below.
  const pinned = opts.repo ? [] : all.filter((p) => p.pinned_at).sort((a, b) => b.pinned_at!.localeCompare(a.pinned_at!));
  const listed = opts.repo ? all : all.filter((p) => !p.pinned_at);
  const shown = state === 'all' ? listed : listed.filter((p) => staging.get(p.id) === state);
  const base = opts.repo ? `/${opts.repo.owner}/${opts.repo.name}` : '/';
  // What the reviewer agents are at, which decides whose turn it is and which the rows say.
  const ready = new Map(everywhere.filter((p) => staging.get(p.id) !== 'done').map((p) => [p.id, s.readiness(p)]));
  const turns = new Map(everywhere.map((p) => [p.id, s.turn(p, ready.get(p.id))]));
  const turn = (p: PullRow) => turns.get(p.id)!;
  const yoursEverywhere = everywhere.filter((p) => turn(p).whose === 'reviewer');
  const yours = current ? yoursEverywhere.filter((p) => p.repo_id === current.id) : yoursEverywhere;
  /** A tab with its count, and how many of them wait for you, also when another tab is shown. */
  const tab = (key: string, iconName: string, label: string) => {
    const n = all.filter((p) => staging.get(p.id) === key).length;
    const mine = yours.filter((p) => staging.get(p.id) === key).length;
    const turnCount = mine ? html` <span class="list-tab-turn" title="${plural(mine, 'pull request')} waiting for you">${icon('inbox')} ${mine}</span>` : '';
    return html`<a class="list-tab${state === key ? ' selected' : ''}" href="${base}?state=${key}">${icon(iconName)} <span data-content="${n} ${label}">${n} ${label}</span>${turnCount}</a>`;
  };
  const href = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return `/${repo.owner}/${repo.name}/pull/${p.number}`;
  };
  const apiBase = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return `/api/repos/${repo.owner}/${repo.name}/pulls/${p.number}`;
  };
  // What notifications follow (notifyTurns in app.js): your turn in every repository, whatever this page lists.
  const notify = yoursEverywhere.map((p) => ({ id: p.id, title: p.title, url: href(p), reasons: turn(p).reasons.map(reasonText).join(' · ') }));
  const pinMark = html`<span class="pin-mark" title="Pinned to the top of the front page">${icon('pin-fill', { label: 'Pinned' })}</span>`;
  const heading = (p: PullRow) => {
    const repo = s.repoById(p.repo_id);
    return html`${opts.repo ? '' : html`<a class="pr-row-repo" href="/${repo.owner}/${repo.name}">${repo.owner}/${repo.name}</a>`}
    <a class="pr-row-title" href="${href(p)}">${p.title}</a> ${checksIndicator(p)}${p.pinned_at && opts.repo ? pinMark : ''}`;
  };
  const published = (p: PullRow) =>
    p.published_url ? html`<a href="${p.published_url}" target="_blank" rel="noopener">${icon('mark-github')} ${p.published_url.replace('https://github.com/', '').replace('/pull/', '#')}</a>` : '';
  /** How a pull request that is done ended: merged or closed on GitHub, or closed here. */
  const ended = (p: PullRow) =>
    p.github_state === 'merged'
      ? html`<span class="Label Label--merged">Merged</span>`
      : p.state === 'closed'
        ? html`<span class="Label Label--closed">Closed</span>`
        : p.github_state === 'closed'
          ? html`<span class="Label Label--closed">Closed on GitHub</span>`
          : '';

  /** Who is at work on a pull request, as small avatars at the end of its row. */
  const atWorkAvatars = (atWork: TurnLine['atWork']) =>
    atWork.length
      ? html`<span class="turn-avatars">${atWork.map(({ actor, doing }) => html`<span class="turn-avatar" title="${doing}">${avatar(avatarUrl(s, actor), actor.login, 20, actor.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')}</span>`)}</span>`
      : '';

  /** A pull request with what it waits for: whose turn it is and why, the decision, and what GitHub does not have yet. */
  const row = (p: PullRow) => {
    const t = turn(p);
    const author = s.db.actorById(p.author_id);
    const unpublished = t.reasons.find((r) => r.kind === 'unpublished');
    const comments = s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE pull_id = ? AND ' + "(review_id IS NULL OR review_id IN (SELECT id FROM reviews WHERE state != 'PENDING'))", p.id)!.n;
    const { line, atWork } = turnLine(s, p, t, ready.get(p.id), apiBase(p));
    return html`<div class="Box-row pr-row">
  <span class="pr-row-icon">${pullIcon(p, !!unpublished)}</span>
  <div class="pr-row-main">
    ${heading(p)}
    ${p.draft && p.state === 'staged' ? html`<span class="Label">Draft</span>` : ''}
    ${t.reasons.some((r) => r.kind === 'approved') ? html`<span class="Label Label--success">${icon('check')} Approved</span>` : ''}
    ${t.reasons.some((r) => r.kind === 'changes_requested') ? html`<span class="Label Label--danger">${icon('file-diff')} Changes requested</span>` : ''}
    ${unpublished ? html`<span class="Label Label--attention">${icon('mark-github')} ${capitalize(unpublished.text)}</span>` : ''}
    ${ended(p)}
    ${line}
    <div class="pr-row-meta">#${p.number} staged ${relTime(p.created_at)} by ${author.login} · <span class="branch-name branch-name-sm">${p.head_ref}</span> ${icon('arrow-right')} <span class="branch-name branch-name-sm">${p.base_ref}</span>${p.published_url ? html` · ${published(p)}` : ''}</div>
  </div>
  <div class="pr-row-side">${atWorkAvatars(atWork)}${comments ? html`<a class="link-muted" href="${href(p)}">${icon('comment')} ${comments}</a>` : ''}</div>
</div>`;
  };

  /** The title, and under it what the agents are doing. */
  const compactRow = (p: PullRow) => {
    const t = turn(p);
    const unpublished = t.reasons.some((r) => r.kind === 'unpublished');
    const { line, atWork } = t.whose === 'none' ? { line: html`<div class="pr-row-turn">${published(p)}</div>`, atWork: [] } : turnLine(s, p, t, ready.get(p.id), apiBase(p), ['author', 'reviewer_agent', 'unpublished', 'conflicts']);
    return html`<div class="Box-row pr-row pr-row--compact">
  <span class="pr-row-icon">${pullIcon(p, unpublished)}</span>
  <div class="pr-row-main">
    <span class="pr-row-heading">${heading(p)} <span class="pr-row-number">#${p.number}</span></span>
    ${line}
  </div>
  <div class="pr-row-side">${atWorkAvatars(atWork)}</div>
</div>`;
  };

  let rows: Safe[] = shown.map(row);
  // Staged and published: those waiting for you first, oldest first, then those with the agents.
  if ((state === 'staged' || state === 'published') && shown.length) {
    const group = (iconName: string, title: string, n: number, note = '') =>
      html`<div class="Box-row turn-group">${icon(iconName)} <h2 class="turn-group-title">${title}</h2> <span class="Counter">${n}</span>${note ? html` <span class="turn-group-note">${note}</span>` : ''}</div>`;
    const mine = shown.filter((p) => turn(p).whose === 'reviewer').sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const pinnedMine = pinned.some((p) => staging.get(p.id) === state && turn(p).whose === 'reviewer');
    const agents = shown.filter((p) => turn(p).whose === 'author' || turn(p).whose === 'reviewer_agents');
    // Published with nothing new here: the next move is on GitHub (its review, checks, the merge).
    const github = shown.filter((p) => turn(p).whose === 'none');
    rows = [
      group('inbox', 'Your turn', mine.length, mine.length > 1 ? 'oldest first' : ''),
      ...(mine.length ? mine.map(row) : [html`<div class="Box-row turn-empty">Nothing ${pinnedMine ? 'else ' : ''}is waiting for you.</div>`]),
      ...(agents.length ? [group('hubot', 'With agents', agents.length), ...agents.map(compactRow)] : []),
      ...(github.length ? [group('mark-github', 'Waiting on GitHub', github.length, 'nothing new since publishing'), ...github.map(compactRow)] : []),
    ];
  }
  const nothing: Record<string, string> = { staged: 'No staged pull requests', published: 'No published pull requests open on GitHub', done: 'No merged or closed pull requests', all: 'No pull requests' };
  // Those pinned above are not repeated.
  const other = pinned.some((p) => state === 'all' || staging.get(p.id) === state);
  const empty = html`<div class="blankslate">
  ${icon('git-pull-request', { size: 24 })}
  <h3>${other ? nothing[state].replace(/^No /, 'No other ') : nothing[state]}${opts.repo ? html` in ${opts.repo.owner}/${opts.repo.name}` : ''}</h3>
  <p>Agents stage pull requests with <code>laatsux pr create</code>, the same way they would use <code>gh pr create</code>.</p>
</div>`;
  // The repository on GitHub, by its name there, which can differ from the one here.
  const slug = opts.repo?.github_slug;
  const onGithub = slug
    ? html`<a class="page-title-github" href="https://github.com/${slug}" target="_blank" rel="noopener" title="${slug} on GitHub">${icon('mark-github')} ${slug} ${icon('link-external')}</a>`
    : '';
  const list = html`<div class="list-header-row"><h1 class="page-title">${opts.repo ? html`${opts.repo.owner}/${opts.repo.name}` : 'Staged pull requests'}</h1>${onGithub}
    <button type="button" class="btn btn-sm notify-toggle js-notify" hidden title="A desktop notification when a pull request becomes your turn, while a page like this is open">${icon('bell')} <span class="js-notify-label">Notify me</span></button></div>
  ${
    pinned.length
      ? html`<div class="Box pinned-list">
    <div class="Box-header turn-group">${icon('pin')} <h2 class="turn-group-title">Pinned</h2> <span class="Counter">${pinned.length}</span>${pinned.length > 1 ? html` <span class="turn-group-note">most recently pinned first</span>` : ''}</div>
    ${pinned.map(row)}
  </div>`
      : ''
  }
  <div class="Box pr-list" data-your-turn="${JSON.stringify(notify)}">
    <div class="Box-header list-tabs">
      ${tab('staged', 'git-pull-request', 'Staged')}
      ${tab('published', 'mark-github', 'Published')}
      ${tab('done', 'check', 'Done')}
    </div>
    ${rows.length ? rows : empty}
  </div>`;
  // The front page and a repository's have your repositories at the left of the page and the list in the rest, like
  // GitHub's dashboard, so that going from one to another moves neither. Without repositories, the front page's list
  // is centered like the pull request pages.
  const sidebar = repoSidebar(s, everywhere, yoursEverywhere, current);
  const body = sidebar
    ? html`<div class="container container-full dashboard">${sidebar}<div class="dashboard-main">${list}</div></div>`
    : html`<div class="container container-xl">${list}</div>`;
  // The tab's title counts the pull requests waiting for you, as a mail client counts unread mail.
  const title = opts.repo ? `Pull requests · ${opts.repo.owner}/${opts.repo.name}` : 'Staged pull requests · laatsux';
  return layout(s, {
    title: yours.length ? `(${yours.length}) ${title}` : title,
    crumbs: opts.repo ? repoCrumbs(opts.repo) : undefined,
    body,
    live: 'all',
  });
}

/** How many repositories the sidebar shows before "Show more". */
const SIDEBAR_REPOS = 10;

/**
 * The repositories beside the list: those with pull requests, latest activity first (the latest
 * update of a pull request in each), with how many of them are your turn. On a repository's page,
 * that one is selected. With more than SIDEBAR_REPOS, a filter and "Show more" (public/app.js).
 * Null when there are none.
 */
function repoSidebar(s: Service, all: PullRow[], yours: PullRow[], current: RepoRow | null): Safe | null {
  // Newest first, so a repository's first pull request is its latest activity.
  const repos = [...new Set(all.map((p) => p.repo_id))].map((id) => s.repoById(id));
  if (!repos.length) return null;
  const many = repos.length > SIDEBAR_REPOS;
  // As many shown on every page, so that the list below them on narrow screens stays put: the selected one among
  // them, in place of the last when it is further down.
  const shown = new Set(repos.slice(0, SIDEBAR_REPOS).map((r) => r.id));
  if (current && repos.some((r) => r.id === current.id) && !shown.has(current.id)) {
    shown.delete(repos[SIDEBAR_REPOS - 1].id);
    shown.add(current.id);
  }
  const items = repos.map((repo) => {
    const name = `${repo.owner}/${repo.name}`;
    const owner = repo.github_slug?.split('/')[0];
    const mine = yours.filter((p) => p.repo_id === repo.id).length;
    const selected = repo.id === current?.id;
    return html`<li class="repo-list-item${selected ? ' selected' : ''}" data-name="${name}"${shown.has(repo.id) ? '' : raw(' hidden')}>
      ${avatar(owner ? `https://github.com/${owner}.png?size=40` : `/avatars/${encodeURIComponent(repo.owner)}.svg`, owner ?? repo.owner, 20)}
      <a class="repo-list-name" href="/${name}" title="${name}"${selected ? raw(' aria-current="page"') : ''}>${name}</a>
      ${mine ? html`<span class="list-tab-turn" title="${plural(mine, 'pull request')} waiting for you">${icon('inbox')} ${mine}</span>` : ''}
    </li>`;
  });
  return html`<aside class="dashboard-sidebar" aria-labelledby="repo-list-title">
  <h2 class="dashboard-sidebar-title" id="repo-list-title">Repositories</h2>
  ${many ? html`<input type="search" class="form-control repo-filter js-repo-filter" placeholder="Find a repository…" aria-label="Find a repository" autocomplete="off">` : ''}
  <ul class="repo-list js-repo-list" data-shown="${SIDEBAR_REPOS}">${items}</ul>
  ${many ? html`<p class="repo-list-none js-repo-none" hidden>No repository matches.</p><button type="button" class="btn-link repo-list-more js-repo-more">Show more</button>` : ''}
</aside>`;
}

/** A row's turn as the list shows it: one line of short phrases, and who is at work on the pull request. */
interface TurnLine {
  line: Safe;
  /** The reviewer agents running a review and the author working on feedback, for avatars at the row's end. */
  atWork: { actor: Actor; doing: string }[];
}

/** A phrase of a TurnLine: one reason, or the reviewer agents in the same state, said together. */
interface Phrase {
  /** The reviewer agents it names, first (none for the other reasons). */
  logins: string[];
  /** What it says after their names. */
  words: string;
  /** The reasons in full, as `pr view` says them. */
  full: string[];
  /** Since when it has been so: the earliest of the agents'. */
  since: string | null;
  mark: Safe | '';
  /** A failed reviewer agent's API name, for Retry. */
  retry?: string;
  /** What explains the row's group comes first. */
  rank: number;
}

/**
 * The reasons of a Turn of the given kinds (by default all but the labels) as one line of the list,
 * in short phrases: reviewer agents in the same state together, with the earliest time, and the
 * commit only when it is not the head. What explains the row's group comes first: what the
 * reviewer has to do on their turn, who is working on the agents'. A shortened phrase has the
 * reasons in full as its tooltip. A failed reviewer agent gets a Retry button, which asks it to
 * review at `apiBase`.
 */
function turnLine(
  s: Service,
  pull: PullRow,
  t: Turn,
  ready: Readiness | undefined,
  apiBase: string,
  kinds: TurnReason['kind'][] = ['author', 'changes', 'reviewer_agent', 'threads', 'conflicts', 'github'],
): TurnLine {
  const shown = t.reasons.filter((r) => kinds.includes(r.kind));
  const author = s.db.actorById(pull.author_id);
  const waiting = t.reasons.some((r) => r.kind === 'author' && r.state === 'waiting');
  // The reviewer agents as the turn saw them, by the API's name for them.
  const agents = new Map(ready?.reviewers.map((x) => [x.reviewer, x]));
  const rank = (r: TurnReason): number => {
    if (t.whose === 'reviewer') {
      // Your turn: a stalled author to get going, feedback to pass on, a review to retry, GitHub; then what changed since your review.
      if (r.state === 'stalled' || r.state === 'unseen' || r.state === 'failed' || r.kind === 'github') return 0;
      if (r.kind === 'changes') return 1;
      return r.kind === 'author' || r.kind === 'reviewer_agent' ? 3 : 2;
    }
    // The agents': the reviewer agents that have the head to review, or else the author, first.
    if (t.whose === 'reviewer_agents' && r.kind === 'reviewer_agent' && TO_REVIEW.includes(r.state as HeadStatus['state'])) return 0;
    return r.kind === 'author' ? 1 : 2;
  };
  const pulse = icon('dot-fill', { cls: 'turn-mark turn-pulse' });
  const phrases = new Map<string, Phrase>();
  const atWork: TurnLine['atWork'] = [];
  shown.forEach((r, i) => {
    const agent = r.kind === 'reviewer_agent' && r.reviewer ? agents.get(r.reviewer) : undefined;
    if (!agent) {
      if (r.state === 'working') atWork.push({ actor: author, doing: r.text });
      const mark =
        r.state === 'working' ? pulse : r.kind === 'conflicts' ? icon('alert', { cls: 'turn-mark turn-mark--danger' }) : r.kind === 'github' ? icon('mark-github', { cls: 'turn-mark' }) : '';
      phrases.set(`reason ${i}`, { logins: [], words: reasonPhrase(r, author.login), full: [r.text], since: r.since ?? null, mark, rank: rank(r) });
      return;
    }
    const actor = r.state === 'reviewing' && s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', agent.login);
    if (actor) atWork.push({ actor, doing: r.text });
    // Each failed review has its own Retry; the others share a phrase with those that say the same.
    const words =
      r.state === 'failed'
        ? "'s review failed"
        : r.state === 'answered'
          ? `'s findings${agent.status.description ? ' in the description' : ''} answered`
          : ` ${agentPhrase(r.state as HeadStatus['state'], agent.status, pull, author.login, waiting)}`;
    const key = r.state === 'failed' ? `failed ${r.reviewer}` : `agent${words}`;
    const same = phrases.get(key);
    if (same) {
      same.logins.push(agent.login);
      same.full.push(r.text);
      if (r.since && (!same.since || r.since < same.since)) same.since = r.since;
    } else {
      const mark = r.state === 'reviewing' ? pulse : r.state === 'failed' ? icon('x-circle-fill', { cls: 'turn-mark turn-mark--danger' }) : '';
      phrases.set(key, { logins: [agent.login], words, full: [r.text], since: r.since ?? null, mark, retry: r.state === 'failed' ? r.reviewer : undefined, rank: rank(r) });
    }
  });
  if (!phrases.size) return { line: raw(''), atWork };
  const sorted = [...phrases.values()].sort((a, b) => a.rank - b.rank);
  return {
    line: html`<div class="pr-row-turn">${sorted.map((p) => {
      const names = p.logins.length > 1 ? `${p.logins.slice(0, -1).join(', ')} and ${p.logins.at(-1)}` : (p.logins[0] ?? '');
      const text = names + p.words;
      const title = p.full.join('\n');
      return html`<span class="turn-reason"${title !== text ? html` title="${title}"` : ''}>${p.mark}${text}${p.since ? html`<span class="turn-since">${since(p.since)}</span>` : ''}${
        p.retry ? html` <button type="button" class="btn-link js-run-codex" data-api="${apiBase}/reviewers/${p.retry}">Retry</button>` : ''
      }</span>`;
    })}</div>`,
    atWork,
  };
}

/** A reason other than a reviewer agent's, in a few words: the author's state is said shorter, the others as they are. */
function reasonPhrase(r: TurnReason, author: string): string {
  if (r.kind !== 'author') return r.text;
  switch (r.state) {
    case 'working':
      return `${author} working on feedback`;
    case 'unseen':
      return `${author} hasn't seen the feedback`;
    case 'waiting':
      return `${author} waiting`;
    case 'stalled':
      return `${author} stalled`;
    default:
      return `${author} not waiting`;
  }
}

/**
 * What a reviewer agent is at with the head, after its name (reviewerAgentText in service.ts says
 * it in full). The commit only when it is not the head, as for a review that started before a push.
 */
function agentPhrase(state: HeadStatus['state'], status: HeadStatus, pull: PullRow, author: string, authorWaiting: boolean): string {
  const older = !status.description && status.commit !== pull.head_sha ? shortSha(status.commit) : '';
  const what = status.description ? ' the description' : older ? ` ${older}` : '';
  switch (state) {
    case 'reviewing':
      return older ? `reviewing an earlier commit, ${older}` : `reviewing${what}`;
    case 'queued':
      return `about to review${what}`;
    case 'interrupted':
      return `to review${what} again after a restart`;
    case 'unreviewed':
      return authorWaiting ? `about to review${what}` : `waiting for ${author}`;
    case 'findings':
      return what ? `commented on${what}` : 'commented';
    case 'cancelled':
      return `cancelled${status.cancelled ? ` (${CANCELLED[status.cancelled]})` : ''}`;
    case 'clean':
      return what ? `found nothing in${what}` : 'found nothing';
    case 'approved':
      return `approved${what}`;
    default:
      // Capped: it has no automatic review left. (Turned off, it has no reason.)
      return 'out of automatic reviews';
  }
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
  // The base, fetched in the background and throttled per repository (Service.fetchBases): a base that moved shows once the poll sees it.
  void s.fetchBases(ctx.repo);
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

function pullLayout(p: PullPage, tab: 'conversation' | 'commits' | 'files' | null, content: Safe, extraData: Record<string, string | number> = {}): string {
  const { s, repo, pull, author, files, commits } = p;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const conversationCount = s.issueComments(pull).length + p.threads.filter((t) => !t.pending).reduce((n, t) => n + 1 + t.replies.length, 0);
  const unpublished = s.unpublishedChanges(pull).length > 0;
  const tabLink = (key: string, href: string, iconName: string, label: string, count: number) =>
    html`<a class="tabnav-tab${tab === key ? ' selected' : ''}" href="${href}">${icon(iconName)} ${label} <span class="Counter">${count}</span></a>`;
  // "Wants to merge" is GitHub's: a staged pull request asks nobody to merge it yet.
  const did =
    pull.github_state === 'merged'
      ? html`${githubUser(pull.github_closed_by)} merged ${plural(commits.length, 'commit')} into`
      : pull.state === 'published' && !unpublished
        ? html`${authorLink(s, author)} published ${plural(commits.length, 'commit')} into`
        : html`${authorLink(s, author)} staged ${plural(commits.length, 'commit')} for`;
  const header = html`<div class="pr-header">
  <div class="container container-xl">
    <div class="gh-header-title-row js-title-view">
      <h1 class="gh-header-title"><bdi>${pull.title}</bdi> <span class="gh-header-number">#${pull.number}</span></h1>
      <div class="gh-header-actions">
        ${pinButton(p)}
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
        ${did} <span class="branch-name">${pull.base_ref}</span> from <span class="branch-name">${pull.head_ref}</span> ${copyButton(pull.head_ref, 'Copy head branch name')}
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
    body: html`${header}${content}`,
    live: pull.id,
    data: { 'api-base': p.apiBase, 'pull-id': pull.id, ...extraData },
  });
}

/** Pins the pull request to the top of the front page, filled while it is pinned. */
function pinButton(p: PullPage): Safe {
  const pinned = !!p.pull.pinned_at;
  const label = pinned ? 'Unpin' : 'Pin to the top of the front page';
  return html`<button type="button" class="btn btn-sm btn-pin js-pin${pinned ? ' selected' : ''}" data-api="${p.apiBase}/pinned" data-method="${pinned ? 'DELETE' : 'PUT'}" title="${label}" aria-label="${label}" aria-pressed="${pinned ? 'true' : 'false'}">${icon(pinned ? 'pin-fill' : 'pin')}</button>`;
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
        { cls: 'timeline-badge--open' },
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
      if (data.reason === 'merged' || data.reason === 'closed_on_github') {
        return timelineBadge('clock', html`Auto-publish turned itself off when the pull request was ${data.reason === 'merged' ? 'merged' : 'closed'} on GitHub ${when}`);
      }
      return timelineBadge('clock', html`${who} disabled auto-publish${AUTO_PUBLISH_OFF[data.reason] ?? ''} ${when}`);
    case 'auto_publish_failed':
      return timelineBadge(
        'x',
        html`Auto-publish failed and turned itself off ${when}
        <details class="codex-error"><summary class="btn-link">Show error</summary><pre>${data.error}</pre></details>`,
        { cls: 'timeline-badge--danger' },
      );
    case 'iterations_stopped':
      return timelineBadge('circle-slash', html`${who} stopped automatic reviews ${afterRound(data.round)} ${when}`);
    case 'iterations_resumed':
      return timelineBadge('iterations', html`${who} resumed automatic reviews ${when}`);
    case 'merged': {
      // `at` is when GitHub merged it; the event is from when laatsux learned of it.
      const commit = data.commit
        ? html`commit <a class="commit-link" href="${String(data.url).replace(/\/pull\/\d+$/, '')}/commit/${data.commit}" target="_blank" rel="noopener"><code>${shortSha(data.commit)}</code></a>`
        : 'this pull request';
      return timelineBadge('git-merge', html`${githubUser(data.by, true)} merged ${commit} into <span class="branch-name branch-name-sm">${p.pull.base_ref}</span> on GitHub ${relTime(data.at)}`, { cls: 'timeline-badge--done' });
    }
    case 'closed_on_github':
      return timelineBadge('git-pull-request-closed', html`${githubUser(data.by, true)} closed this pull request on GitHub ${relTime(data.at)}`, { cls: 'timeline-badge--closed' });
    case 'review_cancelled':
      return timelineBadge('circle-slash', html`${who} stopped reviewing <code>${shortSha(data.head)}</code> ${when}: ${CANCELLED[data.reason as CancelReason] ?? data.reason}`);
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
  const decision = submitted.length ? s.reviewDecision(pull, submitted) : null;
  const unresolved = p.threads.filter((t) => !t.resolved && !t.pending).length;
  const waiting = (s.waiters.get(pull.id) ?? 0) > 0;
  // A review still to come may ask for changes, so publishing before it takes a second click.
  const busy = pull.state === 'closed' ? [] : s.reviewersAtWork(pull);
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
  const conflicts = s.baseConflicts(pull);
  if (conflicts) rows.push(conflictsRow(p, conflicts, !s.currentConflicts(pull)));
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
    publishRow = html`<div class="merge-row merge-actions">${icon('mark-github', { cls: 'color-fg-open' })}<div class="flex-auto"><strong>Published</strong><div class="color-fg-muted">GitHub has the same commits, title and description as this staged version.</div></div>
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
    // Checked when auto-merge is decided already: auto-publish includes it (with its method while
    // GitHub allows it, so publishing by hand does what auto-publish would), or it is on on GitHub.
    const approved = auto?.autoMerge && mergeOption?.methods.includes(auto.autoMerge) ? auto.autoMerge : null;
    const mergeOn = merge?.state === 'enabled' ? merge : null;
    const method = approved ?? mergeOption?.method;
    const checked = !!(approved || mergeOn);
    // What publishing now asks a second click for, and what that click tells the server (Service.publish).
    const acknowledge = [busy.length ? 'during_review' : null, conflicts?.clean === false ? 'during_conflict' : null].filter((a) => a !== null);
    publishRow = html`<form class="merge-row merge-actions js-api-form js-publish-form" data-api="${p.apiBase}/publish" data-method="POST">
      <input type="hidden" name="expected" value="${publishFingerprint(pull)}">
      ${icon('rocket', { cls: 'color-fg-open' })}
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
              : approved || mergeOption.methodAllowed
                ? html`<label${checked ? html` title="Unchecked, this publish does not ask for auto-merge. It does not turn auto-merge off on GitHub."` : ''}><input type="checkbox" name="auto_merge"${checked ? raw(' checked') : ''}> <span>Enable auto-merge on GitHub (${method})${mergeOn ? html`. Auto-merge is on for ${githubPull(mergeOn.url)}.` : ''}</span></label><input type="hidden" name="merge_method" value="${method}">`
                : html`<label class="color-fg-muted"><input type="checkbox" name="auto_merge" disabled> Enable auto-merge on GitHub: ${target} does not allow ${mergeOption.method} merges. <a href="/settings/publishing">Change the merge method</a></label>`
          }
        </div>
        ${images ? html`<div class="flash flash-warn">${icon('alert')}<span>The description has ${plural(images, 'image')} stored in laatsux, which GitHub cannot show. Remove ${them}, or replace ${them} with ${images === 1 ? 'an image' : 'images'} uploaded to GitHub.</span></div>` : ''}
        <div class="flash flash-error js-form-error" hidden></div>
      </div>
      <div class="merge-buttons">
        ${auto ? '' : html`<button type="submit" class="btn" data-api="${p.apiBase}/auto-publish" data-method="PUT" data-toast="Auto-publish is on" title="Publish on its own once the reviewer agents are done with the latest commit and ${p.author.login} has answered them, with the options above, and keep publishing updates that way until the pull request is merged">${icon('clock')} Publish when reviews are done</button>`}
        <button type="submit" class="btn btn-primary btn-publish"${acknowledge.length ? html` data-confirm="Click again to publish anyway" data-acknowledge="${acknowledge.join(' ')}"` : ''}>${icon('mark-github')} ${verb}</button>
      </div>
    </form>`;
  }
  for (const { reviewer, work } of busy) {
    const what =
      work.status === 'QUEUED'
        ? `${reviewer.label} is about to review this commit`
        : work.head_sha === pull.head_sha
          ? `${reviewer.label} is still reviewing this commit`
          : html`${reviewer.label} is still reviewing an earlier commit, <code>${shortSha(work.head_sha)}</code>`;
    const note = html`${work.started_at ? html`Started ${relTime(work.started_at)}. ` : ''}Its review will show up here.${publishable ? ' Publishing before it arrives takes a second click, and cancels it.' : ''}`;
    rows.push(html`<div class="merge-row">${icon('dot-fill', { cls: 'color-fg-attention' })}<div><strong>${what}</strong><div class="color-fg-muted">${note}</div></div></div>`);
  }
  rows.push(...iterationsRows(p));
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
  // An update GitHub does not have yet is staged, as in stateBadge.
  const published = pull.state === 'published' && changed.length === 0;
  return html`<div class="merge-box${closedOnGithub ? ' merge-box--closed' : published ? ' merge-box--published' : ''}">
    <span class="merge-box-icon">${closedOnGithub ? icon('git-pull-request-closed', { size: 24 }) : published ? icon('mark-github', { size: 24 }) : icon('git-pull-request', { size: 24 })}</span>
    <div class="Box">${rows}${publishRow}</div>
  </div>`;
}

/** Stop iterating, while a reviewer agent may still review on its own; Resume once stopped. Both say what the last round found. */
function iterationsRows(p: PullPage): Safe[] {
  const { s, pull, author } = p;
  const api = `${p.apiBase}/stop-iterating`;
  const stop = s.iterationsStopped(pull);
  if (stop) {
    return [
      html`<div class="merge-row">${icon('circle-slash', { cls: 'color-fg-muted' })}<div class="flex-auto"><strong>Iterations stopped by ${s.db.actorById(stop.by).login} ${afterRound(stop.round)}</strong>${lastRound(p)}
        <div class="color-fg-muted">No reviewer agent starts another automatic review, so ${author.login} hands its next commit to you. Asking one to review still works, and Resume lets them go on up to their limits.</div></div>
        <button type="button" class="btn btn-sm js-iterations" data-method="DELETE" data-api="${api}">Resume</button></div>`,
    ];
  }
  // Shown while a reviewer agent may still review on its own; the round is the one stopping records.
  if (!s.reviewersFor(pull).some((r) => r.enabled(pull) && r.automaticReviews(pull) < r.limit(pull))) return [];
  return [
    html`<div class="merge-row">${icon('iterations', { cls: 'color-fg-muted' })}<div class="flex-auto"><strong>${plural(s.automaticRound(pull), 'automatic review round')} so far</strong>${lastRound(p)}
      <div class="color-fg-muted">The reviewer agents review each commit ${author.login} waits with. Good enough, or going in circles? Stop iterating: a review in progress still finishes, and no new one starts.</div></div>
      <button type="button" class="btn btn-sm js-iterations" data-method="PUT" data-api="${api}">Stop iterating</button></div>`,
  ];
}

/**
 * What each reviewer agent's latest review found, by priority and linked to the review, and the
 * automatic round under way: "Round 3 running · last round: codex-review 1 High · claude-review
 * nothing · house-rules approved". A review found the threads it opened, resolved since or not,
 * and the findings its body lists outside the diff or on the title and description.
 */
function lastRound(p: PullPage): Safe {
  const { s, pull } = p;
  let running = false;
  const parts: Safe[] = [];
  // Those that review the pull request: a custom reviewer whose repositories changed since is none of them.
  for (const reviewer of s.reviewersFor(pull)) {
    const runs = reviewer.runs(pull);
    running ||= runs.some((r) => r.status === 'running' && r.trigger === 'auto');
    const last = runs.findLast((r) => r.status === 'done' && r.review_id !== null);
    const review = last && p.reviews.find((r) => r.id === last.review_id);
    if (!review) continue;
    const found = [...p.threads.filter((t) => t.root.review_id === review.id).map((t) => t.root.priority), ...outsideTheDiff(review.body), ...onTheDescription(review.body)];
    // A custom reviewer that did not approve, with nothing to point at, has its summary for a finding (Reviewer.post).
    while (last.findings !== null && found.length < last.findings) found.push(null);
    const pills = priorityCounts(found);
    const login = reviewer.actor().login;
    parts.push(
      html`${parts.length ? ' · ' : ''}<a class="iterations-review" href="#pullrequestreview-${review.id}" title="${login}'s latest review, of ${shortSha(last.head_sha)}">${login} ${
        pills.length
          ? pills.map((pill, i) => html`${i ? ' ' : ''}${pill}`)
          : // A custom reviewer that may approve found nothing and said so.
            review.state === 'APPROVED'
            ? html`<span class="color-fg-success">approved</span>`
            : html`<span class="color-fg-muted">nothing</span>`
      }</a>`,
    );
  }
  if (!running && !parts.length) return raw('');
  const round = running ? `Round ${s.automaticRound(pull)} running` : '';
  return html`<div class="iterations-found">${round}${round && parts.length ? ' · ' : ''}${parts.length ? html`${round ? 'last' : 'Last'} round: ${parts}` : ''}</div>`;
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

/**
 * Whether the head merges cleanly into its base's tip, as laatsux worked it out (Service.baseConflicts),
 * with the files that conflict and git's words for conflicts in none, or why it could not tell, and
 * how many commits it is behind when it merges cleanly. `again`: the base has moved since, and it
 * is being worked out again. Each says when the base could not be fetched, and why.
 */
function conflictsRow(p: PullPage, c: BaseConflicts, again: boolean): Safe {
  const ref = html`<span class="branch-name branch-name-sm">${c.ref}</span>`;
  const tip = html`<code>${shortSha(c.base ?? '')}</code>`;
  const moved = again ? html` ${c.ref} has moved since; checking again.` : '';
  // Only a remote-tracking branch is fetched (Service.fetchBases).
  const error = c.ref !== c.branch ? p.s.fetchError(p.repo, c.branch) : null;
  const fetched = error ? html` Could not fetch ${c.ref}: ${error}` : '';
  if (c.clean === null) {
    return html`<div class="merge-row">${icon('alert', { cls: 'color-fg-attention' })}<div class="flex-auto"><strong>Could not check for conflicts with ${ref}</strong>
      <div class="color-fg-muted">laatsux tries again every few seconds. Auto-publish waits until it can tell.${moved}${fetched}</div>
      <pre class="merge-error">${c.error}</pre></div></div>`;
  }
  if (c.clean) {
    // For information: it merges cleanly, so nobody is asked to rebase it.
    const title = c.behind ? html`${plural(c.behind, 'commit')} behind ${ref}, no conflicts` : html`This branch has no conflicts with ${ref}`;
    return html`<div class="merge-row">${icon('check-circle-fill', { cls: 'color-fg-success' })}<div><strong>${title}</strong><div class="color-fg-muted">Checked against ${tip}, its tip in this repository.${moved}${fetched}</div></div></div>`;
  }
  const { pull, author } = p;
  const told = pull.conflicts_told_sha === pull.head_sha ? `${author.login} was told to rebase it.` : html`${author.login} is told to rebase it in <code>pr wait</code>.`;
  const items = [
    ...c.files.map((f) => {
      const name = p.files.some((d) => d.path === f) ? html`<a href="${p.htmlBase}/files#${fileAnchor(f)}"><code>${f}</code></a>` : html`<code>${f}</code>`;
      return html`<li>${icon('file', { cls: 'color-fg-muted' })} ${name}</li>`;
    }),
    ...c.messages.map((m) => html`<li>${icon('alert', { cls: 'color-fg-muted' })} <span>${m}</span></li>`),
  ];
  const where = c.files.length ? html` in ${plural(c.files.length, 'file')}` : '';
  return html`<div class="merge-row">${icon('alert', { cls: 'color-fg-danger' })}<div class="flex-auto"><strong>This branch has conflicts with ${ref}</strong>
    <div class="color-fg-muted">Merging it into ${tip}, its tip in this repository, conflicts${where}. ${told} Published as it is, GitHub can not merge it until the conflicts are resolved, so publishing takes a second click.${moved}${fetched}</div>
    <ul class="merge-checks">${items}</ul></div></div>`;
}

/** Auto-publish while it is on: what it is waiting for, and a way to turn it off. */
function autoPublishRow(p: PullPage, auto: AutoPublish): Safe {
  const { s, pull, author } = p;
  const r = s.readiness(pull);
  const by = s.db.actorById(auto.by);
  const options = [auto.sign ? 'signed' : null, auto.draft && !pull.published_url ? 'as a draft' : null, auto.force ? 'with force if needed' : null].filter(Boolean);
  const upToDate = !!pull.published_url && !s.unpublishedChanges(pull).length;
  const item = (state: 'done' | 'waiting' | 'failed', text: Safe | string) =>
    html`<li>${state === 'done' ? icon('check', { cls: 'color-fg-success' }) : state === 'failed' ? icon('x', { cls: 'color-fg-danger' }) : icon('dot-fill', { cls: 'color-fg-attention' })} <span>${text}</span></li>`;
  const items = upToDate ? [item('waiting', `GitHub has the latest commit: the next one pushed to ${pull.head_ref} is published once the agents are done with it`)] : [];
  items.push(...r.reviewers.map(({ login, status }) => item(status.done ? 'done' : status.state === 'failed' ? 'failed' : 'waiting', reviewerText(login, status, pull, author))));
  items.push(
    r.authorWaiting && !r.unseen
      ? item('done', `${author.login} is waiting for review, with all feedback seen`)
      : item('waiting', r.authorWaiting ? `${author.login} has feedback it has not seen yet` : `${author.login} is working (not waiting for review)`),
  );
  if (r.openThreads) items.push(item('waiting', `${plural(r.openThreads, 'conversation')} you started ${r.openThreads === 1 ? 'is' : 'are'} unresolved`));
  // For the base as it is now; GitHub answers for the head it has.
  if (s.headUnpublished(pull)) {
    const conflicts = s.currentConflicts(pull);
    if (!conflicts) items.push(item('waiting', `Checking for conflicts with ${pull.base_ref}`));
    else if (conflicts.clean === null) items.push(item('failed', `Could not check for conflicts with ${conflicts.ref}: ${conflicts.error}`));
    else if (!conflicts.clean) items.push(item('failed', `Conflicts with ${conflicts.ref}: nothing is published until ${author.login} rebases it`));
    else items.push(item('done', `No conflicts with ${conflicts.ref}`));
  }
  // GitHub's settings may have changed since it was turned on; publishing refuses then.
  const method = auto.autoMerge;
  const merging = method && p.repo.github_slug ? s.githubRepo(p.repo.github_slug)?.merging : null;
  if (merging && !merging.autoMerge) items.push(item('failed', `${p.repo.github_slug} does not allow auto-merge, so publishing will fail`));
  else if (merging && method && !merging.methods.includes(method)) items.push(item('failed', `${p.repo.github_slug} does not allow ${method} merges, so publishing will fail`));
  return html`<div class="merge-row">${icon('clock', { cls: 'color-fg-open' })}<div class="flex-auto">
    <strong>Auto-publish is on until the pull request is merged</strong>
    <div class="color-fg-muted">${by.login} turned it on ${relTime(auto.at)}. It publishes each update${options.length ? ` ${options.join(', ')}` : ''} once the reviewer agents are done with it and ${author.login} has answered them${auto.autoMerge ? `, and enables auto-merge on GitHub (${method}) after each` : ''}. Publishing by hand leaves it on.</div>
    <ul class="merge-checks">${items}</ul>
  </div>
  <button type="button" class="btn btn-sm js-auto-publish-cancel" data-api="${p.apiBase}/auto-publish">Cancel auto-publish</button></div>`;
}

/** A reviewer agent's progress with the head, for the auto-publish checklist. */
function reviewerText(login: string, status: HeadStatus, pull: PullRow, author: Actor): Safe {
  const sha = html`<code>${shortSha(status.commit)}</code>`;
  // A reviewer of the description reviews the title, description and commit messages the head has.
  const what = status.description ? html`the description` : sha;
  switch (status.state) {
    case 'reviewing':
      return status.description || status.commit === pull.head_sha ? html`${login} is reviewing ${what}` : html`${login} is reviewing an earlier commit, ${sha}`;
    case 'queued':
      return html`${login} is about to review ${what}`;
    case 'interrupted':
      return html`${login}'s review of ${what} was interrupted by a restart; it will run again`;
    case 'unreviewed':
      return html`${login} reviews ${what} when ${author.login} waits for review`;
    case 'findings':
      return status.description
        ? html`${login} found problems in the description, and reviews it again once it changes`
        : html`${login} found problems in ${sha}, and reviews the commit that addresses them`;
    case 'answered':
      return html`${login}'s findings in ${what} are answered`;
    case 'failed':
      return html`${login}'s review of ${what} failed. Ask it to review again, or publish by hand.`;
    case 'cancelled':
      return html`${login}'s review of ${what} was cancelled${status.cancelled ? ` (${CANCELLED[status.cancelled]})` : ''}`;
    case 'clean':
      return html`${login} found nothing in ${what}`;
    case 'approved':
      return html`${login} approved ${what}`;
    case 'capped':
      return pull.iterations_stopped ? html`Automatic reviews are stopped, so ${login} starts no more` : html`${login} has used up its automatic reviews`;
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
  // Reviewer agents still at work show as GitHub shows a requested reviewer: with a dot, in place of their last review.
  const busy = new Map(s.reviewersAtWork(pull).map(({ reviewer, work }) => [reviewer.actor().id, work]));
  const people = [...latest.keys(), ...[...busy.keys()].filter((id) => !latest.has(id))];
  const reviewers = people.length
    ? people.map((id) => {
        const a = s.db.actorById(id);
        const work = busy.get(id);
        const state = latest.get(id)?.state;
        const mark = work
          ? html`<span title="${work.status === 'QUEUED' ? 'About to review' : 'Reviewing'} ${shortSha(work.head_sha)}">${icon('dot-fill', { cls: 'color-fg-attention' })}</span>`
          : state
            ? (reviewIcon[state] ?? '')
            : '';
        return html`<li class="sidebar-person">${avatar(avatarUrl(s, a), a.login, 20, a.type === 'Bot' ? 'avatar-bot' : 'avatar-circle')} <span class="flex-auto">${a.login}</span> ${mark}</li>`;
      })
    : html`<li class="color-fg-muted">No reviews yet</li>`;
  const waiting = (s.waiters.get(pull.id) ?? 0) > 0;
  const revisions = s.revisions(pull);
  return html`<aside class="layout-sidebar">
  <div class="sidebar-item"><h3 class="sidebar-heading">Reviewers</h3><ul class="sidebar-list">${reviewers}</ul></div>
  ${reviewerAgents(p)}
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

/** The reviewer agents that review this pull request, built-in and custom alike, a row each. */
function reviewerAgents(p: PullPage): Safe {
  const reviewers = p.s.reviewersFor(p.pull);
  if (!reviewers.length) return raw('');
  return html`<div class="sidebar-item"><h3 class="sidebar-heading">Reviewer agents</h3>
    <ul class="sidebar-list agent-list">${reviewers.map((r) => reviewerRow(p, r))}</ul>
  </div>`;
}

/** What a reviewer agent's row says it is doing, or did last. */
interface AgentState {
  mark: Safe;
  text: Safe;
  /** The words the row leaves out: the commit, and why. */
  title: string;
  /** The run's transcript, or the review it posted. */
  href: string | null;
  running?: boolean;
}

/**
 * A reviewer agent on this pull request, in one row: what it is doing or did last, and a menu of
 * its controls. A second line says what the row has no room for, only when there is something:
 * why its last review stopped, its automatic reviews, and what its runs cost. While it reviews,
 * its progress shows under the row.
 */
function reviewerRow(p: PullPage, reviewer: Reviewer): Safe {
  const { s, pull } = p;
  const runs = reviewer.runs(pull);
  const last = runs.at(-1);
  const work = reviewer.atWork(pull);
  const live = reviewer.live(pull);
  const actor = reviewer.actor();
  const enabled = reviewer.enabled(pull);
  const own = reviewer.own(pull);
  // Why it reviews nothing on its own, when it does not; in full where there is room.
  const skips = reviewer.settings().enabled && reviewer.skips(pull);
  const off = enabled ? null : own.enabled === false ? 'Off for this pull request' : skips ? `Off for agents in ${reviewer.authorTool}` : 'Off in Settings';
  const skipping = `Settings leave pull requests by agents in ${reviewer.authorTool} to other reviewers`;
  const meta: Safe[] = [];
  const transcript = (run: ReviewRunRow) => (hasTranscript(s.db, run.id) ? runUrl(runBase(p), run) : null);
  let state: AgentState;
  if (live || work?.status === 'IN_PROGRESS') {
    const started = live?.run.started_at ?? work!.started_at;
    state = { mark: icon('dot-fill'), text: html`Reviewing · ${since(started)}`, title: `Reviewing ${shortSha(live?.run.head_sha ?? work!.head_sha)}`, href: live ? runUrl(runBase(p), live.run) : null, running: true };
  } else if (work) {
    state = { mark: icon('dot-fill'), text: html`Queued`, title: `About to review ${shortSha(work.head_sha)}`, href: null, running: true };
  } else if (last?.status === 'done') {
    const approved = p.reviews.find((r) => r.id === last.review_id)?.state === 'APPROVED';
    const what = reviewer.reviews === 'description' ? `the description at ${shortSha(last.head_sha)}` : shortSha(last.head_sha);
    const verb = approved ? 'Approved' : 'Reviewed';
    state = { mark: icon('check', { cls: 'color-fg-success', label: verb }), text: html`<code>${shortSha(last.head_sha)}</code> · ${since(last.finished_at)}`, title: `${verb} ${what}`, href: transcript(last) ?? `#pullrequestreview-${last.review_id}` };
  } else if (last?.status === 'failed') {
    // The run's page has the whole error, also without a transcript.
    state = { mark: icon('x-circle-fill', { cls: 'color-fg-danger' }), text: html`Failed · ${since(last.finished_at)}`, title: `Review of ${shortSha(last.head_sha)} failed`, href: runUrl(runBase(p), last) };
    const error = (last.error ?? '').trim();
    if (error) meta.push(html`<span class="agent-error" title="${error}">${error.replace(/\s+/g, ' ')}</span>`);
  } else if (last?.status === 'cancelled') {
    state = { mark: icon('circle-slash', { cls: 'color-fg-muted' }), text: html`Cancelled · ${since(last.finished_at)}`, title: `Review of ${shortSha(last.head_sha)} cancelled`, href: transcript(last) };
    if (last.reason) meta.push(html`${capitalize(CANCELLED[last.reason])}`);
  } else if (last?.status === 'interrupted') {
    // An interrupted automatic review of the head runs when the author waits, one asked for by hand when the server starts.
    const headState = reviewer.headStatus(pull).state;
    const again = stagingState(pull) !== 'done' && runSubject(last) === reviewer.subject(pull) && (headState === 'unreviewed' || headState === 'interrupted');
    state = { mark: icon('sync', { cls: 'color-fg-attention' }), text: html`Interrupted · ${since(last.finished_at)}`, title: `Review of ${shortSha(last.head_sha)} interrupted by a restart`, href: transcript(last) };
    if (again) meta.push(html`Runs again`);
  } else {
    state = { mark: raw(''), text: html`${off ? 'Off' : 'Not yet'}`, title: (off && own.enabled !== false && skips ? skipping : off) ?? 'Has not reviewed this pull request', href: null };
  }
  const used = reviewer.automaticReviews(pull);
  const limit = reviewer.limit(pull);
  if (enabled) meta.push(html`Automatic: ${pull.iterations_stopped ? 'stopped at ' : ''}${used} of ${limit}`);
  else if (runs.length || work) meta.push(html`${off}`);
  const usage = runUsage(runs);
  if (usage) meta.push(usage);
  const status = html`${state.mark}<span>${state.text}</span>`;
  const cls = `agent-state${state.running ? ' agent-state--running' : ''}`;
  return html`<li class="agent" id="agent-${reviewer.key}">
    <div class="agent-row">
      ${avatar(avatarUrl(s, actor), actor.login, 20, 'avatar-bot')}
      <a class="agent-name" href="${reviewer.settingsUrl()}" title="${reviewer.describe() ?? `Settings for ${actor.login}`}">${actor.login}</a>
      ${state.href ? html`<a class="${cls}" href="${state.href}" title="${state.title}">${status}</a>` : html`<span class="${cls}" title="${state.title}">${status}</span>`}
      ${reviewerMenu(p, reviewer, { enabled, limit, own, why: skips ? skipping : null })}
    </div>
    ${meta.length ? html`<p class="agent-meta">${meta.map((m, i) => html`${i ? ' · ' : ''}<span class="agent-chunk">${m}</span>`)}</p>` : ''}
    ${live ? runProgress(runBase(p), live.run, live.progress) : ''}
  </li>`;
}

/**
 * A reviewer agent's controls on this pull request, in its row's menu: ask it to review, its limit
 * on automatic reviews, turning them on or off here, and its settings. The menu stays open while
 * the page refreshes after a change, so the limit can be stepped again; asking for a review closes it.
 */
function reviewerMenu(p: PullPage, reviewer: Reviewer, o: { enabled: boolean; limit: number; own: OwnSettings; why: string | null }): Safe {
  const { pull } = p;
  const { enabled, limit, own } = o;
  const api = `${p.apiBase}/reviewers/${reviewer.key}`;
  // ":" is in no reviewer's name, so these ids are apart from every row's (agent-<name>) and from each other's.
  const id = (part: string) => `agent-${reviewer.key}:${part}`;
  const onOff = (on: boolean) => (on ? 'on' : 'off');
  const bySettings = reviewer.bySettings(pull);
  const busy = reviewer.isRunning(pull.id) || pull.state === 'closed' || pull.github_state === 'merged';
  // The limit is changed in place, and saved shortly after the last click.
  const limitRow = enabled
    ? html`<div class="agent-menu-limit">
        <span class="flex-auto">Limit</span>
        <span class="codex-limit" data-api="${api}" data-limit="${limit}" data-max="${MAX_ITERATIONS_LIMIT}"><button type="button" class="codex-step js-codex-step" id="${id('fewer')}" data-step="-1" aria-label="One automatic review fewer" title="One fewer"${limit <= 0 ? raw(' disabled') : ''}>${icon('dash')}</button><strong class="js-codex-limit">${limit}</strong><button type="button" class="codex-step js-codex-step" id="${id('more')}" data-step="1" aria-label="One more automatic review" title="One more"${limit >= MAX_ITERATIONS_LIMIT ? raw(' disabled') : ''}>${icon('plus')}</button></span>
        ${own.maxIterations !== null ? html`<button type="button" class="btn-link js-codex-reset" id="${id('limit-reset')}" data-api="${api}" data-field="max_iterations" title="Use the default from Settings (${reviewer.settings().maxIterations})">reset</button>` : ''}
      </div>`
    : '';
  // Turning automatic reviews on or off here (or when staging) holds whatever Settings say.
  const why = o.why ?? `${capitalize(onOff(bySettings))} in Settings`;
  const about = reviewer.describe();
  return html`<details class="dropdown details-reset agent-menu js-keep-open" id="${id('menu')}">
    <summary class="btn-octicon" id="${id('options')}" aria-label="Options for ${reviewer.actor().login}" title="Options">${icon('gear')}</summary>
    <div class="dropdown-menu dropdown-menu-sw">
      <button type="button" class="dropdown-item js-run-codex" id="${id('ask')}" data-api="${api}"${busy ? raw(' disabled') : ''}>Ask ${reviewer.label} to review</button>
      <div class="dropdown-divider"></div>
      <div class="dropdown-header">Automatic reviews of this pull request</div>
      ${limitRow}
      <button type="button" class="dropdown-item js-reviewer-switch" id="${id('switch')}" data-api="${api}" data-enabled="${String(!enabled)}">Turn ${onOff(!enabled)}<span class="dropdown-item-desc">${own.enabled === null ? why : `Turned ${onOff(enabled)} here`}</span></button>
      ${own.enabled !== null ? html`<button type="button" class="dropdown-item js-codex-reset" id="${id('follow')}" data-api="${api}" data-field="enabled">Follow Settings<span class="dropdown-item-desc">${why}</span></button>` : ''}
      <div class="dropdown-divider"></div>
      <a class="dropdown-item" id="${id('settings')}" href="${reviewer.settingsUrl()}">Settings${about ? html`<span class="dropdown-item-desc">${about}</span>` : ''}</a>
    </div>
  </details>`;
}

/** What its runs on this pull request cost together, in a word: dollars when the tool says (Claude), tokens otherwise (Codex). The latest run in detail on hover. */
function runUsage(runs: ReviewRunRow[]): Safe | null {
  const reported = runs.flatMap((r) => (r.usage ? [JSON.parse(r.usage) as RunUsage] : []));
  if (!reported.length) return null;
  const costs = reported.flatMap((u) => (u.cost_usd === null ? [] : [u.cost_usd]));
  const used = reported.reduce((sum, u) => sum + u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens, 0);
  const total = costs.length ? dollars(costs.reduce((sum, n) => sum + n, 0)) : `${tokens(used)} tokens`;
  // The runs the total adds up: those that reported a cost, when it is in dollars.
  const counted = costs.length || reported.length;
  const last = runs.at(-1)?.usage ? reported.at(-1)! : null;
  const detail = [
    counted > 1 ? `${counted} runs: ${total}` : null,
    ...(last
      ? [
          `Last run: ${usageParts(last).join(' · ')}`,
          last.models.length ? `Model: ${last.models.join(', ')}` : null,
          `Input: ${last.input_tokens} tokens, ${last.cache_creation_input_tokens} written to the cache, ${last.cache_read_input_tokens} read from it`,
          `Output: ${last.output_tokens} tokens`,
          last.duration_ms !== null ? `Took ${Math.round(last.duration_ms / 1000)} s` : null,
        ]
      : []),
  ];
  return html`<span title="${detail.filter(Boolean).join('\n')}">${total}</span>`;
}

const runBase = (p: PullPage) => ({ htmlBase: p.htmlBase, repoBase: `/${p.repo.owner}/${p.repo.name}` });

/**
 * A reviewer agent's run on this pull request, and its reviewer; none for a custom reviewer that
 * no longer runs (its file deleted, or wrong), whose runs stay with their transcripts.
 */
function findRun(p: PullPage, runId: number): { run: ReviewRunRow; reviewer: Reviewer | null } {
  const run = p.s.db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ? AND pull_id = ?', runId, p.pull.id);
  if (!run) throw new HttpError(404, 'No such review run on this pull request');
  return { run, reviewer: p.s.reviewerAgents().find((r) => r.key === run.reviewer) ?? null };
}

/** A run's reviewer's bot, when the reviewer no longer runs: the custom reviewer's, by its name. */
function formerLogin(s: Service, run: ReviewRunRow): string {
  const id = Number(s.db.getMeta(customActorKey(run.reviewer)));
  return (id && s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id)?.login) || run.reviewer;
}

/** A run's transcript, on a page of its own (an extension). While the run goes on, the page follows it. */
export function transcriptPage(p: PullPage, runId: number): string {
  const { run, reviewer } = findRun(p, runId);
  const live = reviewer?.live(p.pull);
  const progress = live?.run.id === run.id ? live.progress : null;
  const login = reviewer?.actor().login ?? formerLogin(p.s, run);
  const content = transcriptContent(runBase(p), { run, login, label: reviewer?.label ?? run.reviewer, entries: transcript(p.s.db, run.id), live: progress });
  return pullLayout(p, null, content, progress ? { 'run-live': run.id } : {});
}

/** The sidebar's view of a running review, which pages fetch again as it makes progress; null once it has finished. */
export async function progressPart(s: Service, owner: string, name: string, number: number, runId: number): Promise<string | null> {
  // Without syncing: it is fetched every few seconds while the run goes on.
  const { pull } = await s.ctx(owner, name, number, { sync: false });
  for (const reviewer of s.reviewerAgents()) {
    const live = reviewer.live(pull);
    if (live?.run.id === runId) return runProgress({ htmlBase: `/${owner}/${name}/pull/${number}`, repoBase: `/${owner}/${name}` }, live.run, live.progress).value;
  }
  return null;
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
  // The reviewer agents' reviews link to the transcript of the run that wrote them.
  // Also those of a custom reviewer that no longer runs.
  const posted = s.db.all<ReviewRunRow>('SELECT * FROM review_runs WHERE pull_id = ? AND review_id IS NOT NULL', pull.id);
  const runs = new Map(posted.flatMap((run) => (hasTranscript(s.db, run.id) ? [[run.review_id!, run] as const] : [])));
  // Reviews of the title, description and commit messages, which a custom reviewer approves as such.
  const ofDescription = new Set(s.db.all<{ id: number }>("SELECT review_id AS id FROM review_runs WHERE pull_id = ? AND review_id IS NOT NULL AND subject LIKE 'description:%'", pull.id).map((r) => r.id));
  for (const r of p.reviews) {
    if (r.state === 'PENDING' || !r.submitted_at) continue;
    const a = s.db.actorById(r.author_id);
    const threads = p.threads.filter((t) => t.root.review_id === r.id);
    const meta = REVIEW_TEXT[r.state] ?? REVIEW_TEXT.COMMENTED;
    const single = r.state === 'COMMENTED' && !r.body.trim() && threads.length === 1;
    const text = single
      ? threads[0].root.subject_type === 'commit'
        ? 'commented on a commit'
        : html`commented on <code>${threads[0].root.path}</code>`
      : r.state === 'APPROVED' && ofDescription.has(r.id)
        ? 'approved the description'
        : meta.text;
    const who = html`${avatar(avatarUrl(s, a), a.login, 20, a.type === 'Bot' ? 'avatar-bot avatar-small' : 'avatar-circle avatar-small')} ${authorLink(s, a)}`;
    items.push({
      at: r.submitted_at,
      order: 4,
      html: html`<div class="timeline-review" id="pullrequestreview-${r.id}">
        ${timelineBadge(single ? 'comment' : meta.icon, html`${who} ${text} <a class="link-muted" href="#pullrequestreview-${r.id}">${relTime(r.submitted_at)}</a>`, { cls: single ? '' : meta.cls })}
        <div class="timeline-review-body">
          ${r.body.trim() ? html`<div class="review-summary"><div class="comment-body markdown-body">${raw(renderMarkdown(r.body, { references: p.references }))}</div>${runs.has(r.id) ? html`<a class="review-run-link" href="${runUrl(runBase(p), runs.get(r.id)!)}">${icon('list-unordered')} Transcript of this review</a>` : ''}</div>` : ''}
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
    html`${authorLink(s, p.author)} staged this pull request ${relTime(pull.created_at)}`,
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
