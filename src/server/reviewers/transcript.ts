// What a reviewer agent does while it reviews, in one shape for every tool: the updates of the
// Agent Client Protocol's `session/update` notification (https://agentclientprotocol.com), with
// text as the only content. Each engine reads its tool's own stream into these (codex.ts,
// claude.ts); an engine that speaks ACP passes them on as they come. A run's updates are stored,
// capped, for its transcript page, and its latest steps are kept in memory for the sidebar.
import { now, type Db } from '../db.ts';
import type { RunUsage } from './reviewer.ts';

/** What a tool call does (ACP's ToolKind), for how it is shown. */
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
/** A file a tool call works on: relative to the checkout when it is in there, as the repository has it. */
export interface ToolCallLocation {
  path: string;
  line?: number;
}
export interface TextContent {
  type: 'text';
  text: string;
}
export interface ToolCallContent {
  type: 'content';
  content: TextContent;
}
export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolCall {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations?: ToolCallLocation[];
  content?: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** Changes to a tool call: the fields given replace its own. */
export interface ToolCallUpdate extends Partial<Omit<ToolCall, 'sessionUpdate' | 'toolCallId'>> {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
}

export interface Chunk {
  sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk';
  content: TextContent;
  /** laatsux extension: the message a chunk belongs to. Chunks in a row with the same id (or none) are one message. */
  messageId?: string;
}

export type SessionUpdate =
  | Chunk
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | ToolCall
  | ToolCallUpdate
  /** laatsux extension: the tokens used so far, and the cost once the tool says. Shown live, not stored. */
  | { sessionUpdate: 'usage'; usage: RunUsage }
  /** laatsux extension: an error the tool reported, whether it carried on or stopped. */
  | { sessionUpdate: 'error'; message: string };

/** What the store adds: where it stopped keeping a run's updates, and how many it left out. */
type Stored = SessionUpdate | { sessionUpdate: 'cut'; dropped: number };

/** Hears that a run did something: pages showing it fetch its progress again. */
export interface ProgressEvent {
  pullId: number;
  runId: number;
}

/** A run keeps at most this many updates, and this many bytes of them (UTF-8, as stored); the rest are counted. */
export const MAX_UPDATES = 2000;
export const MAX_BYTES = 2 * 1024 * 1024;
/** Text longer than this many bytes (a command's output, a long message) keeps its start and its end. */
export const MAX_TEXT = 16 * 1024;
/** Pages hear of a run's progress at most this often. */
export const PROGRESS_MS = 1500;
/** The steps the sidebar shows. */
const LIVE_STEPS = 4;
/** Tool calls remembered for the sidebar, so their updates find them. */
const REMEMBERED = 50;

/** Whether a step is still to finish. */
const active = (s: Step) => s.status === 'in_progress' || s.status === 'pending';

/** A tool call as the sidebar shows it. */
export interface Step {
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: ToolCallLocation[];
  /** Its title is the shell command it runs (its rawInput has a `command`). */
  command: boolean;
}

/** Whether a tool call runs a shell command, which is then its title. */
export function runsCommand(call: Pick<ToolCall, 'rawInput'>): boolean {
  return typeof (call.rawInput as { command?: unknown } | undefined)?.command === 'string';
}

/** What a running review has done so far. */
export interface Progress {
  /** Its latest steps, the newest last, and those still running after them. */
  steps: Step[];
  /** How many steps it took. */
  total: number;
  /** The start of what it last said or thought. */
  said: string | null;
  usage: RunUsage | null;
}

/** Keep the start and end of a text longer than `max` bytes, cut between characters. */
export function clip(text: string, max = MAX_TEXT): string {
  // Most text is short; a string of n UTF-16 units is at most 3n bytes.
  if (text.length * 3 <= max) return text;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  const half = Math.floor(max / 2);
  // A character's continuation bytes are 10xxxxxx: move each cut back to where a character starts.
  let start = half;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
  let end = bytes.length - half;
  while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, start).toString('utf8')}\n… ${end - start} bytes left out …\n${bytes.subarray(end).toString('utf8')}`;
}

/** Raw input or output, with long text clipped; given as JSON text when it is too long as a whole. */
function clipRaw(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return clip(value);
  const json = JSON.stringify(value) ?? '';
  return Buffer.byteLength(json) <= MAX_TEXT ? value : clip(json);
}

function clipUpdate(u: SessionUpdate): SessionUpdate {
  switch (u.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return { ...u, content: { type: 'text', text: clip(u.content.text) } };
    case 'tool_call':
    case 'tool_call_update': {
      const c: ToolCall | ToolCallUpdate = { ...u };
      if (u.title !== undefined) c.title = clip(u.title, 1000);
      if (u.content) c.content = u.content.map((x) => ({ type: 'content', content: { type: 'text', text: clip(x.content.text) } }));
      if (u.locations) c.locations = u.locations.slice(0, 20);
      if (u.rawInput !== undefined) c.rawInput = clipRaw(u.rawInput);
      if (u.rawOutput !== undefined) c.rawOutput = clipRaw(u.rawOutput);
      return c;
    }
    case 'error':
      return { ...u, message: clip(u.message) };
    default:
      return u;
  }
}

/**
 * One run's updates: stored as they come, up to the caps, and followed in memory for the
 * sidebar. Pages hear of them through `notify`, at most every PROGRESS_MS.
 */
export class RunLog {
  readonly runId: number;
  private db: Db;
  private notify: () => void;
  private count = 0;
  private bytes = 0;
  private cut: { id: number; dropped: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notified = -Infinity;
  private finished = false;
  private calls = new Map<string, Step>();
  private total = 0;
  private said: string | null = null;
  private usage: RunUsage | null = null;

  constructor(db: Db, runId: number, notify: () => void) {
    this.db = db;
    this.runId = runId;
    this.notify = notify;
  }

  update(update: SessionUpdate): void {
    if (this.finished) return;
    const u = clipUpdate(update);
    this.follow(u);
    if (u.sessionUpdate !== 'usage') this.store(u);
    this.changed();
  }

  /** The run ended: no more updates, and the store says how many it left out. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.cut) this.db.update('review_run_events', this.cut.id, { data: JSON.stringify({ sessionUpdate: 'cut', dropped: this.cut.dropped } satisfies Stored) });
  }

  progress(): Progress {
    // Calls can run side by side: one still running stays in view after newer ones finished.
    const calls = [...this.calls.values()];
    const running = calls.filter(active).slice(-LIVE_STEPS);
    const room = LIVE_STEPS - running.length;
    const finished = room > 0 ? calls.filter((s) => !active(s)).slice(-room) : [];
    return { steps: [...finished, ...running], total: this.total, said: this.said, usage: this.usage };
  }

  private store(u: SessionUpdate): void {
    if (this.cut) {
      this.cut.dropped++;
      return;
    }
    const data = JSON.stringify(u);
    const size = Buffer.byteLength(data);
    if (this.count >= MAX_UPDATES || this.bytes + size > MAX_BYTES) {
      this.cut = { id: this.db.insert('review_run_events', { run_id: this.runId, data: JSON.stringify({ sessionUpdate: 'cut', dropped: 1 } satisfies Stored), created_at: now() }), dropped: 1 };
      return;
    }
    this.count++;
    this.bytes += size;
    this.db.insert('review_run_events', { run_id: this.runId, data, created_at: now() });
  }

  private follow(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'tool_call':
        this.total++;
        this.calls.delete(u.toolCallId);
        this.calls.set(u.toolCallId, { title: u.title, kind: u.kind, status: u.status, locations: u.locations ?? [], command: runsCommand(u) });
        // The oldest finished ones go first (a Map keeps the order calls were added in), then the oldest.
        for (const keep of [active, () => false]) {
          for (const [id, step] of this.calls) {
            if (this.calls.size <= REMEMBERED) break;
            if (!keep(step)) this.calls.delete(id);
          }
        }
        break;
      case 'tool_call_update': {
        const step = this.calls.get(u.toolCallId);
        if (!step) break;
        if (u.title !== undefined) step.title = u.title;
        if (u.kind !== undefined) step.kind = u.kind;
        if (u.status !== undefined) step.status = u.status;
        if (u.locations !== undefined) step.locations = u.locations;
        break;
      }
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const line = u.content.text.trim().split('\n')[0];
        if (line) this.said = line.length > 200 ? `${line.slice(0, 200)}…` : line;
        break;
      }
      case 'usage':
        this.usage = u.usage;
        break;
    }
  }

  private changed(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.notified + PROGRESS_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.notified = Date.now();
      this.notify();
    }, wait);
    this.timer.unref();
  }
}

/** A tool call with its updates applied. */
export type ToolCallView = Omit<ToolCall, 'sessionUpdate'>;

/** A run's transcript, as its page shows it: chunks in a row joined into messages, tool calls with their updates. */
export type Entry =
  | { type: 'prompt' | 'message' | 'thought'; text: string; at: string }
  | { type: 'plan'; entries: PlanEntry[]; at: string }
  | { type: 'tool'; call: ToolCallView; at: string }
  | { type: 'error'; message: string; at: string }
  | { type: 'cut'; dropped: number; at: string };

const CHUNK_ENTRY = { user_message_chunk: 'prompt', agent_message_chunk: 'message', agent_thought_chunk: 'thought' } as const;

export function hasTranscript(db: Db, runId: number): boolean {
  return !!db.get('SELECT 1 FROM review_run_events WHERE run_id = ? LIMIT 1', runId);
}

export function transcript(db: Db, runId: number): Entry[] {
  const rows = db.all<{ data: string; created_at: string }>('SELECT data, created_at FROM review_run_events WHERE run_id = ? ORDER BY id', runId);
  const entries: Entry[] = [];
  const calls = new Map<string, ToolCallView>();
  let plan: Extract<Entry, { type: 'plan' }> | null = null;
  // The message the update before was a chunk of: its id, or '' for none; null after anything else.
  let chunkOf: string | null = null;
  for (const row of rows) {
    let u: Stored;
    try {
      u = JSON.parse(row.data);
    } catch {
      continue;
    }
    const at = row.created_at;
    switch (u.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const type = CHUNK_ENTRY[u.sessionUpdate];
        const prev = entries.at(-1);
        if (chunkOf === (u.messageId ?? '') && prev && prev.type === type) prev.text += u.content.text;
        else entries.push({ type, text: u.content.text, at });
        chunkOf = u.messageId ?? '';
        continue;
      }
      case 'plan':
        // Each plan replaces the one before; it stays where the first one came.
        if (plan) plan.entries = u.entries;
        else entries.push((plan = { type: 'plan', entries: u.entries, at }));
        break;
      case 'tool_call': {
        const { sessionUpdate: _, ...call } = u;
        calls.set(u.toolCallId, call);
        entries.push({ type: 'tool', call, at });
        break;
      }
      case 'tool_call_update': {
        const call = calls.get(u.toolCallId);
        if (!call) break;
        const { sessionUpdate: _, toolCallId: __, ...changes } = u;
        Object.assign(call, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)));
        break;
      }
      case 'error':
        entries.push({ type: 'error', message: u.message, at });
        break;
      case 'cut':
        entries.push({ type: 'cut', dropped: u.dropped, at });
        break;
    }
    chunkOf = null;
  }
  return entries;
}

/** A path the tool gave, relative to the checkout when it is in there. */
export function inCheckout(checkout: string, path: string): string {
  // The checkout is a real path (/private/var/…); a tool may give it as /var/….
  for (const dir of [checkout, checkout.replace(/^\/private(?=\/)/, '')]) {
    if (path === dir) return '.';
    if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
  }
  return path.replace(/^(\.\/)+/, '');
}

/** A command line in words, with `|`, `;`, `&&` and newlines between its commands (null), as far as quoting goes. */
function shellWords(command: string): (string | null)[] {
  const words: (string | null)[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word = (word ?? '') + command.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? command.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < command.length && command[j] !== '"'; j++) s += command[j] === '\\' && j + 1 < command.length ? command[++j] : command[j];
      word = (word ?? '') + s;
      i = j;
    } else if (c === '\\' && command[i + 1] === '\n') {
      // A line that goes on.
      i++;
    } else if (c === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i];
    } else if (/\s/.test(c) || '|;&'.includes(c)) {
      if (word !== null) words.push(word);
      word = null;
      if ('|;&\n'.includes(c) && words.at(-1) !== null) words.push(null);
    } else word = (word ?? '') + c;
  }
  if (word !== null) words.push(word);
  return words;
}

const READERS = new Set(['cat', 'nl', 'head', 'tail', 'bat', 'less', 'more', 'sed', 'wc']);
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'ag', 'ack', 'fd', 'find', 'ls', 'tree']);

/**
 * What a shell command does, as far as its words tell: reading files (`sed -n '10,40p' a.ts`,
 * `nl -ba a.ts | sed -n 10,40p`, `cat`, `head`), searching (`rg`, `grep`, `git grep`, `ls`), or
 * anything else. Paths are read from the checkout: after a `cd` elsewhere, it names no files,
 * since a wrong link is worse than none.
 */
export function commandKind(command: string, checkout: string): { kind: ToolKind; locations: ToolCallLocation[] } {
  const commands: string[][] = [[]];
  for (const w of shellWords(command)) {
    if (w === null) commands.push([]);
    else commands.at(-1)!.push(w);
  }
  const locations: ToolCallLocation[] = [];
  let searches = false;
  let reads = false;
  let moved = false;
  for (const [word, ...args] of commands.filter((c) => c.length)) {
    // `(cd src && …)` runs in a subshell; the directory still changes for what follows in it.
    const name = word.replace(/^\(+/, '');
    // `cd .`, or into the checkout by its path (Claude's commands name it, made `.` in titles), stays put.
    if (['cd', 'pushd', 'popd'].includes(name) && !(name !== 'popd' && args[0] && inCheckout(checkout, args[0]) === '.')) moved = true;
    if (SEARCHERS.has(name) || (name === 'git' && args[0] === 'grep')) searches = true;
    if (!READERS.has(name)) continue;
    // Not options, their numbers (`head -n 20`, `tail -n +20`), nor redirections.
    let operands = args.filter((a, i) => !a.startsWith('-') && !/^\d+$/.test(a) && !/[<>]/.test(a) && !((name === 'head' || name === 'tail') && /^-[nc]$/.test(args[i - 1] ?? '')));
    let line: number | undefined;
    if (name === 'sed') {
      // `sed -n 'a,bp' file`: the script, then the files.
      const m = operands[0]?.match(/^(\d+)(?:,\d+)?p$/);
      if (!m) continue;
      line = Number(m[1]);
      operands = operands.slice(1);
      // `nl -ba file | sed -n 'a,bp'`: the lines of the file before.
      if (!operands.length && !moved && locations.length && locations.at(-1)!.line === undefined) locations.at(-1)!.line = line;
    }
    // Reading its input (`git diff | head`) is not reading a file.
    if (!operands.length) continue;
    reads = true;
    if (moved) continue;
    for (const path of operands) locations.push({ path: inCheckout(checkout, path), ...(line ? { line } : {}) });
  }
  return { kind: reads ? 'read' : searches ? 'search' : 'execute', locations };
}

/**
 * Reads a tool's JSON lines: each object goes to `read`. The last few other lines are kept,
 * for saying what went wrong when the tool printed its error instead.
 */
export function jsonLines(read: (event: any) => void): { onLine: (line: string) => void; other: string[] } {
  const other: string[] = [];
  return {
    other,
    onLine(line: string) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        if (line.trim()) other.push(line);
        if (other.length > 15) other.shift();
        return;
      }
      if (event && typeof event === 'object') read(event);
    },
  };
}
