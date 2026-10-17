import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, now } from '../src/server/db.ts';

test('pull requests stored as open, before staged had a name of its own, are staged', () => {
  const data = mkdtempSync(join(tmpdir(), 'galley-staged-'));
  const file = join(data, 'laatsux.db');
  try {
    const old = new Db(file);
    const repo = old.insert('repos', { git_dir: join(data, '.git'), owner: 'acme', name: 'widgets', created_at: now() });
    const author = old.actor('agent', 'Bot');
    const pull = (number: number, state: string) =>
      old.insert('pulls', {
        repo_id: repo,
        number,
        title: `Pull ${number}`,
        state,
        base_ref: 'main',
        head_ref: `branch-${number}`,
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
        author_id: author.id,
        created_at: now(),
        updated_at: now(),
        author_seen_at: now(),
      });
    const ids = [pull(1, 'open'), pull(2, 'published'), pull(3, 'closed')];
    old.sql.close();
    const db = new Db(file);
    try {
      assert.deepEqual(
        ids.map((id) => db.get<{ state: string }>('SELECT state FROM pulls WHERE id = ?', id)!.state),
        ['staged', 'published', 'closed'],
      );
    } finally {
      db.sql.close();
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('a database opened from another directory, a copy, gets an instance id of its own', () => {
  const data = mkdtempSync(join(tmpdir(), 'galley-instance-'));
  const open = (dir: string) => {
    const db = new Db(join(data, dir, 'laatsux.db'));
    db.sql.close();
    return db.instance;
  };
  try {
    mkdirSync(join(data, 'original'));
    mkdirSync(join(data, 'copy'));
    const original = open('original');
    assert.match(original, /^[0-9a-f]{8}$/);
    assert.equal(open('original'), original);
    copyFileSync(join(data, 'original', 'laatsux.db'), join(data, 'copy', 'laatsux.db'));
    const copy = open('copy');
    assert.notEqual(copy, original);
    assert.equal(open('copy'), copy);
    assert.equal(open('original'), original);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
