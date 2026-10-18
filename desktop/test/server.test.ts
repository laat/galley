// The desktop app and the galley server: attaching to it, or starting it as the CLI does.
import '../../test/helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dataDir } from '../../src/config.ts';
import { attach, findNode, loginShellEnv, noAutostart, startServer, type Found } from '../server.ts';

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

test('starts no server where the CLI starts none', () => {
  const was = process.env.GALLEY_NO_AUTOSTART;
  try {
    process.env.GALLEY_NO_AUTOSTART = '1';
    assert.equal(noAutostart('http://localhost:24823'), 'GALLEY_NO_AUTOSTART is set');
    delete process.env.GALLEY_NO_AUTOSTART;
    assert.equal(noAutostart('http://localhost:24823'), null);
    assert.equal(noAutostart('http://127.0.0.1:4000'), null);
    assert.equal(noAutostart('http://galley.example.com'), 'http://galley.example.com is not on this computer');
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
