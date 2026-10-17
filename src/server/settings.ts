import type { Db } from './db.ts';
import { HttpError } from './service.ts';

/** The tools that review pull requests, as review_runs.reviewer and the settings name them. */
export const REVIEWER_KINDS = ['codex', 'claude'] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

/** A reviewer agent's settings. */
export interface ReviewerSettings {
  /** Review staged pull requests automatically when the author waits for review. */
  enabled: boolean;
  /** The reviewer's name on its reviews. Renaming keeps its earlier reviews: it is one reviewer. */
  name: string;
  /** A model slug from the tool's catalog (`codex debug models`); empty uses the tool's own default. */
  model: string;
  /** A reasoning effort the model supports; empty uses the model's default. */
  effort: string;
  /** Automatic reviews per pull request. Asking from the pull request page is not capped. */
  maxIterations: number;
  /** Install the dependencies before the reviewer starts, and let it run the tests in its checkout without network; off keeps it read-only. */
  runTests: boolean;
  /** Leave pull requests by an author agent running in the same tool to the other reviewers, so authors get a second opinion. */
  skipOwnKind: boolean;
}

export type CodexSettings = ReviewerSettings;

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface PublishSettings {
  /** How GitHub merges a pull request that laatsux turned on auto-merge for: gh pr merge --squash, --merge or --rebase. */
  mergeMethod: MergeMethod;
}

export interface Settings {
  codex: CodexSettings;
  claude: ReviewerSettings;
  publish: PublishSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  // "codex" until it became "codex-review", beside "claude-review" (see CodexReviewer.leaveFormerDefault).
  codex: { enabled: false, name: 'codex-review', model: '', effort: '', maxIterations: 3, runTests: true, skipOwnKind: false },
  // Not "claude": that is what the CLI calls an author agent running in Claude Code.
  claude: { enabled: false, name: 'claude-review', model: '', effort: '', maxIterations: 3, runTests: true, skipOwnKind: false },
  publish: { mergeMethod: 'squash' },
};

export const MAX_ITERATIONS_LIMIT = 20;

export function readSettings(db: Db): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(db.getMeta('settings') ?? '{}');
  } catch {}
  return {
    codex: { ...DEFAULT_SETTINGS.codex, ...stored.codex },
    claude: { ...DEFAULT_SETTINGS.claude, ...stored.claude },
    publish: { ...DEFAULT_SETTINGS.publish, ...stored.publish },
  };
}

const SLUG = /^[A-Za-z0-9._:/-]{0,100}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

/** What the CLI calls author agents (cliActor in src/config.ts). A reviewer may not take those names, even before such an agent turns up. */
const AUTHOR_LOGINS = ['claude', 'codex-agent', 'opencode'];

export function checkReviewerName(name: string): string {
  const n = name.trim();
  if (!LOGIN.test(n)) throw new HttpError(422, `"${n}" is not a valid name (letters, digits, ".", "_" and "-", up to 39 characters)`);
  if (AUTHOR_LOGINS.includes(n.toLowerCase())) throw new HttpError(422, `"${n}" is what the CLI calls author agents; choose another`);
  return n;
}

/** Validate a partial update and return the settings it would give, without storing them. */
export function nextSettings(
  db: Db,
  patch: { [K in ReviewerKind]?: Record<string, unknown> } & { publish?: Record<string, unknown> },
  efforts?: (kind: ReviewerKind, model: string) => string[] | null,
): Settings {
  const current = readSettings(db);
  const next: Settings = { codex: { ...current.codex }, claude: { ...current.claude }, publish: { ...current.publish } };
  for (const kind of REVIEWER_KINDS) {
    const changes = patch[kind];
    if (changes) nextReviewer(next[kind], changes, efforts && ((model) => efforts(kind, model)));
  }
  const p = patch.publish ?? {};
  if (p.mergeMethod !== undefined) {
    const method = String(p.mergeMethod) as MergeMethod;
    if (!MERGE_METHODS.includes(method)) throw new HttpError(422, `merge method must be one of ${MERGE_METHODS.join(', ')}`);
    next.publish.mergeMethod = method;
  }
  return next;
}

/** Apply a partial update to a reviewer's settings, checking each value. */
function nextReviewer(next: ReviewerSettings, c: Record<string, unknown>, efforts?: (model: string) => string[] | null): void {
  const flag = (v: unknown) => v === true || v === 'true';
  if (c.enabled !== undefined) next.enabled = flag(c.enabled);
  if (c.name !== undefined) next.name = checkReviewerName(String(c.name));
  if (c.model !== undefined) {
    const model = String(c.model).trim();
    if (!SLUG.test(model)) throw new HttpError(422, `invalid model "${model}"`);
    next.model = model;
  }
  if (c.effort !== undefined) {
    const effort = String(c.effort).trim();
    if (!SLUG.test(effort)) throw new HttpError(422, `invalid effort "${effort}"`);
    next.effort = effort;
  }
  if (c.maxIterations !== undefined) {
    const n = Number(c.maxIterations);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ITERATIONS_LIMIT) throw new HttpError(422, `max iterations must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
    next.maxIterations = n;
  }
  if (c.runTests !== undefined) next.runTests = flag(c.runTests);
  if (c.skipOwnKind !== undefined) next.skipOwnKind = flag(c.skipOwnKind);
  // A model's catalog entry lists the efforts it accepts; an effort it does not know would fail every run.
  const allowed = next.effort && efforts ? efforts(next.model) : null;
  if (allowed && !allowed.includes(next.effort)) {
    throw new HttpError(422, `${next.model || 'the default model'} does not support effort "${next.effort}" (it supports ${allowed.join(', ')})`);
  }
}

export function saveSettings(db: Db, settings: Settings): void {
  db.setMeta('settings', JSON.stringify(settings));
}
