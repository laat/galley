import './helpers/env.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setField } from '../src/cli/api.ts';
import { parseDuration } from '../src/cli/output.ts';
import { parseReviewers } from '../src/cli/pr.ts';
import { whoReviews } from '../src/cli/reviewers.ts';
import { checkPriority, fillFromCommits, splitPriorityPrefix } from '../src/server/service.ts';
import { Client } from '../src/cli/client.ts';
import { cliActor, META } from '../src/config.ts';
import type { Commit } from '../src/server/git.ts';

test('setField builds nested bodies like gh api -f/-F', () => {
  const body: Record<string, any> = {};
  setField(body, 'event', 'COMMENT');
  setField(body, 'comments[][path]', 'a.js');
  setField(body, 'comments[][line]', 3);
  setField(body, 'comments[][body]', 'first');
  setField(body, 'comments[][path]', 'b.js');
  setField(body, 'comments[][line]', 7);
  setField(body, 'labels[]', 'x');
  setField(body, 'labels[]', 'y');
  setField(body, 'head[ref]', 'main');
  assert.deepEqual(body, {
    event: 'COMMENT',
    comments: [
      { path: 'a.js', line: 3, body: 'first' },
      { path: 'b.js', line: 7 },
    ],
    labels: ['x', 'y'],
    head: { ref: 'main' },
  });
});

test('parseDuration', () => {
  assert.equal(parseDuration('90'), 90_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.throws(() => parseDuration('soon'));
});

const commit = (message: string): Commit => ({
  sha: 'x',
  parents: [],
  authorName: 'a',
  authorEmail: 'a@b',
  authorDate: '',
  committerName: 'a',
  committerEmail: 'a@b',
  committerDate: '',
  message,
});

test('fillFromCommits mirrors gh pr create --fill', () => {
  assert.deepEqual(fillFromCommits([commit('Add x\n\nWhy x.')], 'feat/x', 'default'), { title: 'Add x', body: 'Why x.' });
  assert.deepEqual(fillFromCommits([commit('One'), commit('Two\n\nMore')], 'feat/add-things', 'default'), {
    title: 'Add things',
    body: '- One\n- Two',
  });
  assert.equal(fillFromCommits([commit('One'), commit('Two')], 'b', 'first').title, 'One');
  assert.equal(fillFromCommits([commit('One'), commit('Two\n\nMore')], 'b', 'verbose').body, '- One\n- Two\n  \n  More');
});

/** cliActor() with only these agent variables set. */
function actorWith(env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    for (const k of ['GALLEY_ACTOR', 'GALLEY_ACTOR_TYPE', 'CLAUDECODE', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'OPENCODE']) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    return cliActor();
  } finally {
    process.env = saved;
  }
}

test('an author agent running in Codex is not named like the Codex reviewer', () => {
  assert.deepEqual(actorWith({ CODEX_SANDBOX: 'seatbelt' }), { login: 'codex-agent', type: 'Bot' });
  // Installed without npm and run with its own sandbox off, Codex still sets its thread id.
  assert.deepEqual(actorWith({ CODEX_THREAD_ID: '01a1463b-126d-75c0-bff2-6194ba586de8' }), { login: 'codex-agent', type: 'Bot' });
});

