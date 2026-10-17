// Claude as a reviewer agent: Claude Code headless (`claude -p`) in the review's checkout, with
// the user's own login, answering in the reviewer's JSON schema. Its bot is named
// "claude-review" unless renamed in settings, since the CLI calls author agents in Claude Code
// "claude".
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { run, type RunResult } from '../git.ts';
import type { Service } from '../service.ts';
import { EngineError, lastLines, makeWritable, removeDir, Reviewer, SCHEMA, type Engine, type EngineJob, type EngineResult, type ModelInfo, type RunUsage } from './reviewer.ts';
import { sandboxed } from './sandbox.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The model aliases `claude --model` takes, each the latest of its family. */
const MODELS: ModelInfo[] = [
  { slug: 'fable', name: 'Fable', description: 'the latest Fable model', efforts: EFFORTS, defaultEffort: '' },
  { slug: 'opus', name: 'Opus', description: 'the latest Opus model', efforts: EFFORTS, defaultEffort: '' },
  { slug: 'sonnet', name: 'Sonnet', description: 'the latest Sonnet model', efforts: EFFORTS, defaultEffort: '' },
  { slug: 'haiku', name: 'Haiku', description: 'the latest Haiku model', efforts: EFFORTS, defaultEffort: '' },
];

/**
 * Read-only git commands, for a review that may not run the tests. Claude Code lets read-only
 * commands such as ls and cat through on its own; anything else is denied.
 */
const READ_ONLY_GIT = ['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'cat-file', 'merge-base', 'describe', 'shortlog'];

/**
 * What a Claude Code session sets for the commands it runs. A server started from one (the CLI
 * starts it when none is running) passes them on, and the reviewer would take itself for part
 * of that session: its effort, its plugins, its messaging socket.
 */
const SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_PLUGIN_DIRS',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SHELL',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];

export class ClaudeEngine implements Engine {
  readonly id = 'claude';
  readonly label = 'Claude';
  readonly authorLogin = 'claude';
  readonly authorTool = 'Claude Code';
  private bin: string;
  private sandboxExec: string | undefined;

  /** `sandboxExec` stands in for macOS's sandbox-exec (in tests). */
  constructor(bin = 'claude', sandboxExec?: string) {
    this.bin = bin;
    this.sandboxExec = sandboxExec;
  }

  /** Claude Code can not run a command in its sandbox without the model, so the install gets laatsux's own (sandbox.ts). */
  install(command: string[], o: { checkout: string; tmp: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
    const wrapped = sandboxed(command, { writable: [o.checkout, o.tmp], readOnly: [join(o.checkout, '.git')] }, this.sandboxExec);
    if (!wrapped) return Promise.reject(new Error(`laatsux has no sandbox to install in on ${process.platform}`));
    return run(wrapped.bin, wrapped.args, { cwd: o.checkout, env: o.env, allowFail: true, timeoutMs: o.timeoutMs, signal: o.signal });
  }

  async review(job: EngineJob): Promise<EngineResult> {
    const { checkout, settings, timeoutMs } = job;
    // Claude Code's own temporary directory, which its sandbox lets commands write to ($TMPDIR
    // in there). Short, since it keeps sockets there: past about 30 bytes Claude Code falls back
    // to /tmp/claude-<uid>, where the user's own Claude Code sessions keep their files.
    const own = mkdtempSync('/tmp/lx-');
    try {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(SCHEMA),
        '--no-session-persistence',
        // The checkout is untrusted: without its settings files and the user's (hooks,
        // permissions, plugins), its .mcp.json, CLAUDE.md, skills and agents, and with Read, Grep
        // and Glob kept to the checkout. Claude Code would run its hooks and MCP servers otherwise.
        '--restricted',
        '--safe-mode',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--tools',
        'Read,Grep,Glob,Bash',
        '--allowedTools',
        ...['Read', 'Grep', 'Glob', ...(settings.runTests ? [] : READ_ONLY_GIT.map((c) => `Bash(git ${c}:*)`))],
        '--disallowedTools',
        'mcp__*',
        // Nobody is there to answer: what is not allowed above (or by the sandbox) is denied.
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--settings',
        JSON.stringify({ sandbox: this.sandbox(job, own) }),
      ];
      if (settings.model) args.push('--model', settings.model);
      if (settings.effort) args.push('--effort', settings.effort);
      const env: NodeJS.ProcessEnv = { ...job.env, CLAUDE_CODE_TMPDIR: own, DISABLE_AUTOUPDATER: '1' };
      for (const name of SESSION_VARIABLES) env[name] = undefined;
      const r = await run(this.bin, args, { cwd: checkout, env, input: job.prompt, allowFail: true, timeoutMs, signal: job.signal }).catch((e: Error) => {
        throw new Error(`could not run ${this.bin}: ${e.message}`);
      });
      const out = result(r.stdout);
      // A run that fails after some turns (error_max_structured_output_retries, an API error) has cost something too.
      const cost = out && (typeof out.total_cost_usd === 'number' || out.usage) ? usage(out) : null;
      if (r.code !== 0 || !out || out.is_error) {
        const why = r.timedOut ? `timed out after ${timeoutMs / 60000} minutes` : r.code === null ? 'was killed' : out?.subtype && out.subtype !== 'success' ? `stopped (${out.subtype})` : `exited with ${r.code}`;
        throw new EngineError(`claude ${why}:\n${lastLines(String(out?.result ?? '') || r.stderr || r.stdout, 15)}`, cost);
      }
      if (!out.structured_output || typeof out.structured_output !== 'object') {
        throw new EngineError(`claude did not answer in the review's schema:\n${lastLines(String(out.result ?? r.stdout), 15)}`, cost);
      }
      return { answer: out.structured_output, usage: cost };
    } finally {
      // The tests Claude ran may have left read-only directories in its $TMPDIR.
      await makeWritable(own);
      removeDir(own);
    }
  }

