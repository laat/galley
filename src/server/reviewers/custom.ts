// Custom reviewers: reviewer agents of the user's own, each defined in a file (definition.ts),
// with its own instructions, the repositories it reviews, what it reads and whether it may
// approve. Each is a Reviewer like Codex and Claude, run by one of their tools, so readiness,
// auto-publish, the sidebar and `pr wait` take it in as they do them. The files are read when
// the server starts, when Settings changes them, and when they change on disk.
import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Actor, PullRow, RepoRow } from '../db.ts';
import { HttpError, type ReviewColumns, type Service } from '../service.ts';
import { readSettings, REVIEWER_KINDS, type ReviewerKind, type ReviewerSettings } from '../settings.ts';
import { checkDefinition, readDefinitions, removeDefinition, reviewsRepo, writeDefinition, type Definition, type DefinitionFile, type Reviews, type Verdict } from './definition.ts';
import { customActorKey, moveOff, Reviewer, type Engine, type OwnSettings } from './reviewer.ts';

/**
 * How often laatsux checks that it follows the reviewers' directory: one removed or made again
 * needs a watcher of its own, and a change the watcher missed (it can, right after it starts) is read then.
 */
const FOLLOW_MS = 2000;

/** Custom reviewers' own values for a pull request, by name: pulls.reviewer_overrides. */
type Overrides = Record<string, { enabled: boolean | null; max_iterations: number | null }>;

/** A pull request's overrides, in an object of their own: a name such as `constructor` finds nothing Object has. */
function overrides(pull?: Partial<Pick<PullRow, 'reviewer_overrides'>>): Overrides {
  const all: Overrides = Object.create(null);
  try {
    if (pull?.reviewer_overrides) Object.assign(all, JSON.parse(pull.reviewer_overrides));
  } catch {}
  return all;
}

/** What the API takes of a definition: what GET gives, but for what only the server says (where its file is, its bot, why it does not run). */
function settable(fields: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, login: _login, error: _error, ...rest } = fields;
  return rest;
}

export class CustomReviewer extends Reviewer {
  definition: Definition;

  constructor(s: Service, tool: Engine, definition: Definition) {
    super(s, tool);
    this.definition = definition;
  }

  /** Take a changed definition. A review running now goes on as it began. */
  redefine(definition: Definition, tool: Engine): void {
    this.definition = definition;
    this.tool = tool;
  }

  get key(): string {
    return this.definition.name;
  }

  get label(): string {
    return this.definition.name;
  }

  get reviews(): Reviews {
    return this.definition.reviews;
  }

  get verdict(): Verdict {
    return this.definition.verdict;
  }

  get instructions(): string {
    return this.definition.instructions;
  }

  protected get actorKey(): string {
    return customActorKey(this.definition.name);
  }

  settingsUrl(): string {
    return `/settings/reviewers/${this.definition.name}`;
  }

  /** What it is, in a few words, under its name. */
  describe(): string {
    const reads = this.reviews === 'description' ? 'the title, description and commit messages' : 'the code';
    return `${this.tool.label} · reviews ${reads}${this.verdict === 'approve' ? ', and approves when it finds nothing' : ''}`;
  }

  appliesTo(repo: RepoRow): boolean {
    return reviewsRepo(this.definition.repos, repo.github_slug);
  }

  appliesToPull(pull: PullRow): boolean {
    return !this.definition.repos || this.appliesTo(this.s.repoById(pull.repo_id));
  }

  settings(): ReviewerSettings {
    const d = this.definition;
    return { enabled: d.enabled, name: d.name, model: d.model, effort: d.effort, maxIterations: d.max_iterations, runTests: d.reviews === 'code' && d.run_tests, localhost: false, skipOwnKind: false };
  }

  own(pull: PullRow): OwnSettings {
    const own = overrides(pull)[this.key];
    return { enabled: own?.enabled ?? null, maxIterations: own?.max_iterations ?? null };
  }

  protected ownColumns(change: Partial<OwnSettings>, pull?: Partial<Pick<PullRow, 'reviewer_overrides'>>): ReviewColumns {
    const all = overrides(pull);
    const own: Overrides[string] = all[this.key] ?? { enabled: null, max_iterations: null };
    if (change.enabled !== undefined) own.enabled = change.enabled;
    if (change.maxIterations !== undefined) own.max_iterations = change.maxIterations;
    // Back to the definition on both counts, it has nothing of its own.
    if (own.enabled === null && own.max_iterations === null) delete all[this.key];
    else all[this.key] = own;
    return { reviewer_overrides: Object.keys(all).length ? JSON.stringify(all) : null };
  }

