// A custom reviewer's definition: one Markdown file per reviewer in the reviewers directory
// (configDir() in src/config.ts), named after the reviewer. Its front matter holds the settings,
// its body what the reviewer is told to look for:
//
//   ---
//   engine: claude
//   model: sonnet
//   repos: [nrkno/*]
//   reviews: description
//   verdict: approve
//   ---
//   Check the title and description against these rules: …
//
// The front matter is the small part of YAML these files need: `key: value`, lists as `[a, b]`
// or as `- a` lines under the key, quoted strings and `#` comments.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../service.ts';
import { checkReviewerName, MAX_ITERATIONS_LIMIT, REVIEWER_KINDS, SLUG, type ReviewerKind } from '../settings.ts';

export const REVIEWS = ['code', 'description'] as const;
/** What a reviewer reads: the code (a checkout of the head), or the title, description and commit messages. */
export type Reviews = (typeof REVIEWS)[number];
export const VERDICTS = ['comment', 'approve'] as const;
/** approve: it approves when it finds nothing; comment: it only comments. It never requests changes. */
export type Verdict = (typeof VERDICTS)[number];

/** A custom reviewer, as its file says and the API gives it. */
export interface Definition {
  /** The file's name, and the login its reviews are from. */
  name: string;
  /** The tool that reviews. */
  engine: ReviewerKind;
  /** A model the tool takes; empty for the tool's own default. */
  model: string;
  /** A reasoning effort the model takes; empty for its default. */
  effort: string;
  /** Globs on the GitHub slug (`owner/name`) of the repositories it reviews; null for every repository. */
  repos: string[] | null;
  reviews: Reviews;
  verdict: Verdict;
  /** Automatic reviews per pull request. */
  max_iterations: number;
  /** Install the dependencies first, and let it run the tests (code reviewers only). */
  run_tests: boolean;
  /** Review automatically when the author waits for review. */
  enabled: boolean;
  /** What to look for, in Markdown: the file's body. Empty, a code reviewer looks for what the built-in reviewers do. */
  instructions: string;
}

/** The front matter's keys, in the order they are written. */
const KEYS = ['name', 'engine', 'model', 'effort', 'repos', 'reviews', 'verdict', 'max_iterations', 'run_tests', 'enabled'] as const;

/** A glob on a GitHub slug: `owner/name`, where `*` and `?` match within one of the two. */
const GLOB = /^[A-Za-z0-9._*?-]+\/[A-Za-z0-9._*?-]+$/;

const DEFAULTS: Omit<Definition, 'name' | 'engine'> = {
  model: '',
  effort: '',
  repos: null,
  reviews: 'code',
  verdict: 'comment',
  max_iterations: 3,
  run_tests: true,
  enabled: true,
  instructions: '',
};

/**
 * Check a definition's values, from a file's front matter or the API, over `base` (a definition
 * being changed) or the defaults. Throws with what is wrong.
 */
