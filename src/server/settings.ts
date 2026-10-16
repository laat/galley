import type { Db } from './db.ts';
import { HttpError } from './service.ts';

export interface CodexSettings {
  /** Review staged pull requests automatically when the author waits for review. */
  enabled: boolean;
  /** The reviewer's name on its reviews. Renaming keeps its earlier reviews: it is one reviewer. */
  name: string;
  /** A model slug from `codex debug models`; empty uses Codex's own default. */
  model: string;
  /** A reasoning effort the model supports; empty uses the model's default. */
  effort: string;
  /** Automatic reviews per pull request. Asking from the pull request page is not capped. */
  maxIterations: number;
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface PublishSettings {
  /** How GitHub merges a pull request that laatsux turned on auto-merge for: gh pr merge --squash, --merge or --rebase. */
  mergeMethod: MergeMethod;
}

export interface Settings {
  codex: CodexSettings;
  publish: PublishSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  codex: { enabled: false, name: 'codex', model: '', effort: '', maxIterations: 3 },
  publish: { mergeMethod: 'squash' },
};

export const MAX_ITERATIONS_LIMIT = 20;

export function readSettings(db: Db): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(db.getMeta('settings') ?? '{}');
  } catch {}
  return { codex: { ...DEFAULT_SETTINGS.codex, ...stored.codex }, publish: { ...DEFAULT_SETTINGS.publish, ...stored.publish } };
}

const SLUG = /^[A-Za-z0-9._:/-]{0,100}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

export function checkReviewerName(name: string): string {
  const n = name.trim();
  if (!LOGIN.test(n)) throw new HttpError(422, `"${n}" is not a valid name (letters, digits, ".", "_" and "-", up to 39 characters)`);
  return n;
}

/** Validate a partial update and return the settings it would give, without storing them. */
export function nextSettings(db: Db, patch: { codex?: Record<string, unknown>; publish?: Record<string, unknown> }, efforts?: (model: string) => string[] | null): Settings {
  const current = readSettings(db);
  const next: Settings = { codex: { ...current.codex }, publish: { ...current.publish } };
  const c = patch.codex ?? {};
  if (c.enabled !== undefined) next.codex.enabled = c.enabled === true || c.enabled === 'true';
  if (c.name !== undefined) next.codex.name = checkReviewerName(String(c.name));
  if (c.model !== undefined) {
    const model = String(c.model).trim();
    if (!SLUG.test(model)) throw new HttpError(422, `invalid model "${model}"`);
    next.codex.model = model;
  }
  if (c.effort !== undefined) {
    const effort = String(c.effort).trim();
    if (!SLUG.test(effort)) throw new HttpError(422, `invalid effort "${effort}"`);
    next.codex.effort = effort;
  }
  if (c.maxIterations !== undefined) {
    const n = Number(c.maxIterations);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ITERATIONS_LIMIT) throw new HttpError(422, `max iterations must be a whole number from 0 to ${MAX_ITERATIONS_LIMIT}`);
    next.codex.maxIterations = n;
  }
  const p = patch.publish ?? {};
  if (p.mergeMethod !== undefined) {
    const method = String(p.mergeMethod) as MergeMethod;
    if (!MERGE_METHODS.includes(method)) throw new HttpError(422, `merge method must be one of ${MERGE_METHODS.join(', ')}`);
    next.publish.mergeMethod = method;
  }
  // A model's catalog entry lists the efforts it accepts; an effort it does not know would fail every run.
  const allowed = next.codex.effort && efforts ? efforts(next.codex.model) : null;
  if (allowed && !allowed.includes(next.codex.effort)) {
    throw new HttpError(422, `${next.codex.model || 'the default model'} does not support effort "${next.codex.effort}" (it supports ${allowed.join(', ')})`);
  }
  return next;
}

export function saveSettings(db: Db, settings: Settings): void {
  db.setMeta('settings', JSON.stringify(settings));
}
