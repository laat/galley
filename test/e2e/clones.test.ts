// galley's own clones of GitHub repositories: staged from branches pushed to its
// git endpoint, reviewed, published, and fetched from GitHub, all in the clone, with nothing
// written to the agent's repository. The bare repositories beside it stand in for GitHub. The
// CLI sends the author's branch there, and fetches back what galley fetched from GitHub.
import '../helpers/env.ts';
import { cli, dir, git, gitToGalley, human, remote, repo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { PullRow, RepoRow } from '../../src/server/db.ts';
import { Client } from '../../src/cli/client.ts';
import { clearPushRemote, sendPull } from '../../src/cli/send.ts';

startHarness();

const API = '/api/repos/acme/widgets';

/** galley's clone of acme/widgets: its git URL, and git in it. */
async function widgets() {
  const json = await human('POST', '/api/repos', { github: 'acme/widgets' });
  const clone = (...args: string[]) => execFileSync('git', ['--git-dir', json.git_dir, ...args], { encoding: 'utf8' }).trim();
  return { url: json.git_url as string, gitDir: json.git_dir as string, clone, row: server.service.repoById(json.id) };
}

/** A request as the agent, from a machine called laptop. */
async function asAgent(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(server.url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent', 'x-galley-client': 'laptop:/home/dev/widgets/.git' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** A branch off main with a commit adding `file`, sent to galley and staged there as the agent. */
async function stage(branch: string, file: string, content = 'export {};\n') {
  const { url } = await widgets();
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, file), content);
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const pushed = await gitToGalley(['push', url, branch]);
  assert.equal(pushed.code, 0, pushed.stderr);
  const created = await asAgent('POST', `${API}/pulls`, { title: `Add ${file}`, head: branch, base: 'main', automatic_reviews: false });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { number: created.json.number as number, id: created.json.id as number, base: `${API}/pulls/${created.json.number}` };
}

test('a branch sent to galley is staged from its clone, and nothing is written to the agent’s repository', async () => {
  const { url, gitDir, clone } = await widgets();
  // Not sent yet.
  git('checkout', '-q', 'feature/mul');
  const unsent = await asAgent('POST', `${API}/pulls`, { title: 'Add mul', head: 'feature/mul', base: 'main' });
  assert.equal(unsent.status, 422);
  assert.equal(unsent.json.message, `galley does not have branch "feature/mul": push it to ${url} first`);

  assert.equal((await gitToGalley(['push', url, 'feature/mul'])).code, 0);
  const created = await asAgent('POST', `${API}/pulls`, { title: 'Add mul', head: 'feature/mul', base: 'main', automatic_reviews: false });
  assert.equal(created.status, 201);
  const { number } = created.json;
  const view = async () => (await asAgent('GET', `${API}/gh/pulls/${number}?fields=headRefOid,client,baseRefOid`)).json;
  assert.deepEqual(await view(), { headRefOid: git('rev-parse', 'HEAD'), baseRefOid: git('rev-parse', 'main'), client: 'laptop:/home/dev/widgets/.git' });
  // galley pins the revision in its clone, not in the agent's repository.
  assert.equal(clone('for-each-ref', '--format=%(objectname)', `refs/galley/${server.service.db.instance}/pull/${number}/1`), git('rev-parse', 'HEAD'));
  assert.equal(git('for-each-ref', 'refs/galley'), '');

  // A commit sent to galley is a revision by the time the push returns.
  writeFileSync(join(repo, 'math.js'), readFileSync(join(repo, 'math.js'), 'utf8') + '\nexport function sub(a, b) {\n  return a - b;\n}\n');
  git('commit', '-qam', 'Add sub');
  assert.equal((await gitToGalley(['push', url, 'feature/mul'])).code, 0);
  assert.equal((await view()).headRefOid, git('rev-parse', 'HEAD'));
  const { commits } = (await asAgent('GET', `${API}/gh/pulls/${number}?fields=commits`)).json;
  assert.deepEqual(commits.map((c: any) => c.messageHeadline), ['Add mul', 'Add sub']);
  // Also when a sync under way, such as the poll's, read the branch before the push: the push waits
  // for it, and syncs again. (One that stands in for such a sync ends once the push is in.)
  const syncing = (server.service as unknown as { syncing: Map<number, Promise<unknown>> }).syncing;
  const id = created.json.id as number;
  const before = server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!;
  let end!: () => void;
  const stale = new Promise<void>((resolve) => (end = resolve)).then(() => {
    syncing.delete(id);
    return before;
  });
  syncing.set(id, stale);
  writeFileSync(join(repo, 'math.js'), readFileSync(join(repo, 'math.js'), 'utf8') + '\nexport const zero = 0;\n');
  git('commit', '-qam', 'Add zero');
  const pushing = gitToGalley(['push', url, 'feature/mul']);
  await until(() => clone('rev-parse', 'refs/heads/feature/mul') === git('rev-parse', 'HEAD'), 'the push is in');
  setTimeout(end, 300);
  assert.equal((await pushing).code, 0);
  assert.equal(server.service.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', id)!.head_sha, git('rev-parse', 'HEAD'));
  assert.equal(git('for-each-ref', 'refs/galley'), '');
  // The page names the clone.
  const page = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  assert.ok(page.includes(`<code class="wrap">${gitDir}</code>`));
});

test('a reviewer agent reviews in a worktree of galley’s clone', async () => {
  const { gitDir, clone } = await widgets();
  const pr = await stage('feature/reviewed', 'codex.js', 'export const answer = 42;\n');
  const gate = join(dir, 'clone-review-gate');
  const calls = () => (existsSync(process.env.FAKE_CODEX_LOG!) ? readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n') : []);
  const before = calls().length;
  let checkout = '';
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
    await human('POST', `${pr.base}/reviewers/codex`);
    const call = JSON.parse((await until(() => calls()[before], 'Codex reviews'))!);
    checkout = call.args[call.args.indexOf('-C') + 1];
    assert.equal(call.sawFile, true, 'Codex runs in a checkout of the head');
    assert.ok(readFileSync(join(checkout, '.git'), 'utf8').startsWith(`gitdir: ${realpathSync(gitDir)}/worktrees/`));
    assert.match(clone('worktree', 'list', '--porcelain'), new RegExp(`^worktree ${checkout}$`, 'm'));
    assert.doesNotMatch(git('worktree', 'list', '--porcelain'), /galley-review-/);
    writeFileSync(gate, '');
    await server.service.codex!.settle(pr.id);
  });
  const { runs } = await human('GET', `${pr.base}/reviewers/codex`);
  assert.deepEqual(runs.map((r: any) => r.status), ['done']);
  assert.doesNotMatch(clone('worktree', 'list', '--porcelain'), new RegExp(`^worktree ${checkout}$`, 'm'));
});

test('publishing pushes from galley’s clone to GitHub, signed, and so do the pushes after it', async () => {
  const { url } = await widgets();
  const pr = await stage('feature/publish', 'publish.js');
  const head = git('rev-parse', 'HEAD');
  const onGithub = () => execFileSync('git', ['-C', remote, 'rev-parse', 'refs/heads/feature/publish'], { encoding: 'utf8' }).trim();
  const commit = (sha: string) => execFileSync('git', ['-C', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' });
  const published = await human('POST', `${pr.base}/publish`, { sign: true });
  assert.equal(published.published_url, 'https://github.com/acme/widgets/pull/7');
  const signed = onGithub();
  assert.notEqual(signed, head);
  assert.match(commit(signed), /^gpgsig /m);
  assert.match(commit(signed), /^committer Reviewer <reviewer@example\.com> /m);
  assert.equal(execFileSync('git', ['-C', remote, 'rev-parse', `${signed}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', `${head}^{tree}`));
  assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/widgets --base main --head feature\/publish /m);

  // The author's next commit, sent to galley, is pushed when it waits: signed as published, on top of what galley pushed.
  const heard = await asAgent('GET', `${pr.base}/wait?timeout=5`);
  assert.equal(heard.json.status, 'published');
  await asAgent('PUT', `${pr.base}/seen`, { at: heard.json.seen_at });
  writeFileSync(join(repo, 'publish.js'), 'export const more = 1;\n');
  git('commit', '-qam', 'More');
  assert.equal((await gitToGalley(['push', url, 'feature/publish'])).code, 0);
  const waited = await asAgent('GET', `${pr.base}/wait?timeout=5`);
  assert.equal(waited.json.status, 'pushed', JSON.stringify(waited.json));
  const next = onGithub();
  assert.equal(execFileSync('git', ['-C', remote, 'rev-parse', `${next}^`], { encoding: 'utf8' }).trim(), signed);
  assert.match(commit(next), /^gpgsig /m);
});

test('before the first publish, galley asks GitHub for the branch: one there is replaced only with force, and one gone leaves no lease behind', async () => {
  const { clone } = await widgets();
  const onGithub = (branch: string) => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  // Pushed to GitHub by hand before it was staged, then amended: publishing needs force, and leases against GitHub's.
  const there = await stage('feature/there', 'there.js');
  git('push', '-q', remote, 'feature/there');
  const theirs = git('rev-parse', 'HEAD');
  git('commit', '-q', '--amend', '-m', 'Add there.js, reworded');
  assert.equal((await gitToGalley(['push', '--force-with-lease=refs/heads/feature/there:' + theirs, '-o', `lease=feature/there:${theirs}`, `${server.url}/git/acme/widgets.git`, 'feature/there'])).code, 0);
  const refused = await fetch(`${server.url}${there.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: false, force: false }) });
  assert.equal(refused.status, 409);
  assert.equal(clone('rev-parse', 'refs/remotes/origin/feature/there'), theirs);
  assert.equal(onGithub('feature/there'), theirs);
  assert.equal((await human('POST', `${there.base}/publish`, { sign: false, force: true })).staging_state, 'published');
  assert.equal(onGithub('feature/there'), git('rev-parse', 'HEAD'));
  // A remote-tracking branch an earlier fetch left, of a branch GitHub no longer has: no lease against it.
  const gone = await stage('feature/gone-there', 'gone-there.js');
  clone('update-ref', 'refs/remotes/origin/feature/gone-there', theirs);
  assert.equal((await human('POST', `${gone.base}/publish`, { sign: false })).staging_state, 'published');
  assert.equal(onGithub('feature/gone-there'), git('rev-parse', 'HEAD'));
  assert.equal(clone('for-each-ref', 'refs/remotes/origin/feature/gone-there'), '');
});

test('galley fetches base branches from GitHub into its clone, and checks the head against them', async () => {
  const { clone, row } = await widgets();
  const pr = await stage('feature/conflicting', 'math.js', 'export const add = (a, b) => a + b;\n');
  // The base moves on GitHub, in the same lines.
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => b + a;\n');
  git('commit', '-qam', 'Move the base');
  git('push', '-q', 'origin', 'main');
  const moved = git('rev-parse', 'main');
  assert.notEqual(clone('rev-parse', 'refs/remotes/origin/main'), moved);
  await server.service.fetchBases(row, { base: 'main' });
  assert.equal(clone('rev-parse', 'refs/remotes/origin/main'), moved);
  const conflicts = await until(async () => {
    const { baseConflicts } = (await asAgent('GET', `${pr.base.replace('/pulls/', '/gh/pulls/')}?fields=baseConflicts`)).json;
    return baseConflicts?.oid === moved && baseConflicts;
  }, 'galley checks the head against the base it fetched');
  assert.deepEqual({ ...conflicts }, { ref: 'origin/main', oid: moved, conflicting: true, files: ['math.js'], messages: [], behindBy: 1 });

  // A base the clone does not have yet is fetched when a pull request is staged onto it.
  git('push', '-q', 'origin', 'main:develop');
  const { url } = await widgets();
  git('checkout', '-qb', 'feature/on-develop', 'main');
  writeFileSync(join(repo, 'develop.js'), 'export {};\n');
  git('add', 'develop.js');
  git('commit', '-qm', 'Add develop.js');
  assert.equal((await gitToGalley(['push', url, 'feature/on-develop'])).code, 0);
  const onDevelop = await asAgent('POST', `${API}/pulls`, { title: 'On develop', head: 'feature/on-develop', base: 'develop', automatic_reviews: false });
  assert.equal(onDevelop.status, 201, JSON.stringify(onDevelop.json));
  assert.equal(clone('rev-parse', 'refs/remotes/origin/develop'), moved);
  // So is one a pull request is moved onto.
  git('push', '-q', 'origin', 'main:release');
  const rebased = await asAgent('PATCH', pr.base, { base: 'release' });
  assert.equal(rebased.status, 200, JSON.stringify(rebased.json));
  assert.equal(clone('rev-parse', 'refs/remotes/origin/release'), moved);

  // A base GitHub does not have is a branch sent to galley (stacked pull requests): no error.
  git('checkout', '-qb', 'feature/upper');
  writeFileSync(join(repo, 'upper.js'), 'export {};\n');
  git('add', 'upper.js');
  git('commit', '-qm', 'Add upper.js');
  assert.equal((await gitToGalley(['push', url, 'feature/upper'])).code, 0);
  const stacked = await asAgent('POST', `${API}/pulls`, { title: 'Upper', head: 'feature/upper', base: 'feature/on-develop', automatic_reviews: false });
  assert.equal(stacked.status, 201, JSON.stringify(stacked.json));
  await server.service.fetchBases(row, { base: 'feature/on-develop' });
  assert.equal(server.service.fetchError(row, 'feature/on-develop'), null);
});

test('commits GitHub did not merge are found in galley’s clone', async () => {
  const { url } = await widgets();
  const pr = await stage('feature/left-out', 'left-out.js');
  await human('POST', `${pr.base}/publish`, { sign: false });
  // Sent to galley before it hears of the merge, and never pushed to GitHub: the author did not wait with it.
  writeFileSync(join(repo, 'left-out.js'), 'export const late = 1;\n');
  git('commit', '-qam', 'Too late');
  const late = git('rev-parse', 'HEAD');
  assert.equal((await gitToGalley(['push', url, 'feature/left-out'])).code, 0);
  const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '1'.repeat(33) }, timelineItems: { nodes: [] } };
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
  await server.service.followGithub();
  const waited = await asAgent('GET', `${pr.base}/wait?timeout=5`);
  assert.equal(waited.json.status, 'merged');
  assert.deepEqual(
    { head: waited.json.left_out.head, deleted: waited.json.left_out.deleted, commits: waited.json.left_out.commits.map((c: any) => c.sha) },
    { head: late, deleted: false, commits: [late] },
  );
});

test('a GitHub repository registered twice at once is cloned once, and under a name it had before is the same', async () => {
  // GitHub's acme/twice, with a main branch.
  const twice = join(dir, 'twice.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', twice]);
  git('push', '-q', twice, 'main');
  const repos = join(dir, 'data', 'repos');
  const answers = await Promise.all(['acme/twice', 'acme/twice', 'Acme/Twice.git'].map((github) => human('POST', '/api/repos', { github })));
  assert.deepEqual(new Set(answers.map((a) => a.id)).size, 1);
  assert.equal(answers[0].git_url, `${server.url}/git/acme/twice.git`);
  const clones = server.service.db.all<RepoRow>("SELECT * FROM repos WHERE git_dir LIKE 'repos/%' ORDER BY id").map((r) => r.git_dir.slice('repos/'.length));
  assert.deepEqual(readdirSync(repos).sort(), clones.sort());

  // GitHub does not have it, or it is not a GitHub name: nothing is registered, and nothing left behind.
  const missing = await fetch(`${server.url}/api/repos`, { method: 'POST', body: JSON.stringify({ github: 'acme/missing' }) });
  assert.equal(missing.status, 502);
  assert.match((await missing.json()).message, /^could not ask GitHub for the default branch of acme\/missing: /);
  const invalid = await fetch(`${server.url}/api/repos`, { method: 'POST', body: JSON.stringify({ github: 'acme/../widgets' }) });
  assert.equal(invalid.status, 422);
  assert.deepEqual(readdirSync(repos).sort(), clones.sort());
  assert.equal(server.service.db.get('SELECT 1 FROM repos WHERE github_slug = ?', 'acme/missing'), undefined);

  // Under a name it had before (as galley followed a rename on GitHub in the remote of a repository registered by path), in any case.
  server.service.db.run('INSERT INTO repo_aliases (owner, name, repo_id) VALUES (?, ?, ?)', 'acme', 'once', answers[0].id);
  assert.equal((await human('POST', '/api/repos', { github: 'Acme/Once' })).id, answers[0].id);
  // A CLI from before galley kept clones registers by path, which galley no longer does.
  const byPath = await fetch(`${server.url}/api/repos`, { method: 'POST', body: JSON.stringify({ path: repo }) });
  assert.equal(byPath.status, 422);
  assert.equal((await byPath.json()).message, 'galley registers a repository by its GitHub owner/name (github), not by path: update the CLI');
});

