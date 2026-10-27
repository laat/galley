// The npm package, galley-proof, as scripts/build.ts builds it and npm packs it: what goes in, and
// galley running from it, the server the CLI starts included.
import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = join(import.meta.dirname, '..');
const exec = promisify(execFile);

test('the npm package is galley in JavaScript with public/, and galley runs from it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'galley-package-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'package');
  await exec(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'scripts', 'build.ts'), pkg]);

  // What npm packs, without the variables pnpm gives the scripts it runs.
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', pkg], { cwd: dir, env: { ...npmEnv, npm_config_update_notifier: 'false' }, encoding: 'utf8' }));
  const files: string[] = packed.files.map((f: { path: string }) => f.path);
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const checkout = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packed.id, `galley-proof@${checkout.version}`);
  assert.deepEqual(files.filter((f) => !/^(bin|src)\/.*\.js$|^public\//.test(f)).sort(), ['LICENSE', 'README.md', 'package.json']);
  for (const f of ['bin/galley.js', 'src/server/server.js', 'src/server/receive-hook.js', 'public/app.js']) assert.ok(files.includes(f), `${f} is packed`);
  assert.deepEqual(manifest.bin, { galley: 'bin/galley.js' });
  assert.deepEqual(manifest.dependencies, checkout.dependencies);
  assert.deepEqual(manifest.engines, checkout.engines);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);

  // Its dependencies where an install puts them.
  symlinkSync(join(root, 'node_modules'), join(pkg, 'node_modules'));
  const bin = join(pkg, 'bin', 'galley.js');
  assert.equal((await exec(process.execPath, [bin, '--version'])).stdout, `galley version ${checkout.version}\n`);

  // The CLI starts the package's server, on a machine that has run one.
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'galley.db'), '');
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const url = `http://localhost:${port}`;
  t.after(async () => {
    // Stopped also when an assert failed, as long as it answers.
    const health = await fetch(`${url}/api/health`).then((res) => res.json(), () => null);
    if (health?.pid) process.kill(health.pid);
  });
  const env = { ...process.env, GALLEY_URL: url, GALLEY_HOME: home, GALLEY_NO_AUTOSTART: '' };
  const r = await exec(process.execPath, [bin, 'browse', '--settings', '--no-browser'], { cwd: home, env }).catch((e) => e);
  const log = () => (existsSync(join(home, 'server.log')) ? readFileSync(join(home, 'server.log'), 'utf8') : '');
  assert.match(r.stderr, new RegExp(`Started the galley server at ${url}`), log());
  assert.equal(r.stdout, `${url}/settings\n`);
  assert.equal((await (await fetch(`${url}/api/meta`)).json()).version, checkout.version);
  // Its pages, with public/.
  assert.equal((await fetch(`${url}/settings`)).status, 200);
  assert.equal((await fetch(`${url}/static/app.css`)).status, 200);
});
