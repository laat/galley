// A server reached from other machines at a public URL, such as the HTTPS one `tailscale serve`
// gives it, in front of 127.0.0.1: which requests it takes, and the links it gives.
import './helpers/env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../src/server/server.ts';

const PUBLIC = 'https://galley.tailnet-1234.ts.net';

let dir: string;
let repo: string;
let server: Awaited<ReturnType<typeof startServer>>;

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A request to the server with the headers given, Host and Origin among them, which fetch does not let a caller set. */
function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: body ? { ...headers, 'content-type': 'application/json' } : headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-public-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  git('checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  git('commit', '-qam', 'Add mul');
  server = await startServer({
    port: 0,
    publicUrl: PUBLIC,
    allowedHosts: ['100.101.102.103:24823', 'galley'],
    dataDir: join(dir, 'data'),
    ghBin: 'false',
    codexBin: 'false',
    claudeBin: 'false',
    reviewersDir: join(dir, 'reviewers'),
    viewerLogin: 'reviewer',
    pollMs: 60_000,
    followMs: 60 * 60_000,
  });
});

after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("requests addressed to the public URL's host and the allowed hosts are taken, from pages there too", async () => {
  const { port } = new URL(server.url);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'galley.tailnet-1234.ts.net', 'Galley.Tailnet-1234.ts.net', '100.101.102.103:24823', 'galley']) {
    assert.equal((await send('GET', '/api/health', { host })).status, 200, host);
  }
  for (const host of ['evil.example', 'galley.tailnet-1234.ts.net.evil.example', '100.101.102.103', `galley:${port}`]) {
    const res = await send('GET', '/api/health', { host });
    assert.equal(res.status, 403, host);
    assert.match(res.text, /unexpected Host header/);
  }
  // A write from a page: over https behind `tailscale serve`, which may pass the Host on or put its own.
  const host = 'galley.tailnet-1234.ts.net';
  const setting = { mergeMethod: 'squash' };
  for (const [h, origin] of [
    [host, PUBLIC],
    [`127.0.0.1:${port}`, PUBLIC],
    ['100.101.102.103:24823', 'http://100.101.102.103:24823'],
    [`localhost:${port}`, `http://localhost:${port}`],
  ]) {
    assert.equal((await send('PUT', '/api/settings/publish', { host: h, origin }, setting)).status, 200, `${h} from ${origin}`);
  }
  for (const origin of ['https://evil.example', 'http://galley.tailnet-1234.ts.net.evil.example', 'null']) {
    const res = await send('PUT', '/api/settings/publish', { host, origin }, setting);
    assert.equal(res.status, 403, origin);
    assert.match(res.text, /cross-origin request refused/);
  }
});

test('links start with the public URL, and avatars on pages load from wherever the page was opened', async () => {
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${server.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  assert.equal(registered.html_url, `${PUBLIC}/${registered.full_name}`);
  const api = `/api/repos/${registered.full_name}`;
  const created = await (await fetch(`${server.url}${api}/pulls`, { method: 'POST', headers: { ...json, 'x-galley-actor': 'agent' }, body: JSON.stringify({ title: 'Add mul', head: 'feature/mul', base: 'main' }) })).json();
  const pull = `${PUBLIC}/${registered.full_name}/pull/${created.number}`;
  assert.equal(created.html_url, pull);
  assert.equal(created.user.avatar_url, `${PUBLIC}/avatars/agent.svg`);

  // The user comments from the page at the public URL; the agent answers with the CLI, which prints its comment's link.
  const comment = await send('POST', `${api}/issues/${created.number}/comments`, { host: 'galley.tailnet-1234.ts.net', origin: PUBLIC }, { body: 'Add a test.' });
  assert.equal(comment.status, 201, comment.text);
  assert.equal(JSON.parse(comment.text).html_url, `${pull}#issuecomment-${JSON.parse(comment.text).id}`);
  // The agent, on the server's machine, reaches it at localhost; the links it prints are the public URL's.
  const env = { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: 'agent', NO_COLOR: '1' };
  const cli = (...args: string[]) => promisify(execFile)(process.execPath, [join(import.meta.dirname, '..', 'bin', 'galley.ts'), ...args], { cwd: repo, env });
  assert.match((await cli('pr', 'wait', String(created.number), '--timeout', '10')).stdout, new RegExp(`^New feedback on ${pull} `, 'm'));
  assert.match((await cli('pr', 'comment', String(created.number), '-b', 'Added one.')).stdout, new RegExp(`^${pull}#issuecomment-\\d+$`, 'm'));
  assert.equal((await cli('browse', `s${created.number}`, '--no-browser')).stdout, `${pull}\n`);

  // Copy link gives the public URL; the avatars are the page's own.
  const page = await (await fetch(`${server.url}/${registered.full_name}/pull/${created.number}`)).text();
  assert.match(page, new RegExp(`data-copy="${pull}#issuecomment-\\d+"`));
  assert.match(page, / src="\/avatars\/agent\.svg"/);
  assert.doesNotMatch(page, /src="https?:\/\/[^"]*\/avatars\//);
});
