// galley's git endpoint for its clones (src/server/git-http.ts): git's smart HTTP at
// /git/<owner>/<name>.git, and what its pre-receive hook takes (src/server/receive-hook.ts).
import './helpers/env.ts';
import { dir, git, gitToGalley, human, repo, scratchRepo, server, startHarness } from './helpers/harness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';

startHarness({ clones: true });

/** galley's clone of acme/widgets, registered by its GitHub name, and git in it. */
async function widgets() {
  const json = await human('POST', '/api/repos', { github: 'acme/widgets' });
  const clone = (...args: string[]) => execFileSync('git', ['--git-dir', json.git_dir, ...args], { encoding: 'utf8' }).trim();
  const tip = (ref: string) => execFileSync('git', ['--git-dir', json.git_dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
  return { url: json.git_url as string, gitDir: json.git_dir as string, clone, tip };
}

/** A request with the headers given, Host among them, which fetch does not let a caller set. */
function send(path: string, headers: Record<string, string>): Promise<{ status: number; type: string; text: string }> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), text }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('galley serves its clone of a repository over git smart HTTP, and only branches go in', async () => {
  const { url, gitDir, clone, tip } = await widgets();
  assert.equal(url, `${server.url}/git/acme/widgets.git`);
  assert.equal(gitDir, join(dir, 'data', 'repos', '1.git'));
  // It has GitHub's default branch, which HEAD names.
  assert.equal(tip('refs/remotes/origin/main'), git('rev-parse', 'main'));
  assert.equal(clone('symbolic-ref', 'HEAD'), 'refs/remotes/origin/main');
  // Registering again gives the same clone.
  assert.equal((await human('POST', '/api/repos', { github: 'acme/widgets' })).id, 1);

  // A push larger than git's post buffer goes chunked, without a Content-Length.
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/big');
  writeFileSync(join(repo, 'big.bin'), randomBytes(512 * 1024));
  git('add', 'big.bin');
  git('commit', '-qm', 'Add a big file');
  const pushed = await gitToGalley(['-c', 'http.postBuffer=65536', 'push', url, 'feature/big']);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(tip('refs/heads/feature/big'), git('rev-parse', 'feature/big'));

  // Its other refs are galley's: what it fetched from GitHub, and its pins.
  for (const ref of ['refs/remotes/origin/main', 'refs/galley/x', 'refs/tags/v1']) {
    const r = await gitToGalley(['push', url, `feature/big:${ref}`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`remote: galley: ${ref}: galley takes branches only \\(refs/heads/…\\); its other refs are its own`));
  }
  assert.equal(tip('refs/remotes/origin/main'), git('rev-parse', 'main'));
  const deleted = await gitToGalley(['push', url, ':feature/big']);
  assert.match(deleted.stderr, /remote: galley: feature\/big: galley does not delete branches/);
  assert.equal(tip('refs/heads/feature/big'), git('rev-parse', 'feature/big'));

  // Fetching back over protocol v2, as the CLI fetches what galley fetched from GitHub.
  const fetched = await gitToGalley(['-c', 'protocol.version=2', 'fetch', '--no-tags', url, 'refs/remotes/origin/main:refs/remotes/galley/main']);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(git('rev-parse', 'refs/remotes/galley/main'), git('rev-parse', 'main'));
  git('update-ref', '-d', 'refs/remotes/galley/main');
  // galley's own refs are not advertised.
  clone('update-ref', 'refs/galley/test/pin', 'refs/heads/feature/big');
  const listed = await gitToGalley(['ls-remote', url]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /\trefs\/heads\/feature\/big$/m);
  assert.doesNotMatch(listed.stdout, /refs\/galley/);
});

test('the git endpoint answers only for galley’s clones, and only to requests addressed to galley', async () => {
  const { url } = await widgets();
  const { fullName } = await scratchRepo('by-path');
  const smart = '/info/refs?service=git-upload-pack';
  const git404 = { status: 404, type: 'text/plain; charset=UTF-8', text: 'Not Found' };
  const host = `127.0.0.1:${new URL(server.url).port}`;
  // A repository galley does not know, one registered by path, git's dumb protocol, and other paths.
  for (const path of [`/git/acme/nothing.git${smart}`, `/git/${fullName}.git${smart}`, '/git/acme/widgets.git/info/refs', '/git/acme/widgets.git/HEAD', '/git/acme/widgets.git/objects/info/packs']) {
    assert.deepEqual(await send(path, { host }), git404, path);
  }
  assert.equal((await send(`/git/acme/widgets.git${smart}`, { host })).status, 200);
  // Not a git path: the page of a GitHub owner called "git".
  assert.notDeepEqual(await send('/git/widgets', { host }), git404);
  // As for the API: a Host galley does not answer to is refused.
  const foreign = await send(`/git/acme/widgets.git${smart}`, { host: 'evil.example' });
  assert.equal(foreign.status, 403);
  assert.match(foreign.text, /unexpected Host header/);
  const cloned = await gitToGalley(['ls-remote', url.replace('/acme/widgets.git', '/acme/nothing.git')]);
  assert.equal(cloned.code, 128);
  assert.match(cloned.stderr, /not found/);
});