/** A branch off main in the agent's repository with a commit adding `file`, staged with the CLI as the agent: its number and API path. */
async function stageWithCli(branch: string, file: string, ...flags: string[]) {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, file), 'export {};\n');
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...flags]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stderr, new RegExp(`^Sent ${branch} at ${git('rev-parse', 'HEAD').slice(0, 7)} to galley\\.$`, 'm'));
  const number = Number(created.stdout.trim().split('/').pop());
  const id = server.service.db.get<{ id: number }>("SELECT pulls.id FROM pulls JOIN repos ON repos.id = pulls.repo_id WHERE repos.owner = 'acme' AND repos.name = 'widgets' AND number = ?", number)!.id;
  return { number, id, url: created.stdout.trim(), base: `${API}/pulls/${number}`, wait: (opts: Parameters<typeof cli>[1] = {}) => cli(['pr', 'wait', String(number), '--timeout', '20s'], opts) };
}

/** A setting in the git config of the agent's repository (or of `cwd`), all its values; null when it has none. */
function setting(key: string, cwd = repo): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'config', '--get-all', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const revisions = (id: number) => server.service.db.all<{ seq: number; head_sha: string; forced: number }>('SELECT seq, head_sha, forced FROM revisions WHERE pull_id = ? ORDER BY seq', id);

