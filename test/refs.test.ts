// The refs a server keeps in its clones: in a namespace of its own, and never moved or deleted
// from where someone else put them.
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

let dir: string;
let repo: string;
/** GitHub's acme/repo, which the servers' clones fetch from. */
let remote: string;

const env = { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
}

/** git in the server's clone. */
function inClone(s: Service, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', s.gitDir(s.repos()[0]), ...args], { encoding: 'utf8', env }).trim();
}

/** A branch off main with a commit of its own; returns its head. */
function branch(name: string): string {
  git('checkout', '-qb', name, 'main');
  writeFileSync(join(repo, `${name.replace('/', '-')}.txt`), `${name}\n`);
  git('add', '.');
  git('commit', '-qm', `Add ${name}`);
  return git('rev-parse', 'HEAD');
}

/** Rewrite the branch's commit, as an agent does, and send it to the server's clone; returns the new head. */
function amend(s: Service, name: string): string {
  git('checkout', '-q', name);
  git('commit', '-q', '--amend', '-m', `Add ${name}, reworded`);
  git('push', '-qf', s.gitDir(s.repos()[0]), name);
  return git('rev-parse', 'HEAD');
}

function refs(s: Service, prefix = 'refs/galley/'): Record<string, string> {
  const out = inClone(s, 'for-each-ref', '--format=%(refname) %(objectname)', prefix);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((line) => line.split(' ')));
}

/** A server: a database in a data directory of its own, with its clone of acme/repo, and the service on it. */
async function server(data = mkdtempSync(join(dir, 'data-'))): Promise<{ db: Db; s: Service; data: string }> {
  const db = new Db(join(data, 'galley.db'));
  const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer', dataDir: data, githubUrl: () => remote });
  await s.registerGithub('acme/repo');
  return { db, s, data };
}

/** Stage the branch `head`, sent to the server's clone first. */
async function stage(s: Service, head: string) {
  const row = await s.registerGithub('acme/repo');
  git('push', '-q', s.gitDir(row), head);
  return s.createPull(row, { title: head, head, base: 'main' }, s.db.actor('agent', 'Bot'));
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'galley-refs-'));
  repo = join(dir, 'repo');
  remote = join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), '# widgets\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git('push', '-q', remote, 'main');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('two servers keep their refs in clones of their own', async () => {
  const a = await server();
  const b = await server();
  try {
    assert.notEqual(a.db.instance, b.db.instance);
    const first = branch('feature/a');
    const theirs = branch('feature/b');
    // Each numbers its pull requests from its own database: both stage a pull request 1.
    const pull = await stage(a.s, 'feature/a');
    const other = await stage(b.s, 'feature/b');
    assert.deepEqual([pull.number, other.number], [1, 1]);
    const second = amend(a.s, 'feature/a');
    await a.s.sync(pull);
    assert.deepEqual(refs(a.s), {
      [`refs/galley/${a.db.instance}/pull/1/1`]: first,
      [`refs/galley/${a.db.instance}/pull/1/2`]: second,
    });
    assert.deepEqual(refs(b.s), { [`refs/galley/${b.db.instance}/pull/1/1`]: theirs });
    // Deleting its pull request takes its own refs.
    await b.s.deletePull(await b.s.ctx('acme', 'repo', 1, { sync: false }), b.s.viewer());
    assert.deepEqual(refs(b.s), {});
    assert.equal(Object.keys(refs(a.s)).length, 2);
    // Nothing in the agent's repository.
    assert.equal(git('for-each-ref', 'refs/galley'), '');
  } finally {
    a.db.sql.close();
    b.db.sql.close();
  }
});

test('a ref that is not where the server left it is left alone, and logged', async () => {
  const { db, s } = await server();
  const errors = mock.method(console, 'error', () => {});
  try {
    branch('feature/c');
    const elsewhere = git('rev-parse', 'main');
    const ref = `refs/galley/${db.instance}/pull/1/1`;
    inClone(s, 'update-ref', ref, elsewhere);
    const pull = await stage(s, 'feature/c');
    assert.equal(inClone(s, 'rev-parse', ref), elsewhere);
    await s.deletePull(await s.ctx('acme', 'repo', pull.number, { sync: false }), s.viewer());
    assert.equal(inClone(s, 'rev-parse', ref), elsewhere);
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.equal(logged.length, 2);
    assert.match(logged[0], new RegExp(`^left ${ref} alone in .*: .*reference already exists`));
    assert.match(logged[1], new RegExp(`^left ${ref} alone in .*: .*is at ${elsewhere} but expected ${pull.head_sha}`));
  } finally {
    errors.mock.restore();
    db.sql.close();
  }
});