test('a branch on galley is replaced only by a fast-forward, or with a lease on the commit galley has', async () => {
  const { url, tip } = await widgets();
  const branch = 'feature/guarded';
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, 'guarded.js'), 'export const one = 1;\n');
  git('add', 'guarded.js');
  git('commit', '-qm', 'Add one');
  assert.equal((await gitToGalley(['push', url, branch])).code, 0);
  const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
    body: JSON.stringify({ title: 'Add one', head: branch, base: 'main', automatic_reviews: false }),
  });
  assert.equal(res.status, 201);
  const { number } = await res.json();
  const first = git('rev-parse', 'HEAD');

  // A fast-forward goes in, and the pull request has it when the push returns.
  writeFileSync(join(repo, 'guarded.js'), 'export const one = 1;\nexport const two = 2;\n');
  git('commit', '-qam', 'Add two');
  const second = git('rev-parse', 'HEAD');
  assert.equal((await gitToGalley(['push', url, branch])).code, 0);
  assert.equal(server.service.db.get<{ head_sha: string }>('SELECT head_sha FROM pulls WHERE number = ? AND repo_id = 1', number)!.head_sha, second);

  // A rewrite with --force alone, as another machine's branch of the same name would be, is refused.
  git('commit', '-q', '--amend', '-m', 'Add two, amended');
  const amended = git('rev-parse', 'HEAD');
  const forced = await gitToGalley(['push', '--force', url, branch]);
  assert.equal(forced.code, 1);
  assert.match(
    forced.stderr,
    new RegExp(`remote: galley: ${branch}: galley has it at ${second.slice(0, 7)}, which this push does not have\\. galley replaces a branch only by a fast-forward, or with a lease on the commit it has there \\(-o lease=${branch}:<sha>\\)`),
  );
  // So is one whose lease names another commit than galley has (git checks its own lease, --force-with-lease, before it asks).
  const stale = await gitToGalley(['push', '--force', '-o', `lease=${branch}:${first}`, url, branch]);
  assert.match(stale.stderr, new RegExp(`remote: galley: ${branch}: galley has it at ${second.slice(0, 7)}, not at ${first.slice(0, 7)} as the lease says`));
  assert.equal(tip(`refs/heads/${branch}`), second);
  assert.equal(server.service.db.get<{ head_sha: string }>('SELECT head_sha FROM pulls WHERE number = ? AND repo_id = 1', number)!.head_sha, second);

  // With a lease on what galley has, the rewrite goes in.
  const leased = await gitToGalley(['push', `--force-with-lease=${branch}:${second}`, '-o', `lease=${branch}:${second}`, url, branch]);
  assert.equal(leased.code, 0, leased.stderr);
  assert.equal(tip(`refs/heads/${branch}`), amended);
  const pull = server.service.db.get<{ id: number; head_sha: string }>('SELECT id, head_sha FROM pulls WHERE number = ? AND repo_id = 1', number)!;
  assert.equal(pull.head_sha, amended);
  assert.deepEqual(
    server.service.db.all<{ head_sha: string; forced: number }>('SELECT head_sha, forced FROM revisions WHERE pull_id = ? ORDER BY seq', pull.id).map((r) => ({ ...r })),
    [
      { head_sha: first, forced: 0 },
      { head_sha: second, forced: 0 },
      { head_sha: amended, forced: 1 },
    ],
  );

  // A lease on no branch creates one, and refuses where galley has one.
  const fresh = await gitToGalley(['push', '-o', 'lease=feature/fresh:', url, `${branch}:feature/fresh`]);
  assert.equal(fresh.code, 0, fresh.stderr);
  const again = await gitToGalley(['push', '--force', '-o', 'lease=feature/fresh:', url, `${first}:refs/heads/feature/fresh`]);
  assert.match(again.stderr, new RegExp(`remote: galley: feature/fresh: galley has it at ${amended.slice(0, 7)}, not at no commit as the lease says`));
});

test('a relative data directory is taken from where the server starts: git runs in the clones, and their hooks there', () => {
  const s = new Service({ db: new Db(':memory:'), baseUrl: 'http://localhost:0', dataDir: 'data' });
  assert.equal(s.dataDir, join(process.cwd(), 'data'));
  assert.equal(s.gitDir({ git_dir: 'repos/1.git' } as Parameters<Service['gitDir']>[0]), join(process.cwd(), 'data', 'repos', '1.git'));
});
