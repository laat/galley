import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, now, type ReviewRunRow } from '../src/server/db.ts';
import { CodexEvents } from '../src/server/reviewers/codex.ts';
import { ClaudeEvents } from '../src/server/reviewers/claude.ts';
import { clip, commandKind, MAX_BYTES, MAX_TEXT, MAX_UPDATES, PROGRESS_MS, RunLog, transcript, type SessionUpdate } from '../src/server/reviewers/transcript.ts';
import { transcriptContent } from '../src/server/web/runs.ts';

const CHECKOUT = '/private/var/folders/xy/T/galley-review-abc/checkout';

/** A run to log, in a database of its own. */
function setup(): { db: Db; runId: number } {
  const db = new Db(':memory:');
  const repo = db.insert('repos', { git_dir: '/repo/.git', owner: 'acme', name: 'widgets', created_at: now() });
  const author = db.actor('agent', 'Bot');
  const pull = db.insert('pulls', {
    repo_id: repo,
    number: 1,
    title: 'Pull',
    base_ref: 'main',
    head_ref: 'feature',
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    author_id: author.id,
    created_at: now(),
    updated_at: now(),
    author_seen_at: now(),
  });
  const runId = db.insert('review_runs', { pull_id: pull, reviewer: 'codex', head_sha: 'a'.repeat(40), trigger: 'manual', status: 'running', started_at: now() });
  return { db, runId };
}

test('codex exec --json events become session updates', () => {
  // As Codex 0.162 printed them.
  const events = new CodexEvents(CHECKOUT);
  const read = (e: unknown) => events.read(e);
  assert.deepEqual(read({ type: 'thread.started', thread_id: '01a1' }), []);
  assert.deepEqual(read({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll inspect the diff.' } }), [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I’ll inspect the diff.' }, messageId: 'item_0' },
  ]);
  const sed = `/bin/zsh -lc "sed -n '1,160p' math.js"`;
  assert.deepEqual(read({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: sed, aggregated_output: '', exit_code: null, status: 'in_progress' } }), [
    { sessionUpdate: 'tool_call', toolCallId: 'item_2', title: "sed -n '1,160p' math.js", kind: 'read', locations: [{ path: 'math.js', line: 1 }], rawInput: { command: "sed -n '1,160p' math.js" }, status: 'in_progress', content: undefined },
  ]);
  assert.deepEqual(read({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: sed, aggregated_output: 'export function add', exit_code: 0, status: 'completed' } }), [
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'item_2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'export function add' } }],
      rawOutput: { exit_code: 0 },
      locations: [{ path: 'math.js', line: 1 }],
    },
  ]);
  // A command that only completes starts completed; one that exits non-zero failed.
  const [grep] = read({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: "/bin/zsh -lc 'grep -rn add .'", aggregated_output: '', exit_code: 1, status: 'failed' } });
  assert.deepEqual([grep.sessionUpdate, (grep as any).title, (grep as any).kind, (grep as any).status], ['tool_call', 'grep -rn add .', 'search', 'failed']);
  assert.deepEqual(read({ type: 'item.updated', item: { id: 'item_5', type: 'todo_list', items: [{ text: 'Read the diff', completed: true }, { text: 'Check callers', completed: false }] } }), [
    {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the diff', priority: 'medium', status: 'completed' },
        { content: 'Check callers', priority: 'medium', status: 'pending' },
      ],
    },
  ]);
  // The tokens of each turn add up; cached input is part of Codex's input count.
  read({ type: 'turn.completed', usage: { input_tokens: 54946, cached_input_tokens: 35968, cache_write_input_tokens: 0, output_tokens: 280, reasoning_output_tokens: 0 } });
  assert.deepEqual(events.usage, { cost_usd: null, input_tokens: 18978, cache_creation_input_tokens: 0, cache_read_input_tokens: 35968, output_tokens: 280, turns: null, duration_ms: null, models: [] });
  assert.deepEqual(read({ type: 'turn.failed', error: { message: 'stream disconnected' } }), [{ sessionUpdate: 'error', message: 'stream disconnected' }]);
  assert.deepEqual(events.errors, ['stream disconnected']);
});