test('a copied data directory pins the revisions it came with in its clone, so that they survive', async () => {
  const before = await server();
  const first = branch('feature/d');
  const pull = await stage(before.s, 'feature/d');
  const second = amend(before.s, 'feature/d');
  await before.s.sync(pull);
  // Published as a signed copy, which nothing else in the clone points at.
  const signed = inClone(before.s, 'commit-tree', `${second}^{tree}`, '-p', 'origin/main', '-m', 'Add feature/d, signed');
  before.db.run('UPDATE pulls SET published_source_sha = ?, published_head_sha = ? WHERE id = ?', second, signed, pull.id);
  before.db.sql.close();
  const copied = mkdtempSync(join(dir, 'data-'));
  cpSync(before.data, copied, { recursive: true });
  const original = await server(before.data);
  const copy = await server(copied);
  try {
    // The original's pins came along, in its namespace.
    inClone(copy.s, 'for-each-ref', '--format=%(refname)', `refs/galley/${original.db.instance}/`).split('\n').forEach((ref) => inClone(copy.s, 'update-ref', '-d', ref));
    await copy.s.pinRevisions();
    assert.deepEqual(refs(copy.s, `refs/galley/${copy.db.instance}/`), {
      [`refs/galley/${copy.db.instance}/pull/1/1`]: first,
      [`refs/galley/${copy.db.instance}/pull/1/2`]: second,
      [`refs/galley/${copy.db.instance}/pull/1/published`]: signed,
    });
    // The rewritten first revision and the signed copy are reachable from the copy's refs alone, and survive garbage collection.
    inClone(copy.s, 'reflog', 'expire', '--expire=now', '--all');
    inClone(copy.s, 'gc', '-q', '--prune=now');
    assert.equal(inClone(copy.s, 'cat-file', '-t', first), 'commit');
    assert.equal(inClone(copy.s, 'cat-file', '-t', signed), 'commit');
  } finally {
    original.db.sql.close();
    copy.db.sql.close();
  }
});

test('pins that failed at startup are tried again on the next start, while they can still succeed', async () => {
  const before = await server();
  branch('feature/f');
  const pull = await stage(before.s, 'feature/f');
  const second = amend(before.s, 'feature/f');
  await before.s.sync(pull);
  before.db.sql.close();
  const copied = mkdtempSync(join(dir, 'data-'));
  cpSync(before.data, copied, { recursive: true });
  let copy = await server(copied);
  // The first revision's commit is gone, and with it what its pin was for.
  copy.db.run('UPDATE revisions SET head_sha = ? WHERE seq = 1', 'f'.repeat(40));
  // A git that crashed left a lock where the second revision's pin goes.
  const lock = join(copy.s.gitDir(copy.s.repos()[0]), 'refs', 'galley', copy.db.instance, 'pull', '1', '2.lock');
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '');
  // Something else already holds the third pin's name: retrying would not change that.
  copy.db.run('INSERT INTO revisions (pull_id, seq, head_sha, base_sha, actor_id, created_at) SELECT pull_id, 3, ?, base_sha, actor_id, created_at FROM revisions WHERE seq = 2', second);
  const elsewhere = git('rev-parse', 'main');
  inClone(copy.s, 'update-ref', `refs/galley/${copy.db.instance}/pull/1/3`, elsewhere);
  const errors = mock.method(console, 'error', () => {});
  try {
    await copy.s.pinRevisions();
    assert.deepEqual(refs(copy.s, `refs/galley/${copy.db.instance}/`), { [`refs/galley/${copy.db.instance}/pull/1/3`]: elsewhere });
    assert.equal(errors.mock.calls.length, 3);
    rmSync(lock);
    copy.db.sql.close();
    copy = await server(copied);
    await copy.s.pinRevisions();
    assert.deepEqual(refs(copy.s, `refs/galley/${copy.db.instance}/`), {
      [`refs/galley/${copy.db.instance}/pull/1/2`]: second,
      [`refs/galley/${copy.db.instance}/pull/1/3`]: elsewhere,
    });
    assert.equal(errors.mock.calls.length, 5, 'what could not be pinned is logged again');
    // Every pin that can be is in place: later starts leave it at that.
    copy.db.sql.close();
    copy = await server(copied);
    await copy.s.pinRevisions();
    assert.equal(errors.mock.calls.length, 5);
  } finally {
    errors.mock.restore();
    copy.db.sql.close();
  }
});

test('a database from before namespaces pins its revisions in one, and leaves the refs outside it', async () => {
  const before = await server();
  const first = branch('feature/e');
  const pull = await stage(before.s, 'feature/e');
  const second = amend(before.s, 'feature/e');
  await before.s.sync(pull);
  // As an older galley left it: no instance id, its revisions pinned outside any namespace.
  for (const [seq, sha] of [[1, first], [2, second]] as const) {
    inClone(before.s, 'update-ref', `refs/shared/pull/1/${seq}`, sha);
    inClone(before.s, 'update-ref', '-d', `refs/galley/${before.db.instance}/pull/1/${seq}`);
  }
  before.db.run("DELETE FROM meta WHERE key IN ('instance_id', 'data_dir', 'pinned_namespace')");
  before.db.sql.close();
  const { db, s } = await server(before.data);
  const errors = mock.method(console, 'error', () => {});
  try {
    await s.pinRevisions();
    assert.deepEqual(refs(s, `refs/galley/${db.instance}/`), {
      [`refs/galley/${db.instance}/pull/1/1`]: first,
      [`refs/galley/${db.instance}/pull/1/2`]: second,
    });
    // A copy of the database from before may count on the old refs: deleting leaves them.
    await s.deletePull(await s.ctx('acme', 'repo', pull.number, { sync: false }), s.viewer());
    assert.deepEqual(refs(s, `refs/galley/${db.instance}/`), {});
    assert.deepEqual(refs(s, 'refs/shared/pull/'), { 'refs/shared/pull/1/1': first, 'refs/shared/pull/1/2': second });
    assert.deepEqual(errors.mock.calls, []);
  } finally {
    errors.mock.restore();
    db.sql.close();
  }
});
