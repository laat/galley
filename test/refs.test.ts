// The refs a server keeps in the repositories it stages from: in a namespace of its own, and
// never moved or deleted from where someone else put them.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

let dir: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A branch off main with a commit of its own; returns its head. */
function branch(name: string): string {
  git('checkout', '-qb', name, 'main');
  writeFileSync(join(repo, `${name.replace('/', '-')}.txt`), `${name}\n`);
  git('add', '.');
  git('commit', '-qm', `Add ${name}`);
  return git('rev-parse', 'HEAD');
}

/** Rewrite the branch's commit, as an agent does; returns the new head. */
function amend(name: string): string {
  git('checkout', '-q', name);
  git('commit', '-q', '--amend', '-m', `Add ${name}, reworded`);
  return git('rev-parse', 'HEAD');
}

function refs(prefix = 'refs/galley/'): Record<string, string> {
  const out = git('for-each-ref', '--format=%(refname) %(objectname)', prefix);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((line) => line.split(' ')));
}

/** A server: a database in a data directory of its own, and the service on it. */
function server(data = mkdtempSync(join(dir, 'data-'))): { db: Db; s: Service; data: string } {
  const db = new Db(join(data, 'galley.db'));
  return { db, s: new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' }), data };
}

async function stage(s: Service, head: string) {
  return s.createPull(await s.registerRepo(repo), { title: head, head, base: 'main' }, s.db.actor('agent', 'Bot'));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'galley-refs-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# widgets\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('two servers staging from one repository keep to their own refs', async () => {
  const a = server();
  const b = server();
  try {
    assert.notEqual(a.db.instance, b.db.instance);
    const first = branch('feature/a');
    const theirs = branch('feature/b');
    // Each numbers its pull requests from its own database: both stage a pull request 1.
    const pull = await stage(a.s, 'feature/a');
    const other = await stage(b.s, 'feature/b');
    assert.deepEqual([pull.number, other.number], [1, 1]);
    const second = amend('feature/a');
    await a.s.sync(pull);
    assert.deepEqual(refs(), {
      [`refs/galley/${a.db.instance}/pull/1/1`]: first,
      [`refs/galley/${a.db.instance}/pull/1/2`]: second,
      [`refs/galley/${b.db.instance}/pull/1/1`]: theirs,
    });
    // Deleting its pull request takes only its own refs.
    await b.s.deletePull(await b.s.ctx('local', 'repo', 1, { sync: false }), b.s.viewer());
    assert.deepEqual(refs(), {
      [`refs/galley/${a.db.instance}/pull/1/1`]: first,
      [`refs/galley/${a.db.instance}/pull/1/2`]: second,
    });
  } finally {
    a.db.sql.close();
    b.db.sql.close();
  }
});

test('a ref that is not where the server left it is left alone, and logged', async () => {
  const { db, s } = server();
  const errors = mock.method(console, 'error', () => {});
  try {
    branch('feature/c');
    const elsewhere = git('rev-parse', 'main');
    const ref = `refs/galley/${db.instance}/pull/1/1`;
    git('update-ref', ref, elsewhere);
    const pull = await stage(s, 'feature/c');
    assert.equal(git('rev-parse', ref), elsewhere);
    await s.deletePull(await s.ctx('local', 'repo', pull.number, { sync: false }), s.viewer());
    assert.equal(git('rev-parse', ref), elsewhere);
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.equal(logged.length, 2);
    assert.match(logged[0], new RegExp(`^left ${ref} alone in .*: .*reference already exists`));
    assert.match(logged[1], new RegExp(`^left ${ref} alone in .*: .*is at ${elsewhere} but expected ${pull.head_sha}`));
  } finally {
    errors.mock.restore();
    db.sql.close();
  }
});

test('a copied database pins the revisions it came with, so the original deleting its own leaves them', async () => {
  const before = server();
  const first = branch('feature/d');
  const pull = await stage(before.s, 'feature/d');
  const second = amend('feature/d');
  await before.s.sync(pull);
  // Published as a signed copy, which nothing else here points at.
  const signed = git('commit-tree', `${second}^{tree}`, '-p', 'main', '-m', 'Add feature/d, signed');
  before.db.run('UPDATE pulls SET published_source_sha = ?, published_head_sha = ? WHERE id = ?', second, signed, pull.id);
  before.db.sql.close();
  const copied = mkdtempSync(join(dir, 'data-'));
  copyFileSync(join(before.data, 'galley.db'), join(copied, 'galley.db'));
  const original = server(before.data);
  const copy = server(copied);
  try {
    await copy.s.pinRevisions();
    assert.deepEqual(refs(`refs/galley/${copy.db.instance}/`), {
      [`refs/galley/${copy.db.instance}/pull/1/1`]: first,
      [`refs/galley/${copy.db.instance}/pull/1/2`]: second,
      [`refs/galley/${copy.db.instance}/pull/1/published`]: signed,
    });
    await original.s.deletePull(await original.s.ctx('local', 'repo', 1, { sync: false }), original.s.viewer());
    assert.deepEqual(refs(`refs/galley/${original.db.instance}/`), {});
    // The rewritten first revision and the signed copy are reachable from the copy's refs alone, and survive garbage collection.
    git('reflog', 'expire', '--expire=now', '--all');
    git('gc', '-q', '--prune=now');
    assert.equal(git('cat-file', '-t', first), 'commit');
    assert.equal(git('cat-file', '-t', signed), 'commit');
  } finally {
    original.db.sql.close();
    copy.db.sql.close();
  }
});

