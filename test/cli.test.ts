import './helpers/env.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setField } from '../src/cli/api.ts';
import { parseDuration } from '../src/cli/output.ts';
import { parseReviewers } from '../src/cli/pr.ts';
import { whoReviews } from '../src/cli/reviewers.ts';
import { toGalley } from '../src/cli/send.ts';
import { checkPriority, fillFromCommits, splitPriorityPrefix } from '../src/server/service.ts';
import { Client } from '../src/cli/client.ts';
import { cliActor, META } from '../src/config.ts';
import type { Commit } from '../src/server/git.ts';

test('setField builds nested bodies like gh api -f/-F', () => {
  const body: Record<string, any> = {};
  setField(body, 'event', 'COMMENT');
  setField(body, 'comments[][path]', 'a.js');
  setField(body, 'comments[][line]', 3);
  setField(body, 'comments[][body]', 'first');
  setField(body, 'comments[][path]', 'b.js');
  setField(body, 'comments[][line]', 7);
  setField(body, 'labels[]', 'x');
  setField(body, 'labels[]', 'y');
  setField(body, 'head[ref]', 'main');
  assert.deepEqual(body, {
    event: 'COMMENT',
    comments: [
      { path: 'a.js', line: 3, body: 'first' },
      { path: 'b.js', line: 7 },
    ],
    labels: ['x', 'y'],
    head: { ref: 'main' },
  });
});

