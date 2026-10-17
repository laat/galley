// Moving the data and config directories, and the database file, from their names before the
// rename to galley's, when a server starts. Only in temporary homes: XDG_DATA_HOME and
// XDG_CONFIG_HOME point into a directory of the test's own.
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configDir, dataDir } from '../src/config.ts';
import { Db } from '../src/server/db.ts';
import { startServer } from '../src/server/server.ts';
import { databaseFile, moveFromLaatsux } from '../src/server/rename.ts';

let home: string;
let saved: NodeJS.ProcessEnv;
const data = (name: string) => join(home, 'data', name);
const config = (name: string) => join(home, 'config', name);

beforeEach(() => {
  saved = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'galley-rename-'));
  for (const k of ['GALLEY_HOME', 'LAATSUX_HOME', 'GALLEY_CONFIG_DIR', 'LAATSUX_CONFIG_DIR']) delete process.env[k];
  process.env.XDG_DATA_HOME = join(home, 'data');
  process.env.XDG_CONFIG_HOME = join(home, 'config');
});

afterEach(() => {
  process.env = saved;
  rmSync(home, { recursive: true, force: true });
});

/** What a server called laatsux left: its data directory with a database, a log and an upload, and a custom reviewer. Returns the database's id. */
function leftByLaatsux(): string {
  mkdirSync(join(data('laatsux'), 'uploads'), { recursive: true });
  const db = new Db(join(data('laatsux'), 'laatsux.db'));
  db.setMeta('kept', 'yes');
  const instance = db.instance;
  db.sql.close();
  writeFileSync(join(data('laatsux'), 'server.log'), 'started\n');
  writeFileSync(join(data('laatsux'), 'uploads', 'a.png'), 'png');
  mkdirSync(config('laatsux/reviewers'), { recursive: true });
  writeFileSync(config('laatsux/reviewers/house-rules.md'), '---\nengine: claude\n---\nCheck the house rules.\n');
  return instance;
}

test('until a server moves them, galley uses the directories laatsux left', () => {
  assert.equal(dataDir(), data('galley'));
  assert.equal(configDir(), config('galley'));
  leftByLaatsux();
  assert.equal(dataDir(), data('laatsux'));
  assert.equal(configDir(), config('laatsux'));
  assert.equal(databaseFile(dataDir()), join(data('laatsux'), 'laatsux.db'));
  // Set in the environment, by either name, a directory is used as it is.
  process.env.LAATSUX_HOME = join(home, 'elsewhere');
  assert.equal(dataDir(), join(home, 'elsewhere'));
});

test('a server starting moves the directories and the database, which keeps its id', async () => {
  const instance = leftByLaatsux();
  const server = await startServer({ port: 0, dataDir: dataDir(), moveFromLaatsux: true, ghBin: 'false', codexBin: 'false', claudeBin: 'false', viewerLogin: 'reviewer', pollMs: 60_000, followMs: 60 * 60_000 });
  try {
    assert.ok(!existsSync(data('laatsux')) && !existsSync(config('laatsux')));
    assert.deepEqual([dataDir(), configDir()], [data('galley'), config('galley')]);
    assert.ok(existsSync(join(data('galley'), 'galley.db')) && !existsSync(join(data('galley'), 'laatsux.db')));
    assert.equal(readFileSync(join(data('galley'), 'server.log'), 'utf8'), 'started\n');
    assert.equal(readFileSync(join(data('galley'), 'uploads', 'a.png'), 'utf8'), 'png');
    // Moved, not copied: the same database, with the same id, so its refs stay its own.
    assert.equal(server.service.db.getMeta('kept'), 'yes');
    assert.equal(server.service.db.instance, instance);
    const reviewers = await (await fetch(`${server.url}/api/settings/reviewers`)).json();
    assert.deepEqual(
      reviewers.map((r: { name: string; path: string }) => [r.name, r.path]),
      [['house-rules', config('galley/reviewers/house-rules.md')]],
    );
  } finally {
    await server.close();
  }
});

test('nothing moves while a server from before the rename has the database open', () => {
  leftByLaatsux();
  const running = new DatabaseSync(join(data('laatsux'), 'laatsux.db'));
  running.exec("UPDATE meta SET value = 'still' WHERE key = 'kept'");
  const errors = mock.method(console, 'error', () => {});
  try {
    assert.equal(moveFromLaatsux(dataDir()), data('laatsux'));
    assert.ok(existsSync(join(data('laatsux'), 'laatsux.db')) && existsSync(config('laatsux')));
    assert.ok(!existsSync(data('galley')) && !existsSync(config('galley')));
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /laatsux\.db is open in another process/);
  } finally {
    errors.mock.restore();
    running.close();
  }
  // Once it stopped, the next start moves them.
  assert.equal(moveFromLaatsux(dataDir()), data('galley'));
  const db = new Db(databaseFile(dataDir()));
  assert.equal(db.getMeta('kept'), 'still');
  db.sql.close();
  assert.ok(existsSync(config('galley/reviewers/house-rules.md')));
});

test('a data directory set in the environment stays where it is, and its database takes the new name', () => {
  const own = join(home, 'own');
  mkdirSync(own);
  new Db(join(own, 'laatsux.db')).sql.close();
  process.env.GALLEY_HOME = own;
  assert.equal(moveFromLaatsux(dataDir()), own);
  assert.ok(existsSync(join(own, 'galley.db')) && !existsSync(join(own, 'laatsux.db')));
  assert.ok(!existsSync(data('galley')));
});

test('directories galley has already are kept, and the ones laatsux left stay as they are', () => {
  leftByLaatsux();
  mkdirSync(data('galley'), { recursive: true });
  mkdirSync(config('galley'), { recursive: true });
  assert.equal(moveFromLaatsux(dataDir()), data('galley'));
  assert.ok(existsSync(join(data('laatsux'), 'laatsux.db')) && existsSync(config('laatsux/reviewers/house-rules.md')));
});

test('nothing moves while a server started with the directory set in the environment uses it, under either database name', () => {
  leftByLaatsux();
  // That server renamed the database where it is.
  process.env.GALLEY_HOME = data('laatsux');
  assert.equal(moveFromLaatsux(dataDir()), data('laatsux'));
  const running = new DatabaseSync(join(data('laatsux'), 'galley.db'));
  running.exec('SELECT 1 FROM meta');
  delete process.env.GALLEY_HOME;
  const errors = mock.method(console, 'error', () => {});
  try {
    assert.equal(moveFromLaatsux(dataDir()), data('laatsux'));
    assert.ok(existsSync(join(data('laatsux'), 'galley.db')) && !existsSync(data('galley')));
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /galley\.db is open in another process/);
  } finally {
    errors.mock.restore();
    running.close();
  }
});

test('a server that looked before another moved the directory uses it where it is now', () => {
  leftByLaatsux();
  const looked = dataDir();
  assert.equal(moveFromLaatsux(looked), data('galley'));
  assert.equal(moveFromLaatsux(looked), data('galley'));
  assert.ok(!existsSync(data('laatsux')));
});

test('a data directory with no database yet moves too', () => {
  mkdirSync(data('laatsux'), { recursive: true });
  writeFileSync(join(data('laatsux'), 'server.log'), 'started\n');
  assert.equal(moveFromLaatsux(dataDir()), data('galley'));
  assert.deepEqual([existsSync(join(data('galley'), 'server.log')), existsSync(join(data('galley'), 'galley.db'))], [true, false]);
});
