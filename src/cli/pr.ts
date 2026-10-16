import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ApiError, CliError, Client, currentBranch, git, repoPath, type RepoRef } from './client.ts';
import { c, checkFields, err, isTTY, out, parseDuration, printJson } from './output.ts';
import { conversationItems, formatConversation, reviewersAtWork, stillReviewing, viewPlain, viewTTY } from './format.ts';

type Options = NonNullable<ParseArgsConfig['options']>;

const GH_FIELDS = [
  'additions', 'author', 'baseRefName', 'baseRefOid', 'body', 'changedFiles', 'closed', 'closedAt', 'comments', 'commits',
  'createdAt', 'deletions', 'files', 'headRefName', 'headRefOid', 'id', 'isDraft', 'latestReviews', 'number', 'publishedUrl',
  'reviewDecision', 'reviewRequests', 'reviewThreads', 'reviews', 'state', 'title', 'updatedAt', 'url', 'waiting',
];

// gh flags that have no meaning here. They are accepted so habitual invocations keep working.
const multi = { type: 'string', multiple: true } as const;
const IGNORED: Options = {
  assignee: { ...multi, short: 'a' },
  label: { ...multi, short: 'l' },
  milestone: { type: 'string', short: 'm' },
  project: { ...multi, short: 'p' },
  'no-maintainer-edit': { type: 'boolean' },
  'add-assignee': multi,
  'remove-assignee': multi,
  'add-label': multi,
  'remove-label': multi,
  'add-project': multi,
  'remove-project': multi,
  'add-reviewer': multi,
  'remove-reviewer': multi,
  'remove-milestone': { type: 'boolean' },
};

const JSON_OPTS: Options = {
  json: { type: 'string' },
  jq: { type: 'string', short: 'q' },
  template: { type: 'string', short: 't' },
};

