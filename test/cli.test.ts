import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setField } from '../src/cli/api.ts';
import { parseDuration } from '../src/cli/output.ts';
import { fillFromCommits } from '../src/server/service.ts';
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

test('an author agent running in Codex is not named like the Codex reviewer', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['LAATSUX_ACTOR', 'CLAUDECODE', 'AI_AGENT', 'CODEX_MANAGED_BY_NPM']) delete process.env[k];
    process.env.CODEX_SANDBOX = 'seatbelt';
    assert.deepEqual(cliActor(), { login: 'codex-agent', type: 'Bot' });
  } finally {
    process.env = saved;
  }
});
