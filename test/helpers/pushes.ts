// What the tests of pushes after publishing share: a branch staged and published, its tip on
// GitHub (the bare repository), and changes made there.
import { cli, git, human, remote, repo, server } from './harness.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The branch's tip on GitHub (the bare remote): its commit, whether it is signed, and its parent. */
const tip = (branch: string) => {
  const sha = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' });
  return { sha, signed: /^gpgsig /m.test(commit), parent: commit.match(/^parent ([0-9a-f]+)$/m)?.[1] ?? null };
};
/** Stage a branch with one commit as the agent, publish it as the reviewer, and let the agent hear of the publish. */
export const published = async (branch: string, opts: { sign?: boolean } = {}) => {
  const file = `${branch.split('/').pop()}.js`;
  git('checkout', '-q', 'main');
  git('checkout', '-qb', branch);
  writeFileSync(join(repo, file), 'export {};\n');
  git('add', file);
  git('commit', '-qm', `Add ${file}`);
  const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const n = created.stdout.trim().split('/').pop()!;
  const base = `/api/repos/acme/widgets/pulls/${n}`;
  const { id } = await human('POST', `${base}/publish`, { sign: opts.sign ?? false });
  assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
  return {
    n,
    id,
    base,
    /** A new commit, as the agent; its short SHA. */
    commit: (text: string) => {
      writeFileSync(join(repo, file), text);
      git('commit', '-qam', `Change ${file}`);
      return git('rev-parse', '--short=7', 'HEAD');
    },
    wait: (timeout = '20s') => cli(['pr', 'wait', n, '--timeout', timeout]),
    tip: () => tip(branch),
    pushes: async (): Promise<any[]> => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).filter((e: any) => e.event === 'github_push'),
    page: async () => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(),
  };
};

/** A commit with `at`'s tree on top of `parent` on GitHub, made there (a suggestion committed, a rebase); its SHA. */
export const madeOnGithub = (at: string, parent: string, message: string) => {
  const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${at}^{tree}`], { encoding: 'utf8' }).trim();
  return execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', parent, '-m', message], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' },
  }).trim();
};
