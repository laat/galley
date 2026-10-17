// Codex as a reviewer agent: `codex exec` in the review's checkout, in Codex's own sandbox,
// answering in the reviewer's JSON schema. Its bot is named "codex" unless renamed in settings.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from '../git.ts';
import { now, type Actor, type CommentRow } from '../db.ts';
import { splitPriorityPrefix, type Service } from '../service.ts';
import { lastLines, outsideTheDiff, Reviewer, SCHEMA, type Engine, type EngineJob, type EngineResult, type ModelInfo } from './reviewer.ts';
import { REVIEWER_KINDS } from '../settings.ts';

/**
 * Codex's workspace-write sandbox: it writes only to the checkout and the TMPDIR it is given
 * beside it. Every setting is given here, or Codex takes it from the user's config.toml, where
 * writable_roots or network_access may open more. /tmp and the server's own TMPDIR are left
 * out, since repositories and other agents' worktrees can live there. The user's repository
 * stays read-only: Codex protects the checkout's .git and the worktree's git directory it
 * points to, and the rest of the repository is outside what it may write. Network is only for
 * installing dependencies: with it, code from the pull request could reach laatsux's API on
 * localhost and act as the user.
 */
function workspaceWrite(network: boolean): string[] {
  return [
    '-c',
    `sandbox_workspace_write.network_access=${network}`,
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '-c',
    'sandbox_workspace_write.exclude_tmpdir_env_var=false',
  ];
}

/**
 * Codex loads a trusted project's .codex/config.toml, whose MCP servers it starts outside the
 * sandbox, and on a writable checkout it marks the user's repository trusted in their
 * config.toml. Marking the checkout untrusted turns both off; it outranks the repository's
 * own trust.
 */
function untrusted(checkout: string): string[] {
  return ['-c', `projects={${JSON.stringify(checkout)}={trust_level="untrusted"}}`];
}

/** What the CLI calls an author agent running in Codex (see cliActor in src/config.ts). */
const CODEX_AUTHOR = 'codex-agent';
const CATALOG_TTL_MS = 10 * 60 * 1000;

export class CodexEngine implements Engine {
  readonly id = 'codex';
  readonly label = 'Codex';
  readonly authorLogin = CODEX_AUTHOR;
  readonly authorTool = 'Codex';
  readonly catalogSource = 'codex debug models';
  private bin: string;
  private catalog: { at: number; models: ModelInfo[] } | null = null;

  constructor(bin = 'codex') {
    this.bin = bin;
  }

  install(command: string[], o: { checkout: string; tmp: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
    const args = ['sandbox', '-c', 'sandbox_mode="workspace-write"', ...workspaceWrite(true), ...untrusted(o.checkout), '--', ...command];
    return run(this.bin, args, { cwd: o.checkout, env: o.env, allowFail: true, timeoutMs: o.timeoutMs, signal: o.signal });
  }

  async review(job: EngineJob): Promise<EngineResult> {
    const { checkout, settings, timeoutMs } = job;
    const schemaFile = join(job.dir, 'schema.json');
    const outFile = join(job.dir, 'review.json');
    writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    const sandbox = settings.runTests ? ['-s', 'workspace-write', ...workspaceWrite(false)] : ['-s', 'read-only'];
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', ...sandbox, ...untrusted(checkout), '-C', checkout, '--color', 'never', '--output-schema', schemaFile, '-o', outFile];
    if (settings.model) args.push('-m', settings.model);
    if (settings.effort) args.push('-c', `model_reasoning_effort="${settings.effort}"`);
    args.push('-');
    const r = await run(this.bin, args, { cwd: checkout, env: job.env, input: job.prompt, allowFail: true, timeoutMs, signal: job.signal }).catch((e: Error) => {
      throw new Error(`could not run ${this.bin}: ${e.message}`);
    });
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${timeoutMs / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
      throw new Error(`codex ${why}:\n${lastLines(r.stderr || r.stdout, 15)}`);
    }
    try {
      return { answer: JSON.parse(readFileSync(outFile, 'utf8')), usage: null };
    } catch {
      throw new Error(`codex did not write a review:\n${lastLines(r.stderr || r.stdout, 15)}`);
    }
  }

  /** Models from `codex debug models`, cached; empty when Codex is not available. */
  async models(): Promise<ModelInfo[]> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.models;
    let models: ModelInfo[] = [];
    try {
      const r = await run(this.bin, ['debug', 'models'], { allowFail: true, timeoutMs: 30_000 });
      const data = JSON.parse(r.stdout);
      const list: any[] = Array.isArray(data) ? data : (data.models ?? []);
      models = list
        .filter((m) => m.slug && m.visibility !== 'hide')
        .map((m) => ({
          slug: String(m.slug),
          name: String(m.display_name ?? m.slug),
          description: String(m.description ?? ''),
          efforts: (m.supported_reasoning_levels ?? []).map((l: any) => String(l.effort ?? l)),
          defaultEffort: String(m.default_reasoning_level ?? ''),
        }));
    } catch {
      models = [];
    }
    this.catalog = { at: Date.now(), models };
    return models;
  }