test('parseDuration', () => {
  assert.equal(parseDuration('90'), 90_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.throws(() => parseDuration('soon'));
});

const commit = (message: string): Commit => ({
  sha: 'x',
  parents: [],
  authorName: 'a',
  authorEmail: 'a@b',
  authorDate: '',
  committerName: 'a',
  committerEmail: 'a@b',
  committerDate: '',
  message,
});

test('fillFromCommits mirrors gh pr create --fill', () => {
  assert.deepEqual(fillFromCommits([commit('Add x\n\nWhy x.')], 'feat/x', 'default'), { title: 'Add x', body: 'Why x.' });
  assert.deepEqual(fillFromCommits([commit('One'), commit('Two\n\nMore')], 'feat/add-things', 'default'), {
    title: 'Add things',
    body: '- One\n- Two',
  });
  assert.equal(fillFromCommits([commit('One'), commit('Two')], 'b', 'first').title, 'One');
  assert.equal(fillFromCommits([commit('One'), commit('Two\n\nMore')], 'b', 'verbose').body, '- One\n- Two\n  \n  More');
});

/** cliActor() with only these agent variables set. */
function actorWith(env: Record<string, string>) {
  const saved = { ...process.env };
  try {
    for (const k of ['GALLEY_ACTOR', 'GALLEY_ACTOR_TYPE', 'CLAUDECODE', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'OPENCODE']) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    return cliActor();
  } finally {
    process.env = saved;
  }
}

test('an author agent running in Codex is not named like the Codex reviewer', () => {
  assert.deepEqual(actorWith({ CODEX_SANDBOX: 'seatbelt' }), { login: 'codex-agent', type: 'Bot' });
  // Installed without npm and run with its own sandbox off, Codex still sets its thread id.
  assert.deepEqual(actorWith({ CODEX_THREAD_ID: '01a1463b-126d-75c0-bff2-6194ba586de8' }), { login: 'codex-agent', type: 'Bot' });
});

test('the CLI detects the agent running it, also when Claude Code started that agent', () => {
  assert.deepEqual(actorWith({ CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'claude', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1' }), { login: 'opencode', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1', CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'opencode', type: 'Bot' });
  assert.deepEqual(actorWith({ CODEX_THREAD_ID: 'x', CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-301_agent' }), { login: 'codex-agent', type: 'Bot' });
  assert.deepEqual(actorWith({ AI_AGENT: 'gemini_1_agent' }), { login: 'gemini', type: 'Bot' });
  assert.deepEqual(actorWith({ OPENCODE: '1', GALLEY_ACTOR: 'reviewer' }), { login: 'reviewer', type: 'Bot' });
});

test('the CLI names its caller in X-Galley-Actor and X-Galley-Actor-Type', async () => {
  let heard: IncomingHttpHeaders = {};
  const server = createServer((req, res) => {
    heard = req.headers;
    res.end(JSON.stringify(req.url === '/api/meta' ? META : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...process.env };
  try {
    process.env.GALLEY_ACTOR = 'agent';
    await new Client(`http://127.0.0.1:${(server.address() as { port: number }).port}`).get('/api/health');
  } finally {
    process.env = saved;
    server.close();
  }
  assert.equal(heard['x-galley-actor'], 'agent');
  assert.equal(heard['x-galley-actor-type'], 'Bot');
});

/** A server on a free local port that answers each path as `answer` says (404 for null), and notes the paths asked for. */
async function fake(t: TestContext, answer: (path: string) => [number, unknown] | null) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    const [status, body] = answer(req.url!) ?? [404, { message: 'Not Found' }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

test('the CLI makes sure galley answers before its first request', async (t) => {
  // Another program on the port hears only the question.
  const other = await fake(t, () => [200, { name: 'something else' }]);
  await assert.rejects(new Client(other.url).get('/api/repos'), /something other than galley answers at http:\/\/127\.0\.0\.1:\d+\. Stop it, or run galley on another port with GALLEY_PORT/);
  assert.deepEqual(other.paths, ['/api/meta']);
  // galley that is still starting is waited for.
  let starting = 2;
  const later = await fake(t, (path) => (path === '/api/meta' ? [starting-- > 0 ? 503 : 200, META] : [200, []]));
  assert.deepEqual(await new Client(later.url).get('/api/repos'), []);
  assert.deepEqual(later.paths, ['/api/meta', '/api/meta', '/api/meta', '/api/repos']);
  // Links are checked too, with no request of their own.
  assert.equal(await new Client(later.url).url('/settings'), `${later.url}/settings`);
  assert.deepEqual(later.paths.slice(4), ['/api/meta']);
  // A program that takes the connection and never answers: galley stuck, or another one.
  const sockets: Socket[] = [];
  const silent = createTcpServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
  const quiet = new Client(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, { probeMs: 200 });
  await assert.rejects(quiet.get('/api/repos'), /nothing answered at http:\/\/127\.0\.0\.1:\d+ within 0\.2 seconds: galley may be stuck there, or another program holds the port/);
});

/** Runs bin/galley.ts in a data directory of its own, with these variables. */
async function galley(t: TestContext, env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'galley-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  try {
    const r = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), ...args], { cwd: home, env: { ...process.env, GALLEY_HOME: home, NO_COLOR: '1', ...env }, timeout: 20_000 });
    return { code: 0, ...r };
  } catch (e) {
    const { code, stdout, stderr } = e as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

test('the CLI starts no server for a galley on another machine, and says it does not answer there', async (t) => {
  // On a machine that has run a server, which would start one for a local URL.
  const home = mkdtempSync(join(tmpdir(), 'galley-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'galley.db'), '');
  const r = await galley(t, { GALLEY_URL: 'http://galley.invalid:24823', GALLEY_HOME: home, GALLEY_NO_AUTOSTART: '' }, 'api', 'health');
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'galley does not answer at http://galley.invalid:24823. Is the server running there, and can this machine reach it (is it on the tailnet)?\n');
  assert.deepEqual(readdirSync(home), ['galley.db']);
  // From Codex's sandbox without network access, it says that is why.
  const sandboxed = await galley(t, { GALLEY_URL: 'http://galley.invalid:24823', GALLEY_HOME: home, CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'api', 'health');
  assert.equal(sandboxed.code, 1);
  assert.match(sandboxed.stderr, / Codex runs this command in its sandbox without network access \(CODEX_SANDBOX_NETWORK_DISABLED\), which keeps galley out of reach: tell the user, rather than work around it\.\n$/);
});

test('the CLI finds the server at the url in the config file, unless GALLEY_URL is set', async (t) => {
  const there = await fake(t, (path) => (path === '/api/meta' ? [200, META] : [200, { ok: true }]));
  const dir = mkdtempSync(join(tmpdir(), 'galley-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  // GALLEY_PORT keeps the default URL off a galley this machine may run.
  const env = { GALLEY_CONFIG_DIR: dir, GALLEY_URL: '', GALLEY_PORT: '1', GALLEY_NO_AUTOSTART: '1' };

  writeFileSync(file, JSON.stringify({ url: `${there.url}/` }));
  const fromFile = await galley(t, env, 'api', 'health');
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.deepEqual(there.paths, ['/api/meta', '/api/health']);
  // GALLEY_URL wins over the file.
  const fromEnv = await galley(t, { ...env, GALLEY_URL: 'http://galley.invalid:24823' }, 'api', 'health');
  assert.match(fromEnv.stderr, /^galley does not answer at http:\/\/galley\.invalid:24823\./);
  // Without a file, localhost.
  rmSync(file);
  const none = await galley(t, env, 'api', 'health');
  assert.match(none.stderr, / at http:\/\/localhost:1\b/);
  // A file galley can not use says so, rather than fall back to localhost.
  writeFileSync(file, '{"url": ');
  const broken = await galley(t, env, 'api', 'health');
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.startsWith(`could not read ${file}: `), broken.stderr);
  writeFileSync(file, JSON.stringify({ url: 'galley.example' }));
  const notUrl = await galley(t, env, 'api', 'health');
  assert.equal(notUrl.stderr, `${file}: url is not an http or https URL: "galley.example"\n`);
});

test('the CLI goes through the proxy the environment names, to a galley on another machine only', async (t) => {
  const galleyThere = await fake(t, (path) => (path === '/api/meta' ? [200, META] : [200, { ok: true }]));
  // As `tailscale serve` answers for a galley that is down behind it.
  const down = await fake(t, () => [502, 'Bad Gateway']);
  // A proxy as a sandbox's is, which tunnels to the hosts it allows: down.example to the one that
  // is down, any other name to the fake galley.
  const tunnels: string[] = [];
  const proxy = createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, socket: Socket, head) => {
    tunnels.push(req.url!);
    if (req.url!.startsWith('blocked.example:')) return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    const upstream = connect(Number(new URL(req.url!.startsWith('down.example:') ? down.url : galleyThere.url).port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket).on('error', () => {});
      socket.pipe(upstream).on('error', () => {});
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
  });
  const env = { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, GALLEY_NO_AUTOSTART: '1' };
  const { port } = new URL(galleyThere.url);

  const there = await galley(t, { ...env, GALLEY_URL: `http://galley.example:${port}` }, 'api', 'health');
  assert.equal(there.code, 0, there.stderr);
  assert.deepEqual(JSON.parse(there.stdout), { ok: true });
  assert.deepEqual([...new Set(tunnels)], [`galley.example:${port}`]);
  assert.deepEqual(galleyThere.paths, ['/api/meta', '/api/health']);
  // One on this machine is reached directly, as without a proxy.
  const tunnelled = tunnels.length;
  const here = await galley(t, { ...env, GALLEY_URL: galleyThere.url }, 'api', 'health');
  assert.equal(here.code, 0, here.stderr);
  assert.equal(tunnels.length, tunnelled);
  assert.equal(galleyThere.paths.length, 4);
  // A proxy that refuses the host, as a sandbox's does one it does not allow, says so.
  const blocked = await galley(t, { ...env, GALLEY_URL: 'http://blocked.example:24823' }, 'api', 'health');
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /^could not reach galley at http:\/\/blocked\.example:24823: .*\b403\b/);
  // From Codex's sandbox without network access, it says that is why.
  const fromCodex = await galley(t, { ...env, GALLEY_URL: 'http://blocked.example:24823', CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'api', 'health');
  assert.match(fromCodex.stderr, /\b403\b.*\. Codex runs this command in its sandbox without network access/);
  // A proxy in front of galley that answers for it while it is down, as `tailscale serve` does.
  const gateway = await galley(t, { ...env, GALLEY_URL: 'http://down.example:443' }, 'api', 'health');
  assert.equal(gateway.code, 1);
  assert.match(gateway.stderr, /^galley does not answer at http:\/\/down\.example:443\. Is the server running there/);
});

test('a checkout is registered by the GitHub repository its remote names, once per command, also for a pull request named by its URL; one not on GitHub is refused', async (t) => {
  const posted: unknown[] = [];
  // What galley answers a registration: at first without a clone, so that nothing is sent.
  let answer: [number, unknown] = [200, { owner: { login: 'acme' }, name: 'widgets' }];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/api/meta') return res.end(JSON.stringify(META));
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (req.url === '/api/repos') {
        posted.push(JSON.parse(body));
        return json(...answer);
      }
      json(200, { number: 3 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const checkout = mkdtempSync(join(tmpdir(), 'galley-cli-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  await promisify(execFile)('git', ['init', '-q', checkout]);
  await promisify(execFile)('git', ['-C', checkout, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
  const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), 'pr', 'view', `${url}/acme/widgets/pull/3`, '--json', 'number'], {
    cwd: checkout,
    env: { ...process.env, GALLEY_URL: url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1' },
  });
  assert.deepEqual(JSON.parse(stdout), { number: 3 });
  // With the path, for a server older than the CLI, which registers by path.
  assert.deepEqual(posted, [{ github: 'acme/widgets', path: realpathSync(checkout) }]);
  const saved = { ...process.env };
  process.env.GALLEY_ACTOR = 'agent';
  try {
    // For a pull request named by its URL and one by its number in the same wait: one registration, with the clone's git URL where the CLI reaches galley.
    answer = [200, { owner: { login: 'acme' }, name: 'widgets', git_url: 'http://galley.example/git/acme/widgets.git' }];
    const client = new Client(url);
    const [, repo] = await Promise.all([client.checkoutOf(checkout, { owner: 'acme', name: 'widgets' }), client.repoFor(checkout)]);
    assert.deepEqual([repo.owner, repo.name], ['acme', 'widgets']);
    assert.equal(posted.length, 2);
    assert.equal((await client.registered(checkout))?.gitUrl, `${url}/git/acme/widgets.git`);
    // A failed one is an error.
    answer = [503, { message: 'galley is stopping' }];
    await assert.rejects(new Client(url).checkoutOf(checkout, { owner: 'acme', name: 'widgets' }), /galley is stopping/);
    // A checkout whose remote is not on GitHub, or that has none, is not registered: galley stages GitHub repositories only.
    await promisify(execFile)('git', ['-C', checkout, 'remote', 'set-url', 'origin', 'https://gitlab.example/acme/widgets.git']);
    await assert.rejects(new Client(url).repoFor(checkout), /^Error: galley stages pull requests of GitHub repositories only, and the remote origin of this checkout is not on github\.com: https:\/\/gitlab\.example\/acme\/widgets\.git$/);
    await promisify(execFile)('git', ['-C', checkout, 'remote', 'remove', 'origin']);
    await assert.rejects(new Client(url).repoFor(checkout), /this checkout has no remote$/);
    // For a pull request named by its URL, such a checkout is no checkout of its repository: the command goes on without it.
    await new Client(url).checkoutOf(checkout, { owner: 'acme', name: 'widgets' });
    assert.equal(posted.length, 3);
  } finally {
    process.env = saved;
  }
});

test('git goes to galley through the proxy the CLI goes through, whatever its own http.proxy says', () => {
  const proxy = (url: string, env: Record<string, string>) => toGalley(url, env).args;
  assert.deepEqual(proxy('http://galley.example:24823', {}), ['-c', 'http.proxy=']);
  assert.deepEqual(proxy('http://galley.example:24823', { HTTP_PROXY: 'http://upper:1', http_proxy: 'http://lower:1' }), ['-c', 'http.proxy=http://lower:1']);
  // For https, as Node does: the http proxy when there is no https one.
  assert.deepEqual(proxy('https://galley.example', { HTTP_PROXY: 'http://upper:1' }), ['-c', 'http.proxy=http://upper:1']);
  assert.deepEqual(proxy('https://galley.example', { HTTPS_PROXY: 'http://secure:1', http_proxy: 'http://lower:1' }), ['-c', 'http.proxy=http://secure:1']);
  // NO_PROXY decides, as for the CLI: this machine's by default.
  assert.equal(toGalley('http://localhost:24823', { HTTP_PROXY: 'http://upper:1' }).env.NO_PROXY, 'localhost,127.0.0.1,[::1]');
});

test("pr wait keeps waiting while galley restarts or a proxy in front of it says it is down, not after an error of galley's own", async (t) => {
  // The first wait gets `first`, if any; the others wait out the rest, as galley does. With `drop`,
  // the first question whether it is galley loses its connection, as when galley restarts.
  let first: ((res: ServerResponse) => void) | null = null;
  let drop = false;
  const waits: string[] = [];
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/api/meta' && drop) return ((drop = false), req.socket.destroy());
    if (req.url === '/api/meta') return json(200, META);
    const wait = req.url!.match(/\/wait\?timeout=(\d+)/);
    if (!wait) return json(404, { message: 'Not Found' });
    waits.push(req.url!);
    if (waits.length === 1 && first) return first(res);
    setTimeout(() => json(200, { status: 'timeout' }), Number(wait[1]) * 1000);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const wait = () => galley(t, { GALLEY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1' }, 'pr', 'wait', 's1', '-R', 'acme/widgets', '--timeout', '4');

  // What `tailscale serve` answers while galley is down behind it.
  first = (res) => res.writeHead(502).end('Bad Gateway');
  const r = await wait();
  assert.equal(r.code, 124, r.stderr);
  assert.match(r.stderr, /No feedback yet on acme\/widgets s#1 \(timed out\)/);
  assert.equal(waits.length, 2);
  // galley's own error, with the same status, ends the wait.
  waits.length = 0;
  first = (res) => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'the server is shutting down', status: '503' }));
  const own = await wait();
  assert.equal(own.code, 1);
  assert.equal(own.stderr, 'the server is shutting down\n');
  assert.equal(waits.length, 1);
  // A connection dropped before the first wait.
  waits.length = 0;
  drop = true;
  first = null;
  const dropped = await wait();
  assert.equal(dropped.code, 124, dropped.stderr);
  assert.equal(drop, false);
  assert.equal(waits.length, 1);
});

test("--help prints a command's usage without running it", async (t) => {
  const server = await fake(t, () => [200, META]);
  const home = mkdtempSync(join(tmpdir(), 'galley-help-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // serve without --help would find the port taken and ask what holds it.
  const env = { ...process.env, GALLEY_URL: server.url, GALLEY_PORT: new URL(server.url).port, GALLEY_HOME: home, GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' };
  // Rejects unless the command exits with 0.
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), ...args], { cwd: home, env, timeout: 20_000 });
  // Without --help, each would close, publish or wait on s#1.
  for (const [cmd, flag] of [['close', '--comment'], ['publish', '--during-review'], ['wait', '--timeout']]) {
    const { stdout } = await run('pr', cmd, 's1', '--repo', 'o/r', '--help');
    assert.match(stdout, new RegExp(`^USAGE\\n  galley pr ${cmd} `, 'm'));
    assert.match(stdout, new RegExp(`^ +(-\\w, )?${flag} `, 'm'));
  }
  assert.match((await run('pr', 'reopen', '-h')).stdout, /^  galley pr reopen /m);
  assert.match((await run('serve', '--help')).stdout, /^  galley serve \[flags\]\n[\s\S]*^  -p, --port <number> /m);
  assert.deepEqual(server.paths, []);
});

test('pr create --reviewer takes repeats and commas like gh, and a number of reviews', () => {
  assert.deepEqual(parseReviewers(['octocat,codex:2', ' alice ', 'codex']), [
    { login: 'octocat' },
    { login: 'codex', max_iterations: 2 },
    { login: 'alice' },
    { login: 'codex' },
  ]);
  assert.deepEqual(parseReviewers(['a,,b,']), [{ login: 'a' }, { login: 'b' }]);
  for (const bad of ['codex:two', 'codex:', ':3', 'codex:-1']) assert.throws(() => parseReviewers([bad]), /invalid reviewer/, bad);
});

test('whoReviews names the reviewer agents that review a pull request on their own, by what they read', () => {
  const agent = (login: string, reviews: 'code' | 'description', automatic = true) => ({ login, reviewer: login, engine: 'claude', reviews, automatic, max_iterations: 3 });
  assert.equal(
    whoReviews([agent('codex-review', 'code'), agent('claude-review', 'code'), agent('house-rules', 'description')]),
    'When you wait, codex-review and claude-review review the code, and house-rules the title, description and commit messages.',
  );
  assert.equal(whoReviews([agent('codex-review', 'code', false)]), 'No reviewer agent reviews it.');
});

test('priorities: validated, and moved out of "[P1]"-style prefixes', () => {
  assert.equal(checkPriority('High'), 'high');
  assert.equal(checkPriority(''), null);
  assert.throws(() => checkPriority('urgent'), /priority must be one of high, medium, low/);
  assert.deepEqual(splitPriorityPrefix('[P1] Fix the guard\n\nDetails.'), { priority: 'high', body: 'Fix the guard\n\nDetails.' });
  assert.deepEqual(splitPriorityPrefix('[P0] Data loss'), { priority: 'high', body: 'Data loss' });
  assert.deepEqual(splitPriorityPrefix('[P2] Rename'), { priority: 'medium', body: 'Rename' });
  assert.deepEqual(splitPriorityPrefix('[P3] Typo'), { priority: 'low', body: 'Typo' });
  assert.deepEqual(splitPriorityPrefix('No prefix [P1] here'), { priority: null, body: 'No prefix [P1] here' });
});
