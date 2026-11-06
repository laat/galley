// What the tests of pushes after publishing share: a branch staged and published, its tip on
// GitHub (the bare repository), and changes made there.
import { cli, git, human, remote, repo, server } from './harness.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
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
    /** `pr wait` as the agent; aborting `signal` ends it. */
    wait: (timeout = '20s', signal?: AbortSignal) => cli(['pr', 'wait', n, '--timeout', timeout], { signal }),
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

/**
 * Make GitHub (the bare remote) fail to take pushes to `branch` on its side, as GitHub does now and
 * then: "remote: fatal error in commit_refs", and "[remote rejected] <branch> (failure)". Done by a
 * proc-receive hook, the one hook that gives the reason a ref was rejected. Gives what puts it back.
 */
export const failPushes = (branch: string) => {
  const hook = join(remote, 'hooks', 'proc-receive');
  const script = join(remote, 'hooks', 'proc-receive.mjs');
  // Its protocol is pkt-lines: the version, then the commands, each list ended by a flush-pkt (0000).
  writeFileSync(
    script,
    `import { readSync, writeSync } from 'node:fs';
const read = (n) => { const b = Buffer.alloc(n); for (let o = 0; o < n; ) { const k = readSync(0, b, o, n - o); if (!k) process.exit(1); o += k; } return b.toString(); };
const packets = () => { const out = []; for (let len; (len = parseInt(read(4), 16)); ) out.push(read(len - 4).replace(/\\n$/, '')); return out; };
const pkt = (s) => (s.length + 5).toString(16).padStart(4, '0') + s + '\\n';
packets();
writeSync(1, pkt('version=1') + '0000');
const refs = packets().map((c) => c.split(' ')[2]);
process.stderr.write('fatal error in commit_refs\\n');
writeSync(1, refs.map((r) => pkt('ng ' + r + ' failure')).join('') + '0000');
`,
  );
  writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
  chmodSync(hook, 0o755);
  execFileSync('git', ['--git-dir', remote, 'config', 'receive.procReceiveRefs', `refs/heads/${branch}`]);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    execFileSync('git', ['--git-dir', remote, 'config', '--unset-all', 'receive.procReceiveRefs']);
    rmSync(hook, { force: true });
    rmSync(script, { force: true });
  };
};
