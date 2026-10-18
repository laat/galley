import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/server/db.ts';

test('a database opened from another directory, a copy, gets an instance id of its own', () => {
  const data = mkdtempSync(join(tmpdir(), 'galley-instance-'));
  const open = (dir: string) => {
    const db = new Db(join(data, dir, 'galley.db'));
    db.sql.close();
    return db.instance;
  };
  try {
    mkdirSync(join(data, 'original'));
    mkdirSync(join(data, 'copy'));
    const original = open('original');
    assert.match(original, /^[0-9a-f]{8}$/);
    assert.equal(open('original'), original);
    copyFileSync(join(data, 'original', 'galley.db'), join(data, 'copy', 'galley.db'));
    const copy = open('copy');
    assert.notEqual(copy, original);
    assert.equal(open('copy'), copy);
    assert.equal(open('original'), original);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