  efforts(model: string): string[] | null {
    const slug = model || this.defaults().model;
    const m = this.catalog?.models.find((x) => x.slug === slug);
    return m && m.efforts.length ? m.efforts : null;
  }

  /** What Codex uses when laatsux does not choose: the top-level settings in its config.toml. */
  defaults(): { model?: string; effort?: string } {
    const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return {};
    }
    const top = text.split(/^\s*\[/m)[0];
    const get = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
    return { model: get('model'), effort: get('model_reasoning_effort') };
  }
}

/** The Codex reviewer, with what earlier versions stored about it brought up to date. */
export class CodexReviewer extends Reviewer {
  constructor(s: Service, bin = 'codex') {
    super(s, new CodexEngine(bin));
  }

  /**
   * Older CLIs called author agents running in Codex "codex". That author moves to the name
   * the CLI uses now, keeping its pull requests, so the agent can still work on them; if that
   * name exists too, both are the same kind of author and become one.
   */
  protected takeOver(taken: Actor, name: string): boolean {
    if (taken.id === this.s.viewer().id || name !== 'codex') return false;
    const current = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', CODEX_AUTHOR);
    if (current) this.s.db.transaction(() => this.absorb(taken, current));
    else this.s.db.run('UPDATE actors SET login = ? WHERE id = ?', CODEX_AUTHOR, taken.id);
    return true;
  }

  protected migrate(): void {
    // Earlier versions recorded the reviewer's login in review_runs; fold those identities into
    // one. Runs from before laatsux knew another engine are all Codex's, also under a login that
    // is another engine's kind now (the bot could be called "claude").
    let since = this.s.db.getMeta('engines_since');
    if (!since) this.s.db.setMeta('engines_since', (since = now()));
    const kinds = REVIEWER_KINDS.map((k) => `'${k}'`).join(', ');
    const legacy = `reviewer != '${this.engine}' AND (reviewer NOT IN (${kinds}) OR started_at < ?)`;
    for (const { reviewer } of this.s.db.all<{ reviewer: string }>(`SELECT DISTINCT reviewer FROM review_runs WHERE ${legacy}`, since)) {
      const old = this.s.db.get<Actor>('SELECT * FROM actors WHERE login = ?', reviewer);
      const me = this.actor();
      this.s.db.transaction(() => {
        if (old && old.id !== me.id && this.onlyReviewedForUs(old)) this.absorb(old, me);
        this.s.db.run(`UPDATE review_runs SET reviewer = ? WHERE reviewer = ? AND ${legacy}`, this.engine, reviewer, since);
      });
    }
    // Runs from before findings were counted: count them from the review each posted, its
    // comments and the findings its body lists. Without a review the count stays unknown.
    for (const run of this.s.db.all<{ id: number; review_id: number }>("SELECT id, review_id FROM review_runs WHERE reviewer = ? AND status = 'done' AND findings IS NULL AND review_id IS NOT NULL", this.engine)) {
      const review = this.s.db.get<{ body: string }>('SELECT body FROM reviews WHERE id = ?', run.review_id);
      if (!review) continue;
      const inline = this.s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE review_id = ?', run.review_id)!.n;
      this.s.db.update('review_runs', run.id, { findings: inline + outsideTheDiff(review.body) });
    }
    // Earlier reviews carried the priority in the text ("[P1] ..."); move it into the field.
    const me = this.actor();
    for (const c of this.s.db.all<Pick<CommentRow, 'id' | 'body'>>('SELECT id, body FROM comments WHERE author_id = ? AND priority IS NULL', me.id)) {
      const split = splitPriorityPrefix(c.body);
      if (split.priority) this.s.db.update('comments', c.id, { priority: split.priority, body: split.body });
    }
  }
}