function parse(args: string[], options: Options): { values: Record<string, any>; positionals: string[] } {
  // gh prints the available fields for a bare `--json`; parseArgs would demand a value.
  const fixed = args.map((a, i) => (a === '--json' && (i === args.length - 1 || args[i + 1].startsWith('-')) ? '--json=' : a));
  try {
    return parseArgs({
      args: fixed,
      options: { ...options, repo: { type: 'string', short: 'R' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
}

function readBody(v: { body?: string; 'body-file'?: string }): string | undefined {
  if (v['body-file'] !== undefined) {
    const f = v['body-file'];
    return f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8');
  }
  return v.body;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
  err(`Opening ${url} in your browser.`);
}

interface Target {
  repo: RepoRef;
  number: number;
}

async function resolvePull(client: Client, cwd: string, repoFlag: string | undefined, arg: string | undefined): Promise<Target> {
  if (arg) {
    const url = arg.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (url) return { repo: { owner: url[1], name: url[2] }, number: Number(url[3]) };
    const n = arg.match(/^#?(\d+)$/);
    if (n) return { repo: await client.repoFor(cwd, repoFlag), number: Number(n[1]) };
  }
  const repo = await client.repoFor(cwd, repoFlag);
  const branch = arg ?? currentBranch(cwd);
  if (!branch) throw new CliError('could not determine the current branch; pass a pull request number');
  const list = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=all&head=${encodeURIComponent(branch)}&fields=number,state`);
  const pick = list.find((p) => p.state !== 'CLOSED') ?? list[0];
  if (!pick) throw new CliError(`no pull requests found for branch "${branch}"`);
  return { repo, number: pick.number };
}

const pullPath = (t: Target) => `${repoPath(t.repo)}/pulls/${t.number}`;
const ghPath = (t: Target, fields: string[]) => `${repoPath(t.repo)}/gh/pulls/${t.number}${fields.length ? `?fields=${fields.join(',')}` : ''}`;

// ------------------------------------------------------------------- create

/**
 * `--reviewer` values, repeated or comma-separated as in gh. `codex:3` asks for that many
 * automatic reviews. Which logins are reviewer agents is up to the server, so a new one needs
 * no change here; it ignores the rest.
 */
export function parseReviewers(values: string[]): { login: string; max_iterations?: number }[] {
  return values.flatMap((v) =>
    v.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = s.match(/^([^:\s]+)(?::(\d+))?$/);
      if (!m) throw new CliError(`invalid reviewer "${s}": use a login, or a reviewer agent and its number of reviews, as in codex:3`);
      return m[2] === undefined ? { login: m[1] } : { login: m[1], max_iterations: Number(m[2]) };
    }),
  );
}

async function create(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, {
    ...IGNORED,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    base: { type: 'string', short: 'B' },
    head: { type: 'string', short: 'H' },
    draft: { type: 'boolean', short: 'd' },
    fill: { type: 'boolean', short: 'f' },
    'fill-first': { type: 'boolean' },
    'fill-verbose': { type: 'boolean' },
    web: { type: 'boolean', short: 'w' },
    editor: { type: 'boolean', short: 'e' },
    template: { type: 'string', short: 'T' },
    'dry-run': { type: 'boolean' },
    recover: { type: 'string' },
    reviewer: { ...multi, short: 'r' },
    'no-review': { type: 'boolean' },
  });
  if (v.editor) throw new CliError('--editor is not supported; pass --title and --body or --body-file');
  const reviewers = v.reviewer ? parseReviewers(v.reviewer as string[]) : undefined;
  const fill = v['fill-verbose'] ? 'verbose' : v['fill-first'] ? 'first' : v.fill ? 'default' : undefined;
  const body = readBody(v as any);
  if (v.title === undefined && !fill) {
    throw new CliError('must provide `--title` and `--body` (or `--fill` or `--fill-first` or `--fill-verbose`) when not running interactively');
  }
  const repo = await client.repoFor(cwd, v.repo as string | undefined);
  const head = (v.head as string | undefined) ?? currentBranch(cwd);
  if (!head) throw new CliError('could not determine the current branch (detached HEAD?); pass --head');
  try {
    const dirty = git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    if (dirty) err(`Warning: ${dirty} uncommitted change${dirty === 1 ? '' : 's'}`);
  } catch {}
  err(`Staging pull request for ${head} into ${(v.base as string) ?? 'the default branch'} in ${repo.owner}/${repo.name}\n`);
  if (v['dry-run']) return 0;
  const pr = await client.json('POST', `${repoPath(repo)}/pulls`, {
    title: v.title,
    body,
    head,
    base: v.base,
    draft: !!v.draft,
    fill,
    reviewers,
    automatic_reviews: v['no-review'] ? false : undefined,
  });
  for (const login of pr.ignored_reviewers ?? []) err(`Ignored reviewer ${login}: laatsux has no reviewer agent by that name.`);
  out(pr.html_url);
  if (v.web) openBrowser(pr.html_url);
  err(c.gray(`Review happens in the browser. Run \`laatsux pr wait ${pr.number}\` to block until the reviewer responds.`));
  return 0;
}

// --------------------------------------------------------------------- list

async function list(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, {
    ...JSON_OPTS,
    state: { type: 'string', short: 's', default: 'open' },
    limit: { type: 'string', short: 'L', default: '30' },
    head: { type: 'string', short: 'H' },
    base: { type: 'string', short: 'B' },
    author: { type: 'string', short: 'A' },
    assignee: { type: 'string', short: 'a' },
    label: multi,
    search: { type: 'string', short: 'S' },
    draft: { type: 'boolean', short: 'd' },
    web: { type: 'boolean', short: 'w' },
    app: { type: 'string' },
  });
  const repo = await client.repoFor(cwd, v.repo as string | undefined);
  if (v.web) {
    openBrowser(client.base + `/${repo.owner}/${repo.name}`);
    return 0;
  }
  const state = v.state === 'merged' ? 'published' : String(v.state);
  const fields = v.json !== undefined ? checkFields(String(v.json), GH_FIELDS) : ['number', 'title', 'headRefName', 'state', 'createdAt', 'isDraft', 'author'];
  const q = new URLSearchParams({ state, limit: String(v.limit), fields: [...new Set([...fields, 'isDraft', 'author'])].join(',') });
  if (v.head) q.set('head', String(v.head));
  if (v.base) q.set('base', String(v.base));
  let pulls = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?${q}`);
  if (v.author) pulls = pulls.filter((p) => p.author.login === v.author);
  if (v.draft) pulls = pulls.filter((p) => p.isDraft);
  if (v.json !== undefined) {
    printJson(pulls.map((p) => Object.fromEntries(fields.map((f) => [f, p[f]]))), v.jq as string | undefined);
    return 0;
  }
  if (!pulls.length) {
    if (isTTY) err(`no ${state === 'all' ? '' : state + ' '}pull requests match your search in ${repo.owner}/${repo.name}`);
    return 0;
  }
  if (isTTY) {
    out(`\nShowing ${pulls.length} of ${pulls.length} ${state === 'all' ? '' : state + ' '}pull requests in ${repo.owner}/${repo.name}\n`);
    const w = Math.max(...pulls.map((p) => p.title.length));
    for (const p of pulls) {
      const num = p.state === 'CLOSED' ? c.red(`#${p.number}`) : p.state === 'PUBLISHED' ? c.magenta(`#${p.number}`) : p.isDraft ? c.gray(`#${p.number}`) : c.green(`#${p.number}`);
      out(`${num}\t${p.title.padEnd(w)}  ${c.cyan(p.headRefName)}  ${c.gray(p.createdAt.slice(0, 10))}`);
    }
  } else {
    for (const p of pulls) out([p.number, p.title, p.headRefName, p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state, p.createdAt].join('\t'));
  }
  return 0;
}

// --------------------------------------------------------------------- view

async function view(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { ...JSON_OPTS, comments: { type: 'boolean', short: 'c' }, web: { type: 'boolean', short: 'w' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  if (v.web) {
    openBrowser(`${client.base}/${t.repo.owner}/${t.repo.name}/pull/${t.number}`);
    return 0;
  }
  if (v.json !== undefined) {
    const fields = checkFields(String(v.json), GH_FIELDS);
    printJson(await client.get(ghPath(t, fields)), v.jq as string | undefined);
    return 0;
  }
  const pr = await client.get(ghPath(t, []) + (v.comments ? '?seen=1' : ''));
  out(isTTY ? viewTTY(pr) : viewPlain(pr));
  if (v.comments) out(formatConversation(pr));
  return 0;
}

// --------------------------------------------------------------------- diff

async function diff(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, {
    color: { type: 'string', default: 'auto' },
    patch: { type: 'boolean' },
    'name-only': { type: 'boolean' },
    web: { type: 'boolean', short: 'w' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  if (v.web) {
    openBrowser(`${client.base}/${t.repo.owner}/${t.repo.name}/pull/${t.number}/files`);
    return 0;
  }
  if (v['name-only']) {
    for (const f of await client.get<any[]>(`${pullPath(t)}/files`)) out(f.filename);
    return 0;
  }
  const res = await client.raw('GET', `${pullPath(t)}?format=${v.patch ? 'patch' : 'diff'}`);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text);
  const colorize = v.color === 'always' || (v.color === 'auto' && isTTY && !process.env.NO_COLOR);
  if (!colorize) {
    process.stdout.write(text);
    return 0;
  }
  for (const l of text.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) out(c.bold(l));
    else if (l.startsWith('@@')) out(c.cyan(l));
    else if (l.startsWith('+')) out(c.green(l));
    else if (l.startsWith('-')) out(c.red(l));
    else out(l);
  }
  return 0;
}

// --------------------------------------------------------------------- edit

async function edit(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, {
    ...IGNORED,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    base: { type: 'string', short: 'B' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const patch: Record<string, unknown> = {};
  if (v.title !== undefined) patch.title = v.title;
  const body = readBody(v as any);
  if (body !== undefined) patch.body = body;
  if (v.base !== undefined) patch.base = v.base;
  if (Object.keys(patch).length === 0) {
    if (Object.keys(v).some((k) => k in IGNORED)) {
      err('assignees, labels, reviewers, projects and milestones do not exist in laatsux; nothing to change');
      return 0;
    }
    throw new CliError('specify at least one of --title, --body, --body-file or --base');
  }
  const pr = await client.json('PATCH', pullPath(t), patch);
  out(pr.html_url);
  return 0;
}

// ------------------------------------------------------------------ comment

async function comment(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, {
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    'reply-to': { type: 'string' },
    resolve: { type: 'boolean' },
    'edit-last': { type: 'boolean' },
    'create-if-none': { type: 'boolean' },
    'delete-last': { type: 'boolean' },
    yes: { type: 'boolean' },
    editor: { type: 'boolean', short: 'e' },
    web: { type: 'boolean', short: 'w' },
  });
  if (v.editor || v.web) throw new CliError('--editor and --web are not supported; pass --body or --body-file');
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const body = readBody(v as any);
  if (v['delete-last'] || v['edit-last']) {
    const me = (await client.get('/api/user')).login;
    const mine = (await client.get<any[]>(`${repoPath(t.repo)}/issues/${t.number}/comments`)).filter((cm) => cm.user.login === me);
    const last = mine[mine.length - 1];
    if (v['delete-last']) {
      if (!last) throw new CliError('no comments found for current user');
      await client.json('DELETE', `${repoPath(t.repo)}/issues/comments/${last.id}`);
      err('Comment deleted');
      return 0;
    }
    if (body === undefined) throw new CliError('--body or --body-file required');
    if (last) {
      out((await client.json('PATCH', `${repoPath(t.repo)}/issues/comments/${last.id}`, { body })).html_url);
      return 0;
    }
    if (!v['create-if-none']) throw new CliError('no comments found for current user');
  }
  if (v.resolve && !v['reply-to']) throw new CliError('--resolve needs --reply-to <thread>');
  if (body === undefined) throw new CliError('--body or --body-file required when not running interactively');
  if (v['reply-to']) {
    const id = String(v['reply-to']).replace(/^\D+/, '');
    const reply = await client.json('POST', `${pullPath(t)}/comments/${id}/replies`, { body });
    // Say what was done, then close the thread: the reviewer can reopen it.
    if (v.resolve) await client.json('PUT', `${pullPath(t)}/threads/${id}/resolved`);
    out(reply.html_url);
    return 0;
  }
  out((await client.json('POST', `${repoPath(t.repo)}/issues/${t.number}/comments`, { body })).html_url);
  return 0;
}

// ------------------------------------------------------------------- review

async function review(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, {
    approve: { type: 'boolean', short: 'a' },
    comment: { type: 'boolean', short: 'c' },
    'request-changes': { type: 'boolean', short: 'r' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const event = v.approve ? 'APPROVE' : v['request-changes'] ? 'REQUEST_CHANGES' : v.comment ? 'COMMENT' : null;
  if (!event) throw new CliError('--approve, --request-changes, or --comment required when not running interactively');
  const body = readBody(v as any) ?? '';
  if (event !== 'APPROVE' && !body.trim()) throw new CliError(`body cannot be blank for ${event === 'COMMENT' ? 'comment' : 'request changes'} review`);
  await client.json('POST', `${pullPath(t)}/reviews`, { event, body });
  const verb = { APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes to', COMMENT: 'Reviewed' }[event];
  err(`✓ ${verb} pull request ${t.repo.owner}/${t.repo.name}#${t.number}`);
  return 0;
}

// ------------------------------------------------------------ state changes

async function setState(client: Client, cwd: string, args: string[], state: 'open' | 'closed'): Promise<number> {
  const { values: v, positionals } = parse(args, { comment: { type: 'string', short: 'c' }, 'delete-branch': { type: 'boolean', short: 'd' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  if (v.comment) await client.json('POST', `${repoPath(t.repo)}/issues/${t.number}/comments`, { body: v.comment });
  const pr = await client.json('PATCH', pullPath(t), { state });
  err(`✓ ${state === 'closed' ? 'Closed' : 'Reopened'} pull request ${t.repo.owner}/${t.repo.name}#${t.number} (${pr.title})`);
  if (v['delete-branch']) err('The branch was left alone; laatsux never deletes branches.');
  return 0;
}

async function ready(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { undo: { type: 'boolean' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  await client.json('PATCH', pullPath(t), { draft: !!v.undo });
  err(`✓ Pull request ${t.repo.owner}/${t.repo.name}#${t.number} is ${v.undo ? 'converted to "draft"' : 'marked as "ready for review"'}`);
  return 0;
}

async function checkout(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { branch: { type: 'string', short: 'b' }, detach: { type: 'boolean' }, force: { type: 'boolean', short: 'f' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const pr = await client.get(ghPath(t, ['headRefName', 'headRefOid']));
  const target = v.detach ? pr.headRefOid : pr.headRefName;
  try {
    process.stdout.write(git(cwd, ['checkout', ...(v.force ? ['--force'] : []), target]));
  } catch (e) {
    throw new CliError(String((e as { stderr?: string }).stderr ?? e).trim());
  }
  err(`Switched to ${v.detach ? 'commit' : 'branch'} '${target}'`);
  return 0;
}

async function status(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, { ...JSON_OPTS });
  const repo = await client.repoFor(cwd, v.repo as string | undefined);
  const branch = currentBranch(cwd);
  const pulls = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=open&fields=number,title,headRefName,state,isDraft,reviewDecision,url,waiting`);
  if (v.json !== undefined) {
    const fields = checkFields(String(v.json), GH_FIELDS);
    const pick = (p: any) => Object.fromEntries(fields.map((f) => [f, p[f]]));
    printJson({ currentBranch: pulls.filter((p) => p.headRefName === branch).map(pick)[0] ?? null, open: pulls.map(pick) }, v.jq as string | undefined);
    return 0;
  }
  out(`\nRelevant pull requests in ${repo.owner}/${repo.name}\n`);
  out(c.bold('Current branch'));
  const mine = pulls.find((p) => p.headRefName === branch);
  out(mine ? `  #${mine.number}  ${mine.title} [${mine.headRefName}]\n    - ${mine.reviewDecision.toLowerCase().replace('_', ' ')}` : `  There is no pull request associated with [${branch}]`);
  out('\n' + c.bold('Open staged pull requests'));
  if (!pulls.length) out('  You have no open pull requests');
  for (const p of pulls) out(`  #${p.number}  ${p.title} [${p.headRefName}]${p.state === 'PUBLISHED' ? ' (published)' : ''}`);
  out('');
  return 0;
}

// -------------------------------------------------------------- the loop

async function publish(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, {
    draft: { type: 'boolean', short: 'd' },
    force: { type: 'boolean', short: 'f' },
    sign: { type: 'boolean' },
    'no-sign': { type: 'boolean' },
    'during-review': { type: 'boolean' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  err(`Publishing ${t.repo.owner}/${t.repo.name}#${t.number} to GitHub…`);
  const sign = v.sign ? true : v['no-sign'] ? false : undefined;
  const pr = await client
    .json('POST', `${pullPath(t)}/publish`, { draft: v.draft ? true : undefined, force: !!v.force, sign, during_review: !!v['during-review'] })
    .catch((e) => {
      // A reviewer is at work: the server asks whether to publish anyway.
      if (e instanceof ApiError && e.status === 428) throw new CliError(`${e.message}\nRun \`laatsux pr publish ${t.number} --during-review\` to publish anyway.`);
      throw e;
    });
  out(pr.published_url);
  return 0;
}

/**
 * "The approval from laat came before this review from codex.": an approval that still holds
 * was given before a new review from someone else, so it does not take that review into account.
 */
function approvedBefore(pr: any, fresh: Set<number>): string[] {
  if (pr.reviewDecision !== 'APPROVED') return [];
  const decisions = new Map<string, any>();
  for (const rv of pr.reviews) if (rv.state === 'APPROVED' || rv.state === 'CHANGES_REQUESTED') decisions.set(rv.author.login, rv);
  const lines: string[] = [];
  for (const approval of [...decisions.values()].filter((rv) => rv.state === 'APPROVED')) {
    const later = pr.reviews.filter((rv: any) => fresh.has(rv.databaseId) && rv.author.login !== approval.author.login && rv.submittedAt > approval.submittedAt);
    const who = [...new Set(later.map((rv: any) => rv.author.login))];
    if (who.length) lines.push(`The approval from ${approval.author.login} came before this review from ${who.join(' and ')}.`);
  }
  return lines;
}

/** The server is down or restarting: worth asking again shortly. */
function transient(e: unknown): boolean {
  return (e instanceof TypeError && e.message === 'fetch failed') || (e instanceof CliError && /not running/.test(e.message));
}

async function wait(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, { timeout: { type: 'string' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const deadline = v.timeout ? Date.now() + parseDuration(String(v.timeout)) : Infinity;
  if (isTTY) err(`Waiting for feedback on ${t.repo.owner}/${t.repo.name}#${t.number}…`);
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      err(`No feedback yet on ${t.repo.owner}/${t.repo.name}#${t.number} (timed out). Run \`laatsux pr wait ${t.number}\` again to keep waiting.`);
      return 124;
    }
    let r: any;
    try {
      r = await client.get(`${pullPath(t)}/wait?timeout=${Math.min(left, 240)}`);
    } catch (e) {
      // The server went away (refused) or restarted under us (the open request was dropped):
      // give it a moment and keep waiting.
      if (transient(e)) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      throw e;
    }
    if (r.status === 'timeout') continue;
    const url = `${client.base}/${t.repo.owner}/${t.repo.name}/pull/${t.number}`;
    const pr = r.pr;
    const items = conversationItems(pr, {
      reviews: new Set(r.reviews),
      comments: new Set(r.comments.filter((cm: any) => cm.kind === 'issue').map((cm: any) => cm.id)),
      replies: new Set(r.comments.filter((cm: any) => cm.kind === 'review').map((cm: any) => cm.id)),
    });
    if (items.length) {
      out(`New feedback on ${url} (review decision: ${pr.reviewDecision})\n`);
      out(items.map((i) => i.text).join('\n\n') + '\n');
    }
    for (const line of approvedBefore(pr, new Set(r.reviews))) out(line);
    const unresolved = pr.reviewThreads.filter((th: any) => !th.isResolved);
    // Reviewers still at work will be heard from: their review wakes the next wait.
    const atWork = reviewersAtWork(pr);
    const getIt = `run \`laatsux pr wait ${t.number}\` to get ${atWork.length > 1 ? 'their reviews' : 'its review'}.`;
    // Shown, so now it counts as seen. If this does not get through, the next wait shows it again.
    for (let attempt = 1; ; attempt++) {
      try {
        await client.json('PUT', `${pullPath(t)}/seen`, { at: r.seen_at });
        break;
      } catch (e) {
        if (!transient(e) || attempt === 10) {
          err('Could not confirm the feedback as seen; the next `laatsux pr wait` will show it again.');
          break;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    if (r.status === 'published') {
      out(`Published to GitHub: ${r.published_url}`);
      if (atWork.length) out(`Published while ${stillReviewing(pr)}; ${getIt}`);
      else out(items.length ? 'Published, but read the feedback above: the reviewer may still want changes.' : 'The reviewer is done with this pull request.');
      return 0;
    }
    if (r.status === 'closed') {
      out(`The reviewer closed ${url} without publishing it.`);
      return 0;
    }
    if (unresolved.length) out(`Unresolved threads: ${unresolved.map((th: any) => th.databaseId).join(', ')}`);
    for (const line of atWork) out(`${line}.`);
    if (pr.reviewDecision === 'APPROVED' && !unresolved.length && atWork.length) {
      out(c.gray(`${stillReviewing(pr)}; ${getIt}`));
    } else if (pr.reviewDecision === 'APPROVED' && !unresolved.length) {
      out(c.gray(`Approved with nothing left open. Run \`laatsux pr wait ${t.number}\` to wait until the reviewer publishes it.`));
    } else {
      out(
        c.gray(
          `Address the feedback. Reply to each thread and resolve the ones you fixed with ` +
            `\`laatsux pr comment ${t.number} --reply-to <thread> --resolve -b "…"\` ` +
            `(leave out --resolve to keep a thread open for the reviewer), then run \`laatsux pr wait ${t.number}\` again.`,
        ),
      );
    }
    return 0;
  }
}

// --------------------------------------------------------------------- main

const USAGE = `Work with staged pull requests. Mirrors \`gh pr\`.

USAGE
  laatsux pr <command> [flags]

COMMANDS (same flags as gh)
  create:      Stage a pull request for the current branch
  list:        List staged pull requests
  view:        Show a pull request (--comments for reviews and review threads)
  diff:        Show the diff
  edit:        Change title, body or base
  comment:     Comment, or reply to a review thread with --reply-to <id> [--resolve]
  review:      Approve, comment or request changes
  close:       Close a pull request
  reopen:      Reopen a pull request
  ready:       Mark as ready (or --undo for draft); decides how it is published
  checkout:    Check out the head branch
  status:      Show the pull request for the current branch

LAATSUX COMMANDS
  wait:        Block until the reviewer responds, then print the feedback
  publish:     Push the branch and open the pull request on GitHub

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository
`;

export async function pr(client: Client, cwd: string, args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'create':
    case 'new':
      return create(client, cwd, rest);
    case 'list':
    case 'ls':
      return list(client, cwd, rest);
    case 'view':
      return view(client, cwd, rest);
    case 'diff':
      return diff(client, cwd, rest);
    case 'edit':
      return edit(client, cwd, rest);
    case 'comment':
      return comment(client, cwd, rest);
    case 'review':
      return review(client, cwd, rest);
    case 'close':
      return setState(client, cwd, rest, 'closed');
    case 'reopen':
      return setState(client, cwd, rest, 'open');
    case 'ready':
      return ready(client, cwd, rest);
    case 'checkout':
    case 'co':
      return checkout(client, cwd, rest);
    case 'status':
      return status(client, cwd, rest);
    case 'publish':
      return publish(client, cwd, rest);
    case 'wait':
      return wait(client, cwd, rest);
    case 'checks':
      throw new CliError(`no checks reported on the '${currentBranch(cwd) ?? 'current'}' branch (laatsux does not run CI)`);
    case 'merge':
      throw new CliError('laatsux does not merge. When the reviewer is happy they publish the pull request to GitHub.');
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;
    default:
      throw new CliError(`unknown command "${cmd}" for "laatsux pr"\n\n${USAGE}`);
  }
}