test('the CLI detects the agent running it, also when Claude Code started that agent', () => {
  assert.deepEqual(actorWith({ CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'claude', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1' }), { login: 'opencode', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1', CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'opencode', type: 'Bot' });
  assert.deepEqual(actorWith({ CODEX_THREAD_ID: 'x', CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'codex-agent', type: 'Bot' });
  assert.deepEqual(actorWith({ AI_AGENT: 'gemini_1_agent' }), { login: 'gemini', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1', GALLEY_ACTOR: 'reviewer' }), { login: 'reviewer', type: 'Bot' });
});

test('the CLI names its caller in X-Galley-Actor and X-Galley-Actor-Type', async () => {
  let heard: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    heard = req.headers;
    res.end(JSON.stringify(req.url === '/api/meta' ? META : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...process.env };
  try {
    process.env.GALLEY_ACTOR = 'agent';
    await new Client(`http://127.0.0.1:${(server.address() as { port: number }).port}`).get('/api/health');
  } finally {
    process.env = saved;
    server.close();
  }
  assert.equal(heard['x-galley-actor'], 'agent');
  assert.equal(heard['x-galley-actor-type'], 'Bot');
});

/** A server on a free local port that answers each path as `answer` says (404 for null), and notes the paths asked for. */
async function fake(t: TestContext, answer: (path: string) => [number, unknown] | null) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    const [status, body] = answer(req.url!) ?? [404, { message: 'Not Found' }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

test('the CLI makes sure galley answers before its first request', async (t) => {
  // Another program on the port hears only the question.
  const other = await fake(t, () => [200, { name: 'something else' }]);
  await assert.rejects(new Client(other.url).get('/api/repos'), /something other than galley answers at http:\/\/127\.0\.0\.1:\d+\. Stop it, or run galley on another port with GALLEY_PORT/);
  assert.deepEqual(other.paths, ['/api/meta']);
  // galley that is still starting is waited for.
  let starting = 2;
  const later = await fake(t, (path) => (path === '/api/meta' ? [starting-- > 0 ? 503 : 200, META] : [200, []]));
  assert.deepEqual(await new Client(later.url).get('/api/repos'), []);
  assert.deepEqual(later.paths, ['/api/meta', '/api/meta', '/api/meta', '/api/repos']);
  // Links are checked too, with no request of their own.
  assert.equal(await new Client(later.url).url('/settings'), `${later.url}/settings`);
  assert.deepEqual(later.paths.slice(4), ['/api/meta']);
  // A program that takes the connection and never answers: galley stuck, or another one.
  const sockets: Socket[] = [];
  const silent = createTcpServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
  await assert.rejects(new Client(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`).get('/api/repos'), /nothing answered at http:\/\/127\.0\.0\.1:\d+ within 5 seconds: galley may be stuck there, or another program holds the port/);
});

test("--help prints a command's usage without running it", async (t) => {
  const server = await fake(t, () => [200, META]);
  const home = mkdtempSync(join(tmpdir(), 'galley-help-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // serve without --help would find the port taken and ask what holds it.
  const env = { ...process.env, GALLEY_URL: server.url, GALLEY_PORT: new URL(server.url).port, GALLEY_HOME: home, GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' };
  // Rejects unless the command exits with 0.
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), ...args], { cwd: home, env, timeout: 20_000 });
  // Without --help, each would close, publish or wait on s#1.
  for (const [cmd, flag] of [['close', '--comment'], ['publish', '--during-review'], ['wait', '--timeout']]) {
    const { stdout } = await run('pr', cmd, 's1', '--repo', 'o/r', '--help');
    assert.match(stdout, new RegExp(`^USAGE\\n  galley pr ${cmd} `, 'm'));
    assert.match(stdout, new RegExp(`^ +(-\\w, )?${flag} `, 'm'));
  }
  assert.match((await run('pr', 'reopen', '-h')).stdout, /^  galley pr reopen /m);
  assert.match((await run('serve', '--help')).stdout, /^  galley serve \[flags\]\n[\s\S]*^  -p, --port <number> /m);
  assert.deepEqual(server.paths, []);
});

test('pr create --reviewer takes repeats and commas like gh, and a number of reviews', () => {
  assert.deepEqual(parseReviewers(['octocat,codex:2', ' alice ', 'codex']), [
    { login: 'octocat' },
    { login: 'codex', max_iterations: 2 },
    { login: 'alice' },
    { login: 'codex' },
  ]);
  assert.deepEqual(parseReviewers(['a,,b,']), [{ login: 'a' }, { login: 'b' }]);
  for (const bad of ['codex:two', 'codex:', ':3', 'codex:-1']) assert.throws(() => parseReviewers([bad]), /invalid reviewer/, bad);
});

test('whoReviews names the reviewer agents that review a pull request on their own, by what they read', () => {
  const agent = (login: string, reviews: 'code' | 'description', automatic = true) => ({ login, reviewer: login, engine: 'claude', reviews, automatic, max_iterations: 3 });
  assert.equal(
    whoReviews([agent('codex-review', 'code'), agent('claude-review', 'code'), agent('house-rules', 'description')]),
    'When you wait, codex-review and claude-review review the code, and house-rules the title, description and commit messages.',
  );
  assert.equal(whoReviews([agent('codex-review', 'code', false)]), 'No reviewer agent reviews it.');
});

test('priorities: validated, and moved out of "[P1]"-style prefixes', () => {
  assert.equal(checkPriority('High'), 'high');
  assert.equal(checkPriority(''), null);
  assert.throws(() => checkPriority('urgent'), /priority must be one of high, medium, low/);
  assert.deepEqual(splitPriorityPrefix('[P1] Fix the guard\n\nDetails.'), { priority: 'high', body: 'Fix the guard\n\nDetails.' });
  assert.deepEqual(splitPriorityPrefix('[P0] Data loss'), { priority: 'high', body: 'Data loss' });
  assert.deepEqual(splitPriorityPrefix('[P2] Rename'), { priority: 'medium', body: 'Rename' });
  assert.deepEqual(splitPriorityPrefix('[P3] Typo'), { priority: 'low', body: 'Typo' });
  assert.deepEqual(splitPriorityPrefix('No prefix [P1] here'), { priority: null, body: 'No prefix [P1] here' });
});
