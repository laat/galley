import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksSummary, earlierThreads, githubAsks, githubBusy, githubWaits, prependThreads, readGithub, type GithubPull } from '../src/server/github-follow.ts';

const run = (name: string, status: string, conclusion: string | null = null, job = name.length) => ({
  __typename: 'CheckRun' as const,
  databaseId: job,
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${job}`,
  checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
});
const pull = (more: Partial<GithubPull> = {}, checks: object[] = []): GithubPull => ({
  state: 'OPEN',
  headRefOid: 'aaa',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks as any } }, checkSuites: { nodes: [] } } }] },
  ...more,
});
const thread = (id: string, resolved = false) => ({
  id,
  isResolved: resolved,
  isOutdated: false,
  path: 'a.js',
  line: 1,
  originalLine: 1,
  startLine: null,
  diffSide: 'RIGHT' as const,
  comments: { nodes: [{ databaseId: id.length, author: { login: 'octocat' }, body: `about ${id}`, createdAt: 't', url: `https://github.com/acme/widgets/pull/7#discussion_r${id}`, diffHunk: '@@' }] },
});

test('readGithub sorts checks, keeps running Actions runs, and sees a pending Copilot review', () => {
  const status = readGithub(
    pull({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    run('build', 'COMPLETED', 'SUCCESS'),
                    run('test', 'COMPLETED', 'FAILURE'),
                    run('e2e', 'IN_PROGRESS'),
                    run('docs', 'COMPLETED', 'SKIPPED'),
                    { __typename: 'StatusContext', context: 'deploy', state: 'ERROR', targetUrl: null },
                  ],
                },
              },
              // A suite of an app that never posts stays queued without a run: it is not waited for.
              checkSuites: { nodes: [{ status: 'QUEUED', workflowRun: null }, { status: 'IN_PROGRESS', workflowRun: { databaseId: 9, url: 'u', workflow: { name: 'Copilot' } } }, { status: 'COMPLETED', workflowRun: { databaseId: 8, url: 'u', workflow: null } }] },
            },
          },
        ],
      },
      timelineItems: { nodes: [{ __typename: 'PullRequestReview', author: { login: 'copilot-pull-request-reviewer' } }, { __typename: 'ReviewRequestedEvent', requestedReviewer: { login: 'copilot-pull-request-reviewer' } }] },
      reviewThreads: { nodes: [thread('T1', true), thread('T2')] },
    }),
    null,
    'now',
  );
  assert.deepEqual(
    status.checks.map((c) => [c.name, c.result]),
    [['build', 'passed'], ['test', 'failed'], ['e2e', 'pending'], ['docs', 'skipped'], ['deploy', 'failed']],
  );
  assert.deepEqual(status.runs, [{ id: 9, name: 'Copilot', url: 'u' }]);
  assert.equal(status.copilotPending, true);
  assert.deepEqual(status.threads.map((t) => t.id), ['T2']);
  assert.equal(githubBusy(status), true);
  assert.equal(githubBusy(readGithub(pull({}, [run('build', 'COMPLETED', 'SUCCESS')]), null, 'now')), false);
  assert.equal(githubBusy(readGithub(pull({ mergeable: 'UNKNOWN' }), null, 'now')), true, 'GitHub is still working out mergeability');
  assert.equal(githubBusy(null), true, 'never asked yet');
});

test('a check shows as GitHub has it now: a job run again and failed again is failed, passed again is passed', () => {
  const failed = readGithub(pull({}, [run('test', 'COMPLETED', 'FAILURE', 11)]), null, 'now');
  assert.deepEqual(readGithub(pull({}, [run('test', 'COMPLETED', 'FAILURE', 12)]), failed, 'now').checks.map((c) => [c.result, c.job]), [['failed', 12]]);
  assert.deepEqual(readGithub(pull({}, [run('test', 'COMPLETED', 'SUCCESS', 13)]), failed, 'now').checks.map((c) => [c.result, c.job]), [['passed', 13]]);
});

test('a conflict stays known while GitHub works mergeability out again', () => {
  const conflicting = readGithub(pull({ mergeable: 'CONFLICTING' }), null, 'now');
  assert.equal(readGithub(pull({ mergeable: 'UNKNOWN' }), conflicting, 'now').conflicting, true);
  assert.equal(readGithub(pull({ mergeable: 'MERGEABLE' }), conflicting, 'now').conflicting, false);
});

