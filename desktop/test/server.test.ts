// The desktop app and the galley server: attaching to it, or starting it as the CLI does.
import '../../test/helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dataDir } from '../../src/config.ts';
import { attach, awayText, findNode, loginShellEnv, noAutostart, startServer, type Found } from '../server.ts';

const root = join(import.meta.dirname, '..', '..');

/** What identify answers, one after another, the last one from then on; and how often it was asked. */
function answering(...found: Found[]) {
  let asked = 0;
  const identify = async () => found[Math.min(asked++, found.length - 1)];
  return { identify, asked: () => asked };
}

test('attaches to the galley that answers, and starts none', async () => {
  let started = 0;
  const { identify } = answering('galley');
  assert.deepEqual(await attach('http://localhost:1', { identify, start: () => (started++, null) }), { found: 'galley' });
  assert.equal(started, 0);
});

test('waits for a galley that is starting', async () => {
  let started = 0;
  const { identify, asked } = answering('starting', 'starting', 'galley');
  assert.deepEqual(await attach('http://localhost:1', { identify, start: () => (started++, null), everyMs: 1 }), { found: 'galley' });
  assert.equal(started, 0);
  assert.equal(asked(), 3);
});

test('starts one when nothing answers, and waits until it does', async () => {
  let started = 0;
  const { identify } = answering('none', 'none', 'starting', 'galley');
  assert.deepEqual(await attach('http://localhost:1', { identify, start: () => (started++, null), everyMs: 1 }), { found: 'galley' });
  assert.equal(started, 1);
});

test('says why it started none, and what answers instead of galley', async () => {
  const none = answering('none');
  assert.deepEqual(await attach('http://localhost:1', { identify: none.identify, start: () => 'GALLEY_NO_AUTOSTART is set', everyMs: 1 }), { found: 'none', why: 'GALLEY_NO_AUTOSTART is set' });
  assert.equal(none.asked(), 1, 'it does not wait for a server nobody starts');
  // A server it started that never answers.
  assert.deepEqual(await attach('http://localhost:1', { identify: answering('none').identify, start: () => null, everyMs: 1, tries: 3 }), { found: 'none' });
  for (const found of ['other', 'silent'] as const) {
    let started = 0;
    assert.deepEqual(await attach('http://localhost:1', { identify: answering(found).identify, start: () => (started++, null) }), { found });
    assert.equal(started, 0);
  }
  // identify failing is nothing answering.
  assert.deepEqual(await attach('http://localhost:1', { identify: () => Promise.reject(new Error('EPERM')), start: () => 'no' }), { found: 'none', why: 'no' });
});

test('starts no server where the CLI starts none: on another computer, or on one where no galley server has run', () => {
  const was = { home: process.env.GALLEY_HOME, noAutostart: process.env.GALLEY_NO_AUTOSTART };
  const home = mkdtempSync(join(tmpdir(), 'galley-home-'));
  try {
    process.env.GALLEY_HOME = home;
    process.env.GALLEY_NO_AUTOSTART = '1';
    assert.equal(noAutostart('http://localhost:24823'), 'GALLEY_NO_AUTOSTART is set');
    delete process.env.GALLEY_NO_AUTOSTART;
    // A new computer, where the server's URL was likely forgotten.
    const never = `no galley server has run on this computer: run galley serve once, or set your server's URL as url in ${join(process.env.GALLEY_CONFIG_DIR!, 'config.json')}`;
    assert.equal(noAutostart('http://localhost:24823'), never);
    assert.equal(awayText('http://localhost:24823', 'none', never, ''), `galley is not running at http://localhost:24823 (${never})`);
    // One that has run a server: its database is in the data directory.
    writeFileSync(join(home, 'galley.db'), '');
    assert.equal(noAutostart('http://localhost:24823'), null);
    assert.equal(noAutostart('http://127.0.0.1:4000'), null);
    for (const base of ['http://galley.example.com', 'https://galley.tailnet-1234.ts.net']) assert.equal(noAutostart(base), `${base} is not on this computer`);
  } finally {
    Object.assign(process.env, { GALLEY_HOME: was.home, GALLEY_NO_AUTOSTART: was.noAutostart });
    rmSync(home, { recursive: true, force: true });
  }
});

