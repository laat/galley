import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, now } from '../src/server/db.ts';

test('pull requests stored as open, before staged had a name of its own, are staged', () => {
  const data = mkdtempSync(join(tmpdir(), 'laatsux-staged-'));
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
