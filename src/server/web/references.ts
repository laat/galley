// Links for what GitHub autolinks in Markdown: `#N`, `GH-N` and `owner/repo#N` (issues and pull
// requests on GitHub), `@user`, and commit SHAs; and `s#N`, a staged pull request here (#22). Marked lexes the Markdown exactly as it would without
// them; afterwards `linkReferences` cuts its plain text tokens where a reference sits. So references
// never change how the rest is read: emphasis, autolinked URLs and email addresses, and everything else
// stay marked's. Text inside links, code and inline HTML anchors, <code>, <pre>, <kbd> and <script> is
// left alone.
import { Marked, type MarkedExtension, type Token, type Tokens } from 'marked';
import type { Commit } from '../git.ts';
import type { Ctx, IssueSummary, Service } from '../service.ts';
import type { PullRow } from '../db.ts';
import { esc, shortSha } from './html.ts';
import { tooMuchEmphasis } from './emphasis.ts';

/** What references in one pull request's Markdown link to. */
export interface ReferenceContext {
  /**
   * The repository on GitHub (`repos.github_slug`). Descriptions are written for GitHub, so `#N` is its
   * issue or pull request N, not staged pull request N. Null: nothing links to GitHub.
   */
  slug: string | null;
  /** The commits the text names, by the hex word naming them (see `commitLinks`). */
  commits: Map<string, { href: string; title?: string }>;
  /** The title and state of an issue or pull request on GitHub, if known. Must not wait for GitHub. */
  issue?: (slug: string, number: number) => IssueSummary | null;
  /** Where staged pull request s#N of the repository is, and its title; null when there is none. */
  staged?: (number: number) => { href: string; title: string } | null;
}

interface ReferenceToken extends Tokens.Generic {
  type: 'reference';
  kind: 'issue' | 'staged' | 'mention' | 'commit';
  text: string;
  href: string;
  title?: string;
}

/** Classes on the links, for the sanitizer's allowlist and the stylesheet (GitHub's names). */
const CLASS = { issue: 'issue-link', staged: 'issue-link', mention: 'user-mention', commit: 'commit-link' } as const;
export const REFERENCE_CLASSES = Object.values(CLASS);

// A reference starts at a word boundary, and not inside a path, an entity or a color ("a/b#1", "x@y",
// "&#38;", "#c0ffee00"). The character before may sit in the token before.
const BEFORE = String.raw`[\w/.@#&-]`;
// It ends at one too: "#12." and "(abc1234)" link; "#12-a", "#1.5", "abc1234.js", "@a/b" and "@a.b" don't.
const END = String.raw`(?![\w@]|[.\-/]\w)`;
// A GitHub login: letters, digits and single hyphens, not at either end. Repository names have at
// most 100 characters.
const LOGIN = String.raw`[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}`;
const REPO = String.raw`[\w.-]{1,100}`;
const NUMBER = String.raw`[1-9]\d{0,9}`;
/** Each reference in a text, as far as the text tells: owner/repo#N, #N or GH-N, @login, a hex word, or s#N. */
const REFERENCE = new RegExp(String.raw`(?<!${BEFORE})(?:(${LOGIN})/(${REPO})#(${NUMBER})|(?:#|GH-)(${NUMBER})|@(${LOGIN})|([0-9a-f]{7,40})|s#(${NUMBER}))${END}`, 'g');
/** Hex words in raw Markdown that may be SHAs: a superset of what `linkReferences` looks up. */
const HEX_WORDS = /(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g;
// Inline HTML whose text gets no links: anchors (also written "<a\nhref=…>" or closed with "</a >"),
// and <pre>, <code>, <kbd> and <script>, nested or not.
const ANCHOR_START = /^<a\s/i;
const ANCHOR_END = /^<\/a\s*>/i;
const RAW_START = /^<(?:pre|code|kbd|script)[\s>]/i;
const RAW_END = /^<\/(?:pre|code|kbd|script)[\s>]/i;

function reference(m: RegExpExecArray, refs: ReferenceContext): ReferenceToken | undefined {
  const [raw, owner, repo, repoNumber, number, login, hex, staged] = m;
  // A staged pull request here. GitHub's #4 never starts inside s#4: a word character before "#" rules it out (BEFORE).
  if (staged) {
    const found = refs.staged?.(Number(staged));
    return found ? { type: 'reference', raw, kind: 'staged', text: raw, ...found } : undefined;
  }
  if (refs.slug && owner) return issue(raw, `${owner}/${repo}`, Number(repoNumber), refs);
  if (refs.slug && number) return issue(raw, refs.slug, Number(number), refs);
  if (refs.slug && login) return { type: 'reference', raw, kind: 'mention', text: raw, href: `https://github.com/${login}` };
  const commit = hex ? refs.commits.get(hex) : undefined;
  return commit && { type: 'reference', raw, kind: 'commit', text: shortSha(raw), ...commit };
}

function issue(raw: string, slug: string, number: number, refs: ReferenceContext): ReferenceToken {
  const known = refs.issue?.(slug, number);
  // GitHub redirects /issues/N to /pull/N when N is a pull request.
  return { type: 'reference', raw, kind: 'issue', text: raw, href: `https://github.com/${slug}/issues/${number}`, title: known ? `${known.title} · ${known.state}` : undefined };
}

/**
 * A text token's `text` cut into text and references, or nothing when it has none. `before` and `after`
 * are the characters around it, from the tokens next to it. Each part renders as the whole did: marked
 * escapes text character by character, except an "&" that starts an entity, and no reference starts or
 * ends inside an entity (BEFORE has "&", "#" and word characters, and no reference has "&" or ";").
 */
function cut(text: string, before: string, after: string, refs: ReferenceContext): Token[] | undefined {
  const all = before + text + after;
  const end = before.length + text.length;
  const parts: Token[] = [];
  let from = before.length;
  REFERENCE.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = REFERENCE.exec(all)) && m.index + m[0].length <= end; ) {
    const ref = reference(m, refs);
    if (!ref) continue;
    if (m.index > from) parts.push(plain(all.slice(from, m.index)));
    parts.push(ref);
    from = m.index + m[0].length;
  }
  if (!parts.length) return undefined;
  if (from < end) parts.push(plain(all.slice(from, end)));
  return parts;
}

