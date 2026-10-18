// Codex as a reviewer agent: `codex exec` in the review's checkout, in Codex's own sandbox,
// answering in the reviewer's JSON schema. Its bot is named "codex-review" unless renamed in
// settings; `--reviewer codex` finds it by its engine whatever its name.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run, type RunResult } from '../git.ts';
import type { Service } from '../service.ts';
import { EngineError, lastLines, Reviewer, type Engine, type EngineJob, type EngineResult, type ModelInfo, type RunUsage } from './reviewer.ts';
import { commandKind, inCheckout, jsonLines, type SessionUpdate, type ToolCallLocation, type ToolCallStatus, type ToolKind } from './transcript.ts';

/**
 * Codex's workspace-write sandbox: it writes only to the checkout and the TMPDIR it is given
 * beside it. Every setting is given here, or Codex takes it from the user's config.toml, where
 * writable_roots or network_access may open more. /tmp and the server's own TMPDIR are left
 * out, since repositories and other agents' worktrees can live there. The user's repository
 * stays read-only: Codex protects the checkout's .git and the worktree's git directory it
 * points to, and the rest of the repository is outside what it may write. Network is only for
 * installing dependencies: with it, code from the pull request could reach galley's API on
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
  /**
   * Codex's sandbox lets commands serve on localhost only through its network proxy
   * (features.network_proxy.allow_local_binding), which needs network_access and then also lets
   * them reach port 53 on any host: a way out.
   */
  readonly localServers = false;
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
    writeFileSync(schemaFile, JSON.stringify(job.schema));
    // A review of the description runs read-only in an empty directory: it has nothing to read but the prompt.
    const sandbox = settings.runTests ? ['-s', 'workspace-write', ...workspaceWrite(false)] : ['-s', 'read-only'];
    // --json prints what Codex does as it goes; the answer still goes to the -o file.
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', ...sandbox, ...untrusted(checkout), '-C', checkout, '--color', 'never', '--json', '--output-schema', schemaFile, '-o', outFile];
    if (settings.model) args.push('-m', settings.model);
    if (settings.effort) args.push('-c', `model_reasoning_effort="${settings.effort}"`);
    args.push('-');
    const events = new CodexEvents(checkout);
    const stdout = jsonLines((e) => {
      for (const u of events.read(e)) job.onUpdate(u);
    });
    const r = await run(this.bin, args, { cwd: checkout, env: job.env, input: job.prompt, allowFail: true, timeoutMs, signal: job.signal, onLine: stdout.onLine }).catch((e: Error) => {
      throw new Error(`could not run ${this.bin}: ${e.message}`);
    });
    // Its errors come as events; stderr has its log.
    const output = () => lastLines([r.stderr || stdout.other.join('\n'), ...events.errors].join('\n'), 15);
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${timeoutMs / 60000} minutes` : r.code === null ? 'was killed' : `exited with ${r.code}`;
      throw new EngineError(`codex ${why}:\n${output()}`, events.usage);
    }
    try {
      return { answer: JSON.parse(readFileSync(outFile, 'utf8')), usage: events.usage };
    } catch {
      throw new EngineError(`codex did not write a review:\n${output()}`, events.usage);
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

  /** What Codex uses when galley does not choose: the top-level settings in its config.toml. */
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

/**
 * Reads `codex exec --json` events into session updates: its messages and reasoning, the
 * commands it runs (and the files they read), its file changes and to-do list. It adds up the
 * tokens each turn used, which Codex reports when the turn ends.
 */
export class CodexEvents {
  usage: RunUsage | null = null;
  /** The errors it reported, for saying why a run failed. */
  errors: string[] = [];
  private checkout: string;
  private started = new Set<string>();

  constructor(checkout: string) {
    this.checkout = checkout;
  }

  read(e: any): SessionUpdate[] {
    switch (e.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return e.item && typeof e.item === 'object' ? this.item(e.item, e.type === 'item.completed') : [];
      case 'turn.completed':
        return e.usage ? [{ sessionUpdate: 'usage', usage: this.add(e.usage) }] : [];
      case 'turn.failed':
      case 'error': {
        const message = String(e.error?.message ?? e.message ?? 'error');
        this.errors.push(message);
        return [{ sessionUpdate: 'error', message }];
      }
      default:
        return [];
    }
  }

  private item(item: any, done: boolean): SessionUpdate[] {
    const id = String(item.id);
    const text = (t: unknown) => ({ type: 'text' as const, text: String(t ?? '') });
    // A tool call starts once; what follows updates it. One that only completes starts completed.
    const call = (title: string, kind: ToolKind, status: ToolCallStatus, rest: { locations?: ToolCallLocation[]; output?: string; rawInput?: unknown; rawOutput?: unknown }): SessionUpdate[] => {
      const content = rest.output ? [{ type: 'content' as const, content: text(rest.output) }] : undefined;
      const fields = { status, content, ...(rest.rawOutput === undefined ? {} : { rawOutput: rest.rawOutput }) };
      if (this.started.has(id)) return [{ sessionUpdate: 'tool_call_update', toolCallId: id, ...fields, ...(rest.locations ? { locations: rest.locations } : {}) }];
      this.started.add(id);
      return [{ sessionUpdate: 'tool_call', toolCallId: id, title, kind, locations: rest.locations ?? [], rawInput: rest.rawInput, ...fields }];
    };
    const status = (): ToolCallStatus => (item.status === 'in_progress' || (!done && !item.status) ? 'in_progress' : item.status === 'completed' ? 'completed' : 'failed');
    switch (item.type) {
      case 'agent_message':
        return done && item.text ? [{ sessionUpdate: 'agent_message_chunk', content: text(item.text), messageId: id }] : [];
      case 'reasoning':
        return done && item.text ? [{ sessionUpdate: 'agent_thought_chunk', content: text(item.text), messageId: id }] : [];
      case 'command_execution': {
        const command = unwrapShell(String(item.command ?? ''));
        const { kind, locations } = commandKind(command, this.checkout);
        const failed = typeof item.exit_code === 'number' && item.exit_code !== 0;
        return call(command, kind, failed ? 'failed' : status(), {
          locations,
          output: item.aggregated_output || undefined,
          rawInput: { command },
          rawOutput: item.exit_code === null || item.exit_code === undefined ? undefined : { exit_code: item.exit_code },
        });
      }
      case 'file_change': {
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        const locations = changes.map((c) => ({ path: inCheckout(this.checkout, String(c.path)) }));
        const title = `Edit ${locations.map((l) => l.path).join(', ')}`;
        return call(title, 'edit', status(), { locations, rawInput: changes });
      }
      case 'mcp_tool_call': {
        const output = item.error?.message ?? (Array.isArray(item.result?.content) ? item.result.content.map((c: any) => c.text ?? '').join('\n') : undefined);
        return call(`${item.server}: ${item.tool}`, 'other', status(), { output, rawInput: item.arguments });
      }
      case 'web_search':
        return call(`Search the web for ${JSON.stringify(String(item.query ?? ''))}`, 'fetch', done ? 'completed' : 'in_progress', {});
      case 'todo_list': {
        const items: any[] = Array.isArray(item.items) ? item.items : [];
        return [{ sessionUpdate: 'plan', entries: items.map((i) => ({ content: String(i.text ?? ''), priority: 'medium', status: i.completed ? 'completed' : 'pending' })) }];
      }
      case 'error':
        return [{ sessionUpdate: 'error', message: String(item.message ?? 'error') }];
      default:
        return [];
    }
  }

  /** Add a turn's tokens. Codex counts cached input tokens in its input tokens. */
  private add(u: any): RunUsage {
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const total = this.usage ?? { cost_usd: null, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, turns: null, duration_ms: null, models: [] };
    const cached = n(u.cached_input_tokens);
    const written = n(u.cache_write_input_tokens);
    this.usage = {
      ...total,
      input_tokens: total.input_tokens + Math.max(0, n(u.input_tokens) - cached - written),
      cache_creation_input_tokens: total.cache_creation_input_tokens + written,
      cache_read_input_tokens: total.cache_read_input_tokens + cached,
      output_tokens: total.output_tokens + n(u.output_tokens),
    };
    return this.usage;
  }
}

/** The command Codex ran, without the shell it wraps it in (`/bin/zsh -lc 'git diff'`). */
export function unwrapShell(command: string): string {
  const m = command.match(/^(?:\S*\/)?(?:ba|z|da)?sh -l?c (.+)$/s);
  if (!m) return command;
  const arg = m[1];
  if (arg.length > 1 && arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1).replace(/'\\''/g, "'");
  if (arg.length > 1 && arg.startsWith('"') && arg.endsWith('"')) return arg.slice(1, -1).replace(/\\([\\"$`])/g, '$1');
  return arg;
}

export class CodexReviewer extends Reviewer {
  constructor(s: Service, bin = 'codex') {
    super(s, new CodexEngine(bin));
  }
}