test('what a shell command reads, as far as its words tell', () => {
  const kind = (command: string) => commandKind(command, CHECKOUT);
  assert.deepEqual(kind("nl -ba src/server/service.ts | sed -n '120,200p'"), { kind: 'read', locations: [{ path: 'src/server/service.ts', line: 120 }] });
  assert.deepEqual(kind("sed -n '5,9p' a.ts b.ts"), { kind: 'read', locations: [{ path: 'a.ts', line: 5 }, { path: 'b.ts', line: 5 }] });
  assert.deepEqual(kind(`cat ${CHECKOUT}/README.md 2>/dev/null && tail -n +20 ./x.ts`), { kind: 'read', locations: [{ path: 'README.md' }, { path: 'x.ts' }] });
  // As Claude ran it with Bash: cat's -n takes no number.
  assert.deepEqual(kind('git diff 9139a57 HEAD; echo ---; cat -n src/cart.js; echo ---; cat -n src/format.js'), { kind: 'read', locations: [{ path: 'src/cart.js' }, { path: 'src/format.js' }] });
  // Newlines separate commands too; a backslash before one goes on with the line.
  assert.deepEqual(kind("sed -n '10,20p' a.ts\nsed -n '30,40p' b.ts"), { kind: 'read', locations: [{ path: 'a.ts', line: 10 }, { path: 'b.ts', line: 30 }] });
  assert.deepEqual(kind('cat \\\n  a.ts'), { kind: 'read', locations: [{ path: 'a.ts' }] });
  // After a cd elsewhere a path is not the checkout's: no file rather than the wrong one.
  assert.deepEqual(kind("cd src && sed -n '10,20p' main.ts"), { kind: 'read', locations: [] });
  assert.deepEqual(kind('cat a.ts; (cd src && cat b.ts); cat c.ts'), { kind: 'read', locations: [{ path: 'a.ts' }] });
  // Into the checkout itself, as Claude's commands go (`cd .` in their titles), stays put.
  assert.deepEqual(kind(`cd ${CHECKOUT} && cat a.ts`), { kind: 'read', locations: [{ path: 'a.ts' }] });
  assert.deepEqual(kind('cd . && cat a.ts'), { kind: 'read', locations: [{ path: 'a.ts' }] });
  // Reading its input is not reading a file.
  assert.deepEqual(kind('git diff HEAD~1 | head -50'), { kind: 'execute', locations: [] });
  assert.deepEqual(kind('rg -n "a|b" src'), { kind: 'search', locations: [] });
  assert.deepEqual(kind('git grep -n foo'), { kind: 'search', locations: [] });
  assert.deepEqual(kind('git diff abc HEAD -- math.js'), { kind: 'execute', locations: [] });
  assert.deepEqual(kind('pnpm test'), { kind: 'execute', locations: [] });
});

test('claude -p stream-json messages become session updates', () => {
  // As Claude Code 2.1.302 printed them.
  const events = new ClaudeEvents(CHECKOUT);
  const read = (e: unknown) => events.read(e);
  const msg = (id: string, content: unknown[], output_tokens: number) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model: 'claude-haiku-5-5', id, type: 'message', role: 'assistant', content, usage: { input_tokens: 2, cache_creation_input_tokens: 7178, cache_read_input_tokens: 0, output_tokens } },
  });
  assert.deepEqual(read({ type: 'system', subtype: 'init', cwd: CHECKOUT }), []);
  const [readFile, usage] = read(msg('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: `${CHECKOUT}/src/math.js`, offset: 40, limit: 20 } }], 16));
  assert.deepEqual(readFile, {
    sessionUpdate: 'tool_call',
    toolCallId: 'toolu_1',
    status: 'in_progress',
    rawInput: { file_path: `${CHECKOUT}/src/math.js`, offset: 40, limit: 20 },
    title: 'Read src/math.js',
    kind: 'read',
    locations: [{ path: 'src/math.js', line: 40 }],
  });
  assert.equal((usage as any).usage.cache_creation_input_tokens, 7178);
  // The same message again, with its next content block: its tokens count once.
  const [bash, again] = read(msg('msg_1', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: `cd ${CHECKOUT} && git diff abc HEAD`, description: 'Show diff' } }], 16));
  assert.equal((bash as any).title, 'cd . && git diff abc HEAD');
  assert.equal((bash as any).kind, 'execute');
  assert.deepEqual([(again as any).usage.cache_creation_input_tokens, (again as any).usage.turns], [7178, 1]);
  assert.deepEqual(read({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'fatal: bad revision', is_error: true }] } }), [
    { sessionUpdate: 'tool_call_update', toolCallId: 'toolu_2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'fatal: bad revision' } }] },
  ]);
  // Thinking it does not show comes as an empty block, and is left out.
  assert.deepEqual(read(msg('msg_2', [{ type: 'thinking', thinking: '', signature: 'x' }], 2)).map((u) => u.sessionUpdate), ['usage']);
  // Its answer is the StructuredOutput tool: shown as a message, its result left out.
  const answer = { summary: 'Fine.', comments: [] };
  assert.deepEqual(read(msg('msg_2', [{ type: 'tool_use', id: 'toolu_3', name: 'StructuredOutput', input: answer }], 2))[0], {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: JSON.stringify(answer, null, 2) },
    messageId: 'toolu_3',
  });
  assert.deepEqual(read({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: 'Structured output provided successfully' }] } }), []);
  assert.deepEqual(read({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), []);
  const [final] = read({ type: 'result', subtype: 'success', is_error: false, num_turns: 5, duration_ms: 5117, total_cost_usd: 0.00204978, usage: { input_tokens: 4, cache_creation_input_tokens: 7903, cache_read_input_tokens: 7178, output_tokens: 794 }, modelUsage: { 'claude-haiku-5-5': {} }, structured_output: answer });
  assert.deepEqual((final as any).usage, { cost_usd: 0.00204978, input_tokens: 4, cache_creation_input_tokens: 7903, cache_read_input_tokens: 7178, output_tokens: 794, turns: 5, duration_ms: 5117, models: ['claude-haiku-5-5'] });
  assert.equal(events.result.structured_output, answer);
});