/** A commit made on GitHub, in the bare repository: `at`'s tree on top of `parent` (a rebase there), its SHA. */
function madeOnGithub(at: string, parent: string): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' };
  return execFileSync('git', ['--git-dir', remote, 'commit-tree', `${at}^{tree}`, '-p', parent, '-m', 'Rebased on GitHub'], { encoding: 'utf8', env }).trim();
}

test('pr create and pr wait send the author’s branch to galley’s clone first, and nothing of galley’s is written to the checkout', async () => {
  const { clone } = await widgets();
  const pr = await stageWithCli('feature/sent', 'sent.js', '--reviewer', 'codex');
  const first = git('rev-parse', 'HEAD');
  assert.deepEqual(revisions(pr.id).map((r) => [r.seq, r.head_sha]), [[1, first]]);
  // Where it was staged from: this machine, and the checkout's git directory.
  const { client } = (await asAgent('GET', `${API}/gh/pulls/${pr.number}?fields=client`)).json;
  assert.equal(client, `${hostname()}:${git('rev-parse', '--path-format=absolute', '--git-common-dir')}`);
  assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'client'])).stdout), { client });

  // The next commit is sent by the wait, before it waits: the reviewer agent reviews it, in galley's clone.
  writeFileSync(join(repo, 'sent.js'), 'export const sent = 2;\n');
  git('commit', '-qam', 'Change sent.js');
  const second = git('rev-parse', 'HEAD');
  const gate = join(dir, 'sent-review-gate');
  const calls = () => (existsSync(process.env.FAKE_CODEX_LOG!) ? readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n') : []);
  const before = calls().length;
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
    const waiting = pr.wait();
    const call = JSON.parse((await until(() => calls()[before], 'Codex reviews what the wait sent'))!);
    assert.deepEqual(revisions(pr.id).map((r) => [r.seq, r.head_sha]), [[1, first], [2, second]]);
    assert.equal(execFileSync('git', ['-C', call.args[call.args.indexOf('-C') + 1], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), second);
    // No worktree in the checkout, nor galley's refs.
    assert.doesNotMatch(git('worktree', 'list', '--porcelain'), /galley-review-/);
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
    assert.equal(git('for-each-ref', 'refs/galley'), '');
    writeFileSync(gate, '');
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`^Sent feature/sent at ${second.slice(0, 7)} to galley\\.$`, 'm'));
    assert.match(r.stdout, new RegExp(`^codex-review reviewed: commented [^]*Codex \\(default model\\) reviewed \`${second.slice(0, 7)}\``, 'm'));
    await server.service.codex!.settle(pr.id);
  });
  // Nothing new: nothing is sent.
  const again = await cli(['pr', 'view', String(pr.number)]);
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stderr, /Sent /);
  // Named by its URL from the checkout, it is sent all the same.
  writeFileSync(join(repo, 'sent.js'), 'export const sent = 3;\n');
  git('commit', '-qam', 'Change sent.js again');
  const byUrl = await cli(['pr', 'view', pr.url]);
  assert.equal(byUrl.code, 0, byUrl.stderr);
  assert.match(byUrl.stderr, new RegExp(`^Sent feature/sent at ${git('rev-parse', 'HEAD').slice(0, 7)} to galley\\.$`, 'm'));
  assert.equal(clone('rev-parse', 'refs/heads/feature/sent'), git('rev-parse', 'HEAD'));
});

