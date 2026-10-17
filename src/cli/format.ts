import { c, indent } from './output.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type GhPull = Record<string, any>;

const REVIEW_STATE: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

/** Where an image uploaded to laatsux (`/uploads/<sha256>.<ext>`) can be had: its URL, or a file it was saved to. */
export type ImageRef = (path: string) => string;

/** The images uploaded to laatsux that a text refers to, each once (the server's `uploadsIn`). */
export function uploadsIn(text: string): string[] {
  return [...new Set(text.match(/\/uploads\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)\b/g) ?? [])];
}

/** A comment's text, followed by a line for each image uploaded to laatsux in it. */
function withImages(text: string, images?: ImageRef): string {
  const found = images ? uploadsIn(text) : [];
  return [text, ...found.map((path) => `Image: ${images!(path)}`)].join('\n');
}

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}

/** What a reviewer in reviewRequests is doing ("reviewing 35ef70b") and since when. */
function atWork(r: any, pr: GhPull): { what: string; since: string | null } {
  const sha = String(r.commit?.oid ?? '').slice(0, 7);
  if (r.status === 'QUEUED') return { what: `about to review ${sha}`, since: null };
  const earlier = r.commit?.oid && pr.headRefOid && r.commit.oid !== pr.headRefOid ? ', an earlier commit' : '';
  return { what: `reviewing ${sha}${earlier}`, since: r.startedAt ? `started ${ago(r.startedAt)}` : null };
}

/** One line per reviewer at work: "codex-review is reviewing 35ef70b (started 2 minutes ago)". */
export function reviewersAtWork(pr: GhPull): string[] {
  return (pr.reviewRequests ?? []).map((r: any) => {
    const w = atWork(r, pr);
    return `${r.login} is ${w.what}${w.since ? ` (${w.since})` : ''}`;
  });
}

/** "codex-review is still reviewing", or "codex-review is about to review" when it has not started yet. */
export function stillReviewing(pr: GhPull): string {
  const requests = pr.reviewRequests ?? [];
  const who = requests.map((r: any) => r.login).join(' and ');
  const verb = requests.length > 1 ? 'are' : 'is';
  return `${who} ${verb} ${requests.every((r: any) => r.status === 'QUEUED') ? 'about to review' : 'still reviewing'}`;
}

function reviewersLine(pr: GhPull): string {
  // As in gh, a reviewer asked for a review shows that instead of the state of its last one.
  const requests = pr.reviewRequests ?? [];
  const asked = new Set(requests.map((r: any) => r.login));
  return [
    ...(pr.latestReviews ?? []).filter((r: any) => !asked.has(r.author.login)).map((r: any) => `${r.author.login} (${REVIEW_STATE[r.state] ?? r.state.toLowerCase()})`),
    ...requests.map((r: any) => {
      const w = atWork(r, pr);
      return `${r.login} (${[w.what, w.since].filter(Boolean).join(', ')})`;
    }),
  ].join(', ');
}

// As gh describes them.
const MERGE_METHOD: Record<string, string> = { MERGE: 'a merge commit', REBASE: 'rebase and merge', SQUASH: 'squash and merge' };

const WHOSE: Record<string, string> = {
  AUTHOR: "the author's turn",
  REVIEWER_AGENTS: "the reviewer agents' turn",
  REVIEWER: "the reviewer's turn",
  NONE: 'nothing waiting',
};

/** Whose move it is and why: "the reviewer's turn: claude is waiting for review, 3 min; codex-review found nothing in 8c64534". */
export function turnLine(turn: { whose: string; reasons: string[] }): string {
  return `${WHOSE[turn.whose] ?? turn.whose.toLowerCase()}${turn.reasons.length ? `: ${turn.reasons.join('; ')}` : ''}`;
}