test('a run log stores the updates, clips long text and stops at its caps', () => {
  const { db, runId } = setup();
  const log = new RunLog(db, runId, () => {});
  const say = (text: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  log.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Review this.' } });
  log.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'cat big.log', kind: 'read', status: 'in_progress', locations: [{ path: 'big.log' }] });
  log.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a'.repeat(60_000) + 'z'.repeat(60_000) } }] });
  // Chunks in a row of one message are one message.
  log.update(say('Looks '));
  log.update(say('fine.'));
  // Tokens are shown live, not stored.
  log.update({ sessionUpdate: 'usage', usage: { cost_usd: null, input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2, turns: null, duration_ms: null, models: [] } });
  const entries = transcript(db, runId);
  assert.deepEqual(entries.map((e) => e.type), ['prompt', 'tool', 'message']);
  const tool = entries[1].type === 'tool' ? entries[1].call : null;
  assert.equal(tool?.status, 'completed');
  const output = tool!.content![0].content.text;
  assert.equal(output, `${'a'.repeat(MAX_TEXT / 2)}\n… ${120_000 - MAX_TEXT} bytes left out …\n${'z'.repeat(MAX_TEXT / 2)}`);
  assert.equal(entries[2].type === 'message' && entries[2].text, 'Looks fine.');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_run_events WHERE run_id = ?', runId)!.n, 5);
  assert.equal(log.progress().usage?.output_tokens, 2);

  // Past the number of updates it keeps, it counts the rest, and says so where it stopped.
  for (let i = 5; i < MAX_UPDATES + 7; i++) log.update({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `step ${i}`, kind: 'execute', status: 'completed' });
  log.finish();
  log.update(say('after the end'));
  const cut = transcript(db, runId).at(-1);
  assert.deepEqual(cut && { type: cut.type, dropped: cut.type === 'cut' && cut.dropped }, { type: 'cut', dropped: 7 });
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_run_events WHERE run_id = ?', runId)!.n, MAX_UPDATES + 1);

  // And past the bytes it keeps.
  const other = setup();
  const big = new RunLog(other.db, other.runId, () => {});
  const n = Math.ceil(MAX_BYTES / MAX_TEXT) + 3;
  for (let i = 0; i < n; i++) big.update(say('x'.repeat(MAX_TEXT)));
  big.finish();
  assert.ok(storedBytes(other.db, other.runId) <= MAX_BYTES, `${storedBytes(other.db, other.runId)} bytes kept`);
  assert.equal(transcript(other.db, other.runId).at(-1)?.type, 'cut');
});

/** The bytes SQLite stores for a run's updates (in UTF-8), besides where it stopped. */
const storedBytes = (db: Db, runId: number) =>
  db.get<{ n: number }>(`SELECT SUM(LENGTH(CAST(data AS BLOB))) AS n FROM review_run_events WHERE run_id = ? AND data NOT LIKE '%"cut"%'`, runId)!.n;

test('the caps count bytes as stored, not characters', () => {
  // Three bytes each in UTF-8: as characters, a text of these fits the cap three times over.
  const wide = '界'.repeat(MAX_TEXT);
  const clipped = clip(wide);
  const [start, note, end] = clipped.split('\n');
  assert.ok(Buffer.byteLength(start) + Buffer.byteLength(end) <= MAX_TEXT, 'the text keeps at most MAX_TEXT bytes');
  // Cut between characters, never inside one.
  assert.match(start, /^界+$/);
  assert.match(end, /^界+$/);
  assert.equal(note, `… ${Buffer.byteLength(wide) - Buffer.byteLength(start) - Buffer.byteLength(end)} bytes left out …`);
  const { db, runId } = setup();
  const log = new RunLog(db, runId, () => {});
  for (let i = 0; i < 150; i++) log.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: wide } });
  log.finish();
  assert.ok(storedBytes(db, runId) <= MAX_BYTES, `${storedBytes(db, runId)} bytes kept`);
  assert.equal(transcript(db, runId).at(-1)?.type, 'cut');
});