test('attaches to a galley on another computer, and starts nothing there: it says when that galley does not answer', async () => {
  const base = 'https://galley.tailnet-1234.ts.net';
  const was = process.env.GALLEY_NO_AUTOSTART;
  delete process.env.GALLEY_NO_AUTOSTART;
  try {
    let tried = 0;
    // As the app starts one (main.ts ensure): only where noAutostart lets it.
    const start = () => noAutostart(base) ?? (tried++, null);
    assert.deepEqual(await attach(base, { identify: answering('galley').identify, start }), { found: 'galley' });
    const starting = answering('starting', 'galley');
    assert.deepEqual(await attach(base, { identify: starting.identify, start, everyMs: 1 }), { found: 'galley' });
    assert.equal(starting.asked(), 2);
    // Nothing answers (or tailscale serve answers for a galley that is down): it does not wait for a server nobody starts.
    const none = answering('none');
    const away = await attach(base, { identify: none.identify, start, everyMs: 1 });
    assert.deepEqual(away, { found: 'none', why: `${base} is not on this computer` });
    assert.equal(none.asked(), 1);
    assert.equal(tried, 0);
    assert.equal(awayText(base, away.found, away.why, ''), `galley does not answer at ${base}. Is the server running there, and can this computer reach it (is it on the tailnet)?`);
    assert.equal(awayText(base, 'other', undefined, ''), `Another program answers at ${base}`);
  } finally {
    process.env.GALLEY_NO_AUTOSTART = was;
  }
});

test("finds the user's Node: the first on PATH that is 24 or newer", () => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-node-'));
  try {
    const bin = (name: string, version: string | null) => {
      mkdirSync(join(dir, name));
      if (version) {
        writeFileSync(join(dir, name, 'node'), `#!/bin/sh\necho ${version}\n`);
        chmodSync(join(dir, name, 'node'), 0o755);
      }
      return join(dir, name);
    };
    const [old, none, current, newer] = [bin('old', 'v22.11.0'), bin('none', null), bin('current', 'v24.21.0'), bin('newer', 'v26.1.0')];
    assert.equal(findNode([old, none, '', current, newer].join(delimiter)), join(current, 'node'));
    assert.equal(findNode([old, none].join(delimiter)), null);
    assert.equal(findNode(''), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the login shell's environment, past what its startup files print", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-shell-'));
  try {
    // A shell whose startup files greet, set GALLEY_PORT and a value over two lines, then run the command (-ilc <command>).
    const shell = join(dir, 'zsh');
    writeFileSync(shell, `#!/bin/sh\necho "Last login: today"\nexport GALLEY_PORT=4321\nexport TWO_LINES="one\ntwo"\nexec /bin/sh -c "$2"\n`);
    chmodSync(shell, 0o755);
    const env = await loginShellEnv(shell);
    assert.equal(env?.GALLEY_PORT, '4321');
    assert.equal(env?.TWO_LINES, 'one\ntwo');
    assert.equal(env?.HOME, process.env.HOME);
    assert.equal(await loginShellEnv(join(dir, 'missing')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('starts galley as the CLI does: in the background, with the given Node, logging to the data directory', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const base = `http://localhost:${port}`;
  let log = '';
  try {
    const attached = await attach(base, {
      start: () => {
        log = startServer({ base, node: process.execPath, root });
        return null;
      },
    });
    assert.deepEqual(attached, { found: 'galley' });
    assert.equal(log, join(dataDir(), 'server.log'));
    assert.match(readFileSync(log, 'utf8'), new RegExp(`galley is serving ${base}`));
  } finally {
    const health = await fetch(`${base}/api/health`).then((res) => res.json(), () => null);
    if (health?.pid) process.kill(health.pid);
  }
});
