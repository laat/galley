// Repositories registered by path, from before galley kept clones of its own: each moves into a
// clone when the server starts, with what galley has in it, and nothing is written there.
import '../helpers/env.ts';
import { BIN, dir, exec, git, remote, repo, reviewCheckouts, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Db, type RepoRow } from '../../src/server/db.ts';

startHarness();

test('a repository registered by path moves into a clone of galley’s own when the server starts, with what galley has in it', async (t) => {
  const data = mkdtempSync(join(dir, 'migrated-'));
  const at = new Date().toISOString();
  // As an older galley left the user's repository and its database: pull request 1 merged on
  // GitHub, its first revision amended away and its last published as a signed copy, all kept by
  // pins; pull request 2 open, its branch here; and main as galley last fetched it from GitHub.
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/done');
  writeFileSync(join(repo, 'done.js'), 'export const done = 1;\n');
  git('add', 'done.js');
  git('commit', '-qm', 'Add done.js');
  const amended = git('rev-parse', 'HEAD');
  git('commit', '-q', '--amend', '-m', 'Add done.js, reworded');
  const done = git('rev-parse', 'HEAD');
  const signed = git('commit-tree', `${done}^{tree}`, '-p', 'main', '-m', 'Add done.js, reworded (signed)');
  git('checkout', '-q', 'main');
  git('branch', '-qD', 'feature/done');
  git('checkout', '-qb', 'feature/open');
  writeFileSync(join(repo, 'open.js'), 'export const open = 1;\n');
  git('add', 'open.js');
  git('commit', '-qm', 'Add open.js');
  const open = git('rev-parse', 'HEAD');
  const main = git('rev-parse', 'main');
  // main moved on GitHub, and galley fetched it into origin/main here.
  const fetched = execFileSync('git', ['--git-dir', remote, 'commit-tree', `${main}^{tree}`, '-p', main, '-m', 'Merged on GitHub'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', fetched]);
  git('fetch', '-q', remote, '+refs/heads/main:refs/remotes/origin/main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const db = new Db(join(data, 'galley.db'));
  const namespace = `refs/galley/${db.instance}`;
  const agent = db.actor('agent', 'Bot');
  const gitDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const pull = (repoId: number, number: number, head: string, sha: string, more: Record<string, string> = {}) => {
    const id = db.insert('pulls', { repo_id: repoId, number, title: `Pull ${number}`, base_ref: 'main', head_ref: head, head_sha: sha, base_sha: main, author_id: agent.id, created_at: at, updated_at: at, author_seen_at: at, ...more });
    return id;
  };
  const widgets = db.insert('repos', { git_dir: gitDir, work_dir: repo, owner: 'acme', name: 'widgets', remote: 'origin', github_slug: 'acme/widgets', created_at: at });
  const merged = pull(widgets, 1, 'feature/done', done, { state: 'published', published_url: 'https://github.com/acme/widgets/pull/7', published_at: at, published_head_sha: signed, published_source_sha: done, github_state: 'merged' });
  for (const [seq, sha] of [[1, amended], [2, done]] as const) db.insert('revisions', { pull_id: merged, seq, head_sha: sha, base_sha: main, actor_id: agent.id, created_at: at });
  const staged = pull(widgets, 2, 'feature/open', open);
  db.insert('revisions', { pull_id: staged, seq: 1, head_sha: open, base_sha: main, actor_id: agent.id, created_at: at });
  for (const [ref, sha] of [['pull/1/1', amended], ['pull/1/2', done], ['pull/1/published', signed], ['pull/2/1', open]]) git('update-ref', `${namespace}/${ref}`, sha);
  // One whose path is gone; one whose remote names no GitHub repository, with an open pull request
  // galley pinned there; another checkout of acme/widgets, registered as acme/widgets-2; and a
  // shallow one.
  const gone = db.insert('repos', { git_dir: join(dir, 'gone', '.git'), work_dir: join(dir, 'gone'), owner: 'acme', name: 'gone', remote: 'origin', github_slug: 'acme/gone', created_at: at });
  pull(gone, 1, 'feature/gone', open);
  const local = join(dir, 'local-only');
  const inLocal = (...args: string[]) => execFileSync('git', ['-C', local, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  writeFileSync(join(local, 'a.js'), 'export const a = 1;\n');
  inLocal('add', 'a.js');
  inLocal('commit', '-qm', 'Initial commit');
  inLocal('checkout', '-qb', 'feature/local');
  writeFileSync(join(local, 'a.js'), 'export const a = 2;\n');
  inLocal('commit', '-qam', 'Change a');
  const localHead = inLocal('rev-parse', 'HEAD');
  inLocal('update-ref', `${namespace}/pull/1/1`, localHead);
  const localId = db.insert('repos', { git_dir: join(local, '.git'), work_dir: local, owner: 'local', name: 'local-only', remote: 'origin', github_slug: null, created_at: at });
  const localPull = pull(localId, 1, 'feature/local', localHead, { base_sha: inLocal('rev-parse', 'main') });
  db.insert('revisions', { pull_id: localPull, seq: 1, head_sha: localHead, base_sha: inLocal('rev-parse', 'main'), actor_id: agent.id, created_at: at });
  const twin = join(dir, 'widgets-twin');
  execFileSync('git', ['clone', '-q', repo, twin]);
  const twinId = db.insert('repos', { git_dir: join(twin, '.git'), work_dir: twin, owner: 'acme', name: 'widgets-2', remote: 'origin', github_slug: 'acme/widgets', created_at: at });
  const shallow = join(dir, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${remote}`, shallow]);
  const shallowHead = execFileSync('git', ['-C', shallow, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', shallow, 'update-ref', `${namespace}/pull/1/1`, shallowHead]);
  const shallowId = db.insert('repos', { git_dir: join(shallow, '.git'), work_dir: shallow, owner: 'acme', name: 'shallow', remote: 'origin', github_slug: 'acme/shallow', created_at: at });
  const shallowPull = pull(shallowId, 1, 'main', shallowHead, { state: 'closed' });
  db.insert('revisions', { pull_id: shallowPull, seq: 1, head_sha: shallowHead, base_sha: shallowHead, actor_id: agent.id, created_at: at });
  // acme/moved, renamed from acme/before as galley followed it, whose first checkout is gone and whose second is here.
  const movedGone = db.insert('repos', { git_dir: join(dir, 'moved-gone', '.git'), work_dir: join(dir, 'moved-gone'), owner: 'acme', name: 'moved', remote: 'origin', github_slug: 'acme/moved', created_at: at });
  db.run('INSERT INTO repo_aliases (owner, name, repo_id) VALUES (?, ?, ?)', 'acme', 'before', movedGone);
  const movedHere = join(dir, 'moved-here');
  execFileSync('git', ['clone', '-q', repo, movedHere]);
  const movedId = db.insert('repos', { git_dir: join(movedHere, '.git'), work_dir: movedHere, owner: 'acme', name: 'moved-2', remote: 'origin', github_slug: 'acme/moved', created_at: at });
  db.setMeta('pinned_namespace', namespace);
  db.sql.close();

  /** What the user's repository has: refs, config and worktrees, which galley only reads. */
  const userRepository = () => [git('for-each-ref', '--format=%(refname) %(objectname) %(symref)'), git('config', '--list', '--local'), git('worktree', 'list', '--porcelain')];
  const before = userRepository();
  const options = {
    port: 0,
    dataDir: data,
    ghBin: join(dir, 'gh'),
    codexBin: join(dir, 'codex'),
    reviewersDir: join(data, 'reviewers'),
    viewerLogin: 'reviewer',
    pollMs: 50,
    followMs: 60 * 60_000,
    githubUrl: (slug: string) => (slug === 'acme/widgets' ? remote : join(dir, `${slug.split('/')[1]}.git`)),
  };
  const logged: string[] = [];
  const log = (...args: unknown[]) => void logged.push(args.join(' '));
  t.mock.method(console, 'log', log);
  t.mock.method(console, 'error', log);
  let server = await startServer(options);
  try {
    const rows = () => server.service.db.all<RepoRow>('SELECT * FROM repos ORDER BY id');
    const clone = (...args: string[]) => execFileSync('git', ['--git-dir', join(data, 'repos', `${widgets}.git`), ...args], { encoding: 'utf8' }).trim();
    assert.deepEqual(
      rows().map((r) => [r.id, r.git_dir, r.work_dir, r.remote]),
      [
        [widgets, `repos/${widgets}.git`, null, 'origin'],
        [gone, join(dir, 'gone', '.git'), join(dir, 'gone'), 'origin'],
        [localId, join(local, '.git'), local, 'origin'],
        [twinId, join(twin, '.git'), twin, 'origin'],
        [shallowId, `repos/${shallowId}.git`, null, 'origin'],
        [movedGone, join(dir, 'moved-gone', '.git'), join(dir, 'moved-gone'), 'origin'],
        [movedId, `repos/${movedId}.git`, null, 'origin'],
      ],
    );
    // From a shallow repository, as shallow.
    const shallowClone = (...args: string[]) => execFileSync('git', ['--git-dir', join(data, 'repos', `${shallowId}.git`), ...args], { encoding: 'utf8' }).trim();
    assert.equal(shallowClone('rev-parse', `${namespace}/pull/1/1`), shallowHead);
    assert.equal(shallowClone('rev-parse', '--is-shallow-repository'), 'true');
    // The clone has what galley pins, the open pull request's branch, and the base as galley fetched it.
    assert.deepEqual(
      clone('for-each-ref', '--format=%(refname) %(objectname)').split('\n'),
      [
        `${namespace}/pull/1/1 ${amended}`,
        `${namespace}/pull/1/2 ${done}`,
        `${namespace}/pull/1/published ${signed}`,
        `${namespace}/pull/2/1 ${open}`,
        `refs/heads/feature/open ${open}`,
        `refs/remotes/origin/HEAD ${fetched}`,
        `refs/remotes/origin/main ${fetched}`,
      ],
    );
    assert.equal(clone('symbolic-ref', 'HEAD'), 'refs/remotes/origin/main');
    assert.equal(clone('symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.equal(clone('config', 'remote.origin.url'), remote);
    // Nothing was written to the user's repository.
    assert.deepEqual(userRepository(), before);
    assert.deepEqual(logged.filter((l) => !l.startsWith('asking GitHub')), [
      `moved acme/widgets from ${gitDir} into galley's own clone, ${join(data, 'repos', `${widgets}.git`)}, with 6 of its refs`,
      `left acme/gone at ${join(dir, 'gone', '.git')} where it was: it is gone`,
      `left local/local-only at ${join(local, '.git')} where it is: its remote names no GitHub repository, and galley keeps clones of GitHub repositories only`,
      `left acme/widgets-2 at ${join(twin, '.git')} where it is: galley keeps one clone of acme/widgets, acme/widgets`,
      `moved acme/shallow from ${join(shallow, '.git')} into galley's own clone, ${join(data, 'repos', `${shallowId}.git`)}, with 2 of its refs`,
      `left acme/moved at ${join(dir, 'moved-gone', '.git')} where it was: it is gone`,
      `moved acme/moved-2 from ${join(movedHere, '.git')} into galley's own clone, ${join(data, 'repos', `${movedId}.git`)}, with 1 of its refs`,
    ]);

    // Its pages show what it had, the merged pull request's revisions too.
    for (const path of ['/', '/acme/widgets/pull/1', '/acme/widgets/pull/1/files', `/acme/widgets/pull/1/files?range=${amended}..${done}`, '/acme/widgets/pull/2/files', '/local/local-only']) {
      const res = await fetch(server.url + path);
      assert.equal(res.status, 200, path);
    }
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/1/files`)).text(), /done\.js/);
    // One left where it is is only read: its page checks for no conflicts there, and deleting its pull request leaves its pin.
    const objects = () => inLocal('count-objects');
    const was = objects();
    assert.equal((await fetch(`${server.url}/local/local-only/pull/1`)).status, 200);
    await server.service.conflictChecks;
    assert.equal(objects(), was);
    assert.equal((await fetch(`${server.url}/api/repos/local/local-only/pulls/1`, { method: 'DELETE' })).status, 204);
    assert.equal(inLocal('rev-parse', `${namespace}/pull/1/1`), localHead);
    // Another checkout of a GitHub repository galley has a clone of registers as that one.
    const twinRegistered = await (await fetch(`${server.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github: 'acme/widgets' }) })).json();
    assert.equal(twinRegistered.id, widgets);
    // So does one of a GitHub repository whose first checkout is gone, by its name and by one it had before.
    for (const github of ['acme/moved', 'acme/before']) {
      assert.equal((await (await fetch(`${server.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github }) })).json()).id, movedId, github);
    }

    // The agent's next commit reaches the clone through the CLI, and is a revision when its wait returns.
    git('checkout', '-q', 'feature/open');
    writeFileSync(join(repo, 'open.js'), 'export const open = 2;\n');
    git('commit', '-qam', 'Change open.js');
    const next = git('rev-parse', 'HEAD');
    const env = { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' };
    const waited = await exec(process.execPath, [BIN, 'pr', 'wait', '2', '--timeout', '20s'], { cwd: repo, env });
    assert.match(waited.stderr, new RegExp(`^Sent feature/open at ${next.slice(0, 7)} to galley\\.$`, 'm'));
    assert.deepEqual(server.service.revisions(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', staged)).map((r) => r.head_sha), [open, next]);
    assert.equal(clone('rev-parse', `${namespace}/pull/2/2`), next);
    // A reviewer agent reviews it in a worktree of the clone.
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }) }, async () => {
      const asked = await fetch(`${server.url}/api/repos/acme/widgets/pulls/2/reviewers/codex`, { method: 'POST' });
      assert.equal(asked.status, 202);
      await server.service.codex!.settle(staged);
    });
    const { runs } = await (await fetch(`${server.url}/api/repos/acme/widgets/pulls/2/reviewers/codex`)).json();
    assert.deepEqual(runs.map((r: any) => [r.head_sha, r.status]), [[next, 'done']]);
    assert.deepEqual(reviewCheckouts(join(data, 'repos', `${widgets}.git`)), []);
    assert.doesNotMatch(git('worktree', 'list', '--porcelain'), /galley-review-/);

    // A second start moves nothing, and says again what it left.
    await server.close();
    logged.length = 0;
    const refs = clone('for-each-ref', '--format=%(refname) %(objectname)');
    server = await startServer(options);
    assert.deepEqual(rows().map((r) => r.git_dir), [`repos/${widgets}.git`, join(dir, 'gone', '.git'), join(local, '.git'), join(twin, '.git'), `repos/${shallowId}.git`, join(dir, 'moved-gone', '.git'), `repos/${movedId}.git`]);
    assert.equal(clone('for-each-ref', '--format=%(refname) %(objectname)'), refs);
    assert.deepEqual(logged.filter((l) => !l.startsWith('asking GitHub')).map((l) => l.split(' at ')[0]), ['left acme/gone', 'left local/local-only', 'left acme/widgets-2', 'left acme/moved']);
    // Registered by its GitHub name, as the CLI does, the one whose path is gone is cloned from GitHub then.
    execFileSync('git', ['clone', '-q', '--bare', remote, join(dir, 'gone.git')]);
    const registered = await (await fetch(`${server.url}/api/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ github: 'acme/gone' }) })).json();
    assert.deepEqual([registered.id, registered.full_name, registered.git_dir, registered.git_url], [gone, 'acme/gone', join(data, 'repos', `${gone}.git`), `${server.url}/git/acme/gone.git`]);
  } finally {
    await server.close();
    git('checkout', '-q', 'feature/mul');
  }
});