test('when the head conflicts with the base galley fetched, pr wait fetches that base into the checkout’s galley/main, leaving origin/main, unless the one there is newer', async () => {
  const { clone, row } = await widgets();
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/clash');
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b; // clash\n');
  git('commit', '-qam', 'Rewrite add');
  const created = await cli(['pr', 'create', '--title', 'Rewrite add', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  // The base moves on GitHub, in the same lines, and galley fetches it; the checkout has not.
  const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  git('checkout', '-q', '--detach', tip);
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => b + a; // moved\n');
  git('commit', '-qam', 'Move the base again');
  const moved = git('rev-parse', 'HEAD');
  // GitHub fetches it rather than the checkout pushing it: git 2.56 moves origin/main on a push to
  // its push URL, which the bare repository is (pushInsteadOf), and origin/main is to stay older.
  execFileSync('git', ['--git-dir', remote, 'fetch', '-q', repo, 'HEAD:refs/heads/main']);
  git('checkout', '-q', 'feature/clash');
  const older = git('rev-parse', 'refs/remotes/origin/main');
  assert.notEqual(older, moved);
  await server.service.fetchBases(row, { base: 'main' });
  assert.equal(clone('rev-parse', 'refs/remotes/origin/main'), moved);
  await until(async () => (await asAgent('GET', `${API}/gh/pulls/${number}?fields=baseConflicts`)).json.baseConflicts?.oid === moved, 'galley finds the conflict');

  let r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^This branch conflicts with galley\/main in math\.js; rebase onto galley\/main\./m);
  assert.match(r.stdout, /^Rebase onto galley\/main, resolve the conflicts and run the tests/m);
  assert.equal(git('rev-parse', 'refs/remotes/galley/main'), moved);
  // origin/main is what the checkout last fetched from GitHub.
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), older);

  // One fetched from galley since, newer than what galley fetched then, stays.
  git('checkout', '-q', '--detach', moved);
  writeFileSync(join(repo, 'newer.js'), 'export {};\n');
  git('add', 'newer.js');
  git('commit', '-qm', 'Newer on GitHub');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'feature/clash');
  git('update-ref', 'refs/remotes/galley/main', newer);
  await human('POST', `${API}/issues/${number}/comments`, { body: 'Rebase, please.' });
  r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^This branch conflicts with galley\/main in math\.js; rebase onto galley\/main\./m);
  assert.equal(r.stderr, '');
  assert.equal(git('rev-parse', 'refs/remotes/galley/main'), newer);
  // One that is another (main rewritten on GitHub) becomes galley's.
  git('checkout', '-q', '--detach', older);
  writeFileSync(join(repo, 'other.js'), 'export {};\n');
  git('add', 'other.js');
  git('commit', '-qm', 'Another main');
  git('update-ref', 'refs/remotes/galley/main', git('rev-parse', 'HEAD'));
  git('checkout', '-q', 'feature/clash');
  await human('POST', `${API}/issues/${number}/comments`, { body: 'Rebase onto the right one, please.' });
  r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git('rev-parse', 'refs/remotes/galley/main'), moved);
  assert.equal(git('rev-parse', 'refs/remotes/origin/main'), older);
});

test('pr create sends a base galley does not have, of a pull request stacked on a branch not staged yet, and pr wait fetches it into galley/<base> when the head conflicts with it', async () => {
  const { clone } = await widgets();
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stack-base');
  writeFileSync(join(repo, 'stack.js'), 'export const stack = 1;\n');
  git('add', 'stack.js');
  git('commit', '-qm', 'Add stack.js');
  git('checkout', '-qb', 'feature/stack-top');
  writeFileSync(join(repo, 'stack.js'), 'export const stack = 2;\n');
  git('commit', '-qam', 'Change stack.js');
  // Neither is on galley or GitHub: both are sent.
  const created = await cli(['pr', 'create', '--title', 'Change stack.js', '--body', 'x', '--base', 'feature/stack-base']);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stderr, new RegExp(`^Sent feature/stack-base at ${git('rev-parse', '--short=7', 'feature/stack-base')} to galley\\.$`, 'm'));
  assert.match(created.stderr, new RegExp(`^Sent feature/stack-top at ${git('rev-parse', '--short=7', 'HEAD')} to galley\\.$`, 'm'));
  const number = Number(created.stdout.trim().split('/').pop());
  assert.equal((await asAgent('GET', `${API}/gh/pulls/${number}?fields=baseRefName`)).json.baseRefName, 'feature/stack-base');
  // A base the checkout has a remote-tracking branch of is GitHub's to give: main is not sent.
  git('checkout', '-qb', 'feature/on-main', 'main');
  writeFileSync(join(repo, 'on-main.js'), 'export {};\n');
  git('add', 'on-main.js');
  git('commit', '-qm', 'Add on-main.js');
  const onMain = await cli(['pr', 'create', '--title', 'Add on-main.js', '--body', 'x', '--base', 'main']);
  assert.equal(onMain.code, 0, onMain.stderr);
  assert.doesNotMatch(onMain.stderr, /Sent main/);
  assert.equal(clone('for-each-ref', 'refs/heads/main'), '');

  // The base moves on galley, in the same lines: the wait says to rebase onto galley's, fetched into galley/<base>.
  git('checkout', '-q', 'feature/stack-base');
  writeFileSync(join(repo, 'stack.js'), 'export const stack = 3;\n');
  git('commit', '-qam', 'Set stack to 3');
  const moved = git('rev-parse', 'HEAD');
  assert.equal((await gitToGalley(['push', `${server.url}/git/acme/widgets.git`, 'feature/stack-base'])).code, 0);
  git('checkout', '-q', 'feature/stack-top');
  await until(async () => (await asAgent('GET', `${API}/gh/pulls/${number}?fields=baseConflicts`)).json.baseConflicts?.oid === moved, 'galley finds the conflict');
  const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^This branch conflicts with galley\/feature\/stack-base in stack\.js; rebase onto galley\/feature\/stack-base\./m);
  assert.equal(git('rev-parse', 'refs/remotes/galley/feature/stack-base'), moved);
  // No local branch was written.
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/heads/galley'), '');
});

