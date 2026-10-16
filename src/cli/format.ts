import { c, indent } from './output.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type GhPull = Record<string, any>;

const REVIEW_STATE: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
};

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

/** One line per reviewer at work: "codex is reviewing 35ef70b (started 2 minutes ago)". */
export function reviewersAtWork(pr: GhPull): string[] {
  return (pr.reviewRequests ?? []).map((r: any) => {
    const w = atWork(r, pr);
    return `${r.login} is ${w.what}${w.since ? ` (${w.since})` : ''}`;
  });
}

/** "codex is still reviewing", or "codex is about to review" when it has not started yet. */
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

/** `gh pr view` without a TTY: key/value header, "--", body. */
export function viewPlain(pr: GhPull): string {
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
    `auto-merge:\tdisabled`,
    `base:\t${pr.baseRefName}`,
    `head:\t${pr.headRefName} (${String(pr.headRefOid).slice(0, 7)})`,
    `commits:\t${pr.commits.length}`,
    `draft:\t${pr.isDraft}`,
    `review decision:\t${pr.reviewDecision}`,
    `unresolved threads:\t${pr.reviewThreads.filter((t: any) => !t.isResolved).length}`,
  ];
  if (pr.publishedUrl) lines.push(`published:\t${pr.publishedUrl}`);
  return `${lines.join('\n')}\n--\n${pr.body}\n`;
}

export function viewTTY(pr: GhPull): string {
  const state =
    pr.state === 'OPEN' ? (pr.isDraft ? c.gray('Draft') : c.green('Open')) : pr.state === 'PUBLISHED' ? c.magenta('Published') : c.red('Closed');
  const out = [
    `${c.bold(pr.title)} ${c.gray('#' + pr.number)}`,
    `${state} • ${pr.author.login} wants to merge ${pr.commits.length} commit${pr.commits.length === 1 ? '' : 's'} into ${pr.baseRefName} from ${pr.headRefName} • ${c.green('+' + pr.additions)} ${c.red('-' + pr.deletions)}`,
  ];
  const reviewers = reviewersLine(pr);
  if (reviewers) out.push(`Reviewers: ${reviewers}`);
  const unresolved = pr.reviewThreads.filter((t: any) => !t.isResolved).length;
  if (unresolved) out.push(c.yellow(`${unresolved} unresolved review thread${unresolved === 1 ? '' : 's'}`));
  out.push('', pr.body.trim() ? indent(pr.body.trim(), '  ') : c.gray('  No description provided.'), '');
  if (pr.publishedUrl) out.push(`Published: ${pr.publishedUrl}`);
  out.push(c.gray(`View this pull request in laatsux: ${pr.url}`));
  return out.join('\n') + '\n';
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

export function formatThread(t: any, newIds?: Set<number>, pr?: GhPull): string {
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
    out.push(indent(`${c.bold(cm.author.login)}${mark}:`), indent(cm.body.trim(), '      '));
  }
  return out.join('\n');
}

interface Item {
  at: string;
  text: string;
}

export function conversationItems(pr: GhPull, opts: { reviews?: Set<number>; comments?: Set<number>; replies?: Set<number> } = {}): Item[] {
  const filter = opts.reviews || opts.comments || opts.replies;
  const items: Item[] = [];
  for (const cm of pr.comments) {
    if (filter && !opts.comments?.has(cm.databaseId)) continue;
    items.push({ at: cm.createdAt, text: `${c.bold(cm.author.login)} commented (comment ${cm.databaseId}, ${cm.createdAt}):\n${indent(cm.body.trim())}` });
  }
  const shownThreads = new Set<number>();
  for (const r of pr.reviews) {
    if (filter && !opts.reviews?.has(r.databaseId)) continue;
    const threads = pr.reviewThreads.filter((t: any) => t.reviewDatabaseId === r.databaseId);
    // An approval or a change request is feedback even without text; an empty comment is not.
    if (!r.body.trim() && threads.length === 0 && r.state === 'COMMENTED') continue;
    const parts = [`${c.bold(r.author.login)} reviewed: ${REVIEW_STATE[r.state] ?? r.state} (review ${r.databaseId}, ${r.submittedAt})`];
    if (r.body.trim()) parts.push(indent(r.body.trim()));
    for (const t of threads) {
      shownThreads.add(t.databaseId);
      parts.push(indent(formatThread(t, undefined, pr), '  '));
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
      items.push({ at: last.createdAt, text: `${c.bold(last.author.login)} replied:\n${indent(formatThread(t, new Set(fresh), pr), '  ')}` });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export function formatConversation(pr: GhPull): string {
  const items = conversationItems(pr);
  const out = [c.bold('-- conversation --')];
  out.push(...(items.length ? items.map((i) => i.text) : [c.gray('No comments or reviews yet.')]));
  const unresolved = pr.reviewThreads.filter((t: any) => !t.isResolved);
  if (unresolved.length) out.push(c.yellow(`Unresolved threads: ${unresolved.map((t: any) => t.databaseId).join(', ')}`));
  return out.join('\n\n') + '\n';
}
