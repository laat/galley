// What is the user's to do, as docs/api.md lists it: an agent is refused each, through the API and
// in Service, so a caller inside the server can not do it for an agent either. Publishing and
// auto-publish are the author's too: only other agents are refused those.
import './helpers/env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/server.ts';
import { HttpError } from '../src/server/service.ts';

let dir: string;
let repo: string;
let server: Awaited<ReturnType<typeof startServer>>;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A request to the API, as the agent with `actor`, or as the user without. */
async function call(method: string, path: string, body?: unknown, actor?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = body ? { 'content-type': 'application/json' } : {};
  if (actor) headers['x-galley-actor'] = actor;
  const res = await fetch(server.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-human-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  // GitHub's acme/repo, which galley's clone fetches from.
  const remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git('push', '-q', remote, 'main');
  git('checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  git('commit', '-qam', 'Add mul');
  // Nothing here runs gh, Codex or Claude: each is refused first.
  server = await startServer({ port: 0, dataDir: join(dir, 'data'), ghBin: 'false', codexBin: 'false', claudeBin: 'false', reviewersDir: join(dir, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000, followMs: 60 * 60_000, githubUrl: () => remote });
});

after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an agent is refused each of the user's actions that docs/api.md lists, through the API and in Service, and another than the author publishing too", async () => {
  const registered = await call('POST', '/api/repos', { github: 'acme/repo' });
  assert.equal(registered.status, 200);
  // The agent's branch, as the CLI sends it.
  git('push', '-q', registered.body.git_dir, 'feature/mul');
  const created = await call('POST', '/api/repos/acme/repo/pulls', { title: 'Add mul', head: 'feature/mul', base: 'main' }, 'agent');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pull = `/api/repos/acme/repo/pulls/${created.body.number}`;
  const s = server.service;
  const agent = s.db.actor('agent', 'Bot');
  const other = s.db.actor('other', 'Bot');
  const x = await s.ctx('acme', 'repo', created.body.number);
  const before = { pull: (await call('GET', pull)).body, settings: (await call('GET', '/api/settings')).body };
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'api.md'), 'utf8');

  // Publishing and auto-publish are the author's as well: refused for another agent.
  assert.match(doc, /^- Publishing and turning auto-publish on or off are the user's and the pull request's author's: other callers of type `Bot`/m);
  for (const [method, path, body] of [['POST', `${pull}/publish`, { sign: false }], ['PUT', `${pull}/auto-publish`, { sign: false }], ['DELETE', `${pull}/auto-publish`]] as const) {
    const r = await call(method, path, body, 'other');
    assert.equal(r.status, 403, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /^only the user or the author of this pull request \(agent\) can .*, not other$/);
  }
  for (const f of [() => s.publish(x, { sign: false }, other), () => s.enableAutoPublish(x, { sign: false }, other), async () => s.disableAutoPublish(x, other)]) {
    await assert.rejects(f(), (e) => e instanceof HttpError && e.status === 403, String(f));
  }

  // Each item of the list, with the API calls that do it, and the Service calls behind them (settings have none), refused for the author.
  const walk: Record<string, { api: [string, string, unknown?][]; service: (() => unknown)[] }> = {
    deleting: { api: [['DELETE', pull]], service: [() => s.deletePull(x, agent)] },
    pinning: { api: [['PUT', `${pull}/pinned`], ['DELETE', `${pull}/pinned`]], service: [() => s.setPinned(x.pull, true, agent), () => s.setPinned(x.pull, false, agent)] },
    'dismissing their turn': {
      api: [['PUT', `${pull}/dismissed`], ['DELETE', `${pull}/dismissed`]],
      service: [() => s.dismissTurn(x, agent), () => s.undismissTurn(x, agent)],
    },
    'stop-iterating': {
      api: [['PUT', `${pull}/stop-iterating`], ['DELETE', `${pull}/stop-iterating`]],
      service: [() => s.stopIterating(x, agent), () => s.resumeIterating(x, agent)],
    },
    settings: {
      api: [
        ['PUT', '/api/settings/codex', { enabled: true }],
        ['PUT', '/api/settings/claude', { enabled: true }],
        ['PUT', '/api/settings/publish', { mergeMethod: 'rebase' }],
        ['POST', '/api/settings/reviewers', { name: 'mine', engine: 'codex' }],
        ['PATCH', '/api/settings/reviewers/mine', { effort: 'low' }],
        ['DELETE', '/api/settings/reviewers/mine'],
      ],
      service: [],
    },
    'asking for or configuring a reviewer agent': {
      api: [['POST', `${pull}/reviewers/codex`], ['PATCH', `${pull}/reviewers/codex`, { enabled: false, max_iterations: 0 }]],
      service: [() => s.codex!.request(x, agent), () => s.codex!.configure(x, { enabled: false, max_iterations: 0 }, agent)],
    },
  };
  const listed = doc.match(/get 403 from what is the user's to do: ([^.]+)\./)![1];
  assert.deepEqual(Object.keys(walk), listed.split(/, (?:and )?/));

  for (const [what, { api, service }] of Object.entries(walk)) {
    for (const [method, path, body] of api) {
      const r = await call(method, path, body, 'agent');
      assert.equal(r.status, 403, `${what}: ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const f of service) {
      await assert.rejects(async () => f(), (e) => e instanceof HttpError && e.status === 403, `${what}: ${f}`);
    }
  }
  // Nothing changed, and no review started.
  assert.deepEqual({ pull: (await call('GET', pull)).body, settings: (await call('GET', '/api/settings')).body }, before);
  assert.deepEqual(s.codex!.runs(x.pull), []);
  assert.deepEqual((await call('GET', '/api/settings/reviewers')).body, []);
});