function plain(text: string): Tokens.Text {
  return { type: 'text', raw: text, text, escaped: false };
}

/** Where `linkReferences` is: how deep in inline HTML whose text gets no links. */
interface Depth {
  anchors: number;
  raw: number;
}

/**
 * Cut the plain text tokens in marked's token tree where references sit, in document order. One pass,
 * each text scanned once, so it is linear in the Markdown.
 */
export function linkReferences(tokens: Token[], refs: ReferenceContext, depth: Depth = { anchors: 0, raw: 0 }): void {
  let out: Token[] | undefined;
  for (const [i, t] of tokens.entries()) {
    let parts: Token[] | undefined;
    if (t.type === 'html' && !t.block) {
      if (ANCHOR_START.test(t.raw)) depth.anchors++;
      else if (ANCHOR_END.test(t.raw)) depth.anchors = Math.max(0, depth.anchors - 1);
      if (RAW_START.test(t.raw) && !t.raw.endsWith('/>')) depth.raw++;
      else if (RAW_END.test(t.raw)) depth.raw = Math.max(0, depth.raw - 1);
    } else if (t.type === 'text' && !t.tokens) {
      if (!depth.anchors && !depth.raw && !t.escaped) parts = cut(t.text, tokens[i - 1]?.raw.at(-1) ?? '', following(tokens, i), refs);
    } else if (t.type === 'table') {
      for (const cell of [...t.header, ...t.rows.flat()]) linkReferences(cell.tokens, refs, depth);
    } else if (t.type === 'list') {
      for (const item of t.items) linkReferences(item.tokens, refs, depth);
    } else if (t.type !== 'link' && t.type !== 'image' && 'tokens' in t && t.tokens) {
      linkReferences(t.tokens, refs, depth);
    }
    if (parts) out ??= tokens.slice(0, i);
    if (out) for (const part of parts ?? [t]) out.push(part);
  }
  // In place: the caller holds this array (and marked's `links` on the top one).
  if (out) {
    tokens.length = 0;
    for (const t of out) tokens.push(t);
  }
}

/** The first two characters after token `i`, which decide whether a reference ends with it. */
function following(tokens: Token[], i: number): string {
  let after = '';
  for (let j = i + 1; j < tokens.length && after.length < 2; j++) after += tokens[j].raw.slice(0, 2 - after.length);
  return after;
}