test('githubAsks: what on GitHub is for the reviewer', () => {
  assert.deepEqual(githubAsks(null, 'main'), []);
  assert.deepEqual(githubAsks(readGithub(pull({}, [run('build', 'COMPLETED', 'SUCCESS'), run('e2e', 'IN_PROGRESS')]), null, 'now'), 'main'), [], 'running and passing checks are nobody\'s to act on');
  const status = readGithub(pull({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', reviewThreads: { nodes: [thread('T1'), thread('T2')] } }, [run('test', 'COMPLETED', 'FAILURE')]), null, 'now');
  assert.deepEqual(githubAsks(status, 'main'), ['1 check failed on GitHub', 'changes requested on GitHub', '2 unresolved threads on GitHub', 'conflicts with main on GitHub']);
});

test('githubAsks: GitHub would merge it now, and auto-merge is off', () => {
  assert.deepEqual(githubAsks(readGithub(pull({ autoMergeRequest: null }), null, 'now'), 'main'), ['ready to merge on GitHub']);
  assert.deepEqual(githubAsks(readGithub(pull({ autoMergeRequest: null, mergeStateStatus: 'HAS_HOOKS' }), null, 'now'), 'main'), ['ready to merge on GitHub'], 'pre-receive hooks run on the merge');
  assert.deepEqual(githubAsks(readGithub(pull({ autoMergeRequest: { enabledAt: 't' } }), null, 'now'), 'main'), [], 'GitHub merges it by itself');
  assert.deepEqual(githubAsks(readGithub(pull({ autoMergeRequest: null, mergeStateStatus: 'BLOCKED' }), null, 'now'), 'main'), []);
  const { autoMerge, ...before } = readGithub(pull({ autoMergeRequest: null }), null, 'now');
  assert.deepEqual(githubAsks(before, 'main'), [], 'a status stored before galley asked about auto-merge');
});

test('githubAsks: of a commit a push replaces, the checks and the merge ask nothing', () => {
  const status = readGithub(pull({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', reviewThreads: { nodes: [thread('T1')] } }, [run('test', 'COMPLETED', 'FAILURE')]), null, 'now');
  assert.deepEqual(githubAsks(status, 'main', true), ['changes requested on GitHub', '1 unresolved thread on GitHub', 'conflicts with main on GitHub']);
  assert.deepEqual(githubAsks(readGithub(pull({ autoMergeRequest: null }), null, 'now'), 'main', true), []);
});

test('githubWaits: a required review, from those asked for one', () => {
  const requests = (...who: object[]) => ({ totalCount: who.length + 2, nodes: who.map((requestedReviewer) => ({ requestedReviewer })) });
  const blocked = (more: Partial<GithubPull>) => readGithub(pull({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', ...more }), null, 'now');
  // A team as org/team; past the first page, and reviewers it does not read (an enterprise team), counted.
  assert.deepEqual(githubWaits(blocked({ reviewRequests: requests({ login: 'eskilgh' }, { combinedSlug: 'acme/platform' }, {}) })), ['waiting for review from eskilgh, acme/platform and 3 more']);
  assert.deepEqual(githubWaits(blocked({ reviewRequests: { totalCount: 0, nodes: [] } })), ['waiting for a required review']);
  assert.deepEqual(githubWaits(readGithub(pull({ reviewDecision: 'APPROVED', reviewRequests: requests({ login: 'eskilgh' }) }), null, 'now')), []);
  assert.deepEqual(githubWaits(null), []);
});

test('threads on earlier pages are read too, all of them', () => {
  const node = pull({ reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'c1' }, nodes: [thread('T3')] } });
  assert.equal(earlierThreads(node), 'c1');
  prependThreads(node, { pageInfo: { hasPreviousPage: false, startCursor: 'c0' }, nodes: [thread('T1'), thread('T2', true)] });
  assert.equal(earlierThreads(node), null);
  assert.deepEqual(readGithub(node, null, 'now').threads.map((t) => t.id), ['T1', 'T3']);
});

test('threads on pages that could not be read stay as last seen', () => {
  const all = readGithub(pull({ reviewThreads: { nodes: [thread('T1'), thread('T3')] } }), null, 'now');
  // T1 was on an earlier page, which failed this time; T3 (on the page read) was resolved, and T4 is new.
  const now = readGithub(pull({ reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'c1' }, nodes: [thread('T3', true), thread('T4')] } }), all, 'now', false);
  assert.deepEqual(now.threads.map((t) => t.id), ['T1', 'T4']);
  // Read in full, what is gone is gone.
  assert.deepEqual(readGithub(pull({ reviewThreads: { nodes: [thread('T4')] } }), now, 'now').threads.map((t) => t.id), ['T4']);
});

test("more checks than one page: the result is GitHub's sum of all of them", () => {
  const rollup = (state: string, total: number, checks: object[]) =>
    pull({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { totalCount: total, nodes: checks as any } }, checkSuites: { nodes: [] } } }] } });
  // The first page passes; one past it failed.
  const failed = readGithub(rollup('FAILURE', 130, [run('build', 'COMPLETED', 'SUCCESS')]), null, 'now');
  assert.deepEqual(checksSummary(failed), { passed: 1, failed: 0, pending: 0, skipped: 0, shown: 1, total: 130, result: 'failed' });
  assert.deepEqual(githubAsks(failed, 'main'), ['checks failed on GitHub']);
  // One past it still runs.
  const running = readGithub(rollup('PENDING', 130, [run('build', 'COMPLETED', 'SUCCESS')]), null, 'now');
  assert.equal(checksSummary(running).result, 'pending');
  assert.equal(githubBusy(running), true);
  assert.deepEqual(githubAsks(running, 'main'), []);
});
