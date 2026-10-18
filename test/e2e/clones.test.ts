// galley's own clones of GitHub repositories (GALLEY_CLONES): staged from branches pushed to its
// git endpoint, reviewed, published, and fetched from GitHub, all in the clone, with nothing
// written to the agent's repository. The bare repositories beside it stand in for GitHub.
import '../helpers/env.ts';
import { dir, git, gitToGalley, human, remote, repo, reviewCheckouts, scratchRepo, server, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PullRow, RepoRow } from '../../src/server/db.ts';

startHarness({ clones: true });

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
    assert.deepEqual(reviewCheckouts(), []);
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

test('a GitHub repository registered twice at once is cloned once; one registered by path stays so', async () => {
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

  // Registered by path, as the CLI does while it sends no branches, it stays so when registered by name.
  const { fullName, g } = await scratchRepo('by-path');
  const byPath = await human('GET', `/api/repos/${fullName}`);
  const byName = await human('POST', '/api/repos', { github: 'acme/by-path' });
  assert.equal(byName.id, byPath.id);
  assert.equal(byName.git_url, undefined);
  assert.equal(byName.work_dir, realpathSync(join(dir, 'by-path')));
  // Renamed on GitHub, it is the one registered by its former name too, in any case.
  g('remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git');
  await server.service.followRemotes();
  assert.equal((await human('GET', '/api/repos/acme/renamed')).id, byPath.id);
  assert.equal((await human('POST', '/api/repos', { github: 'Acme/By-Path' })).id, byPath.id);
});