export function checkDefinition(name: string, fields: Record<string, unknown>, base?: Definition): Definition {
  const login = checkReviewerName(name);
  const next: Partial<Definition> = base ? { ...base } : { ...DEFAULTS, name: login };
  const text = (key: string, v: unknown) => {
    if (typeof v !== 'string') throw new HttpError(422, `${key} must be text`);
    return v.trim();
  };
  const flag = (key: string, v: unknown) => {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw new HttpError(422, `${key} must be true or false`);
  };
  const oneOf = <T extends string>(key: string, v: unknown, values: readonly T[]): T => {
    if (!values.includes(v as T)) throw new HttpError(422, `${key} must be ${values.join(' or ')}`);
    return v as T;
  };
  for (const [key, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    switch (key) {
      case 'name':
        // The file is the name: a name in it must agree.
        if (text(key, v) !== login) throw new HttpError(422, `the name "${text(key, v)}" is not the file's name, "${login}"`);
        break;
      case 'engine':
        next.engine = oneOf(key, v, REVIEWER_KINDS);
        break;
      case 'model':
      case 'effort': {
        const slug = text(key, v ?? '');
        if (!SLUG.test(slug)) throw new HttpError(422, `invalid ${key} "${slug}"`);
        next[key] = slug;
        break;
      }
      case 'repos': {
        // A list, or (from a form) the globs in one text, a line or comma apart.
        const list = v === null ? [] : Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [v];
        const globs = list.map((g) => text(key, g)).filter(Boolean);
        for (const g of globs) if (!GLOB.test(g)) throw new HttpError(422, `"${g}" is not a repository on GitHub as owner/name, where * and ? match within each`);
        // None listed is every repository.
        next.repos = globs.length ? globs : null;
        break;
      }
      case 'reviews':
        next.reviews = oneOf(key, v, REVIEWS);
        break;
      case 'verdict':
        next.verdict = oneOf(key, v, VERDICTS);
        break;
      case 'max_iterations': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_ITERATIONS_LIMIT) throw new HttpError(422, `max_iterations must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
        next.max_iterations = n;
        break;
      }
      case 'run_tests':
      case 'enabled':
        next[key] = flag(key, v);
        break;
      case 'instructions':
        next.instructions = text(key, v);
        break;
      default:
        throw new HttpError(422, `unknown setting "${key}"`);
    }
  }
  if (!next.engine) throw new HttpError(422, `engine is required: ${REVIEWER_KINDS.join(' or ')}`);
  // Without a checkout, there is nothing else to go on.
  if (next.reviews === 'description' && !next.instructions) throw new HttpError(422, 'a reviewer of the description needs instructions: what to check it against');
  return next as Definition;
}

/** Whether a reviewer reviews a repository, by its GitHub slug: one without a GitHub remote only gets reviewers of every repository. */
export function reviewsRepo(repos: string[] | null, slug: string | null): boolean {
  if (!repos) return true;
  if (!slug) return false;
  return repos.some((glob) => globRegExp(glob).test(slug));
}

function globRegExp(glob: string): RegExp {
  const pattern = [...glob].map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.\\/-]/g, '\\$&'))).join('');
  // GitHub's owners and names are not case-sensitive.
  return new RegExp(`^${pattern}$`, 'i');
}

// -------------------------------------------------------------- the file

/** Read a definition file. Throws with what is wrong, and where. */
export function parseDefinition(name: string, text: string): Definition {
  const { fields, body } = frontMatter(text);
  return checkDefinition(name, { ...fields, instructions: body });
}

/** A definition as its file has it. */
export function formatDefinition(d: Definition): string {
  const values: Record<(typeof KEYS)[number], string | null> = {
    name: null,
    engine: d.engine,
    model: d.model ? scalar(d.model) : null,
    effort: d.effort ? scalar(d.effort) : null,
    repos: d.repos ? `[${d.repos.map(scalar).join(', ')}]` : null,
    reviews: d.reviews,
    verdict: d.verdict,
    max_iterations: String(d.max_iterations),
    run_tests: d.reviews === 'code' ? String(d.run_tests) : null,
    enabled: String(d.enabled),
  };
  const lines = KEYS.flatMap((key) => (values[key] === null ? [] : [`${key}: ${values[key]}`]));
  return `---\n${lines.join('\n')}\n---\n${d.instructions ? `\n${d.instructions}\n` : ''}`;
}

/** A string as a scalar: plain when YAML reads it back as the same string, quoted otherwise. */
function scalar(s: string): string {
  return /^[A-Za-z0-9._-][A-Za-z0-9._/*?-]*$/.test(s) && !/^(true|false|null|~|[-+]?[0-9.]+)$/i.test(s) ? s : JSON.stringify(s);
}

function frontMatter(text: string): { fields: Record<string, string | string[]>; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') throw new HttpError(422, 'the file must start with front matter between two --- lines');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) throw new HttpError(422, 'the front matter has no closing --- line');
  const fields: Record<string, string | string[]> = {};
  // The key whose list the `- item` lines below it make up.
  let listKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const n = i + 1;
    const fail = (why: string) => new HttpError(422, `line ${n}: ${why}`);
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-(?:\s+(.*))?$/);
    if (item) {
      if (!listKey) throw fail('a list item belongs under a key');
      const [value, rest] = readScalar(item[1] ?? '', '', fail);
      if (!ended(rest)) throw fail(`unexpected "${rest.trim()}"`);
      (fields[listKey] as string[]).push(value);
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s(.*))?$/);
    if (!m) throw fail('expected "key: value"');
    const [, key, raw = ''] = m;
    if (key in fields) throw fail(`${key} is given twice`);
    listKey = null;
    if (ended(raw)) {
      // A list follows as `- item` lines, or the value is empty.
      fields[key] = [];
      listKey = key;
    } else if (raw.trimStart().startsWith('[')) {
      fields[key] = flowList(raw.trimStart().slice(1), fail);
    } else {
      const [value, rest] = readScalar(raw, '', fail);
      if (!ended(rest)) throw fail(`unexpected "${rest.trim()}"`);
      fields[key] = value;
    }
  }
  // `key:` with no items under it is an empty value.
  for (const [key, v] of Object.entries(fields)) if (Array.isArray(v) && !v.length && key !== 'repos') fields[key] = '';
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

/** Whether nothing but a comment is left of a line. */
function ended(rest: string): boolean {
  const r = rest.trim();
  return !r || r.startsWith('#');
}

/** `a, "b", c]`: the items of a list given in line. */
function flowList(s: string, fail: (why: string) => Error): string[] {
  const items: string[] = [];
  let rest = s.trimStart();
  while (rest[0] !== ']') {
    const [value, after] = readScalar(rest, ',]', fail);
    if (!value) throw fail('an empty list item');
    items.push(value);
    rest = after.trimStart();
    if (rest[0] === ',') rest = rest.slice(1).trimStart();
    else if (rest[0] !== ']') throw fail('a list in [ ] needs a , between items and ] at the end');
  }
  if (!ended(rest.slice(1))) throw fail(`unexpected "${rest.slice(1).trim()}"`);
  return items;
}

/** The scalar at the start of `s`, quoted or plain (up to one of `stop`, or a comment), and what follows it. */
function readScalar(s: string, stop: string, fail: (why: string) => Error): [string, string] {
  const t = s.trimStart();
  if (t[0] === '"') {
    const m = t.match(/^"(?:[^"\\]|\\.)*"/);
    if (!m) throw fail('a " with no closing "');
    // JSON's escapes are YAML's common ones.
    try {
      return [JSON.parse(m[0]), t.slice(m[0].length)];
    } catch {
      throw fail(`can not read ${m[0]}`);
    }
  }
  if (t[0] === "'") {
    const m = t.match(/^'(?:[^']|'')*'/);
    if (!m) throw fail("a ' with no closing '");
    return [m[0].slice(1, -1).replaceAll("''", "'"), t.slice(m[0].length)];
  }
  let i = 0;
  while (i < t.length && !stop.includes(t[i]) && !(t[i] === '#' && (i === 0 || /\s/.test(t[i - 1])))) i++;
  return [t.slice(0, i).trim(), t.slice(i)];
}

// ---------------------------------------------------------- the directory

/** A definition file: the definition, or why it can not be read. */
export interface DefinitionFile {
  name: string;
  definition: Definition | null;
  error: string | null;
}

/** Every `<name>.md` in the directory, read; none when there is no directory. */
export function readDefinitions(dir: string): DefinitionFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
  } catch {
    return [];
  }
  return names.sort().map((file) => {
    const name = file.slice(0, -3);
    try {
      return { name, definition: parseDefinition(name, readFileSync(join(dir, file), 'utf8')), error: null };
    } catch (e) {
      return { name, definition: null, error: (e as Error).message };
    }
  });
}

/** Write a definition to its file, whole: one being read never sees half of it. */
export function writeDefinition(dir: string, d: Definition): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${d.name}.md.tmp`);
  writeFileSync(tmp, formatDefinition(d));
  renameSync(tmp, join(dir, `${d.name}.md`));
}

export function removeDefinition(dir: string, name: string): void {
  rmSync(join(dir, `${name}.md`), { force: true });
}