/** `gh pr view` without a TTY: key/value header, "--", body. */
export function viewPlain(pr: GhPull, images?: ImageRef): string {
  const lines = [
    `title:\t${pr.title}`,
    `state:\t${pr.state}`,
    `author:\t${pr.author.login}`,
    `labels:\t`,
    `assignees:\t`,
    `reviewers:\t${reviewersLine(pr)}`,
    `projects:\t`,
    `milestone:\t`,
    `number:\t${pr.number}`,
    `url:\t${pr.url}`,
    `additions:\t${pr.additions}`,
    `deletions:\t${pr.deletions}`,
    `auto-merge:\t${pr.autoMergeRequest ? `enabled\t${pr.autoMergeRequest.enabledBy.login}\t${pr.autoMergeRequest.mergeMethod.toLowerCase()}` : 'disabled'}`,
    `auto-publish:\t${pr.autoPublishRequest ? `enabled\t${pr.autoPublishRequest.enabledBy.login}` : 'disabled'}`,
    `base:\t${pr.baseRefName}`,
    `head:\t${pr.headRefName} (${String(pr.headRefOid).slice(0, 7)})`,
    `commits:\t${pr.commits.length}`,
    `draft:\t${pr.isDraft}`,
    `review decision:\t${pr.reviewDecision}`,
    `unresolved threads:\t${pr.reviewThreads.filter((t: any) => !t.isResolved).length}`,
  ];
  if (pr.publishedUrl) lines.push(`published:\t${pr.publishedUrl}`);
  // A server older than the CLI has neither field.
  if (pr.unpublishedChanges?.length) lines.push(`unpublished:\t${unpublished(pr)}`);
  if (pr.turn) lines.push(`turn:\t${pr.turn.whose.toLowerCase()}\t${pr.turn.reasons.join('; ')}`);
  if (pr.mergedAt) lines.push(`merged:\t${mergedText(pr)}`);
  if (pr.githubStatus) lines.push(`github:\t${githubSummary(pr)}`);
  return `${lines.join('\n')}\n--\n${withImages(pr.body, images)}\n`;
}

export function viewTTY(pr: GhPull, images?: ImageRef): string {
  // A server older than the CLI says OPEN for STAGED.
  const staged = pr.state === 'STAGED' || pr.state === 'OPEN';
  const update = pr.state === 'PUBLISHED' && pr.unpublishedChanges?.length > 0;
  const state = staged
    ? pr.isDraft
      ? c.gray('Draft')
      : c.blue('Staged')
    : pr.state === 'PUBLISHED'
      ? update
        ? c.blue('Update not published')
        : c.magenta('Published')
      : pr.state === 'MERGED'
        ? c.magenta('Merged')
        : c.red('Closed');
  const commits = `${pr.commits.length} commit${pr.commits.length === 1 ? '' : 's'}`;
  const did =
    pr.state === 'MERGED'
      ? `${pr.mergedBy?.login ?? 'Someone'} merged ${commits} into`
      : pr.state === 'PUBLISHED' && !update
        ? `${pr.author.login} published ${commits} into`
        : `${pr.author.login} staged ${commits} for`;
  const out = [
    `${c.bold(pr.title)} ${c.gray('#' + pr.number)}`,
    `${state} • ${did} ${pr.baseRefName} from ${pr.headRefName} • ${c.green('+' + pr.additions)} ${c.red('-' + pr.deletions)}`,
  ];
  const reviewers = reviewersLine(pr);
  if (reviewers) out.push(`Reviewers: ${reviewers}`);
  if (pr.autoMergeRequest) out.push(`${c.bold('Auto-merge:')} ${c.green('enabled')} on GitHub by ${pr.autoMergeRequest.enabledBy.login}, using ${MERGE_METHOD[pr.autoMergeRequest.mergeMethod] ?? pr.autoMergeRequest.mergeMethod}`);
  if (pr.autoPublishRequest) {
    const then = pr.autoPublishRequest.autoMerge ? ', then auto-merge on GitHub' : '';
    out.push(`${c.bold('Auto-publish:')} ${c.green('enabled')} by ${pr.autoPublishRequest.enabledBy.login}, when the reviews are done${then}`);
  }
  const unresolved = pr.reviewThreads.filter((t: any) => !t.isResolved).length;
  if (unresolved) out.push(c.yellow(`${unresolved} unresolved review thread${unresolved === 1 ? '' : 's'}`));
  if (pr.turn && pr.turn.whose !== 'NONE') out.push(`${c.bold('Turn:')} ${turnLine(pr.turn)}`);
  out.push('', pr.body.trim() ? indent(withImages(pr.body.trim(), images), '  ') : c.gray('  No description provided.'), '');
  if (pr.publishedUrl) out.push(`Published: ${pr.publishedUrl}${pr.unpublishedChanges?.length ? c.yellow(` (update not published: ${unpublished(pr)})`) : ''}`);
  if (pr.mergedAt) out.push(`Merged on GitHub ${mergedText(pr)}`);
  if (pr.githubStatus) out.push(`On GitHub: ${githubSummary(pr)}`);
  out.push(c.gray(`View this pull request in laatsux: ${pr.url}`));
  return out.join('\n') + '\n';
}