test('after GitHub refused a push for the branch rewritten there, pr wait fetches it into the checkout, and the rebase onto it is sent and pushed', async () => {
  await widgets();
  const pr = await stageWithCli('feature/rewritten', 'rewritten.js');
  const since = git('rev-parse', 'HEAD');
  await human('POST', `${pr.base}/publish`, { sign: false });
  assert.match((await pr.wait()).stdout, /^Published to GitHub: /m);
  // Rewritten on GitHub: rebased there onto main, without the commit galley pushed.
  const main = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const theirs = madeOnGithub(since, main);
  execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/rewritten', theirs]);
  writeFileSync(join(repo, 'rewritten.js'), 'export const more = 1;\n');
  git('commit', '-qam', 'More');
  let r = await pr.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Could not push [0-9a-f]{7} to GitHub: /m);
  assert.ok(r.stdout.includes(`\`git rebase --onto galley/feature/rewritten ${since.slice(0, 7)}\``), r.stdout);
  assert.equal(git('rev-parse', 'refs/remotes/galley/feature/rewritten'), theirs);

  // The rebase it says works here; it is a rewrite of what galley has, sent with a lease, and pushed on top of GitHub's.
  git('rebase', '-q', '--onto', 'galley/feature/rewritten', since);
  r = await pr.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Pushed [0-9a-f]{7} to GitHub: /m);
  assert.equal(revisions(pr.id).at(-1)!.forced, 1);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/rewritten^'], { encoding: 'utf8' }).trim(), theirs);
});