export function referenceExtension(refs: ReferenceContext): MarkedExtension {
  return {
    hooks: {
      processAllTokens(tokens) {
        linkReferences(tokens, refs);
        return tokens;
      },
    },
    extensions: [
      {
        name: 'reference',
        renderer(token) {
          const t = token as ReferenceToken;
          const text = t.kind === 'commit' ? `<code>${esc(t.text)}</code>` : esc(t.text);
          return `<a class="${CLASS[t.kind]}" href="${esc(t.href)}"${t.title ? ` title="${esc(t.title)}"` : ''}>${text}</a>`;
        },
      },
    ],
  };
}

/**
 * The references a pull request's page links, given the Markdown it shows (`texts`, for finding SHAs).
 * `lookUp: false` takes issue titles from the cache alone (see `Service.githubIssue`).
 */
export async function pullReferences(s: Service, ctx: Ctx, commits: Commit[], texts: string[], opts: { lookUp?: boolean } = {}): Promise<ReferenceContext> {
  return {
    slug: ctx.repo.github_slug,
    commits: await commitLinks(ctx, commits, texts),
    issue: (slug, number) => s.githubIssue(slug, number, opts),
    staged: (number) => {
      const pull = s.db.get<PullRow>('SELECT * FROM pulls WHERE repo_id = ? AND number = ?', ctx.repo.id, number);
      const state = pull?.github_state === 'merged' ? 'merged' : pull?.github_state === 'closed' ? 'closed on GitHub' : pull?.state;
      return pull ? { href: `/${ctx.repo.owner}/${ctx.repo.name}/pull/${number}`, title: `${pull.title} · ${state}` } : null;
    },
  };
}

/**
 * Where the commit SHAs in `texts` link. A hex word of 7 to 40 characters is a SHA only when it names
 * exactly one commit in the repository, so hex words, numbers and checksums ("deadbeef", "1234567", an
 * md5) stay text, and so does an abbreviation two commits share. A commit of the pull request links to
 * its view here; any other commit links to GitHub when the GitHub remote has it, and otherwise to its
 * view here (say, a commit an earlier push replaced).
 */
async function commitLinks(ctx: Ctx, commits: Commit[], texts: string[]): Promise<ReferenceContext['commits']> {
  const { repo, pull, git } = ctx;
  const view = (sha: string) => `/${repo.owner}/${repo.name}/pull/${pull.number}/files?commit=${sha}`;
  // Git resolves every word, the pull request's commits too: only it knows which are ambiguous.
  const found = await git.resolveCommits([...new Set(texts.flatMap((t) => t.match(HEX_WORDS) ?? []))]);
  const own = new Map(commits.map((c) => [c.sha, c.message.split('\n')[0]]));
  const slug = repo.github_slug;
  const others = [...new Set(found.values())].filter((sha) => !own.has(sha));
  const unpushed = slug ? await git.notOnRemote(others, repo.remote) : new Set<string>();
  const links: ReferenceContext['commits'] = new Map();
  for (const [word, sha] of found) {
    if (own.has(sha)) links.set(word, { href: view(sha), title: own.get(sha) });
    else links.set(word, { href: slug && !unpushed.has(sha) ? `https://github.com/${slug}/commit/${sha}` : view(sha) });
  }
  return links;
}

// "Fixes #12", "closes: owner/repo#3": GitHub's closing keywords, right before the reference.
const CLOSING = /(?:^|\W)(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+$/i;

/**
 * The issues a description closes once GitHub merges the pull request, as links (deduplicated). None for a
 * description with too much emphasis for marked, rather than counting the references in its code, which
 * close nothing.
 */
export function closingIssues(text: string, refs: ReferenceContext): { text: string; href: string; title?: string }[] {
  if (tooMuchEmphasis(text)) return [];
  const marked = new Marked({ gfm: true, breaks: true });
  const tokens = marked.lexer(text);
  linkReferences(tokens, refs);
  const found = new Map<string, { text: string; href: string; title?: string }>();
  let prev: Token | undefined;
  marked.walkTokens(tokens, (token) => {
    const t = token as ReferenceToken;
    if (t.type === 'reference' && t.kind === 'issue' && prev?.type === 'text' && CLOSING.test(prev.raw) && !found.has(t.href)) {
      found.set(t.href, { text: t.text, href: t.href, title: t.title });
    }
    prev = token;
  });
  return [...found.values()];
}