/** "commits, title": what GitHub does not have yet. */
function unpublished(pr: GhPull): string {
  return pr.unpublishedChanges.map((x: string) => (x === 'BODY' ? 'description' : x.toLowerCase())).join(', ');
}

/** "as e468a4e by laat at 2026-10-16T09:12:00Z" */
function mergedText(pr: GhPull): string {
  return [pr.mergeCommit ? `as ${String(pr.mergeCommit.oid).slice(0, 7)}` : null, pr.mergedBy ? `by ${pr.mergedBy.login}` : null, `at ${pr.mergedAt}`].filter(Boolean).join(' ');
}

function location(t: any, pr?: GhPull): string {
  if (t.subjectType === 'COMMIT') {
    const headline = pr?.commits?.find((cm: any) => cm.oid === t.commit.oid)?.messageHeadline;
    return `the message of commit ${String(t.commit.oid).slice(0, 7)}${headline ? ` "${headline}"` : ' (no longer in the branch)'}`;
  }
  if (t.subjectType === 'FILE' || (t.line === null && t.originalLine === null)) return `file ${t.path}`;
  const line = t.isOutdated ? t.originalLine : t.line;
  const start = t.isOutdated ? t.originalStartLine : t.startLine;
  const range = start && start !== line ? `${start}-${line}` : `${line}`;
  return `${t.path}:${range}${t.diffSide === 'LEFT' ? ' (old side)' : ''}`;
}

export function formatThread(t: any, newIds?: Set<number>, pr?: GhPull, images?: ImageRef): string {
  const flags = [t.isResolved ? 'resolved' : 'unresolved', t.isOutdated ? 'outdated' : null].filter(Boolean).join(', ');
  const priority = t.priority ? ` (${t.priority === 'high' ? c.red('high priority') : `${t.priority} priority`})` : '';
  const out = [c.bold(`thread ${t.databaseId}`) + ` on ${location(t, pr)} [${flags}]${priority}`];
  if (t.diffHunk) {
    const hunk = t.diffHunk.split('\n');
    const shown = hunk.length > 5 ? hunk.slice(-4) : hunk;
    out.push(indent(shown.map((l: string) => (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.gray(l))).join('\n')));
  }
  for (const cm of t.comments) {
    const mark = newIds?.has(cm.databaseId) ? c.yellow(' (new)') : '';
    out.push(indent(`${c.bold(cm.author.login)}${mark}:`), indent(withImages(cm.body.trim(), images), '      '));
  }
  return out.join('\n');
}

interface Item {
  at: string;
  text: string;
}