test('pins that failed at startup are tried again on the next start, while they can still succeed', async () => {
  const before = server();
  branch('feature/f');
  const pull = await stage(before.s, 'feature/f');
  const second = amend('feature/f');
  await before.s.sync(pull);
  before.db.sql.close();
  const copied = mkdtempSync(join(dir, 'data-'));
  copyFileSync(join(before.data, 'galley.db'), join(copied, 'galley.db'));
  let copy = server(copied);
  // The first revision's commit is gone, and with it what its pin was for.
  copy.db.run('UPDATE revisions SET head_sha = ? WHERE seq = 1', 'f'.repeat(40));
  // A git that crashed left a lock where the second revision's pin goes.
  const lock = join(repo, '.git', 'refs', 'galley', copy.db.instance, 'pull', '1', '2.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '');
  // Something else already holds the third pin's name: retrying would not change that.
  copy.db.run('INSERT INTO revisions (pull_id, seq, head_sha, base_sha, actor_id, created_at) SELECT pull_id, 3, ?, base_sha, actor_id, created_at FROM revisions WHERE seq = 2', second);
  const elsewhere = git('rev-parse', 'main');
  git('update-ref', `refs/galley/${copy.db.instance}/pull/1/3`, elsewhere);
  const errors = mock.method(console, 'error', () => {});
  try {
    await copy.s.pinRevisions();
    assert.deepEqual(refs(`refs/galley/${copy.db.instance}/`), { [`refs/galley/${copy.db.instance}/pull/1/3`]: elsewhere });
    assert.equal(errors.mock.calls.length, 3);
    rmSync(lock);
    copy.db.sql.close();
    copy = server(copied);
    await copy.s.pinRevisions();
    assert.deepEqual(refs(`refs/galley/${copy.db.instance}/`), {
      [`refs/galley/${copy.db.instance}/pull/1/2`]: second,
      [`refs/galley/${copy.db.instance}/pull/1/3`]: elsewhere,
    });
    assert.equal(errors.mock.calls.length, 5, 'what could not be pinned is logged again');
    // Every pin that can be is in place: later starts leave it at that.
    copy.db.sql.close();
    copy = server(copied);
    await copy.s.pinRevisions();
    assert.equal(errors.mock.calls.length, 5);
  } finally {
    errors.mock.restore();
    copy.db.sql.close();
  }
});

test('a database from before namespaces pins its revisions in one, and leaves the refs outside it', async () => {
  const before = server();
  const first = branch('feature/e');
  const pull = await stage(before.s, 'feature/e');
  const second = amend('feature/e');
  await before.s.sync(pull);
  // As an older galley left it: no instance id, its revisions pinned outside any namespace.
  for (const [seq, sha] of [[1, first], [2, second]] as const) {
    git('update-ref', `refs/shared/pull/1/${seq}`, sha);
    git('update-ref', '-d', `refs/galley/${before.db.instance}/pull/1/${seq}`);
  }
  before.db.run("DELETE FROM meta WHERE key IN ('instance_id', 'data_dir', 'pinned_namespace')");
  before.db.sql.close();
  const { db, s } = server(before.data);
  const errors = mock.method(console, 'error', () => {});
  try {
    await s.pinRevisions();
    assert.deepEqual(refs(`refs/galley/${db.instance}/`), {
      [`refs/galley/${db.instance}/pull/1/1`]: first,
      [`refs/galley/${db.instance}/pull/1/2`]: second,
    });
    // A copy of the database from before may count on the old refs: deleting leaves them.
    await s.deletePull(await s.ctx('local', 'repo', pull.number, { sync: false }), s.viewer());
    assert.deepEqual(refs(`refs/galley/${db.instance}/`), {});
    assert.deepEqual(refs('refs/shared/pull/'), { 'refs/shared/pull/1/1': first, 'refs/shared/pull/1/2': second });
    assert.deepEqual(errors.mock.calls, []);
  } finally {
    errors.mock.restore();
    db.sql.close();
  }
});
