// Failures of gh and git in the background, where nobody waits for an answer: each is logged once,
// and what failed is tried again.
import { assertLeftAsFound, fakes, withFakes } from './helpers/fakes.ts';
import { after, afterEach, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, type PullRow } from '../src/server/db.ts';
import { Repo } from '../src/server/git.ts';
import { Service } from '../src/server/service.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

let dir: string;
let repo: string;
let gh: string;
/** The FAKE_* variables every test starts with. */
let startingFakes: Record<string, string>;
/** The services the test staged on. */
let services: Service[] = [];

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A server's service on a database of its own, with a pull request staged from feature/mul. */
async function staged(): Promise<{ s: Service; pull: PullRow }> {
  const db = new Db(join(mkdtempSync(join(dir, 'data-')), 'galley.db'));
  const s = new Service({ db, baseUrl: 'http://localhost:0', ghBin: gh, viewerLogin: 'reviewer' });
  services.push(s);
  const pull = await s.createPull(await s.registerRepo(repo), { title: 'Add mul', head: 'feature/mul', base: 'main' }, db.actor('agent', 'Bot'));
  return { s, pull };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'galley-failures-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  git('checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  git('commit', '-qam', 'Add mul');
  // A gh that fails each call, answering FAKE_GH_ANSWER (GitHub's JSON) and FAKE_GH_STDERR, where
  // <id> is a request ID of the call's own, as GitHub gives one to quote.
  gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst id = (s) => s?.replaceAll('<id>', 'C0DE:ABCD:' + process.pid);\nif (process.env.FAKE_GH_ANSWER) console.log(id(process.env.FAKE_GH_ANSWER));\nconsole.error(id(process.env.FAKE_GH_STDERR));\nprocess.exit(1);\n`,
  );
  chmodSync(gh, 0o755);
  startingFakes = fakes();
});

afterEach(() => {
  assertLeftAsFound(services, startingFakes);
  services = [];
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("a failure of GitHub's GraphQL API is logged once per repository, whatever request ID GitHub gives it", async () => {
  const { s, pull } = await staged();
  s.db.update('pulls', pull.id, { state: 'published', published_url: 'https://github.com/acme/widgets/pull/7' });
  const logged = mock.method(console, 'error', () => {});
  try {
    // GitHub answers with an error: what merging allows, issue titles and following each ask, twice.
    const error = 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `<id>` when reporting this issue.';
    await withFakes({ FAKE_GH_ANSWER: JSON.stringify({ data: null, errors: [{ message: error }] }), FAKE_GH_STDERR: `gh: ${error}` }, async () => {
      for (let i = 0; i < 2; i++) {
        await s.refreshGithubRepo('acme/widgets');
        await s.refreshGithubIssues('acme/widgets', [12]);
        await s.followGithub();
      }
      // The same about another repository.
      await s.refreshGithubRepo('acme/gadgets');
    });
    // A token GitHub no longer takes: its REST error, without GraphQL's errors.
    await withFakes({ FAKE_GH_ANSWER: JSON.stringify({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql', status: '401' }), FAKE_GH_STDERR: 'gh: Bad credentials (HTTP 401)' }, async () => {
      await s.refreshGithubRepo('acme/widgets');
      await s.followGithub();
    });
    // Not logged in: gh says so on stderr alone.
    await withFakes({ FAKE_GH_ANSWER: undefined, FAKE_GH_STDERR: 'To get started with GitHub CLI, please run:  gh auth login' }, async () => {
      await s.refreshGithubRepo('acme/widgets');
      await s.followGithub();
    });
    assert.deepEqual(
      logged.mock.calls.map((c) => c.arguments.join(' ').replace(/C0DE:ABCD:\d+/, '<id>')),
      [
        `asking GitHub about acme/widgets failed: ${error}`,
        `asking GitHub about acme/gadgets failed: ${error}`,
        'asking GitHub about acme/widgets failed: gh: Bad credentials (HTTP 401)',
        'asking GitHub about acme/widgets failed: To get started with GitHub CLI, please run:  gh auth login',
      ],
    );
  } finally {
    logged.mock.restore();
  }
});

test('a sync the poll could not do is tried again at the next poll, and its failure logged once', async () => {
  const { s, pull } = await staged();
  // The agent rewrites its commit; git fails the poll's first two syncs, each time naming where the branch was.
  git('commit', '-q', '--amend', '-m', 'Add mul, reworded');
  const head = git('rev-parse', 'HEAD');
  const sync = s.sync.bind(s);
  const failures = [`is at ${head} but expected ${pull.head_sha}`, `is at ${pull.head_sha} but expected ${head}`];
  const syncs = mock.method(s, 'sync', (p: PullRow) => (failures.length ? Promise.reject(new Error(`fatal: cannot lock ref 'refs/heads/feature/mul': ${failures.shift()}`)) : sync(p)));
  const logged = mock.method(console, 'error', () => {});
  try {
    for (let i = 0; i < 4; i++) await s.pollAll();
  } finally {
    logged.mock.restore();
  }
  // Tried at each poll until it worked, and not again while the branches stay where they are.
  assert.equal(syncs.mock.callCount(), 3);
  assert.equal(s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pull.id)!.head_sha, head);
  const lines = logged.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.startsWith('could not sync'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], new RegExp(`^could not sync feature/mul \\(s#1\\) in \\S+: fatal: cannot lock ref 'refs/heads/feature/mul': is at ${head} but expected ${pull.head_sha}$`));
});

test("a base branch galley could not fetch is logged once while it fails the same way, whatever git's timings, and again when it fails another way", async (t) => {
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  try {
    const { s, pull } = await staged();
    const repoRow = s.repoById(pull.repo_id);
    const unreachable = (ms: number) => `fatal: unable to access 'https://github.com/acme/widgets.git/': Failed to connect to 127.0.0.1 port 1 after ${ms} ms: Couldn't connect to server`;
    const refused = (status: number) => `fatal: unable to access 'https://github.com/acme/widgets.git/': The requested URL returned error: ${status}`;
    const answers = [unreachable(0), unreachable(1), refused(403), refused(403), refused(404), null, unreachable(2)];
    t.mock.method(Repo.prototype, 'fetchBranch', async () => answers.shift() ?? null);
    const logged = t.mock.method(console, 'error', () => {});
    const shown: (string | null)[] = [];
    while (answers.length) {
      await s.fetchBases(repoRow, { base: 'main' });
      shown.push(s.fetchError(repoRow, 'main'));
    }
    // The page keeps the first message while it fails the same way.
    assert.deepEqual(shown, [unreachable(0), unreachable(0), refused(403), refused(403), refused(404), null, unreachable(2)]);
    assert.deepEqual(
      logged.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.startsWith('could not fetch')).map((l) => l.replace(/ into \S+:/, ' into <repo>:')),
      [unreachable(0), refused(403), refused(404), unreachable(2)].map((e) => `could not fetch origin/main into <repo>: ${e}`),
    );
  } finally {
    git('remote', 'remove', 'origin');
  }
});