export function conversationItems(pr: GhPull, opts: { reviews?: Set<number>; comments?: Set<number>; replies?: Set<number>; images?: ImageRef } = {}): Item[] {
  const filter = opts.reviews || opts.comments || opts.replies;
  const items: Item[] = [];
  for (const cm of pr.comments) {
    if (filter && !opts.comments?.has(cm.databaseId)) continue;
    items.push({ at: cm.createdAt, text: `${c.bold(cm.author.login)} commented (comment ${cm.databaseId}, ${cm.createdAt}):\n${indent(withImages(cm.body.trim(), opts.images))}` });
  }
  const shownThreads = new Set<number>();
  for (const r of pr.reviews) {
    if (filter && !opts.reviews?.has(r.databaseId)) continue;
    const threads = pr.reviewThreads.filter((t: any) => t.reviewDatabaseId === r.databaseId);
    // An approval or a change request is feedback even without text; an empty comment is not.
    if (!r.body.trim() && threads.length === 0 && r.state === 'COMMENTED') continue;
    const parts = [`${c.bold(r.author.login)} reviewed: ${REVIEW_STATE[r.state] ?? r.state} (review ${r.databaseId}, ${r.submittedAt})`];
    if (r.body.trim()) parts.push(indent(withImages(r.body.trim(), opts.images)));
    for (const t of threads) {
      shownThreads.add(t.databaseId);
      parts.push(indent(formatThread(t, undefined, pr, opts.images), '  '));
    }
    items.push({ at: r.submittedAt, text: parts.join('\n') });
  }
  // Replies that arrived after their review: show the whole thread so the reply has context.
  if (opts.replies?.size) {
    for (const t of pr.reviewThreads) {
      const ids = new Set<number>(t.comments.map((cm: any) => cm.databaseId));
      const fresh = [...opts.replies].filter((id) => ids.has(id));
      if (!fresh.length || shownThreads.has(t.databaseId)) continue;
      const last = t.comments.find((cm: any) => cm.databaseId === fresh[fresh.length - 1]);
      items.push({ at: last.createdAt, text: `${c.bold(last.author.login)} replied:\n${indent(formatThread(t, new Set(fresh), pr, opts.images), '  ')}` });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export function formatConversation(pr: GhPull, images?: ImageRef): string {
  const items = conversationItems(pr, { images });
  const out = [c.bold('-- conversation --')];
  out.push(...(items.length ? items.map((i) => i.text) : [c.gray('No comments or reviews yet.')]));
  const unresolved = pr.reviewThreads.filter((t: any) => !t.isResolved);
  if (unresolved.length) out.push(c.yellow(`Unresolved threads: ${unresolved.map((t: any) => t.databaseId).join(', ')}`));
  return out.join('\n\n') + '\n';
}

// ------------------------------------------------------------------- GitHub

/** How the published pull request stands on GitHub, in one line: "checks: 1 failed, 3 passed · 2 unresolved threads". */
export function githubSummary(pr: GhPull): string {
  const g = pr.githubStatus;
  const count = (result: string) => g.checks.filter((ch: any) => ch.result === result).length;
  const counts = ['failed', 'pending', 'passed', 'skipped'].map((r) => (count(r) ? `${count(r)} ${r}` : null)).filter(Boolean);
  // `checks` is the first page; checksResult is GitHub's sum of all of them (absent from a status stored before).
  const total = Math.max(g.checksTotal ?? 0, g.checks.length);
  const checks =
    total > g.checks.length
      ? `checks: ${g.checksResult ?? 'unknown'} (first ${g.checks.length} of ${total}: ${counts.join(', ') || 'none listed'})`
      : counts.length
        ? `checks: ${counts.join(', ')}`
        : null;
  const parts = [
    checks,
    g.runs.length ? `${g.runs.length} workflow run${g.runs.length === 1 ? '' : 's'} running` : null,
    g.copilotPending ? 'Copilot is reviewing' : null,
    g.reviewDecision ? `review: ${g.reviewDecision.toLowerCase().replace('_', ' ')}` : null,
    g.threads.length ? `${g.threads.length} unresolved thread${g.threads.length === 1 ? '' : 's'}` : null,
    g.conflicting ? `conflicts with ${pr.baseRefName}` : g.mergeStateStatus === 'BEHIND' ? `behind ${pr.baseRefName}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no checks, reviews or threads';
}