  /** Why the reviewer can not have its name, or null: someone else has it, a person or an author agent. */
  nameTaken(): string | null {
    const id = Number(this.s.db.getMeta(this.actorKey));
    const mine = id ? this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id) : undefined;
    // Its bot moved off the name when the human took it (Reviewer.releaseName).
    if (mine) return mine.login === this.key ? null : `"${this.key}" is your name now; its reviews are from ${mine.login}`;
    // In any case, as --reviewer and the other names are matched: "AgEnT" is the author agent's name too.
    const taken = this.s.db.all<Actor>('SELECT * FROM actors WHERE login = ? COLLATE NOCASE', this.key).find((a) => !this.onlyReviewedForUs(a));
    if (!taken) return null;
    return `"${this.key}" is already used by ${taken.id === this.s.viewer().id ? 'you' : `${taken.login === this.key ? '' : `${taken.login}, `}an author agent or another reviewer`}; choose another`;
  }
}

/** The custom reviewers this server runs, from the definition files in `dir`. */
export class CustomReviewers {
  readonly dir: string;
  private s: Service;
  private engines: Record<ReviewerKind, Engine>;
  /** The reviewers that run: those whose definitions are valid. */
  private running = new Map<string, CustomReviewer>();
  /** Every definition file, with why it does not run when it does not. */
  private files: DefinitionFile[] = [];
  private started = false;
  private watcher: FSWatcher | null = null;
  /** The directory the watcher follows, by its inode: one made again is another directory. */
  private watched: number | null = null;
  /** The directory as load() last found it (snapshot). */
  private seen: string | null = null;
  /** The pause after a change on disk, which the changes that come with it fall into. */
  private timer: NodeJS.Timeout | undefined;
  private following: NodeJS.Timeout | undefined;

  constructor(s: Service, dir: string, engines: Record<ReviewerKind, Engine>) {
    this.s = s;
    this.dir = dir;
    this.engines = engines;
  }

  list(): CustomReviewer[] {
    return [...this.running.values()];
  }

  /** Every definition file, valid or not, with the reason when it does not run. */
  entries(): DefinitionFile[] {
    return this.files;
  }

  entry(name: string): DefinitionFile | undefined {
    return this.files.find((f) => f.name === name);
  }

  /** The names of every definition file, valid or not. */
  names(): string[] {
    return this.files.map((f) => f.name);
  }

  /** The custom reviewer's bot by that login, also of one that no longer runs: its bot is still its. */
  private bot(login: string): Actor | undefined {
    return this.s.db.get<Actor>(`SELECT a.* FROM meta m JOIN actors a ON a.id = CAST(m.value AS INTEGER) WHERE m.key LIKE '${customActorKey('')}%' AND a.login = ?`, login);
  }

  /** Whether a login is a custom reviewer's bot, also one that no longer runs. */
  heldBy(login: string): boolean {
    return !!this.bot(login);
  }

  /**
   * Move the bot that has the human's login off it (Reviewer.releaseName), also that of a reviewer
   * that no longer runs, which is no reviewer agent to ask: a file deleted, or wrong, as one by
   * the human's name is.
   */
  releaseName(login: string): void {
    const bot = this.bot(login);
    if (bot) moveOff(this.s.db, bot);
  }

  path(name: string): string {
    return join(this.dir, `${name}.md`);
  }

  /**
   * Read the files again and bring the reviewers in line: a new one starts, a changed one takes
   * its new definition, and one whose file is gone or no longer valid stops, interrupting its
   * reviews (they run again if it comes back). Pages hear of a change.
   */
  load(): void {
    this.seen = this.snapshot();
    const files = readDefinitions(this.dir);
    const before = JSON.stringify(this.files);
    const next = new Map<string, CustomReviewer>();
    const names = new Set<string>();
    for (const f of files) {
      const d = f.definition;
      const lower = f.name.toLowerCase();
      if (!d) continue;
      const known = this.running.get(d.name);
      const reviewer = known ?? new CustomReviewer(this.s, this.engines[d.engine], d);
      const taken = names.has(lower) ? `another file is called ${f.name} in another case` : (this.builtInName(d.name) ?? reviewer.nameTaken());
      names.add(lower);
      if (taken) {
        f.error = taken;
        continue;
      }
      known?.redefine(d, this.engines[d.engine]);
      // Its name is taken from now on: the API refuses CLI callers that use it.
      reviewer.actor();
      next.set(d.name, reviewer);
    }
    const added = [...next.values()].filter((r) => !this.running.has(r.key));
    for (const [name, r] of this.running) if (!next.has(name)) void r.stop();
    this.running = next;
    this.files = files;
    if (!this.started) return;
    for (const r of added) r.start();
    if (JSON.stringify(files) === before) return;
    // Turned on, or given more reviews: authors waiting now need not wait for their next wait.
    for (const r of next.values()) for (const id of this.s.waiters.keys()) r.consider(id);
    this.s.bus.emit('change', { pullId: null, type: 'settings', actor: 'settings' });
  }

