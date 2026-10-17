// What galley kept under laatsux's name before the rename (#9), moved to galley's when a server
// starts: the data directory (~/.local/share/laatsux), the database file in it (laatsux.db) and
// the config directory (~/.config/laatsux). Until then galley uses them where they are
// (config.ts ownDir, databaseFile).
import { existsSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configHome, dataHome, fromEnv, ownDir } from '../config.ts';

const DB = 'galley.db';
const DB_BEFORE = 'laatsux.db';

/** The database in a data directory: galley.db, or laatsux.db while only that one exists. */
export function databaseFile(dir: string): string {
  const file = join(dir, DB);
  return !existsSync(file) && existsSync(join(dir, DB_BEFORE)) ? join(dir, DB_BEFORE) : file;
}

/**
 * Whether nobody else has the database open. The last connection to close checkpoints the
 * write-ahead log and deletes it, so a log left after closing ours is someone else's: a server
 * from before the rename, say, still running from the directory on another port.
 */
function unused(file: string): boolean {
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch (e) {
    console.error(`could not open ${file} to move it:`, e);
    return false;
  }
  return !existsSync(`${file}-wal`);
}

/**
 * Move the data directory and the config directory from laatsux's names to galley's, where
 * galley's do not exist yet, and the database file within from laatsux.db to galley.db. A
 * directory set in the environment stays where it is; its database file moves. `galley serve`
 * calls this once it holds its port, before it opens the database. While the database is open
 * elsewhere nothing moves, and the next start tries again. Returns the data directory to use.
 */
export function moveFromLaatsux(dataDir: string): string {
  const home = dataHome();
  const own = !fromEnv('HOME') && dataDir === join(home, 'laatsux');
  const moving = own && !existsSync(join(home, 'galley'));
  const renaming = existsSync(join(dataDir, DB_BEFORE)) && !existsSync(join(dataDir, DB));
  // Whichever name the database has: one started with the directory set in the environment may have renamed it.
  const file = databaseFile(dataDir);
  if ((moving || renaming) && existsSync(file) && !unused(file)) {
    console.error(`${file} is open in another process; galley uses it where it is until it starts again with nothing else using it.`);
    return dataDir;
  }
  let dir = dataDir;
  try {
    if (moving) {
      const was = realpathSync(dir);
      renameSync(dir, join(home, 'galley'));
      dir = join(home, 'galley');
      // Moved, not copied: the database keeps its id, and with it its refs (Db.instance).
      if (existsSync(databaseFile(dir))) {
        const db = new DatabaseSync(databaseFile(dir));
        try {
          db.prepare("UPDATE meta SET value = ? WHERE key = 'data_dir' AND value = ?").run(realpathSync(dir), was);
        } finally {
          db.close();
        }
      }
    }
    if (existsSync(join(dir, DB_BEFORE)) && !existsSync(join(dir, DB))) renameSync(join(dir, DB_BEFORE), join(dir, DB));
    const config = configHome();
    if (!fromEnv('CONFIG_DIR') && existsSync(join(config, 'laatsux')) && !existsSync(join(config, 'galley'))) renameSync(join(config, 'laatsux'), join(config, 'galley'));
  } catch (e) {
    console.error('could not move what galley kept under the name laatsux:', e);
  }
  // Where it is now, also when another server moved it since this one looked.
  return own ? ownDir(home) : dir;
}
