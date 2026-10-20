import { parseArgs, type ParseArgsConfig } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ApiError, CliError, Client, GATEWAY_DOWN, Help, currentBranch, git, repoPath, type RepoRef } from './client.ts';
import { c, checkFields, err, isTTY, out, parseDuration, printJson, stagedRef, stagedNumber } from './output.ts';
import { conflictsText, conversationItems, formatConversation, reviewersAtWork, stillReviewing, turnLine, viewPlain, viewTTY, type ImageRef } from './format.ts';
import { whoReviews } from './reviewers.ts';
import { openPage } from './open.ts';
import { clearPushRemote, fetchBack, fetchHead, hasBranch, sendBase, sendHead, sendPull, setPushRemote } from './send.ts';

type Options = NonNullable<ParseArgsConfig['options']>;

const GH_FIELDS = [
  'additions', 'author', 'autoMergeRequest', 'autoPublishRequest', 'baseConflicts', 'baseRefName', 'baseRefOid', 'body', 'changedFiles', 'client', 'closed', 'closedAt', 'comments',
  'commits', 'createdAt', 'deletions', 'files', 'githubStatus', 'headRefName', 'headRefOid', 'id', 'isDraft', 'isPinned', 'latestReviews', 'mergeCommit',
  'mergeStateStatus', 'mergeable', 'mergedAt', 'mergedBy', 'number', 'publishedUrl', 'ref', 'reviewDecision', 'reviewRequests', 'reviewThreads', 'reviews', 'state',
  'statusCheckRollup', 'title', 'turn', 'unpublishedChanges', 'updatedAt', 'url', 'waiting',
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

/**
 * A subcommand's flags, and --repo and --help. --help throws its usage for `main` to print, before
 * the subcommand asks the server or does anything.
 */
function parse(args: string[], usage: string, options: Options): { values: Record<string, any>; positionals: string[] } {
  // gh prints the available fields for a bare `--json`; parseArgs would demand a value.
  const fixed = args.map((a, i) => (a === '--json' && (i === args.length - 1 || args[i + 1].startsWith('-')) ? '--json=' : a));
  let parsed;
  try {
    parsed = parseArgs({
      args: fixed,
      options: { ...options, repo: { type: 'string', short: 'R' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
  if (parsed.values.help) throw new Help(`${usage}\nINHERITED FLAGS\n  -R, --repo [HOST/]OWNER/REPO   Select another repository\n`);
  return parsed;
}

/** How subcommands that take one pull request name it; without it, the one for the current branch. */
const PULL = '[<s-number> | <url> | <branch>]';

function readBody(v: { body?: string; 'body-file'?: string }): string | undefined {
  if (v['body-file'] !== undefined) {
    const f = v['body-file'];
    return f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8');
  }
  return v.body;
}

/** --web: in the browser, or in the desktop app while it runs and opens galley links. */
async function openWeb(client: Client, url: string): Promise<void> {
  const where = await openPage(client, url);
  err(`Opening ${url} in ${where === 'app' ? 'the galley app' : 'your browser'}.`);
}

interface Target {
  repo: RepoRef;
  number: number;
}

async function resolvePull(client: Client, cwd: string, repoFlag: string | undefined, arg: string | undefined): Promise<Target> {
  if (arg) {
    const url = arg.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/[sS]?(\d+)/);
    if (url) {
      const repo = { owner: url[1], name: url[2] };
      await client.checkoutOf(cwd, repo);
      return { repo, number: Number(url[3]) };
    }
    const n = stagedNumber(arg);
    if (n !== null) return { repo: await client.repoFor(cwd, repoFlag), number: n };
  }
  const repo = await client.repoFor(cwd, repoFlag);
  const branch = arg ?? currentBranch(cwd);
  if (!branch) throw new CliError('could not determine the current branch; pass a pull request, as in s4');
  const list = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=all&head=${encodeURIComponent(branch)}&fields=number,state`);
  const pick = list.find((p) => p.state !== 'CLOSED' && p.state !== 'MERGED') ?? list[0];
  if (!pick) throw new CliError(`no pull requests found for branch "${branch}"`);
  return { repo, number: pick.number };
}

/**
 * Text that shows comments, with the images uploaded to galley in them as absolute URLs, or
 * with `dir` (--download-images), as the files they were saved to: agents read image files,
 * not URLs. `found` is the number of images.
 */
async function withImageFiles(client: Client, dir: string | undefined, render: (images: ImageRef) => string): Promise<{ text: string; found: number }> {
  const found = new Set<string>();
  const text = render((path) => (found.add(path), client.base + path));
  if (dir === undefined || !found.size) return { text, found: found.size };
  mkdirSync(dir, { recursive: true });
  const saved = new Map<string, string>();
  for (const path of found) {
    // Named by their content, so a file already there is this image.
    const file = resolve(dir, basename(path));
    try {
      if (!existsSync(file)) {
        const res = await client.raw('GET', path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      saved.set(path, file);
    } catch (e) {
      err(`Could not download ${client.base}${path}: ${(e as Error).message}`);
    }
  }
  return { text: render((path) => saved.get(path) ?? client.base + path), found: found.size };
}

const pullPath = (t: Target) => `${repoPath(t.repo)}/pulls/${t.number}`;
/** A pull request in a message: owner/name s#4. */
const named = (t: Target) => `${t.repo.owner}/${t.repo.name} ${stagedRef(t.number)}`;
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

const CREATE_USAGE = `Stage a pull request for the current branch. Mirrors \`gh pr create\`.

USAGE
  galley pr create --title <title> [--body <text> | --body-file <file>] [flags]

FLAGS
  -t, --title <title>           The title
  -b, --body <text>             The description
  -F, --body-file <file>        Read the description from a file ("-" for stdin)
  -f, --fill                    Use commit info for the title and description
      --fill-first              Use the first commit's info for the title and description
      --fill-verbose            Use the commits' messages and bodies for the description
  -B, --base <branch>           The branch to merge into (default: the default branch)
  -H, --head <branch>           The branch to stage (default: the current branch)
  -d, --draft                   Stage it as a draft, which is published as a draft
  -r, --reviewer <name>[:<n>]   Have this reviewer agent review it, at most n times (codex:3).
                                Repeat for more. \`galley reviewers\` lists them
      --no-review               Have no reviewer agent review it
      --dry-run                 Say what would be staged, and stage nothing
  -w, --web                     Open it in the browser

Accepted for gh, with no effect: --assignee, --label, --milestone, --project, --template,
--recover and --no-maintainer-edit.
`;

async function create(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, CREATE_USAGE, {
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
  if (v.base) await sendBase(client, cwd, repo, v.base as string);
  await sendHead(client, cwd, repo, head.replace(/^[^:]+:/, ''));
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
  await setPushRemote(client, cwd, repo, head.replace(/^[^:]+:/, ''));
  for (const login of pr.ignored_reviewers ?? []) err(`Ignored reviewer ${login}: galley has no reviewer agent by that name for this repository.`);
  out(pr.html_url);
  err(whoReviews(pr.reviewer_agents));
  if (v.web) await openWeb(client, pr.html_url);
  err(c.gray(`Review happens in the browser. Run \`galley pr wait s${pr.number}\` to block until the reviewer agents or the user respond.`));
  return 0;
}

// --------------------------------------------------------------------- list

const LIST_USAGE = `List staged and published pull requests. Mirrors \`gh pr list\`.

USAGE
  galley pr list [flags]

FLAGS
  -s, --state <state>     open (staged or published, the default), staged, published, done,
                          merged, closed or all
  -L, --limit <n>         List at most n (default 30)
  -H, --head <branch>     Only those of this branch
  -B, --base <branch>     Only those into this branch
  -A, --author <login>    Only those by this author
  -d, --draft             Only drafts
  -w, --web               Open the list in the browser
      --json <fields>     Output JSON with these fields (a bare --json lists them)
  -q, --jq <expression>   Filter the JSON output with jq
`;

async function list(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, LIST_USAGE, {
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
    await openWeb(client, await client.url(`/${repo.owner}/${repo.name}`));
    return 0;
  }
  const state = String(v.state);
  // gh's open is staged and published here; the server says which states there are.
  const what = state === 'all' ? '' : state === 'open' ? 'staged or published ' : `${state} `;
  const fields = v.json !== undefined ? checkFields(String(v.json), GH_FIELDS) : ['number', 'title', 'headRefName', 'state', 'createdAt', 'isDraft', 'author'];
  const q = new URLSearchParams({ state, limit: String(v.limit), fields: [...new Set([...fields, 'isDraft', 'author', 'unpublishedChanges'])].join(',') });
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
    if (isTTY) err(`no ${what}pull requests match your search in ${repo.owner}/${repo.name}`);
    return 0;
  }
  if (isTTY) {
    out(`\nShowing ${pulls.length} of ${pulls.length} ${what}pull requests in ${repo.owner}/${repo.name}\n`);
    const w = Math.max(...pulls.map((p) => p.title.length));
    for (const p of pulls) {
      // A published pull request with an update not on GitHub yet shows as staged, as in the web UI.
      const published = (p.state === 'PUBLISHED' && !p.unpublishedChanges?.length) || p.state === 'MERGED';
      const num = p.state === 'CLOSED' ? c.red(stagedRef(p.number)) : published ? c.magenta(stagedRef(p.number)) : p.isDraft ? c.gray(stagedRef(p.number)) : c.blue(stagedRef(p.number));
      out(`${num}\t${p.title.padEnd(w)}  ${c.cyan(p.headRefName)}  ${c.gray(p.createdAt.slice(0, 10))}`);
    }
  } else {
    for (const p of pulls) out([stagedRef(p.number), p.title, p.headRefName, p.isDraft && p.state === 'STAGED' ? 'DRAFT' : p.state, p.createdAt].join('\t'));
  }
  return 0;
}

// --------------------------------------------------------------------- view

const VIEW_USAGE = `Show a staged pull request. Mirrors \`gh pr view\`.

USAGE
  galley pr view ${PULL} [flags]

FLAGS
  -c, --comments                Show the reviews, comments and review threads
      --download-images <dir>   Save its images as files in dir, and show their paths
  -w, --web                     Open it in the browser
      --json <fields>           Output JSON with these fields (a bare --json lists them)
  -q, --jq <expression>         Filter the JSON output with jq
`;

async function view(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, VIEW_USAGE, {
    ...JSON_OPTS,
    comments: { type: 'boolean', short: 'c' },
    web: { type: 'boolean', short: 'w' },
    'download-images': { type: 'string' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  await sendPull(client, cwd, t.repo, t.number);
  if (v.web) {
    await openWeb(client, await client.url(`/${t.repo.owner}/${t.repo.name}/pull/${t.number}`));
    return 0;
  }
  if (v.json !== undefined) {
    const fields = checkFields(String(v.json), GH_FIELDS);
    printJson(await client.get(ghPath(t, fields)), v.jq as string | undefined);
    return 0;
  }
  const pr = await client.get(ghPath(t, []) + (v.comments ? '?seen=1' : ''));
  const dir = v['download-images'] as string | undefined;
  const { text, found } = await withImageFiles(client, dir, (images) => (isTTY ? viewTTY(pr, images) : viewPlain(pr, images)) + (v.comments ? formatConversation(pr, images) : ''));
  process.stdout.write(text);
  if (found && dir === undefined) out(c.gray('Run again with --download-images <dir> to save the images as files.'));
  return 0;
}

// --------------------------------------------------------------------- diff

const DIFF_USAGE = `Show the changes of a staged pull request. Mirrors \`gh pr diff\`.

USAGE
  galley pr diff ${PULL} [flags]

FLAGS
      --color <when>   always, never or auto (default auto)
      --patch          Show them as patches, one per commit
      --name-only      Show only the names of the changed files
  -w, --web            Open them in the browser
`;

async function diff(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, DIFF_USAGE, {
    color: { type: 'string', default: 'auto' },
    patch: { type: 'boolean' },
    'name-only': { type: 'boolean' },
    web: { type: 'boolean', short: 'w' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  if (v.web) {
    await openWeb(client, await client.url(`/${t.repo.owner}/${t.repo.name}/pull/${t.number}/files`));
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

const EDIT_USAGE = `Change the title, description or base of a staged pull request. Mirrors \`gh pr edit\`.

USAGE
  galley pr edit ${PULL} [flags]

FLAGS
  -t, --title <title>      The new title
  -b, --body <text>        The new description
  -F, --body-file <file>   Read the new description from a file ("-" for stdin)
  -B, --base <branch>      The new base branch

Accepted for gh, with no effect: the flags for assignees, labels, projects, milestones and
reviewers.
`;

async function edit(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, EDIT_USAGE, {
    ...IGNORED,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    base: { type: 'string', short: 'B' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  await sendPull(client, cwd, t.repo, t.number);
  const patch: Record<string, unknown> = {};
  if (v.title !== undefined) patch.title = v.title;
  const body = readBody(v as any);
  if (body !== undefined) patch.body = body;
  if (v.base !== undefined) patch.base = v.base;
  if (Object.keys(patch).length === 0) {
    if (Object.keys(v).some((k) => k in IGNORED)) {
      err('assignees, labels, reviewers, projects and milestones do not exist in galley; nothing to change');
      return 0;
    }
    throw new CliError('specify at least one of --title, --body, --body-file or --base');
  }
  const pr = await client.json('PATCH', pullPath(t), patch);
  out(pr.html_url);
  return 0;
}

// ------------------------------------------------------------------ comment

const COMMENT_USAGE = `Comment on a staged pull request, or reply in a review thread. Mirrors \`gh pr comment\`.

USAGE
  galley pr comment ${PULL} [flags]

FLAGS
  -b, --body <text>         The comment
  -F, --body-file <file>    Read the comment from a file ("-" for stdin)
      --reply-to <thread>   Reply in this review thread (its id, as \`pr wait\` shows it)
      --resolve             With --reply-to: resolve the thread after replying
      --edit-last           Edit your last comment
      --create-if-none      With --edit-last: comment if you have not yet
      --delete-last         Delete your last comment
`;

async function comment(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, COMMENT_USAGE, {
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
  await sendPull(client, cwd, t.repo, t.number);
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

const REVIEW_USAGE = `Review a staged pull request. Mirrors \`gh pr review\`.

USAGE
  galley pr review ${PULL} [flags]

FLAGS
  -a, --approve            Approve it
  -r, --request-changes    Request changes
  -c, --comment            Comment, without approving or requesting changes
  -b, --body <text>        The review's text
  -F, --body-file <file>   Read the review's text from a file ("-" for stdin)
`;

async function review(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, REVIEW_USAGE, {
    approve: { type: 'boolean', short: 'a' },
    comment: { type: 'boolean', short: 'c' },
    'request-changes': { type: 'boolean', short: 'r' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  await sendPull(client, cwd, t.repo, t.number);
  const event = v.approve ? 'APPROVE' : v['request-changes'] ? 'REQUEST_CHANGES' : v.comment ? 'COMMENT' : null;
  if (!event) throw new CliError('--approve, --request-changes, or --comment required when not running interactively');
  const body = readBody(v as any) ?? '';
  if (event !== 'APPROVE' && !body.trim()) throw new CliError(`body cannot be blank for ${event === 'COMMENT' ? 'comment' : 'request changes'} review`);
  await client.json('POST', `${pullPath(t)}/reviews`, { event, body });
  const verb = { APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes to', COMMENT: 'Reviewed' }[event];
  err(`✓ ${verb} pull request ${named(t)}`);
  return 0;
}

// ------------------------------------------------------------ state changes

const CLOSE_USAGE = `Close a staged pull request. Mirrors \`gh pr close\`.

USAGE
  galley pr close ${PULL} [flags]

FLAGS
  -c, --comment <text>   Leave a comment first
  -d, --delete-branch    Accepted for gh; galley never deletes branches
`;

const REOPEN_USAGE = `Reopen a closed pull request. Mirrors \`gh pr reopen\`.

USAGE
  galley pr reopen ${PULL} [flags]

FLAGS
  -c, --comment <text>   Leave a comment first
`;

async function setState(client: Client, cwd: string, args: string[], state: 'open' | 'closed'): Promise<number> {
  const usage = state === 'closed' ? CLOSE_USAGE : REOPEN_USAGE;
  const { values: v, positionals } = parse(args, usage, { comment: { type: 'string', short: 'c' }, 'delete-branch': { type: 'boolean', short: 'd' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  if (v.comment) await client.json('POST', `${repoPath(t.repo)}/issues/${t.number}/comments`, { body: v.comment });
  const pr = await client.json('PATCH', pullPath(t), { state });
  if (state === 'closed') await clearPushRemote(client, cwd, t.repo, pr.head.ref);
  else await setPushRemote(client, cwd, t.repo, pr.head.ref);
  err(`✓ ${state === 'closed' ? 'Closed' : 'Reopened'} pull request ${named(t)} (${pr.title})`);
  if (v['delete-branch']) err('The branch was left alone; galley never deletes branches.');
  return 0;
}

const READY_USAGE = `Mark a staged pull request as ready for review, which decides whether it is published as a
draft. Mirrors \`gh pr ready\`.

USAGE
  galley pr ready ${PULL} [flags]

FLAGS
      --undo   Mark it as a draft instead
`;

async function ready(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, READY_USAGE, { undo: { type: 'boolean' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  await sendPull(client, cwd, t.repo, t.number);
  await client.json('PATCH', pullPath(t), { draft: !!v.undo });
  err(`✓ Pull request ${named(t)} is ${v.undo ? 'converted to "draft"' : 'marked as "ready for review"'}`);
  return 0;
}

const CHECKOUT_USAGE = `Check out the head branch of a staged pull request. Mirrors \`gh pr checkout\`.

USAGE
  galley pr checkout ${PULL} [flags]

FLAGS
      --detach   Check out its head commit, detached
  -f, --force    Check out even if local changes are lost

Accepted for gh, with no effect: --branch.
`;

async function checkout(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, CHECKOUT_USAGE, { branch: { type: 'string', short: 'b' }, detach: { type: 'boolean' }, force: { type: 'boolean', short: 'f' } });
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const pr = await client.get(ghPath(t, ['headRefName', 'headRefOid']));
  const target = v.detach ? pr.headRefOid : pr.headRefName;
  // From galley's clone, the head when it is not here, and the branch when there is none.
  const here = await fetchHead(client, cwd, t.repo, pr.headRefName, pr.headRefOid, { detach: !!v.detach });
  try {
    process.stdout.write(git(cwd, ['checkout', ...(v.force ? ['--force'] : []), target]));
    if (here === 'behind') git(cwd, ['merge', '--ff-only', '--quiet', pr.headRefOid]);
  } catch (e) {
    throw new CliError(String((e as { stderr?: string }).stderr ?? e).trim());
  }
  err(`Switched to ${v.detach ? 'commit' : 'branch'} '${target}'`);
  if (here === 'behind') err(`Fast-forwarded it to galley's ${pr.headRefOid.slice(0, 7)}.`);
  if (here === 'differs') err(`galley has it at ${pr.headRefOid.slice(0, 7)}, which your ${target} does not have.`);
  return 0;
}

const STATUS_USAGE = `Show the pull request for the current branch, and the staged and published ones. Mirrors
\`gh pr status\`.

USAGE
  galley pr status [flags]

FLAGS
      --json <fields>     Output JSON with these fields (a bare --json lists them)
  -q, --jq <expression>   Filter the JSON output with jq
`;

async function status(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v } = parse(args, STATUS_USAGE, { ...JSON_OPTS });
  const repo = await client.repoFor(cwd, v.repo as string | undefined);
  const branch = currentBranch(cwd);
  const pulls = await client.get<any[]>(`${repoPath(repo)}/gh/pulls?state=open&fields=number,title,headRefName,state,isDraft,reviewDecision,url,waiting,turn,unpublishedChanges`);
  if (v.json !== undefined) {
    const fields = checkFields(String(v.json), GH_FIELDS);
    const pick = (p: any) => Object.fromEntries(fields.map((f) => [f, p[f]]));
    printJson({ currentBranch: pulls.filter((p) => p.headRefName === branch).map(pick)[0] ?? null, open: pulls.map(pick) }, v.jq as string | undefined);
    return 0;
  }
  out(`\nRelevant pull requests in ${repo.owner}/${repo.name}\n`);
  out(c.bold('Current branch'));
  const mine = pulls.find((p) => p.headRefName === branch);
  out(mine ? `  ${stagedRef(mine.number)}  ${mine.title} [${mine.headRefName}]\n    - ${mine.reviewDecision.toLowerCase().replace('_', ' ')}${mine.turn ? `\n    - ${turnLine(mine.turn)}` : ''}` : `  There is no pull request associated with [${branch}]`);
  out('\n' + c.bold('Staged and published pull requests'));
  if (!pulls.length) out('  You have no staged or published pull requests');
  const label = (p: any) => (p.state === 'PUBLISHED' ? (p.unpublishedChanges?.length ? ' (update not published)' : ' (published)') : '');
  for (const p of pulls) out(`  ${stagedRef(p.number)}  ${p.title} [${p.headRefName}]${label(p)}`);
  out('');
  return 0;
}

// -------------------------------------------------------------- the loop

const PUBLISH_USAGE = `Push the branch and open the pull request on GitHub, or update it there. The user may
publish, and so may the agent that staged it.

USAGE
  galley pr publish ${PULL} [flags]

FLAGS
  -d, --draft                 Open it on GitHub as a draft (default: as it is staged)
      --sign                  Sign the commits as you (default: as the last publish did, or as
                              commit.gpgsign says)
      --no-sign               Push the commits as they are
  -f, --force                 Force-push, with a lease, over commits on GitHub that this push
                              replaces (the default)
      --no-force              Refuse to publish when it would have to force-push
      --during-review         Publish while reviewer agents review it, cancelling their reviews
      --during-conflict       Publish although the branch conflicts with its base
      --auto                  Publish once the reviewer agents are done and the author has answered
                              them, like \`gh pr merge --auto\`
      --auto-merge [method]   Turn on auto-merge on GitHub once it is published: squash, merge or
                              rebase (default: the merge method in galley's settings)
      --disable-auto          Turn auto-publish off
`;

const MERGE_METHODS = ['squash', 'merge', 'rebase'];

async function publish(client: Client, cwd: string, args: string[]): Promise<number> {
  // A bare --auto-merge takes the merge method in settings; parseArgs would take what follows as one.
  const fixed = args.map((a, i) => (a === '--auto-merge' && !MERGE_METHODS.includes(args[i + 1]) ? '--auto-merge=' : a));
  const { values: v, positionals } = parse(fixed, PUBLISH_USAGE, {
    draft: { type: 'boolean', short: 'd' },
    force: { type: 'boolean', short: 'f' },
    'no-force': { type: 'boolean' },
    sign: { type: 'boolean' },
    'no-sign': { type: 'boolean' },
    'during-review': { type: 'boolean' },
    'during-conflict': { type: 'boolean' },
    auto: { type: 'boolean' },
    'disable-auto': { type: 'boolean' },
    'auto-merge': { type: 'string' },
  });
  const method = v['auto-merge'] as string | undefined;
  if (method && !MERGE_METHODS.includes(method)) throw new CliError(`--auto-merge takes ${MERGE_METHODS.join(', ')}, not ${method}`);
  if (v.force && v['no-force']) throw new CliError('specify only one of --force or --no-force');
  if (v.auto && v['disable-auto']) throw new CliError('specify only one of --auto or --disable-auto');
  if (method !== undefined && v['disable-auto']) throw new CliError('--auto-merge goes with publishing; --disable-auto only turns auto-publish off');
  if (v.auto && v['during-review']) throw new CliError('--during-review publishes now; --auto waits for the reviews instead');
  if (v.auto && v['during-conflict']) throw new CliError('--during-conflict publishes now; --auto waits for a head that merges cleanly instead');
  const t = await resolvePull(client, cwd, v.repo as string | undefined, positionals[0]);
  const name = named(t);
  const sign = v.sign ? true : v['no-sign'] ? false : undefined;
  // Like `gh pr merge --auto`: publish once the reviewer agents are done and the author has answered them.
  if (v['disable-auto']) {
    await client.json('DELETE', `${pullPath(t)}/auto-publish`);
    err(`✓ Auto-publish disabled for pull request ${name}`);
    return 0;
  }
  // The author publishes what it has, as auto-publish publishes what it waits with.
  await sendPull(client, cwd, t.repo, t.number, { strict: true });
  const autoMerge = method !== undefined;
  // Force-push when it has to, as the publish box offers: with a lease, over only what it replaces.
  const force = !v['no-force'];
  // Without a method, the server's setting.
  const options = { draft: v.draft ? true : undefined, force, sign, auto_merge: autoMerge, merge_method: method || undefined };
  if (v.auto) {
    await client.json('PUT', `${pullPath(t)}/auto-publish`, options);
    err(`✓ Pull request ${name} will be published when the reviewer agents are done and the author has answered them${autoMerge ? ', with auto-merge on GitHub' : ''}`);
    return 0;
  }
  err(`Publishing ${name} to GitHub…`);
  const acknowledged = (['during-review', 'during-conflict'] as const).filter((flag) => v[flag]);
  const body = { ...options, during_review: !!v['during-review'], during_conflict: !!v['during-conflict'] };
  const pr = await client.json('POST', `${pullPath(t)}/publish`, body).catch(async (e) => {
    // A reviewer is at work, or the head conflicts with its base: the server asks whether to publish
    // anyway, and lists what the request must acknowledge (during_review, during_conflict).
    if (e instanceof ApiError && e.status === 428) {
      let asked: string[] = ['during_review'];
      try {
        asked = JSON.parse(e.body).acknowledge ?? asked;
      } catch {}
      const flags = new Set([...acknowledged, ...asked.map((field) => field.replace('_', '-'))]);
      throw new CliError(`${e.message}\nRun \`galley pr publish s${t.number} ${[...flags].map((f) => `--${f}`).join(' ')}\` to publish anyway.`);
    }
    // Signing as the user failed (`signing`, an extension), often a prompt nobody was there to answer.
    let signing: { transient: boolean } | undefined;
    try {
      signing = e instanceof ApiError ? JSON.parse(e.body).signing : undefined;
    } catch {}
    if (signing) {
      // This publish again, with its options, for the same pull request: as given, a number as s4, and the repository given.
      const ref = positionals[0] === undefined || stagedNumber(positionals[0]) !== null ? `s${t.number}` : positionals[0];
      const command = (...flags: string[]) => ['galley pr publish', ref, ...(v.repo ? ['-R', v.repo] : []), ...flags].join(' ');
      const same = [v.draft ? '--draft' : '', v.sign ? '--sign' : '', v['no-force'] ? '--no-force' : '', autoMerge ? `--auto-merge${method ? ` ${method}` : ''}` : ''].filter(Boolean);
      // Auto-publish is for the first publish. An update is left to the user: the author's next wait
      // pushes the head as the last publish did, not with this one's options.
      const published = !!(await client.get<any>(pullPath(t)).catch(() => null))?.published_url;
      const again = published
        ? `Tell the user, and run \`${command(...same, ...acknowledged.map((f) => `--${f}`))}\` again when they can answer the signing prompt.`
        : `Turn on auto-publish with \`${command('--auto', ...same)}\` and wait: it publishes once it can, and tries signing again over the next hour. Or tell the user.`;
      throw new CliError(`${e.message}\nNothing was published. ${signing.transient ? again : 'Trying again fails the same way: tell the user.'}`);
    }
    throw e;
  });
  out(pr.published_url);
  // Publishing worked either way; auto-merge comes after it.
  const merge = pr.auto_merge_result;
  const via = merge && merge.merge_method !== 'merge' ? ` via ${merge.merge_method}` : '';
  if (merge?.state === 'enabled') err(`✓ ${pr.published_url} will be automatically merged${via} when all requirements are met`);
  if (merge?.state === 'merged') err(`✓ Merged ${pr.published_url}${via} right away: GitHub had nothing left to wait for`);
  if (merge?.state === 'requested') err(`✓ Requested auto-merge${via} for ${pr.published_url}; whether GitHub merged it at once could not be checked`);
  if (merge?.state === 'failed') {
    err(`Published, but turning on auto-merge failed:\n${merge.error}`);
    return 1;
  }
  return 0;
}

/**
 * "The approval from laat came before this review from codex.": an approval that still holds
 * was given before a new review from someone else, so it does not take that review into account.
 */
function approvedBefore(pr: any, fresh: Set<number>): string[] {
  if (pr.reviewDecision !== 'APPROVED') return [];
  const decisions = new Map<string, any>();
  // A reviewer agent's approval is its own, not part of the decision (byReviewerAgent, a galley extension).
  for (const rv of pr.reviews) if (!rv.byReviewerAgent && (rv.state === 'APPROVED' || rv.state === 'CHANGES_REQUESTED')) decisions.set(rv.author.login, rv);
  const lines: string[] = [];
  for (const approval of [...decisions.values()].filter((rv) => rv.state === 'APPROVED')) {
    const later = pr.reviews.filter((rv: any) => fresh.has(rv.databaseId) && rv.author.login !== approval.author.login && rv.submittedAt > approval.submittedAt);
    const who = [...new Set(later.map((rv: any) => rv.author.login))];
    if (who.length) lines.push(`The approval from ${approval.author.login} came before this review from ${who.join(' and ')}.`);
  }
  return lines;
}

/**
 * The server is down or restarting, or out of reach for now: worth asking again shortly. While it
 * starts it answers 503, and a proxy in front of it (`tailscale serve`) 502 while it is down. An
 * error of galley's own with such a status says what went wrong, and asking again would not help.
 */
function transient(e: unknown): boolean {
  if (e instanceof ApiError) return GATEWAY_DOWN.includes(e.status) && !galleyError(e);
  return (e instanceof TypeError && e.message === 'fetch failed') || (e instanceof CliError && /not running|does not answer/.test(e.message));
}

/** Whether the error is galley's own: JSON with its message and its status, as GitHub's errors are. */
function galleyError(e: ApiError): boolean {
  try {
    return typeof JSON.parse(e.body).status === 'string';
  } catch {
    return false;
  }
}

const WAIT_USAGE = `Block until a staged pull request has news, and print it: feedback, the reviewer agents done
with the latest commit, a conflict with its base, or a publish, merge or close. Once it is
published, each commit you wait with is pushed to GitHub, and your edits of the title and
description are published. Given several, whichever has news first.

USAGE
  galley pr wait ${PULL}... [flags]

FLAGS
      --timeout <duration>      Stop waiting after this long (90, 30s, 10m, 1h), with exit code 124
      --download-images <dir>   Save the feedback's images as files in dir, and show their paths
`;

async function wait(client: Client, cwd: string, args: string[]): Promise<number> {
  const { values: v, positionals } = parse(args, WAIT_USAGE, { timeout: { type: 'string' }, 'download-images': { type: 'string' } });
  const repoFlag = v.repo as string | undefined;
  // Several pull requests, for an agent that orchestrates others: whichever has news first.
  const targets = positionals.length
    ? await Promise.all(positionals.map((arg) => resolvePull(client, cwd, repoFlag, arg)))
    : [await resolvePull(client, cwd, repoFlag, undefined)];
  const names = targets.map(named).join(', ');
  // To wait again: each as given, a number as s4, which looks like no GitHub number and no shell pattern.
  const again = (i: number) => (positionals[i] === undefined || stagedNumber(positionals[i]) !== null ? `s${targets[i].number}` : positionals[i]);
  const all = targets.map((_, i) => again(i)).join(' ');
  const deadline = v.timeout ? Date.now() + parseDuration(String(v.timeout)) : Infinity;
  // What the author committed, before it waits: galley reviews and pushes what it has.
  for (const t of targets) await sendPull(client, cwd, t.repo, t.number, { strict: true });
  if (isTTY) err(`Waiting for feedback on ${names}…`);
  while (true) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      err(`No feedback yet on ${names} (timed out). Run \`galley pr wait ${all}\` again to keep waiting.`);
      // Findings the author has not answered hold up the reviewer agents, which no wait would say.
      for (const t of targets) {
        const pull = await client.get<any>(pullPath(t)).catch(() => null);
        const which = targets.length > 1 ? `${named(t)}: ` : '';
        const reasons = pull?.turn.reasons ?? [];
        for (const r of reasons) {
          if (r.state !== 'findings') continue;
          // Not shown to the author yet: the wait holds the review while other reviewer agents are
          // at work, to hand their reviews over together, so there is nothing to answer yet.
          if (r.unseen) {
            const toCome = reasons.filter((o: any) => o.to_review).map((o: any) => o.text);
            const held = toCome.length ? `is held until the other reviewer agents are done (${toCome.join('; ')}), to come with theirs` : 'comes with the next wait';
            err(`${which}${r.text}. Its review ${held}: nothing to answer until then.`);
            continue;
          }
          const answer = r.description ? 'edit the title or description, or reword the commits, as it asks; a reply does not answer it' : 'reply to or resolve each of its threads, or push a commit';
          err(`${which}${r.text}: ${answer}. The reviewer agents are not done with it until then.`);
        }
      }
      return 124;
    }
    const first = await firstNews(client, targets, Math.min(left, 240));
    if (!first) continue;
    if ('error' in first) {
      // The server went away (refused) or restarted under us (the open request was dropped):
      // give it a moment and keep waiting.
      if (transient(first.error)) {
        await new Promise((res) => setTimeout(res, 3000));
        continue;
      }
      throw first.error;
    }
    const { t, r } = first;
    const others = targets.flatMap((other, i) => (other === t ? [] : [again(i)]));
    const pr = r.pr;
    // What galley fetched from GitHub for the author to rebase onto, fetched into the checkout too
    // (from galley's clone), and named as it is there, galley/<branch>: the base the head conflicts
    // with, and the branch on GitHub after a push GitHub refused. So does a base staged in galley (stacked).
    if (pr.baseConflicts?.conflicting && [`origin/${pr.baseRefName}`, pr.baseRefName].includes(pr.baseConflicts.ref)) {
      const staged = pr.baseConflicts.ref === pr.baseRefName;
      pr.baseConflicts.ref = (await fetchBack(client, cwd, t.repo, pr.baseRefName, pr.baseConflicts.oid, { staged })) ?? pr.baseConflicts.ref;
    }
    const onGithub = r.status === 'push_failed' && r.push.fetched?.sha && r.push.fetched.ref === `origin/${pr.headRefName}` ? r.push.fetched : null;
    if (onGithub) {
      const there = onGithub.ref;
      onGithub.ref = (await fetchBack(client, cwd, t.repo, pr.headRefName, onGithub.sha)) ?? there;
      // A refusal for commits the rewrite removed names it as galley's clone has it.
      if (r.push.error) r.push.error = r.push.error.replace(`fetched it into ${there} at`, `fetched it into ${onGithub.ref} at`);
    }
    // The server's link, which starts with its public URL.
    const url = pr.url;
    // Waiting on several: say which one this is about.
    if (others.length) out(`${c.bold(named(t))} (${pr.headRefName}): ${url}\n`);
    const fresh = {
      reviews: new Set<number>(r.reviews),
      comments: new Set<number>(r.comments.filter((cm: any) => cm.kind === 'issue').map((cm: any) => cm.id)),
      replies: new Set<number>(r.comments.filter((cm: any) => cm.kind === 'review').map((cm: any) => cm.id)),
    };
    const dir = v['download-images'] as string | undefined;
    const { text, found } = await withImageFiles(client, dir, (images) => conversationItems(pr, { ...fresh, images }).map((i) => i.text).join('\n\n'));
    if (text) {
      out(`New feedback on ${url} (review decision: ${pr.reviewDecision})\n`);
      out(text + '\n');
    }
    if (found && dir === undefined) out(c.gray(`To read the images, save them as files with \`galley pr view s${t.number} --comments --download-images <dir>\`.`));
    for (const line of approvedBefore(pr, new Set(r.reviews))) out(line);
    // The head conflicts with its base: the author's to rebase, with whatever else there is.
    const conflicts = conflictsText(pr);
    if (conflicts) out(`This branch conflicts ${conflicts}`);
    // Said once per commit: the agents' part of the review is over, so the reviewer's starts.
    if (r.status === 'agents_done') {
      const { sha, reviewers } = r.agents_done;
      const done = reviewers.length ? `The reviewer agents are done with ${sha.slice(0, 7)} (${reviewers.join('; ')})` : `No reviewer agent reviews ${sha.slice(0, 7)}`;
      out(`${done}; ask the user to review it: ${url}`);
      out(c.gray(`Then run \`galley pr wait ${all}\` to wait for the review.`));
    }
    // Before the confirmation below, like the feedback: once confirmed, no wait says it again.
    if (r.status === 'published') out(`Published to GitHub: ${r.published_url}`);
    // Published, the commit it waited with went to GitHub, or could not.
    if (r.status === 'pushed') out(`${r.push.force ? 'Force-pushed' : 'Pushed'} ${r.push.source.slice(0, 7)} to GitHub: ${r.published_url}`);
    if (r.status === 'push_failed') out(`Could not push ${r.push.source.slice(0, 7)} to GitHub: ${r.push.error}`);
    // And its edits of the title and description, which went first (a server older than the CLI does not say).
    if (r.edit) out(editLine(r.edit, r.published_url));
    const unresolved = pr.reviewThreads.filter((th: any) => !th.isResolved);
    // Reviewers still at work will be heard from: their review wakes the next wait.
    const atWork = reviewersAtWork(pr);
    const getIt = `run \`galley pr wait ${all}\` to get ${atWork.length > 1 ? 'their reviews' : 'its review'}.`;
    // Feedback that leaves the author nothing to address, as the server says (asks_author): what the
    // reviewer agents still to review the head are at ("claude-review is about to review 8c64534"),
    // none when they are all done with it. A server older than the CLI does not say.
    const toCome: string[] | null = r.status === 'feedback' && r.asks_author === false ? (r.still_to_review ?? []) : null;
    // Shown, so now it counts as seen. If this does not get through, the next wait shows it again.
    for (let attempt = 1; ; attempt++) {
      try {
        await client.json('PUT', `${pullPath(t)}/seen`, { at: r.seen_at, agents_done: r.agents_done?.sha, conflicts: conflicts ? (r.conflicts ?? undefined) : undefined });
        break;
      } catch (e) {
        if (!transient(e) || attempt === 10) {
          err('Could not confirm the feedback as seen; the next `galley pr wait` will show it again.');
          break;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    // Done with, here or on GitHub: a plain `git push` of the branch no longer goes to galley, and
    // every wait on it says so, so leave it out of the next one.
    if (r.status === 'merged' || r.status === 'closed_on_github' || r.status === 'closed') await clearPushRemote(client, cwd, t.repo, pr.headRefName);
    const rest = others.length ? ` Wait on the others with \`galley pr wait ${others.join(' ')}\`.` : '';
    if (r.status === 'merged') {
      const sha = pr.mergeCommit?.oid ? ` as ${String(pr.mergeCommit.oid).slice(0, 7)}` : '';
      out(`Merged on GitHub${sha}${r.github_closed_by ? ` by ${r.github_closed_by}` : ''}: ${r.published_url}`);
      // Commits GitHub never got (a server older than the CLI does not say): only the branch has them.
      const left: { head: string; deleted: boolean; commits: { sha: string; parents: string[]; message: string }[] } | null = r.left_out ?? null;
      if (left) {
        const { commits } = left;
        const [branch, base, them] = [pr.headRefName, pr.baseRefName, commits.length === 1 ? 'it' : 'them'];
        out(`GitHub merged it without ${commits.length === 1 ? 'this commit' : `these ${commits.length} commits`} of ${branch}, which it never got:`);
        for (const cm of commits) out(`  ${cm.sha.slice(0, 7)} ${cm.message.split('\n')[0]}`);
        // One line of commits, each on the one before: a rebase carries over exactly these. Not a
        // merge, whose changes a rebase would drop.
        const line = commits.every((cm, i) => cm.parents.length === 1 && (i === 0 || cm.parents[0] === commits[i - 1].sha));
        // galley's clone keeps the branches sent to it: whether this one is gone is the checkout's to say.
        const here = await hasBranch(client, cwd, t.repo, branch);
        const deleted = here === null ? left.deleted : !here;
        const restore = deleted ? `The branch ${branch} is gone here; bring it back with \`git branch ${branch} ${left.head}\`. ` : '';
        const others = `rebase the other open pull requests that touch the same files.${rest}`;
        out(
          c.gray(
            line
              ? `${restore}Next: keep the branch ${branch} and tell the user. Fast-forward your ${base} to the merge, move ${them} onto it with ` +
                  `\`git rebase --onto ${base} ${commits[0].parents[0].slice(0, 7)} ${branch}\`, stage ${them} as a new pull request, and ${others}`
              : `${restore}Next: keep the branch ${branch}, tell the user, and ask how to stage ${them} as a new pull request: a rebase would not carry ` +
                  `${them} over as ${commits.length === 1 ? 'it is' : 'they are'} (a merge, say). Fast-forward your ${base} to the merge, and ${others}`,
          ),
        );
        return 0;
      }
      out(
        c.gray(
          `Next: fast-forward your ${pr.baseRefName} to the merge, remove the worktree and the branch ${pr.headRefName}, ` +
            `and rebase the other open pull requests that touch the same files.${rest}`,
        ),
      );
      return 0;
    }
    if (r.status === 'closed_on_github') {
      out(`Closed on GitHub without merging${r.github_closed_by ? ` by ${r.github_closed_by}` : ''}: ${r.published_url}`);
      if (rest) out(c.gray(rest.trim()));
      return 0;
    }
    // Published, the wait after the rebase pushes it, force-pushed over the commits it replaces;
    // after a push GitHub refused, what is pushed next is said with the refusal.
    const pushes = pr.state === 'PUBLISHED' && r.status !== 'push_failed' ? ': it force-pushes the rebase to GitHub.' : '.';
    const rebase = conflicts ? `Rebase onto ${pr.baseConflicts.ref}, resolve the conflicts and run the tests, then run \`galley pr wait ${all}\` again${pushes}` : null;
    if (r.status === 'published') {
      if (atWork.length) out(`Published while ${stillReviewing(pr)}; ${getIt}`);
      // Whoever published it: the user, the author, or auto-publish that either turned on.
      else out(text ? 'Published, but read the feedback above: the user may still want changes.' : 'Its review in galley is over.');
      // Published with a conflict (a second click): the rebase is left.
      out(c.gray(rebase ?? `Run \`galley pr wait ${all}\` again to hear when it is merged or closed on GitHub, or gets new feedback.`));
      out(c.gray(PUSHES));
      return 0;
    }
    if (r.status === 'push_failed') {
      // Refused for commits added on GitHub, galley fetched them where the author can rebase onto them.
      const fetched = r.push.fetched?.sha ? r.push.fetched : null;
      const bringIn = fetched ? `galley fetched the branch on GitHub into ${fetched.ref}: rebase onto it` : `fetch ${pr.headRefName} from origin and rebase onto it`;
      // Rewritten there, only the commits made since galley pushed last go on top: the ones before may be what the rewrite removed.
      const since = fetched?.since?.slice(0, 7);
      out(
        c.gray(
          'Nothing on GitHub was overwritten, and this commit is not tried again. Do not push or force-push to GitHub yourself: the user has been told, and decides. ' +
            // Signing failed for good: nothing for the author to change, and its next commit is pushed as usual.
            (r.push.signing
              ? 'Signing it as the user failed; the user can publish it by hand. Your next commit is pushed when you wait.'
              : fetched?.rewritten
                ? `The branch on GitHub was rewritten there, and galley fetched it into ${fetched.ref}. Rebase the commits you made ${since ? `after ${since}` : 'since galley last pushed'} onto it, leaving out the ones before` +
                  (since ? ` (\`git rebase --onto ${fetched.ref} ${since}\`)` : '') +
                  `, and wait: galley pushes them on top of it. Do not merge ${fetched.ref} in: a commit that brings back what the rewrite removed is refused.`
                : `A later commit is pushed when you wait if GitHub takes it: one that has the commits added there (${bringIn}), or leaves out what GitHub declined.`),
        ),
      );
    }
    if ((r.status === 'pushed' || r.status === 'push_failed' || r.status === 'edited' || r.status === 'edit_failed') && !text) {
      // A conflict told with it (it is marked as told above) is the author's to rebase.
      out(c.gray(rebase ?? `Run \`galley pr wait ${all}\` again to hear when it is merged or closed on GitHub, or gets new feedback.`));
      if (rebase && r.status === 'pushed') out(c.gray(PUSHES));
      return 0;
    }
    if (r.status === 'closed') {
      out(`The user closed ${url} without publishing it.`);
      if (rest) out(c.gray(rest.trim()));
      return 0;
    }
    if (r.status === 'agents_done') return 0;
    if (r.status === 'conflicts') {
      // Gone again before it could be shown (the base moved once more): nothing to say, so keep waiting.
      if (!rebase) continue;
      out(c.gray(rebase));
      if (pr.state === 'PUBLISHED') out(c.gray(PUSHES));
      return 0;
    }
    if (unresolved.length) out(`Unresolved threads: ${unresolved.map((th: any) => th.databaseId).join(', ')}`);
    for (const line of atWork) out(`${line}.`);
    // Approved, it waits for the user to publish it. Published, the approval is the publish or came
    // before it (Service.withPublishes), and what came since is to address.
    const approved = pr.reviewDecision === 'APPROVED' && pr.state !== 'PUBLISHED' && !unresolved.length;
    if (approved && atWork.length) {
      out(c.gray(`${stillReviewing(pr)}; ${getIt}`));
    } else if (approved) {
      // Approved, but it conflicts with its base: the rebase is left.
      out(c.gray(rebase ?? `Approved with nothing left open. Run \`galley pr wait ${all}\` to wait until the user publishes it.`));
    } else if (toCome) {
      const still = toCome.length ? ` for the ${toCome.length > 1 ? 'reviews' : 'review'} still to come (${toCome.join('; ')})` : '';
      out(c.gray(rebase ?? `Nothing to address. Run \`galley pr wait ${all}\` again${still}.`));
    } else {
      out(
        c.gray(
          `Address the feedback. Reply to each thread and resolve the ones you fixed with ` +
            `\`galley pr comment s${t.number} --reply-to <thread> --resolve -b "…"\` ` +
            `(leave out --resolve to keep a thread open for the user), then run \`galley pr wait ${all}\` again.`,
        ),
      );
    }
    if (pr.state === 'PUBLISHED') out(c.gray(PUSHES));
    // The user or the author approved in advance; publishing happens while the author waits.
    const auto = pr.autoPublishRequest;
    if (auto) {
      out(
        c.gray(
          `Auto-publish is on (${auto.enabledBy.login} turned it on): galley publishes this pull request once the reviewer agents are done with ` +
            `your latest commit and you are waiting in \`galley pr wait ${all}\` with the feedback addressed` +
            `${auto.autoMerge ? ', and turns on auto-merge on GitHub' : ''}.`,
        ),
      );
    }
    return 0;
  }
}

/**
 * What came of publishing the author's edits of the title and description when it waited, in one
 * line: what GitHub got, and what it did not and why.
 */
function editLine(e: { published: string[]; edited_on_github: string[]; failed: string[]; error?: string }, url: string): string {
  const and = (fields: string[]) => ['title', 'description'].filter((f) => fields.includes(f)).join(' and ');
  const left = [...e.edited_on_github, ...e.failed];
  if (!left.length) return `Published the ${and(e.published)} to GitHub: ${url}`;
  const it = (fields: string[]) => (fields.length > 1 ? 'them' : 'it');
  const why = [e.edited_on_github.length ? `someone edited the ${and(e.edited_on_github)} on GitHub since galley published ${it(e.edited_on_github)}` : null, e.failed.length ? e.error : null];
  const what = e.published.length ? `Published the ${and(e.published)} to GitHub, but not the ${and(left)}` : `Could not publish the ${and(left)} to GitHub`;
  return `${what}: ${why.filter(Boolean).join('; ')}. Nothing on GitHub was overwritten. The user has been told, and decides; do not edit ${it(left)} on GitHub yourself.`;
}

/** What the author does once its pull request is published. */
const PUSHES = 'It is published: commit and wait, and galley pushes each commit you wait with to GitHub. Never push to GitHub yourself.';

/**
 * One long poll per pull request. The first answer with news (or an error) wins, and the other
 * polls are dropped: news they had is not confirmed as seen, so the next wait brings it again.
 * Null when every poll timed out.
 */
async function firstNews(client: Client, targets: Target[], seconds: number): Promise<{ t: Target; r: any } | { t: Target; error: unknown } | null> {
  const stop = new AbortController();
  try {
    return await new Promise((resolve) => {
      let pending = targets.length;
      for (const t of targets) {
        client.get(`${pullPath(t)}/wait?timeout=${seconds}`, stop.signal).then(
          (r) => (r.status !== 'timeout' ? resolve({ t, r }) : --pending === 0 && resolve(null)),
          (error) => resolve({ t, error }),
        );
      }
    });
  } finally {
    stop.abort();
  }
}

// --------------------------------------------------------------------- main

const USAGE = `Work with staged pull requests. Mirrors \`gh pr\`.

USAGE
  galley pr <command> [flags]

COMMANDS (same flags as gh)
  create:      Stage a pull request for the current branch
  list:        List staged and published pull requests (--state staged, published, done, all)
  view:        Show a pull request (--comments for reviews and review threads,
               --download-images <dir> to save the images in them as files)
  diff:        Show the diff
  edit:        Change title, body or base
  comment:     Comment, or reply to a review thread with --reply-to <id> [--resolve]
  review:      Approve, comment or request changes
  close:       Close a pull request
  reopen:      Reopen a pull request
  ready:       Mark as ready (or --undo for draft); decides how it is published
  checkout:    Check out the head branch
  status:      Show the pull request for the current branch

GALLEY COMMANDS
  wait:        Block until the reviewer agents or the user respond, then print the
               feedback, or until the reviewer agents are done with the latest commit.
               After publishing, pushes your commits to GitHub, and waits until it is
               merged or closed there. Several (as in s4 s5): whichever is first
  publish:     Push the branch and open the pull request on GitHub (--auto: once the
               reviews are done; --auto-merge: and turn on auto-merge there)

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository

Add --help to a command for its flags, as in \`galley pr wait --help\`.
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
      throw new CliError(`no checks reported on the '${currentBranch(cwd) ?? 'current'}' branch (galley does not run CI)`);
    case 'merge':
      throw new CliError('galley does not merge. When the user is happy they publish the pull request to GitHub.');
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return 0;
    default:
      throw new CliError(`unknown command "${cmd}" for "galley pr"\n\n${USAGE}`);
  }
}