  /**
   * Claude Code's sandbox for the commands Claude runs. Its network is off, so code from the
   * pull request can not reach laatsux's API on localhost, which takes any local caller for the
   * user. It writes to the checkout (when it runs the tests), its own temporary directory and
   * the review's, and nowhere else: not to the git directory the checkout points into, which
   * Claude Code would let it write to for a worktree, and not to /tmp/claude-<uid>, should Claude
   * Code fall back to it. It may not leave the sandbox.
   */
  private sandbox(job: EngineJob, own: string) {
    const uid = process.getuid?.();
    return {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: job.settings.runTests,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true },
      filesystem: {
        allowWrite: job.tmp ? [job.tmp] : [],
        denyWrite: [
          join(job.checkout, '.git'),
          job.gitDir,
          ...(job.settings.runTests ? [] : [job.checkout]),
          ...(uid === undefined ? [] : [`/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`]),
        ],
      },
    };
  }

  async models(): Promise<ModelInfo[]> {
    return MODELS;
  }

  /** Every model takes every effort; one laatsux does not list (a full model name) is not checked. */
  efforts(model: string): string[] | null {
    return model ? (MODELS.find((m) => m.slug === model)?.efforts ?? null) : EFFORTS;
  }

  /** Claude Code's own default model and effort, since --restricted leaves the user's settings out. */
  defaults(): { model?: string; effort?: string } {
    return {};
  }
}

/** The result `claude -p --output-format json` prints, the last line of its output when something printed before it. */
function result(stdout: string): any {
  for (const line of [stdout, ...stdout.trim().split('\n').reverse()]) {
    try {
      const out = JSON.parse(line);
      if (out?.type === 'result') return out;
    } catch {}
  }
  return null;
}

/** What `claude -p --output-format json` reports a run cost. */
function usage(out: any): RunUsage {
  const u = out.usage ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    cost_usd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : null,
    input_tokens: n(u.input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    output_tokens: n(u.output_tokens),
    turns: typeof out.num_turns === 'number' ? out.num_turns : null,
    duration_ms: typeof out.duration_ms === 'number' ? out.duration_ms : null,
    models: Object.keys(out.modelUsage ?? {}),
  };
}

export class ClaudeReviewer extends Reviewer {
  constructor(s: Service, bin = 'claude', sandboxExec?: string) {
    super(s, new ClaudeEngine(bin, sandboxExec));
  }
}
