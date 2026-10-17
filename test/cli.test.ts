import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { setField } from '../src/cli/api.ts';
import { parseDuration } from '../src/cli/output.ts';
import { parseReviewers } from '../src/cli/pr.ts';
import { checkPriority, fillFromCommits, splitPriorityPrefix } from '../src/server/service.ts';
import { Client } from '../src/cli/client.ts';
import { cliActor } from '../src/config.ts';
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
    for (const k of ['GALLEY_ACTOR', 'GALLEY_ACTOR_TYPE', 'LAATSUX_ACTOR', 'LAATSUX_ACTOR_TYPE', 'CLAUDECODE', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'OPENCODE']) {
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

test('the names from before the rename still work: the laatsux command, LAATSUX_ variables and X-Laatsux- headers', async () => {
  assert.equal(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'laatsux.ts'), '--version'], { encoding: 'utf8' }), 'galley version 0.1.0\n');
  assert.deepEqual(actorWith({ LAATSUX_ACTOR: 'reviewer', LAATSUX_ACTOR_TYPE: 'User' }), { login: 'reviewer', type: 'User' });
  assert.deepEqual(actorWith({ LAATSUX_ACTOR: 'before', GALLEY_ACTOR: 'after' }), { login: 'after', type: 'Bot' });
  // The CLI names its caller with both headers, so a server that has not restarted since knows it too.
  let heard: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    heard = req.headers;
    res.end('{}');
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
  for (const name of ['galley', 'laatsux']) {
    assert.equal(heard[`x-${name}-actor`], 'agent');
    assert.equal(heard[`x-${name}-actor-type`], 'Bot');
  }
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