test('a step still running stays in view after newer ones finished', () => {
  const { db, runId } = setup();
  const log = new RunLog(db, runId, () => {});
  const call = (id: string, status: 'in_progress' | 'completed'): SessionUpdate => ({ sessionUpdate: 'tool_call', toolCallId: id, title: id, kind: 'execute', status });
  // Calls side by side: the slow one started first.
  log.update(call('slow', 'in_progress'));
  for (let i = 1; i <= 5; i++) log.update(call(`fast ${i}`, 'completed'));
  assert.deepEqual(log.progress().steps.map((s) => [s.title, s.status]), [['fast 3', 'completed'], ['fast 4', 'completed'], ['fast 5', 'completed'], ['slow', 'in_progress']]);
  // Nor is it forgotten while many more come and go.
  for (let i = 6; i <= 80; i++) log.update(call(`fast ${i}`, 'completed'));
  assert.deepEqual(log.progress().steps.map((s) => [s.title, s.status]), [['fast 78', 'completed'], ['fast 79', 'completed'], ['fast 80', 'completed'], ['slow', 'in_progress']]);
  log.finish();
});

test('a run log follows the latest steps, and tells pages at most every few seconds', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { db, runId } = setup();
    let told = 0;
    const log = new RunLog(db, runId, () => told++);
    for (let i = 1; i <= 6; i++) log.update({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: `step ${i}`, kind: 'execute', status: 'in_progress' });
    log.update({ sessionUpdate: 'tool_call_update', toolCallId: 't6', status: 'failed' });
    log.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n**Checking the callers**\nmore' } });
    const progress = log.progress();
    // Four still run, so they fill the view.
    assert.deepEqual(progress.steps.map((s) => [s.title, s.status]), [['step 2', 'in_progress'], ['step 3', 'in_progress'], ['step 4', 'in_progress'], ['step 5', 'in_progress']]);
    assert.equal(progress.total, 6);
    assert.equal(progress.said, '**Checking the callers**');
    mock.timers.tick(0);
    assert.equal(told, 1, 'at once for the first');
    log.update({ sessionUpdate: 'tool_call_update', toolCallId: 't5', status: 'completed' });
    log.update({ sessionUpdate: 'tool_call_update', toolCallId: 't4', status: 'completed' });
    mock.timers.tick(PROGRESS_MS - 1);
    assert.equal(told, 1);
    mock.timers.tick(1);
    assert.equal(told, 2, 'once for the rest');
    log.update({ sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' });
    log.finish();
    mock.timers.tick(PROGRESS_MS);
    assert.equal(told, 2, 'not after the run ended');
  } finally {
    mock.timers.reset();
  }
});

test("the transcript shows a shell step's command in full, also one too long for its title", () => {
  const { db, runId } = setup();
  const log = new RunLog(db, runId, () => {});
  const long = `rg -n "${'x'.repeat(1200)}" src`;
  log.update({ sessionUpdate: 'tool_call', toolCallId: 'long', title: long, kind: 'search', status: 'completed', rawInput: { command: long } });
  // One with no output, which the summary may show only in part.
  log.update({ sessionUpdate: 'tool_call', toolCallId: 'short', title: 'git status --short', kind: 'execute', status: 'completed', rawInput: { command: 'git status --short' } });
  log.finish();
  const run = db.get<ReviewRunRow>('SELECT * FROM review_runs WHERE id = ?', runId)!;
  const html = transcriptContent({ htmlBase: '/acme/widgets/pull/1', repoBase: '/acme/widgets', apiBase: '/api/repos/acme/widgets/pulls/1' }, { run, login: 'codex-review', label: 'Codex', entries: transcript(db, runId), live: null }).value;
  // Its title, in the summary, keeps its start and end.
  assert.match(html, /<code class="run-command">rg -n &quot;x+\n… \d+ bytes left out …\nx+&quot; src<\/code>/);
  // Opened, each shows its command as it ran.
  assert.ok(html.includes(`<pre class="run-output run-output--command">$ ${long.replaceAll('"', '&quot;')}</pre>`), 'the long command in full');
  assert.ok(html.includes('<pre class="run-output run-output--command">$ git status --short</pre>'), 'the short one too');
});