test('merged without commits only the checkout had: pr wait sends them first, and the checkout says whether the branch is gone', async () => {
  const { clone } = await widgets();
  // A branch the user pushes to a fork.
  git('config', 'branch.feature/late.pushRemote', 'fork');
  const pr = await stageWithCli('feature/late', 'late.js');
  await human('POST', `${pr.base}/publish`, { sign: false });
  assert.match((await pr.wait()).stdout, /^Published to GitHub: /m);
  writeFileSync(join(repo, 'late.js'), 'export const late = 1;\n');
  git('commit', '-qam', 'Too late');
  const late = git('rev-parse', 'HEAD');
  const merged = { state: 'MERGED', mergedAt: '2026-10-18T09:00:00Z', closedAt: '2026-10-18T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '2'.repeat(33) }, timelineItems: { nodes: [] } };
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
  await server.service.followGithub();
  assert.equal(setting('branch.feature/late.pushRemote'), 'galley');
  let r = await pr.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: /m);
  assert.ok(r.stdout.includes(`  ${late.slice(0, 7)} Too late\n`), r.stdout);
  assert.doesNotMatch(r.stdout, /is gone here/);
  // Merged, a plain git push of the branch goes where it went before it was staged.
  assert.equal(setting('branch.feature/late.pushRemote'), 'fork');
  assert.equal(setting('branch.feature/late.pushRemoteBeforeGalley'), null);
  // Deleted here: galley's clone still has it, but the checkout says it is gone.
  git('checkout', '-q', 'main');
  git('branch', '-qD', 'feature/late');
  r = await pr.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`The branch feature/late is gone here; bring it back with \`git branch feature/late ${late}\`.`), r.stdout);
  // The name used again, for new work: galley's branch of it, the merged pull request's, is nobody's, and is replaced.
  const next = await stageWithCli('feature/late', 'later.js');
  assert.equal(clone('rev-parse', 'refs/heads/feature/late'), git('rev-parse', 'HEAD'));
  assert.equal(setting('branch.feature/late.pushRemote'), 'galley');
  assert.notEqual(next.number, pr.number);
  // Commands on the merged one send nothing to the branch the new one has now.
  writeFileSync(join(repo, 'later.js'), 'export const later = 1;\n');
  git('commit', '-qam', 'More later');
  r = await cli(['pr', 'view', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Sent /);
  assert.notEqual(clone('rev-parse', 'refs/heads/feature/late'), git('rev-parse', 'HEAD'));
  // The merged one, checked out where it never was, comes from galley by its head's SHA, not by the branch it had.
  const fresh = join(dir, 'fresh');
  execFileSync('git', ['clone', '-q', remote, fresh]);
  execFileSync('git', ['-C', fresh, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git']);
  r = await cli(['pr', 'checkout', String(pr.number)], { cwd: fresh });
  assert.equal(r.code, 0, r.stderr);
  const { headRefOid } = (await asAgent('GET', `${API}/gh/pulls/${pr.number}?fields=headRefOid`)).json;
  assert.notEqual(clone('rev-parse', 'refs/heads/feature/late'), headRefOid);
  assert.equal(execFileSync('git', ['-C', fresh, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), headRefOid);
});

test('pr create replaces galley’s branch of a name used again only once no open pull request is stacked on it', async () => {
  const { clone } = await widgets();
  const lower = await stageWithCli('feature/stack-lower', 'stack-lower.js');
  const before = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature/stack-upper');
  writeFileSync(join(repo, 'stack-upper.js'), 'export {};\n');
  git('add', 'stack-upper.js');
  git('commit', '-qm', 'Add stack-upper.js');
  const upper = await cli(['pr', 'create', '--title', 'Add stack-upper.js', '--body', 'x', '--base', 'feature/stack-lower']);
  assert.equal(upper.code, 0, upper.stderr);
  await human('PATCH', lower.base, { state: 'closed' });
  // The lower one closed, its name is used again for other work, even with the branch's own history.
  git('checkout', '-q', 'feature/stack-lower');
  git('reset', '-q', '--hard', 'main');
  writeFileSync(join(repo, 'stack-again.js'), 'export {};\n');
  git('add', 'stack-again.js');
  git('commit', '-qm', 'Add stack-again.js');
  const create = () => cli(['pr', 'create', '--title', 'Add stack-again.js', '--body', 'x']);
  let r = await create();
  assert.equal(r.code, 1);
  const stacked = upper.stdout.trim();
  assert.equal(
    r.stderr.split('\n').at(-2),
    `galley has feature/stack-lower at ${before.slice(0, 7)}, and the open pull request ${stacked} is stacked on it: it is replaced only by a fast-forward. Nothing was sent. Stage this on a branch of another name.`,
  );
  assert.equal(clone('rev-parse', 'refs/heads/feature/stack-lower'), before);
  // Once the one stacked on it is closed too, the branch is nobody's.
  await human('PATCH', `${API}/pulls/${stacked.split('/').pop()}`, { state: 'closed' });
  r = await create();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(clone('rev-parse', 'refs/heads/feature/stack-lower'), git('rev-parse', 'HEAD'));
});

test('another checkout with a branch of the same name replaces galley’s only over commits its branch had, and nobody but the author sends', async () => {
  const { url, gitDir, clone } = await widgets();
  const pr = await stageWithCli('feature/shared', 'shared.js');
  const mine = git('rev-parse', 'HEAD');
  const tip = () => clone('rev-parse', 'refs/heads/feature/shared');

  // Another checkout, on another machine say, makes a branch of the same name from the same main.
  const other = join(dir, 'other');
  execFileSync('git', ['clone', '-q', remote, other]);
  const o = (...args: string[]) => execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
  o('remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
  o('checkout', '-qb', 'feature/shared', git('rev-parse', 'main'));
  writeFileSync(join(other, 'other.js'), 'export {};\n');
  o('add', 'other.js');
  o('commit', '-qm', 'Add other.js');
  // It has not seen what galley has: nothing is sent, and the wait ends saying what to do.
  let r = await cli(['pr', 'wait', '--timeout', '5s'], { cwd: other });
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    `galley has feature/shared at ${mine.slice(0, 7)}, which feature/shared here never had: another checkout sent it. Nothing was sent. Fetch it with \`git fetch ${url} feature/shared\`, rebase onto FETCH_HEAD, and run this again.\n`,
  );
  assert.equal(tip(), mine);
  // pr checkout fetches galley's, and says the branch here differs from it. Fetched is not had:
  // the next command sends nothing still.
  r = await cli(['pr', 'checkout', `s${pr.number}`], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^galley has it at ${mine.slice(0, 7)}, which your feature/shared does not have\\.$`, 'm'));
  r = await cli(['pr', 'view', '--json', 'number'], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^galley has feature/shared at ${mine.slice(0, 7)}, which feature/shared here never had`));
  assert.equal(tip(), mine);

  // Rebased onto it, its commit goes on top: a fast-forward. Signed, as the user's may be: git log
  // would show its signature (log.showSignature here) where the branch's reflog is read.
  o('-c', 'commit.gpgsign=true', 'rebase', '-q', mine);
  assert.match(o('cat-file', 'commit', 'HEAD'), /^gpgsig /m);
  const onTop = o('rev-parse', 'HEAD');
  r = await cli(['pr', 'wait', '--timeout', '20s'], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^Sent feature/shared at ${onTop.slice(0, 7)} to galley\\.$`, 'm'));
  assert.equal(tip(), onTop);
  // Rewritten here, it replaces what galley has, which this checkout has, with a lease on it.
  o('commit', '-q', '--amend', '-m', 'Add other.js, reworded');
  const reworded = o('rev-parse', 'HEAD');
  r = await cli(['pr', 'wait', '--timeout', '20s'], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(tip(), reworded);
  assert.deepEqual(revisions(pr.id).map((x) => [x.head_sha, x.forced]), [[mine, 0], [onTop, 0], [reworded, 1]]);

  // pr checkout fast-forwards a branch behind galley's, and makes one where there is none.
  o('reset', '-q', '--hard', mine);
  r = await cli(['pr', 'checkout', `s${pr.number}`], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^Fast-forwarded it to galley's ${reworded.slice(0, 7)}\\.$`, 'm'));
  assert.equal(o('rev-parse', 'HEAD'), reworded);
  o('checkout', '-q', '--detach');
  o('branch', '-qD', 'feature/shared');
  r = await cli(['pr', 'checkout', `s${pr.number}`], { cwd: other });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(o('symbolic-ref', '--short', 'HEAD'), 'feature/shared');
  assert.equal(o('rev-parse', 'HEAD'), reworded);

  // The first checkout, which has not seen that, rewrites its own commit: nothing is sent. Nor once
  // it fetched galley's without building on it, or with its branch behind galley's: a command that
  // sends on its way does not wind galley's back.
  git('commit', '-q', '--amend', '-m', 'Add shared.js, reworded');
  r = await pr.wait();
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^galley has feature/shared at ${reworded.slice(0, 7)}, which feature/shared here never had`));
  assert.equal(tip(), reworded);
  assert.equal((await gitToGalley(['fetch', '-q', url, 'feature/shared'])).code, 0);
  for (const at of ['HEAD', mine]) {
    git('reset', '-q', '--hard', at);
    r = await cli(['pr', 'comment', String(pr.number), '-b', 'Looking.']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`^galley has feature/shared at ${reworded.slice(0, 7)}, which feature/shared here never had`));
    assert.equal(tip(), reworded);
  }

  // A person at a terminal, no agent, sends nothing, even from the checkout galley's head came from.
  writeFileSync(join(other, 'other.js'), 'export const byHand = 1;\n');
  o('commit', '-qam', 'By hand');
  const client = new Client(server.url);
  const checkout = await client.repoFor(other);
  await atTerminal(() => sendPull(client, other, checkout, pr.number, { strict: true }));
  assert.equal(tip(), reworded);
  const byHand = o('rev-parse', 'HEAD');
  process.env.GALLEY_ACTOR = 'agent';
  try {
    await sendPull(client, other, checkout, pr.number, { strict: true });
  } finally {
    delete process.env.GALLEY_ACTOR;
  }
  assert.equal(tip(), byHand);

  // Rebased onto galley's, the first checkout's branch had galley's head, and may replace it with a
  // lease on it; but galley's branch moves while it sends (the other checkout again), and the
  // lease is stale.
  assert.equal((await gitToGalley(['fetch', '-q', url, 'feature/shared'])).code, 0);
  git('reset', '-q', '--hard', 'FETCH_HEAD');
  git('commit', '-q', '--amend', '-m', 'By hand, reworded');
  const stale = git('rev-parse', 'HEAD');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const race = join(dir, 'race-bin');
  mkdirSync(race, { recursive: true });
  writeFileSync(join(race, 'git'), `#!/bin/sh\ncase " $* " in *" push "*) "${realGit}" --git-dir "${gitDir}" update-ref refs/heads/feature/shared ${onTop} ;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(race, 'git'), 0o755);
  r = await pr.wait({ env: { PATH: `${race}:${process.env.PATH}` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`^galley did not take feature/shared at ${stale.slice(0, 7)} \\(.+\\): its feature/shared moved while this was sent\\. Nothing was sent\\. Run this again\\.$`, 'm'));
  assert.equal(tip(), onTop);
});

test('the CLI keeps a remote called galley at galley’s URL, which a staged branch’s plain git push goes to, and which fetches what galley fetched from GitHub', async () => {
  const { clone } = await widgets();
  const url = `${server.url}/git/acme/widgets.git`;
  // As in a checkout the CLI never ran in.
  if (setting('remote.galley.url')) git('config', '--remove-section', 'remote.galley');
  const pr = await stageWithCli('feature/remote', 'remote.js');
  assert.equal(setting('remote.galley.url'), url);
  assert.equal(setting('remote.galley.fetch'), '+refs/remotes/origin/*:refs/remotes/galley/*\n^refs/remotes/origin/HEAD');
  assert.equal(setting('branch.feature/remote.pushRemote'), 'galley');
  assert.equal(git('remote', 'get-url', 'origin'), 'https://github.com/acme/widgets.git');

  // A plain git push from the branch goes to galley, not GitHub: a fast-forward is taken, and
  // staged. With push.autoSetupRemote, it makes galley the branch's upstream too.
  writeFileSync(join(repo, 'remote.js'), 'export const pushed = 1;\n');
  git('commit', '-qam', 'Push by hand');
  const byHand = git('rev-parse', 'HEAD');
  const pushed = await gitToGalley(['-c', 'push.autoSetupRemote=true', 'push']);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(setting('branch.feature/remote.remote'), 'galley');
  assert.equal(clone('rev-parse', 'refs/heads/feature/remote'), byHand);
  assert.equal(revisions(pr.id).at(-1)!.head_sha, byHand);
  assert.equal(execFileSync('git', ['--git-dir', remote, 'for-each-ref', 'refs/heads/feature/remote'], { encoding: 'utf8' }), '');
  // A rewrite needs the lease the CLI sends.
  git('commit', '-q', '--amend', '-m', 'Push by hand, reworded');
  const forced = await gitToGalley(['push', '--force']);
  assert.notEqual(forced.code, 0);
  assert.match(forced.stderr, /^remote: galley: feature\/remote: /m);
  assert.equal(clone('rev-parse', 'refs/heads/feature/remote'), byHand);

  // git fetch galley fetches what galley fetched from GitHub, not the branches sent to it.
  const fetched = await gitToGalley(['fetch', '-q', 'galley']);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(git('rev-parse', 'refs/remotes/galley/main'), clone('rev-parse', 'refs/remotes/origin/main'));
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/remotes/galley/HEAD', 'refs/remotes/galley/feature/remote'), '');

  // The server moved: the next command points the remote at it, and its push URL should it have
  // one, unless the checkout's git config can not be written (a sandbox), which it says, and goes on by URL.
  git('config', 'remote.galley.url', 'http://127.0.0.1:1/git/acme/widgets.git');
  git('config', 'remote.galley.pushurl', 'http://127.0.0.1:1/git/acme/widgets.git');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const sandbox = join(dir, 'config-refused-bin');
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, 'git'), `#!/bin/sh\ncase " $* " in *" config --get"*) ;; *" config "*) echo "error: could not lock config file .git/config: Operation not permitted" >&2; exit 255 ;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(sandbox, 'git'), 0o755);
  let r = await cli(['pr', 'view', String(pr.number)], { env: { PATH: `${sandbox}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stderr.includes(`Could not set the remote galley at ${url} in this checkout: error: could not lock config file .git/config: Operation not permitted. The CLI sends and fetches by that URL all the same, but a plain \`git push\` here does not go to galley.\n`), r.stderr);
  assert.equal(setting('remote.galley.url'), 'http://127.0.0.1:1/git/acme/widgets.git');
  r = await cli(['pr', 'view', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(setting('remote.galley.url'), url);
  assert.equal(setting('remote.galley.pushurl'), url);
  git('config', '--unset', 'remote.galley.pushurl');

  // A checkout whose remote on GitHub is not origin is still registered by it, not by the galley remote the CLI added.
  const upstream = join(dir, 'upstream');
  execFileSync('git', ['clone', '-q', '-o', 'upstream', remote, upstream]);
  execFileSync('git', ['-C', upstream, 'remote', 'set-url', 'upstream', 'https://github.com/acme/widgets.git']);
  for (let i = 0; i < 2; i++) {
    r = await cli(['pr', 'view', String(pr.number), '--json', 'number'], { cwd: upstream });
    assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(setting('remote.galley.url', upstream), url);

  // Closed, a plain git push of the branch goes where it went before it was staged, and galley is
  // no longer its upstream.
  await human('PATCH', pr.base, { state: 'closed' });
  r = await pr.wait();
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /without publishing it/);
  assert.deepEqual(['pushRemote', 'remote', 'merge', 'pushRemoteBeforeGalley', 'remoteBeforeGalley'].map((key) => setting(`branch.feature/remote.${key}`)), [null, null, null, null, null]);
  // Reopened, to galley again; closed with pr close, no more.
  r = await cli(['pr', 'reopen', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(setting('branch.feature/remote.pushRemote'), 'galley');
  r = await cli(['pr', 'close', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(setting('branch.feature/remote.pushRemote'), null);
  // An author's command on an open one staged before the CLI kept the remote points it at galley.
  const older = await stageWithCli('feature/older', 'older.js');
  git('config', '--unset', 'branch.feature/older.pushRemote');
  r = await cli(['pr', 'view', String(older.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(setting('branch.feature/older.pushRemote'), 'galley');
});

test('what a staged branch pushed to before comes back when its pull request is done with, unless the user changed it since', async () => {
  await widgets();
  const branch = (key: string) => setting(`branch.feature/fork.${key}`);
  // A branch the user pushes to a fork, with no upstream: its remote has no merge.
  git('config', 'branch.feature/fork.pushRemote', 'fork');
  git('config', 'branch.feature/fork.remote', 'fork');
  const pr = await stageWithCli('feature/fork', 'fork.js');
  assert.equal(branch('pushRemote'), 'galley');
  // A plain git push with push.autoSetupRemote makes galley its upstream, over that remote.
  const pushed = await gitToGalley(['-c', 'push.autoSetupRemote=true', 'push']);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.deepEqual([branch('remote'), branch('merge')], ['galley', 'refs/heads/feature/fork']);
  let r = await cli(['pr', 'close', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(['pushRemote', 'remote', 'merge', 'pushRemoteBeforeGalley', 'remoteBeforeGalley'].map(branch), ['fork', 'fork', null, null, null]);
  // Reopened, to galley again. Closed, two cleanups at once put it back, as `pr wait` hearing of the
  // close while `pr close` closes it: one finds it at galley, and asks galley whether an open pull
  // request has the branch only once the other put it back.
  r = await cli(['pr', 'reopen', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(branch('pushRemote'), 'galley');
  await human('PATCH', pr.base, { state: 'closed' });
  const [first, second] = [new Client(server.url), new Client(server.url)];
  let asked!: () => void, answer!: () => void;
  const asking = new Promise<void>((resolve) => (asked = resolve));
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const get = second.get.bind(second);
  second.get = async (path: string, signal?: AbortSignal) => {
    if (path.includes('state=open')) {
      asked();
      await answered;
    }
    return get(path, signal);
  };
  const late = clearPushRemote(second, repo, await second.repoFor(repo), 'feature/fork');
  await asking;
  await clearPushRemote(first, repo, await first.repoFor(repo), 'feature/fork');
  answer();
  await late;
  assert.deepEqual(['pushRemote', 'pushRemoteBeforeGalley'].map(branch), ['fork', null]);
  // A pushRemote the user sets while it is staged stays when it is closed.
  r = await cli(['pr', 'reopen', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(branch('pushRemote'), 'galley');
  git('config', 'branch.feature/fork.pushRemote', 'mine');
  r = await cli(['pr', 'close', String(pr.number)]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([branch('pushRemote'), branch('remote')], ['mine', 'fork']);
});

test('a remote called galley the user has at another URL is left alone: the CLI goes to galley by its URL, and fetches into origin', async () => {
  const { row } = await widgets();
  const theirs = join(dir, 'theirs');
  execFileSync('git', ['clone', '-q', remote, theirs]);
  const t = (...args: string[]) => execFileSync('git', ['-C', theirs, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
  t('remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
  t('remote', 'add', 'galley', 'https://github.com/someone/galley.git');
  const before = setting('remote.galley.fetch', theirs);
  t('checkout', '-qb', 'feature/theirs');
  writeFileSync(join(theirs, 'theirs.js'), 'export const theirs = 1;\n');
  t('add', 'theirs.js');
  t('commit', '-qm', 'Add theirs.js');
  const created = await cli(['pr', 'create', '--title', 'Add theirs.js', '--body', 'x'], { cwd: theirs });
  assert.equal(created.code, 0, created.stderr);
  const said = `This checkout has a remote called galley at https://github.com/someone/galley.git, which is not galley's. The CLI leaves it alone, and goes to galley by its URL, ${server.url}/git/acme/widgets.git.`;
  assert.equal(created.stderr.split('\n').filter((l) => l === said).length, 1, created.stderr);
  assert.match(created.stderr, new RegExp(`^Sent feature/theirs at ${t('rev-parse', '--short=7', 'HEAD')} to galley\\.$`, 'm'));
  assert.equal(setting('remote.galley.url', theirs), 'https://github.com/someone/galley.git');
  assert.equal(setting('remote.galley.fetch', theirs), before);
  assert.equal(setting('branch.feature/theirs.pushRemote', theirs), null);
  const number = Number(created.stdout.trim().split('/').pop());
  // Nor one that has galley's URL too, which git would push to with the other, or that pushes to GitHub.
  let r = { code: 0, stdout: '', stderr: '' };
  t('config', '--add', 'remote.galley.url', `${server.url}/git/acme/widgets.git`);
  for (const pushTo of [null, 'https://github.com/acme/widgets.git']) {
    if (pushTo) {
      t('remote', 'remove', 'galley');
      t('remote', 'add', 'galley', `${server.url}/git/acme/widgets.git`);
      t('remote', 'set-url', '--push', 'galley', pushTo);
    }
    r = await cli(['pr', 'view', String(number)], { cwd: theirs });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes(`This checkout has a remote called galley at ${pushTo ?? 'https://github.com/someone/galley.git'}, which is not galley's.`), r.stderr);
    assert.equal(setting('branch.feature/theirs.pushRemote', theirs), null);
  }
  assert.equal(setting('remote.galley.url', theirs), `${server.url}/git/acme/widgets.git`);
  assert.equal(setting('remote.galley.pushurl', theirs), 'https://github.com/acme/widgets.git');
  t('remote', 'remove', 'galley');
  t('remote', 'add', 'galley', 'https://github.com/someone/galley.git');
  // A pushRemote the user set on it stays when the pull request is done with.
  t('config', 'branch.feature/theirs.pushRemote', 'galley');

  // The base moves on GitHub, in the same file: the wait fetches it into origin/main, as the remote galley is not galley's.
  t('checkout', '-q', '--detach', 'feature/theirs~1');
  writeFileSync(join(theirs, 'theirs.js'), 'export const theirs = 2;\n');
  t('add', 'theirs.js');
  t('commit', '-qm', 'Add theirs.js on GitHub');
  const moved = t('rev-parse', 'HEAD');
  t('push', '-q', remote, 'HEAD:refs/heads/main');
  t('checkout', '-q', 'feature/theirs');
  await server.service.fetchBases(row, { base: 'main' });
  await until(async () => (await asAgent('GET', `${API}/gh/pulls/${number}?fields=baseConflicts`)).json.baseConflicts?.oid === moved, 'galley finds the conflict');
  r = await cli(['pr', 'wait', String(number), '--timeout', '20s'], { cwd: theirs });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^This branch conflicts with origin\/main in theirs\.js; rebase onto origin\/main\./m);
  assert.equal(t('rev-parse', 'refs/remotes/origin/main'), moved);
  assert.equal(t('for-each-ref', 'refs/remotes/galley'), '');
  r = await cli(['pr', 'close', String(number)], { cwd: theirs });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(setting('branch.feature/theirs.pushRemote', theirs), 'galley');
});

/** Runs `fn` as the CLI does for a person at a terminal: no agent's name, and stdin a terminal. */
async function atTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const env = { ...process.env };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  for (const name of ['GALLEY_ACTOR', 'CLAUDECODE', 'AI_AGENT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_MANAGED_BY_NPM', 'OPENCODE']) delete process.env[name];
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    process.env = env;
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}