  /** Why a custom reviewer can not have a name Codex's or Claude's reviewer answers to (see Reviewer.answersTo), or yours; null when it can. */
  private builtInName(name: string): string | null {
    const l = name.toLowerCase();
    for (const kind of REVIEWER_KINDS) {
      const id = Number(this.s.db.getMeta(`${kind}_actor_id`));
      const login = (id && this.s.db.get<Actor>('SELECT * FROM actors WHERE id = ?', id)?.login) || readSettings(this.s.db)[kind].name;
      if (l === kind || l === login.toLowerCase()) return `"${name}" would ask for the ${this.engines[kind].label} reviewer (--reviewer ${name}); choose another`;
    }
    if (l === this.s.viewer().login.toLowerCase()) return `"${name}" is your name; choose another`;
    return null;
  }

  /**
   * Begin running the reviewers (start() each first) and following the files. The directory is
   * made now, so a definition written into it by hand is followed from the first one on.
   */
  start(): void {
    this.started = true;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      console.error(`could not make ${this.dir}:`, (e as Error).message);
    }
    this.watch();
    this.following = setInterval(() => this.follow(), FOLLOW_MS);
    this.following.unref();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
    clearInterval(this.following);
    this.unwatch();
  }

  /**
   * Follow the directory there is now. A watcher hears nothing once its directory is removed, nor
   * of one made again in its place, and one that failed is gone: watch again. Read the files when
   * they are not as they were when last read, whatever the watcher heard.
   */
  private follow(): void {
    let ino: number | null = null;
    try {
      ino = statSync(this.dir).ino;
    } catch {}
    if (ino !== this.watched || !this.watcher) {
      this.unwatch();
      if (ino !== null) this.watch();
    }
    if (this.snapshot() !== this.seen) this.load();
  }

  /** The directory in a few words: which it is (its inode), and each definition file's name, size and time. Null when there is none. */
  private snapshot(): string | null {
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith('.md'));
      const stats = files.sort().map((f) => {
        const st = statSync(join(this.dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      });
      return [statSync(this.dir).ino, ...stats].join('|');
    } catch {
      return null;
    }
  }

  /** Follow edits to the files, as they are saved. */
  private watch(): void {
    if (this.watcher || !this.started) return;
    try {
      const ino = statSync(this.dir).ino;
      this.watcher = watch(this.dir, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.load(), 200);
      });
      // follow() watches again.
      this.watcher.on('error', () => this.unwatch());
      this.watcher.unref();
      this.watched = ino;
    } catch {}
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watched = null;
  }

  /** Define a reviewer, from the API. */
  async create(fields: Record<string, unknown>): Promise<DefinitionFile> {
    const name = String(fields.name ?? '').trim();
    const d = checkDefinition(name, settable(fields));
    // As the files are now, so one written by hand a moment ago is not written over.
    this.load();
    if (this.files.some((f) => f.name.toLowerCase() === d.name.toLowerCase())) throw new HttpError(422, `there is a reviewer called ${d.name} already`);
    const taken = this.builtInName(d.name) ?? new CustomReviewer(this.s, this.engines[d.engine], d).nameTaken();
    if (taken) throw new HttpError(422, taken);
    await this.checkEffort(d);
    return this.save(d);
  }

  /** Change a reviewer's definition, from the API. It keeps its name. */
  async update(name: string, fields: Record<string, unknown>): Promise<DefinitionFile> {
    // A change by hand a moment ago is what this one changes.
    this.load();
    const file = this.entry(name);
    if (!file) throw new HttpError(404, `no reviewer called ${name}`);
    if (fields.name !== undefined && fields.name !== name) throw new HttpError(422, 'a reviewer keeps its name; define one by the new name and delete this one');
    // One whose file can not be read is written whole.
    const d = checkDefinition(name, settable(fields), file.definition ?? undefined);
    await this.checkEffort(d);
    return this.save(d);
  }

  /** Delete a reviewer's file. Its reviews stay, and come back with it if it is defined again. */
  remove(name: string): void {
    this.load();
    if (!this.entry(name)) throw new HttpError(404, `no reviewer called ${name}`);
    removeDefinition(this.dir, name);
    this.load();
  }

  private save(d: Definition): DefinitionFile {
    writeDefinition(this.dir, d);
    this.load();
    this.watch();
    return this.entry(d.name)!;
  }

  /** A model's catalog entry lists the efforts it accepts; one it does not know would fail every run. */
  private async checkEffort(d: Definition): Promise<void> {
    if (!d.effort) return;
    const engine = this.engines[d.engine];
    await engine.models();
    const allowed = engine.efforts(d.model);
    if (allowed && !allowed.includes(d.effort)) throw new HttpError(422, `${d.model || 'the default model'} does not support effort "${d.effort}" (it supports ${allowed.join(', ')})`);
  }

  /** A definition file as the API gives it (an extension): the definition, where its file is, and why it does not run when it does not. */
  json(f: DefinitionFile) {
    const login = this.running.get(f.name)?.actor().login ?? null;
    return { name: f.name, ...f.definition, path: this.path(f.name), login, error: f.error };
  }
}
