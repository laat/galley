// Codex and Claude as reviewer agents: their settings, sandboxes, progress and names, two at once,
// and stopping their iterations.
import '../helpers/env.ts';
import { cli, dir, git, handedOver, human, repo, reviewCheckouts, server, slashTmpWritable, startHarness } from '../helpers/harness.ts';
import { withFakes } from '../helpers/fakes.ts';
import { until } from '../helpers/until.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now } from '../../src/server/db.ts';
import { doneForAutoPublish } from '../../src/server/reviewers/head-status.ts';

startHarness();

test('codex-review reviews when the author waits, within the limits in settings', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/codex');
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', 'codex.js', 'pnpm-lock.yaml');
  git('commit', '-qm', 'Add the answer');
  const created = await cli(['pr', 'create', '--title', 'Add the answer', '--body', 'It is 42.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const review = {
    summary: 'Off by one.',
    comments: [
      // Models often write a one-line comment as start_line == line.
      { path: 'codex.js', line: 1, start_line: 1, side: 'RIGHT', priority: 'high', body: '```suggestion\nexport const answer = 42;\n```' },
      // The priority written into the text the way Codex likes to: it becomes the field.
      { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: null, body: '[P2] Not in this diff.' },
    ],
  };
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    // Settings belong to the reviewer, and the effort has to suit the model.
    const asAgent = await cli(['api', '-X', 'PUT', 'settings/codex', '-F', 'enabled=true']);
    assert.equal(asAgent.code, 1);
    await assert.rejects(human('PUT', '/api/settings/codex', { model: 'gpt-test', effort: 'ultra' }), /does not support effort \\?"ultra"?/);
    await human('PUT', '/api/settings/codex', { enabled: true, model: 'gpt-test', effort: 'high', maxIterations: 1 });
    const settingsPage = await (await fetch(`${server.url}/settings`)).text();
    assert.match(settingsPage, /<option value="gpt-test"[^>]* selected>GPT Test/);
    assert.doesNotMatch(settingsPage, /internal/);
    assert.match(settingsPage, /<div class="Subhead" id="codex">/);
    assert.match(settingsPage, /<input type="checkbox" name="runTests" checked> Let Codex install dependencies and run tests/);

    // The agent waits; Codex reviews first and its review wakes the agent.
    const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex-review reviewed: commented/);
    assert.match(r.stdout, /Off by one\./);
    assert.match(r.stdout, /thread \d+ on codex\.js:1 \[unresolved\] \(high priority\)/);
    assert.match(r.stdout, /`math\.js:1` \(medium priority\): Not in this diff\./);
    const call = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-test');
    assert.ok(call.args.includes('model_reasoning_effort="high"'));
    assert.match(call.prompt, /Title: Add the answer/);
    assert.equal(call.sawFile, true, 'codex runs in a checkout of the head commit');
    // By default galley installs the dependencies from the lockfile first, in Codex's sandbox with
    // network and without the repository's scripts. Then Codex may run the tests, without network,
    // writing only to the checkout and a temporary directory beside it, whatever the user's
    // config.toml says, and ignoring the checkout's own .codex/config.toml.
    const checkout = call.args[call.args.indexOf('-C') + 1];
    const workspaceWrite = (network: boolean) => [
      '-c',
      `sandbox_workspace_write.network_access=${network}`,
      '-c',
      'sandbox_workspace_write.writable_roots=[]',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=false',
    ];
    const untrusted = ['-c', `projects={${JSON.stringify(checkout)}={trust_level="untrusted"}}`];
    const installs = () => readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(installs(), [
      {
        args: [
          'sandbox',
          '-c',
          'sandbox_mode="workspace-write"',
          ...workspaceWrite(true),
          ...untrusted,
          '--',
          'pnpm',
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--config.manage-package-manager-versions=false',
        ],
        cwd: checkout,
        store: join(dirname(checkout), 'tmp', 'pnpm-store'),
      },
    ]);
    assert.deepEqual(call.args.slice(call.args.indexOf('-s'), call.args.indexOf('-C')), ['-s', 'workspace-write', ...workspaceWrite(false), ...untrusted]);
    assert.equal(call.tmpdir, join(dirname(checkout), 'tmp'));
    assert.equal(call.npmCache, join(call.tmpdir, 'npm'));
    assert.match(call.prompt, /galley installed the dependencies with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile [^`]*`, which runs no install scripts/);
    assert.match(call.prompt, /\n    Packages: \+3\n    Done in 1s\n/);
    // Its sandbox can not let the tests serve on localhost without opening more (README).
    assert.match(call.prompt, /you may run the typecheck, tests or build/);
    assert.match(call.prompt, /There is no network, so you can not install anything/);
    assert.match(call.prompt, /changes you make to it are lost/);
    assert.doesNotMatch(call.prompt, /Do not modify any files/);
    // Removed afterwards, read-only directories and all. The review is posted before the cleanup finishes.
    await server.service.codex!.settle((await human('GET', base)).id);
    assert.equal(existsSync(dirname(checkout)), false);
    assert.deepEqual(reviewCheckouts(), []);

    // The cap: after one automatic review, a new commit and another wait start nothing. The
    // reviewer agents are done with it, and the wait says so.
    writeFileSync(join(repo, 'codex.js'), 'export const answer = 42;\n');
    git('commit', '-qam', 'Fix the answer');
    const capped = await cli(['pr', 'wait', String(number), '--timeout', '2s']);
    assert.equal(capped.code, 0, capped.stderr);
    assert.match(capped.stdout, new RegExp(`^The reviewer agents are done with ${git('rev-parse', '--short=7', 'HEAD')} \\(codex-review used 1 of 1 automatic reviews\\); ask the user to review it: `));

    // Raising this pull request's limit lets Codex go on, at once when the author is waiting.
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /data-limit="1"[^]*js-reviewer-step[^]*js-reviewer-step/);
    // This time the install fails; Codex reviews anyway and is told why.
    const second = await withFakes({ FAKE_INSTALL_FAIL: '1' }, async () => {
      const resumed = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      const selfRaise = await cli(['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${number}/reviewers/codex`, '-F', 'max_iterations=9']);
      assert.equal(selfRaise.code, 1, 'agents cannot raise their own limit');
      assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: '2' }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: 2 } });
      return resumed;
    });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /automatic review 2 of 2/);
    const failedInstall = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.match(failedInstall.prompt, /galley could not install the dependencies: `pnpm install [^`]*` exited with 1\. Its output ended with:\n\n    ERR_PNPM_OUTDATED_LOCKFILE\n/);

    // Asking from the page ignores the cap, and a failed run keeps its error. With running the
    // tests turned off, Codex gets today's read-only sandbox and is told not to modify files.
    await human('PUT', '/api/settings/codex', { runTests: false });
    // In the Codex section, which comes before Claude's.
    assert.doesNotMatch((await (await fetch(`${server.url}/settings`)).text()).split('id="claude"')[0], /name="runTests" checked/);
    const pull = await human('GET', base);
    await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(pull.id);
    });
    const readOnly = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('-s'), readOnly.args.indexOf('-C')), [
      '-s',
      'read-only',
      '-c',
      `projects={${JSON.stringify(readOnly.args[readOnly.args.indexOf('-C') + 1])}={trust_level="untrusted"}}`,
    ]);
    assert.equal(installs().length, 2, 'nothing is installed for a read-only review');
    assert.equal(readOnly.tmpdir, process.env.TMPDIR);
    assert.match(readOnly.prompt, /Do not modify any files\./);
    assert.doesNotMatch(readOnly.prompt, /install the dependencies/);
    await human('PUT', '/api/settings/codex', { runTests: true });
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((x: any) => [x.trigger, x.status]), [['auto', 'done'], ['auto', 'done'], ['manual', 'failed']]);
    assert.match(runs[2].error, /model overloaded/);
    const page = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    assert.match(page, /failed/);
    assert.match(page, /<span class="agent-chunk">Automatic: 2 of 2<\/span>/);
    assert.match(page, /class="reviewer-limit" data-api="[^"]*\/reviewers\/codex" data-limit="2"/);
    assert.match(page, /js-reviewer-reset"[^>]* data-field="max_iterations"/);
    assert.doesNotMatch(page, /for this pull request/, 'following the setting, as without --reviewer');
    assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: null }), { enabled: true, max_iterations: 1, overrides: { enabled: null, max_iterations: null } });

    // The reviewer is one identity: renaming it carries its earlier reviews along.
    await human('PUT', '/api/settings/codex', { name: 'codex-bot' });
    const reviews = await human('GET', `${base}/reviews`);
    assert.deepEqual([...new Set(reviews.map((rv: any) => rv.user.login))], ['codex-bot']);
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Looks right.' });
    const renamed = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    assert.equal(renamed.match(/<span class="flex-auto">codex-bot<\/span>/g)?.length, 1, 'under Reviewers');
    assert.doesNotMatch(renamed, /<span class="flex-auto">codex<\/span>/);
    // Its name goes to its settings, under the new name too; a person's name does not.
    assert.match(renamed, /<a class="agent-name" href="\/settings#codex" title="Settings for codex-bot">codex-bot<\/a>/);
    assert.match(renamed, /<a class="author" href="\/settings#codex" title="Settings for codex-bot">codex-bot<\/a><span class="Label Label--bot">bot<\/span> reviewed/);
    assert.match(renamed, /<a class="author" href="#" title="reviewer">reviewer<\/a> commented/);
    // A name someone else uses is refused, and nobody can post as the reviewer.
    await assert.rejects(human('PUT', '/api/settings/codex', { name: 'agent' }), /already used by someone else/);
    const impostor = await cli(['pr', 'comment', String(number), '-b', 'hi'], { actor: 'codex-bot' });
    assert.equal(impostor.code, 1);
    assert.match(impostor.stderr, /is the name of the Codex reviewer/);
    await human('PUT', '/api/settings/codex', { name: 'codex-review' });

    // A pull request written by an agent running in Codex (the CLI calls it "codex-agent") is
    // reviewed too, and the review reaches that agent's wait.
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/by-codex');
    writeFileSync(join(repo, 'by-codex.js'), 'export {};\n');
    git('add', 'by-codex.js');
    git('commit', '-qm', 'Written in Codex');
    const byCodex = await cli(['pr', 'create', '--title', 'Written in Codex', '--body', 'x'], { actor: 'codex-agent' });
    assert.equal(byCodex.code, 0, byCodex.stderr);
    const waited = await cli(['pr', 'wait', byCodex.stdout.trim().split('/').pop()!, '--timeout', '20s'], { actor: 'codex-agent' });
    assert.equal(waited.code, 0, waited.stderr);
    assert.match(waited.stdout, /codex-review reviewed: commented/);
    // Without a lockfile nothing is installed, and Codex is told so.
    const noLockfile = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.match(noLockfile.prompt, /No dependencies are installed: the repository root has no lockfile/);
    assert.equal(installs().length, 2);
    await human('PUT', '/api/settings/codex', { enabled: false });
  });
});

test('claude reviews when the author waits, in its own sandbox, and says what it cost', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/claude');
  writeFileSync(join(repo, 'claude.js'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', 'claude.js', 'pnpm-lock.yaml');
  git('commit', '-qm', 'Add the answer for Claude');
  const created = await cli(['pr', 'create', '--title', 'Add the answer', '--body', 'It is 42.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const lastCall = () => JSON.parse(readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').at(-1)!);
  const review = { summary: 'Off by one.', comments: [{ path: 'claude.js', line: 1, start_line: null, side: 'RIGHT', priority: 'high', body: 'It should be 42.' }] };
  await withFakes({ FAKE_CLAUDE_REVIEW: JSON.stringify(review) }, async () => {
    // Its section of the settings is next to Codex's, with the same settings.
    await assert.rejects(human('PUT', '/api/settings/claude', { model: 'haiku', effort: 'extreme' }), /does not support effort \\?"extreme"?/);
    await human('PUT', '/api/settings/claude', { enabled: true, model: 'haiku', effort: 'low', maxIterations: 2 });
    const settingsPage = await (await fetch(`${server.url}/settings`)).text();
    assert.match(settingsPage, /<div class="Subhead" id="claude">/);
    assert.match(settingsPage, /posts its findings as a review from <strong>claude-review<\/strong>/);
    assert.match(settingsPage, /<option value="haiku"[^>]* selected>Haiku/);
    assert.match(settingsPage, /<input type="checkbox" name="skipOwnKind"> Skip pull requests by agents in Claude Code/);
    assert.match(settingsPage, /<input type="checkbox" name="skipOwnKind"> Skip pull requests by agents in Codex/);
    // Letting its tests listen on localhost is a setting of Claude's alone, off by default, and says
    // what it opens. Codex's sandbox can not do it without letting the tests connect to other hosts.
    assert.equal((await human('GET', '/api/settings')).claude.localhost, false);
    assert.match(settingsPage, /<input type="checkbox" name="localhost"> Let Claude's tests listen on localhost/);
    assert.match(settingsPage, /Code in the pull request can then reach anything on localhost, including galley, which takes any local caller for you and could publish as you/);
    assert.match(settingsPage, /other machines on your network can reach a server that does not listen on 127\.0\.0\.1 only/);
    assert.doesNotMatch(settingsPage.split('id="claude"')[0], /name="localhost"/);
    await assert.rejects(human('PUT', '/api/settings/codex', { localhost: true }), /Codex's sandbox can not let its tests listen on localhost/);

    const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claude-review reviewed: commented/);
    assert.match(r.stdout, /Off by one\./);
    assert.match(r.stdout, /thread \d+ on claude\.js:1 \[unresolved\] \(high priority\)/);

    // Claude Code headless in a checkout of the head, with the user's own login (no --bare), the
    // prompt on stdin and the answer in the schema, as the reviewer bot asked for.
    const call = lastCall();
    const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
    assert.equal(call.sawFile, true, 'claude runs in a checkout of the head commit');
    assert.match(call.prompt, /Title: Add the answer/);
    assert.equal(flag('--model'), 'haiku');
    assert.equal(flag('--effort'), 'low');
    assert.equal(flag('--output-format'), 'stream-json');
    assert.ok(call.args.includes('--verbose'), 'stream-json needs --verbose');
    assert.deepEqual(JSON.parse(flag('--json-schema')).required, ['summary', 'comments']);
    // The checkout is untrusted: none of its settings (hooks), MCP servers, CLAUDE.md, skills or agents.
    for (const f of ['--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.args.includes(f), f);
    assert.equal(flag('--disallowedTools'), 'mcp__*');
    assert.ok(!call.args.includes('--bare'));
    // Tools for reading and for running commands, with nobody to ask: what is not allowed is denied.
    assert.equal(flag('--tools'), 'Read,Grep,Glob,Bash');
    assert.deepEqual(call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--disallowedTools')), ['Read', 'Grep', 'Glob']);
    assert.equal(flag('--permission-mode'), 'dontAsk');
    assert.equal(flag('--permission-prompts'), 'none');
    // Commands run in Claude Code's sandbox, never outside it: no network (not even localhost, by
    // default), writes to the checkout, Claude Code's own temporary directory and the review's, and
    // not to the user's repository (nor to /tmp/claude-<uid>, where the user's own Claude Code
    // sessions keep theirs).
    const checkout = call.cwd;
    const tmp = join(dirname(checkout), 'tmp');
    const uid = process.getuid!();
    const { git_dir } = await human('GET', '/api/repos/acme/widgets');
    assert.deepEqual(JSON.parse(flag('--settings')), {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowLocalBinding: false },
        filesystem: { allowWrite: [tmp], denyWrite: [join(checkout, '.git'), git_dir, `/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`] },
      },
    });
    assert.equal(call.tmpdir, tmp);
    // Short, or Claude Code falls back to /tmp/claude-<uid>. Where /tmp is not writable, it is under
    // $TMPDIR, which may be longer.
    if (slashTmpWritable()) assert.ok(Buffer.byteLength(`${call.claudeTmpdir}/claude-${uid}`) <= 30, call.claudeTmpdir);
    else t.diagnostic(`not checking that ${call.claudeTmpdir} is short: /tmp is not writable here (in a reviewer agent's sandbox?), so it is under $TMPDIR`);
    assert.equal(call.claudeTmpdirExists, true);
    assert.equal(existsSync(call.claudeTmpdir), false, 'removed after the review');
    assert.equal(call.session, null, 'not taken for part of a Claude Code session the server was started from');
    // The dependencies were installed first, in galley's own sandbox: network, and writes only to the checkout and the review's TMPDIR.
    const install = JSON.parse(readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    const pnpmInstall = ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.manage-package-manager-versions=false'];
    if (process.platform === 'linux') {
      assert.deepEqual(install.args.slice(install.args.indexOf('--bind')), ['--bind', checkout, checkout, '--bind', tmp, tmp, '--ro-bind', join(checkout, '.git'), join(checkout, '.git'), '--', ...pnpmInstall]);
    } else {
      assert.match(install.args[1], /^\(version 1\)\n\(deny default\)/);
      assert.deepEqual(install.args.slice(2), [`-DWRITABLE_0=${checkout}`, `-DWRITABLE_1=${tmp}`, `-DREAD_ONLY_0=${join(checkout, '.git')}`, ...pnpmInstall]);
    }
    assert.equal(install.cwd, checkout);
    assert.equal(install.store, join(tmp, 'pnpm-store'));
    assert.match(call.prompt, /galley installed the dependencies with `pnpm install [^`]*`[^]*\n    Packages: \+1\n/);
    assert.match(call.prompt, /There is no network, so you can not install anything/);
    assert.doesNotMatch(call.prompt, /localhost/);

    // The review is Claude's, and the run says what it cost, in the API and in the sidebar.
    const { runs } = await human('GET', `${base}/reviewers/claude`);
    assert.deepEqual(
      runs.map((x: any) => [x.trigger, x.status, x.findings, x.model, x.effort]),
      [['auto', 'done', 1, 'haiku', 'low']],
    );
    assert.deepEqual(runs[0].usage, {
      cost_usd: 0.0123,
      input_tokens: 12,
      cache_creation_input_tokens: 15000,
      cache_read_input_tokens: 30000,
      output_tokens: 2100,
      turns: 7,
      duration_ms: 4200,
      models: ['claude-haiku-5-5'],
    });
    assert.match((await human('GET', `${base}/reviews`)).at(-1).body, /<sub>Claude \(haiku, low effort\) reviewed `[0-9a-f]{7}`, automatic review 1 of 2\.<\/sub>$/);
    let html = await page();
    assert.match(html, /<a class="agent-name" href="\/settings#claude" title="Settings for claude-review">claude-review<\/a>/);
    // What its runs cost, and the latest in detail on hover.
    assert.match(html, /<span class="agent-chunk"><span title="Last run: \$0\.01 · 45k tokens in, 2k out · 7 turns\n[^"]*">\$0\.01<\/span><\/span>/);
    assert.match(html, /Ask Claude to review/);
    // Its transcript: the file it read by its full path, linked as the repository's own at the
    // reviewed commit, what it said, and its answer.
    const transcript = await (await fetch(`${server.url}/acme/widgets/pull/${number}/runs/${runs[0].id}`)).text();
    assert.match(transcript, new RegExp(`Read <a class="run-location" href="/acme/widgets/blob/${runs[0].head_sha}/math\\.js#L2"><code>math\\.js:2</code></a>`));
    assert.match(transcript, /The answer is off by one\./);
    assert.match(transcript, /&quot;summary&quot;: &quot;Off by one\.&quot;/);
    assert.match(transcript, /2 steps · \$0\.01 · 45k tokens in, 2k out · 7 turns/);
    // The first step was galley's: installing the dependencies.
    assert.match(transcript, /<code class="run-command">pnpm install --frozen-lockfile [^<]*<\/code><\/span> <svg[^>]*octicon-check[^]*?Packages: \+1/);

    // Without running the tests, it reads: Read, Grep, Glob and read-only git, with the checkout
    // read-only too, and nothing installed. Nothing listens on localhost, whatever that setting says.
    // A failed run keeps Claude Code's error.
    const installs = readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').length;
    await human('PUT', '/api/settings/claude', { runTests: false, localhost: true });
    const pull = await human('GET', base);
    await withFakes({ FAKE_CLAUDE_FAIL: '1' }, async () => {
      await human('POST', `${base}/reviewers/claude`);
      await server.service.claude!.settle(pull.id);
    });
    const readOnly = lastCall();
    const readOnlyFlag = (name: string) => readOnly.args[readOnly.args.indexOf(name) + 1];
    const allowed = readOnly.args.slice(readOnly.args.indexOf('--allowedTools') + 1, readOnly.args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed.slice(0, 5), ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)']);
    assert.ok(allowed.every((t: string) => !t.startsWith('Bash') || t.startsWith('Bash(git ')));
    const { sandbox } = JSON.parse(readOnlyFlag('--settings'));
    assert.equal(sandbox.autoAllowBashIfSandboxed, false);
    assert.deepEqual(sandbox.filesystem.allowWrite, []);
    assert.ok(sandbox.filesystem.denyWrite.includes(readOnly.cwd));
    assert.equal(sandbox.network.allowLocalBinding, false);
    assert.match(readOnly.prompt, /Do not modify any files\./);
    assert.equal(readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').length, installs, 'nothing is installed for a read-only review');
    await human('PUT', '/api/settings/claude', { runTests: true });
    const failed = (await human('GET', `${base}/reviewers/claude`)).runs.at(-1);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /^claude stopped \(error_during_execution\):\nAPI Error: 529 overloaded$/);
    // What it cost before it failed counts too.
    assert.equal(failed.usage.cost_usd, 0.004);
    assert.equal(failed.usage.output_tokens, 300);
    assert.match(await page(), /<span title="2 runs: \$0\.02\nLast run: \$0\.0040 · 5 tokens in, 300 out · 2 turns\n[^"]*">\$0\.02<\/span>/);

    // With the tests and localhost on, the tests may start servers there, and Claude is told so.
    // They still can not connect to other hosts.
    await human('POST', `${base}/reviewers/claude`);
    await server.service.claude!.settle(pull.id);
    const serving = lastCall();
    assert.deepEqual(JSON.parse(serving.args[serving.args.indexOf('--settings') + 1]).sandbox.network, {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: true,
    });
    assert.match(serving.prompt, /you may run the typecheck, the whole test suite \(tests that start servers on localhost included\) or the build/);
    assert.match(serving.prompt, /There is no network beyond localhost, so you can not install anything/);
    await human('PUT', '/api/settings/claude', { localhost: false });

    // One identity whose name is a setting. It can not take an author agent's name, nor another
    // reviewer's, and nobody can post under it.
    await assert.rejects(human('PUT', '/api/settings/claude', { name: 'claude' }), /is what the CLI calls author agents/);
    await assert.rejects(human('PUT', '/api/settings/claude', { name: 'codex-review' }), /already used by someone else/);
    await assert.rejects(human('PUT', '/api/settings/codex', { name: 'claude-review' }), /already used by someone else/);
    await human('PUT', '/api/settings/claude', { name: 'claude-bot' });
    assert.deepEqual([...new Set((await human('GET', `${base}/reviews`)).map((rv: any) => rv.user.login))], ['claude-bot']);
    for (const actor of ['claude-bot', 'codex-review']) {
      const impostor = await cli(['pr', 'comment', String(number), '-b', 'hi'], { actor });
      assert.equal(impostor.code, 1);
      assert.match(impostor.stderr, new RegExp(`"${actor}" is the name of the ${actor === 'codex-review' ? 'Codex' : 'Claude'} reviewer`));
    }
    await human('PUT', '/api/settings/claude', { name: 'claude-review' });

    // Its own switch and limit on each pull request, in its menu in the sidebar as for Codex.
    html = await page();
    assert.match(html, new RegExp(`data-api="${base}/reviewers/claude" data-limit="2"`));
    assert.match(html, new RegExp(`class="dropdown-item js-reviewer-switch"[^>]* data-api="${base}/reviewers/claude" data-enabled="false">Turn off<`));
    assert.deepEqual(await human('PATCH', `${base}/reviewers/claude`, { enabled: false }), { enabled: false, max_iterations: 2, overrides: { enabled: false, max_iterations: null } });
    html = await page();
    // Only the automatic ones are off: the row may say Reviewing above, for a review asked for by hand.
    assert.match(html, /<span class="agent-chunk">Automatic: off for this pull request<\/span>/);
    assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">On in Settings<\/span>/);
    assert.match(html, new RegExp(`js-reviewer-switch"[^>]* data-api="${base}/reviewers/claude" data-enabled="true">Turn on<`));
    assert.deepEqual(await human('PATCH', `${base}/reviewers/claude`, { enabled: null }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: null } });
    await human('PUT', '/api/settings/claude', { enabled: false, model: '', effort: '', maxIterations: 3 });
  });
});

test("a reviewer agent's progress shows while it runs, and its transcript stays", async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/progress');
  writeFileSync(join(repo, 'progress.js'), 'export const progress = 1;\n');
  git('add', 'progress.js');
  git('commit', '-qm', 'Add progress.js');
  const created = await cli(['pr', 'create', '--title', 'Show the progress', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pullPath = `/acme/widgets/pull/${number}`;
  const page = async (path = '') => (await fetch(server.url + pullPath + path)).text();
  const pull = await human('GET', base);
  const gate = join(dir, 'codex-progress-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'progress.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it better.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_BIG: '1', FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { runTests: false });
    // Pages hear of progress on the stream they share, as their own kind of message.
    const listening = new AbortController();
    const heard = fetch(`${server.url}/events?pull=${pull.id}`, { signal: listening.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      let text = '';
      while (!/data: \{"type":"progress".*\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    });
    let runId: number;
    try {
      ({ run_id: runId } = await human('POST', `${base}/reviewers/codex`));
      // While Codex waits, the sidebar shows what it did: the file it read, at the reviewed commit,
      // the command it runs now, what it said and how many steps it took.
      await until(async () => (await page()).includes('git diff HEAD~1 HEAD'), 'the sidebar shows the running command');
      const html = await page();
      const box = `<div class="run-progress js-run-progress" data-run="${runId}" data-src="${pullPath}/runs/${runId}/progress">`;
      assert.ok(html.includes(box), html);
      assert.match(html, new RegExp(`run-step--completed">[^]*?<span class="run-step-label">Read <a class="run-location" href="/acme/widgets/blob/${pull.head.sha}/math\\.js#L2"><code>math\\.js:2</code></a></span>`));
      assert.match(html, /run-step--in_progress">[^]*?<code class="run-command">git diff HEAD~1 HEAD<\/code>/);
      assert.match(html, /<p class="run-said" title="What it last said">I will read math\.js and the diff\.<\/p>/);
      assert.match(html, new RegExp(`<a class="run-link" href="${pullPath}/runs/${runId}">.*Transcript \\(2 steps\\)</a>`));
      // The same box alone, which the page fetches again when it hears of progress.
      const part = await fetch(`${server.url}${pullPath}/runs/${runId}/progress`);
      assert.equal(part.status, 200);
      assert.ok((await part.text()).startsWith(box));
      assert.ok((await heard).includes(`data: {"type":"progress","event":{"pullId":${pull.id},"runId":${runId}}}\n`), 'a progress message');
      // The transcript page follows the run while it goes on.
      const live = await page(`/runs/${runId}`);
      assert.match(live, new RegExp(`<div id="main"[^>]* data-run-live="${runId}"`));
      assert.match(live, /Reviewing for <relative-time/);
      writeFileSync(gate, '');
      await server.service.codex!.settle(pull.id);
    } finally {
      listening.abort();
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { runTests: true });
    }

    // Once it is done, the box is gone, and the sidebar and the review link to the transcript.
    assert.equal((await fetch(`${server.url}${pullPath}/runs/${runId}/progress`)).status, 204);
    const html = await page();
    assert.doesNotMatch(html, /js-run-progress/);
    // Its row says what it found, with a comment in the attention colour: agent has not answered it.
    assert.match(html, new RegExp(`<a class="agent-state" href="${pullPath}/runs/${runId}" title="Found 1 problem in ${pull.head.sha.slice(0, 7)}; agent has not answered it"><svg class="octicon octicon-comment color-fg-attention"[^>]*>[^]*?</svg><span>1 finding · <code>${pull.head.sha.slice(0, 7)}</code></span></a>`));
    assert.match(html, new RegExp(`<a class="review-run-link" href="${pullPath}/runs/${runId}">`));
    // Codex says how many tokens it used.
    assert.match(html, /<span title="Last run: 12k tokens in, 300 out[^"]*">12k tokens<\/span>/);

    const transcript = await page(`/runs/${runId}`);
    assert.doesNotMatch(transcript, /data-run-live/);
    assert.match(transcript, /codex-review's review on request of <code>[0-9a-f]{7}<\/code>/);
    assert.match(transcript, new RegExp(`<a href="${pullPath}#pullrequestreview-\\d+">Posted its review</a>`));
    assert.match(transcript, /2 steps · 12k tokens in, 300 out/);
    assert.match(transcript, /The prompt galley gave it<\/summary><pre class="run-output">[^<]*Title: Show the progress/);
    assert.match(transcript, /run-thought[^]*<strong>Reading the change<\/strong>/);
    assert.match(transcript, /I will read math\.js and the diff\./);
    // The read links to the file at the reviewed commit, with the command that read it and its
    // output, of which only the start and the end are kept.
    assert.match(transcript, new RegExp(`Read <a class="run-location" href="/acme/widgets/blob/${pull.head.sha}/math\\.js#L2"><code>math\\.js:2</code></a></span> <svg[^>]*octicon-check[^]*?<pre class="run-output run-output--command">\\$ sed -n &#39;2,20p&#39; math\\.js</pre>`));
    assert.match(transcript, /<pre class="run-output">a{8192}\n… 83616 bytes left out …\nx{8192}<\/pre>/);
    assert.match(transcript, /<code class="run-command">git diff HEAD~1 HEAD<\/code><\/span> <svg[^>]*octicon-check[^]*?\+export const answer = 41;/);
    // Its answer, as code.
    assert.match(transcript, /&quot;summary&quot;: &quot;One thing\.&quot;/);
    // Stored as ACP session updates; the tokens are not among them.
    const stored = server.service.db.all<{ data: string }>('SELECT data FROM review_run_events WHERE run_id = ? ORDER BY id', runId).map((r) => JSON.parse(r.data).sessionUpdate);
    assert.deepEqual(stored, ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
    // A run of another pull request is not this one's.
    assert.equal((await fetch(`${server.url}/acme/widgets/pull/1/runs/${runId}`)).status, 404);
  });
});

test('a reviewer can not take a name that --reviewer would take for the other one', async () => {
  // The other's kind or name, in any case: staging with it would turn on the other reviewer.
  const codex = server.service.codex!.actor().login;
  for (const name of ['CODEX', 'Codex', codex.toUpperCase()]) {
    await assert.rejects(human('PUT', '/api/settings/claude', { name }), new RegExp(`${name}\\\\?" would ask for the Codex reviewer \\(--reviewer ${name}\\)`));
  }
  await assert.rejects(human('PUT', '/api/settings/codex', { name: 'Claude-Review' }), /Claude-Review\\?" would ask for the Claude reviewer/);
  const { codex: codexSettings, claude: claudeSettings } = await human('GET', '/api/settings');
  assert.deepEqual([codexSettings.name, claudeSettings.name], [codex, 'claude-review']);
  assert.deepEqual([server.service.codex!.actor().login, server.service.claude!.actor().login], [codex, 'claude-review']);
});

test('a reviewer can leave pull requests by its own kind of agent to the other', async (t) => {
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine by Codex.', comments: [] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine by Claude.', comments: [] }),
  }, async () => {
    const stage = async (branch: string, file: string, actor: string, flags: string[] = []) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
      const r = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...flags], { actor });
      assert.equal(r.code, 0, r.stderr);
      return Number(r.stdout.trim().split('/').pop());
    };
    const config = async (n: number, kind: string) => {
      const { enabled, runs } = await human('GET', `/api/repos/acme/widgets/pulls/${n}/reviewers/${kind}`);
      return { enabled, runs: runs.length };
    };
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1, skipOwnKind: true });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 1, skipOwnKind: true });
    try {
      await t.test('Codex reviews what an agent in Claude Code wrote, and Claude does not', async () => {
        const n = await stage('feature/by-claude', 'by-claude.js', 'claude');
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'claude' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /codex-review reviewed: commented/);
        assert.doesNotMatch(w.stdout, /claude-review/);
        assert.deepEqual(await config(n, 'claude'), { enabled: false, runs: 0 });
        assert.deepEqual(await config(n, 'codex'), { enabled: true, runs: 1 });
        const html = await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
        assert.match(html, /Settings leave pull requests by agents in Claude Code to other reviewers/);
      });
      await t.test('galley reviewers says which review the caller\'s pull requests on their own', async () => {
        const list = async (actor: string) => JSON.parse((await cli(['reviewers', '--json', 'name,automatic'], { actor })).stdout);
        assert.deepEqual(await list('claude'), [{ name: 'codex-review', automatic: true }, { name: 'claude-review', automatic: false }]);
        assert.deepEqual(await list('codex-agent'), [{ name: 'codex-review', automatic: false }, { name: 'claude-review', automatic: true }]);
      });
      await t.test('and the other way round', async () => {
        const n = await stage('feature/by-codex-agent', 'by-codex-agent.js', 'codex-agent');
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'codex-agent' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /claude-review reviewed: commented/);
        assert.deepEqual(await config(n, 'codex'), { enabled: false, runs: 0 });
      });
      await t.test('asked for when staging, it reviews all the same', async () => {
        const n = await stage('feature/by-claude-asked', 'by-claude-asked.js', 'claude', ['--reviewer', 'claude:1']);
        assert.deepEqual((await human('GET', `/api/repos/acme/widgets/pulls/${n}/reviewers/claude`)).overrides, { enabled: true, max_iterations: 1 });
        await human('PATCH', `/api/repos/acme/widgets/pulls/${n}/reviewers/codex`, { enabled: false });
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'claude' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /claude-review reviewed: commented/);
      });
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3, skipOwnKind: false });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3, skipOwnKind: false });
    }
  });
});

test('with two reviewer agents, pr wait hands the author both reviews of a commit together', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/two-reviewers');
  writeFileSync(join(repo, 'two-reviewers.js'), 'export const two = 1;\n');
  git('add', 'two-reviewers.js');
  git('commit', '-qm', 'Add two-reviewers.js');
  const created = await cli(['pr', 'create', '--title', 'Two reviewers', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const finished = async (kind: string, n: number) => (await human('GET', `${base}/reviewers/${kind}`)).runs.filter((r: any) => r.status === 'done').length === n;
  const comment = (body: string) => ({ path: 'two-reviewers.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body });
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Codex has one thing.', comments: [comment('From Codex.')] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has another.', comments: [comment('From Claude.')] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 2 });
    try {
      // Codex is done with the commit and Claude is still at it: the author keeps waiting.
      let returned = false;
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']).finally(() => (returned = true));
      await until(() => finished('codex', 1), 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(returned, false, 'pr wait returned before Claude reviewed');
      // Who is still reviewing: in pr view, its turn, and the sidebar.
      const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests,turn'])).stdout);
      assert.deepEqual(view.reviewRequests.map((r: any) => [r.login, r.status]), [['claude-review', 'IN_PROGRESS']]);
      assert.equal(view.turn.whose, 'REVIEWER_AGENTS');
      const html = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
      assert.match(html, /<span class="flex-auto">claude-review<\/span> <span title="Reviewing [0-9a-f]{7}">/);
      assert.match(html, /<span class="flex-auto">codex-review<\/span> <svg[^>]*octicon-comment/);
      assert.match(html, /<strong>Claude is still reviewing this commit<\/strong>/);

      // Then both reviews come back together.
      writeFileSync(gate, '');
      const both = await waiting;
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /codex-review reviewed: commented/);
      assert.match(both.stdout, /claude-review reviewed: commented/);
      assert.match(both.stdout, /From Codex\.[^]*From Claude\.|From Claude\.[^]*From Codex\./);
      await server.service.claude!.settle(id);

      // Feedback from anyone else comes back at once, with what the reviewer agents posted so far
      // and who is still reviewing.
      rmSync(gate);
      writeFileSync(join(repo, 'two-reviewers.js'), 'export const two = 2;\n');
      git('commit', '-qam', 'Answer both');
      const second = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => finished('codex', 2), 'Codex has reviewed the new commit');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews the new commit');
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Looks better.' });
      const early = await second;
      assert.equal(early.code, 0, early.stderr);
      assert.match(early.stdout, /reviewer commented/);
      assert.match(early.stdout, /codex-review reviewed: commented/);
      assert.doesNotMatch(early.stdout, /claude-review reviewed/);
      assert.match(early.stdout, /^claude-review is reviewing [0-9a-f]{7} \(started [^)]*\)\.$/m);
      writeFileSync(gate, '');
      const last = await cli(['pr', 'wait', String(number), '--timeout', '30s']);
      assert.match(last.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('pr wait says when the reviewer agents leave nothing to address, and which reviews are still to come', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/nothing-to-address');
  writeFileSync(join(repo, 'nothing.js'), 'export const nothing = 1;\n');
  git('add', 'nothing.js');
  git('commit', '-qm', 'Add nothing.js');
  const created = await cli(['pr', 'create', '--title', 'Add nothing.js', '--body', 'x', '--reviewer', 'codex:4']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const { id } = await human('GET', `/api/repos/acme/widgets/pulls/${number}`);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  // The author waits, and Codex answers `review`.
  const wait = (review: object = { summary: 'Fine.', comments: [] }) =>
    withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      await server.service.codex!.settle(id);
      return r.stdout;
    });
  const commit = async (n: number) => {
    writeFileSync(join(repo, 'nothing.js'), `export const nothing = ${n};\n`);
    git('commit', '-qam', `Count to ${n}`);
    await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the server has the new commit');
  };
  try {
    // A finding outside the diff has no thread to answer in, and asks something of the author all the same.
    const found = await wait({ summary: 'One thing.', comments: [{ path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' }] });
    assert.match(found, /`math\.js:1` \(low priority\): Not in this diff\./);
    assert.match(found, /^Address the feedback\./m);

    // Codex finds nothing in the next commit, and Claude's review of it is still to run, as after a restart.
    await commit(2);
    const interrupted = server.service.db.insert('review_runs', { pull_id: id, reviewer: 'claude', head_sha: row().head_sha, trigger: 'manual', status: 'interrupted', started_at: now(), finished_at: now() });
    const clean = await wait();
    assert.match(clean, /codex-review reviewed: commented/);
    assert.match(clean, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again for the review still to come \\(claude-review's review of ${sha()} was interrupted by a restart; it will run again\\)\\.$`, 'm'));
    assert.doesNotMatch(clean, /Address the feedback/);
    server.service.db.run('DELETE FROM review_runs WHERE id = ?', interrupted);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); `));

    // A thread the author was shown and has not answered since its latest comment is still to address,
    // whatever the reviewer agents found.
    await human('POST', `/api/repos/acme/widgets/pulls/${number}/reviews`, { event: 'COMMENT', comments: [{ path: 'nothing.js', line: 1, side: 'RIGHT', body: 'Why a constant?' }] });
    const thread = (await human('GET', `/api/repos/acme/widgets/pulls/${number}/comments`)).at(-1).id;
    assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', 'It is all it needs.'])).code, 0);
    await human('POST', `/api/repos/acme/widgets/pulls/${number}/comments/${thread}/replies`, { body: 'Is it?' });
    await cli(['pr', 'view', String(number), '--comments']);
    await commit(3);
    const open = await wait();
    assert.match(open, /codex-review reviewed: commented/);
    assert.match(open, /^Address the feedback\./m);
    assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', 'Yes.'])).code, 0);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} `));

    // Once answered, it may stay open. The only reviewer agent finds nothing: the next wait hands the commit over.
    await commit(4);
    const done = await wait();
    assert.match(done, new RegExp(`^Unresolved threads: ${thread}$`, 'm'));
    assert.match(done, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again\\.$`, 'm'));
    assert.doesNotMatch(done, /Address the feedback/);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); `));
  } finally {
    await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { state: 'closed' });
  }
});

test('stop iterating: a running review finishes, no new one starts, the author hands over, and Resume lets them go on', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-iterating');
  writeFileSync(join(repo, 'stop.js'), 'export const stop = 1;\n');
  git('add', 'stop.js');
  git('commit', '-qm', 'Add stop.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const runs = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.map((r: any) => r.status);
  const ownLimits = async () => Promise.all(['codex', 'claude'].map(async (kind) => (await human('GET', `${base}/reviewers/${kind}`)).overrides.max_iterations));
  const comment = (body: string) => ({ path: 'stop.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body });
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Codex has one thing.', comments: [comment('From Codex.')] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has another.', comments: [comment('From Claude.')] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      // Codex has reviewed the first commit and Claude is still at it when the reviewer stops iterating.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(async () => (await runs('codex'))[0] === 'done', 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      assert.match(await page(), /<strong>1 automatic review round so far<\/strong>[^]*>Stop iterating<\/button>/);
      const agent = await fetch(`${server.url}${base}/stop-iterating`, { method: 'PUT', headers: { 'x-galley-actor': 'agent' } });
      assert.equal(agent.status, 403);
      const stopped = await human('PUT', `${base}/stop-iterating`);
      assert.equal(stopped.iterations_stopped.stopped_by.login, 'reviewer');
      assert.equal(stopped.iterations_stopped.round, 1);
      // The stop is the gate; the limits stay as they were.
      assert.deepEqual(await ownLimits(), [null, null]);

      // Nothing running is cut short: Claude's review reaches the author.
      assert.equal(server.service.claude!.atWork(row())?.status, 'IN_PROGRESS');
      writeFileSync(gate, '');
      const both = await waiting;
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /codex-review reviewed: commented/);
      assert.match(both.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
      const box = await page();
      assert.match(box, /<strong>Automatic reviews stopped by reviewer after round 1<\/strong>[^]*>Resume<\/button>/);
      assert.match(box, /stopped automatic reviews after round 1/);
      assert.doesNotMatch(box, />Stop iterating<\/button>/);

      // The author's next commit gets no automatic review: pr wait hands it to the reviewer, saying why.
      writeFileSync(join(repo, 'stop.js'), 'export const stop = 2;\n');
      git('commit', '-qam', 'Answer both');
      const sha = git('rev-parse', '--short=7', 'HEAD');
      const handed = await handedOver(number);
      assert.match(handed, new RegExp(`^The reviewer agents are done with ${sha} \\(reviewer stopped automatic reviews after round 1\\); ask the user to review it: `, 'm'));
      assert.deepEqual([await runs('codex'), await runs('claude')], [['done'], ['done']]);
      assert.ok(server.service.readiness(row()).reviewers.every((r) => doneForAutoPublish(r.status.state)));
      const { turn } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
      assert.deepEqual(turn.reasons.filter((r: string) => r.includes('stopped')), ['reviewer stopped automatic reviews after round 1']);

      // Resume lets them go on, and the waiting author's commit is reviewed at once (the gate is open).
      const again = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => server.service.authorWaiting(id), 'the author waits');
      await human('DELETE', `${base}/stop-iterating`);
      assert.equal((await human('GET', base)).iterations_stopped, null);
      const reviewed = await again;
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /codex-review reviewed: commented/);
      assert.match(reviewed.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
      assert.match(await page(), /resumed automatic reviews/);

      // A limit set by hand resumes them, as Resume does.
      await human('PUT', `${base}/stop-iterating`);
      await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 3 });
      assert.equal((await human('GET', base)).iterations_stopped, null);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('a review that fails after iterations stop holds nothing up, and the next commit gets no automatic review', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-then-fail');
  writeFileSync(join(repo, 'stop-fail.js'), 'export const fail = 1;\n');
  git('add', 'stop-fail.js');
  git('commit', '-qm', 'Add stop-fail.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-fail.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const codex = server.service.codex!;
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const codexStatus = () => server.service.readiness(row()).reviewers.find((r) => r.engine === 'codex')!.status;
  const gate = join(dir, 'codex-gate');
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
  try {
    await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_FAIL: '1' }, async () => {
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
      assert.equal((await human('PUT', `${base}/stop-iterating`)).iterations_stopped.round, 1);
      // Still running, it holds things up.
      assert.equal(codexStatus().state, 'reviewing');
      // The review fails, as one cut short by a server restart does, so no automatic review counts as done.
      writeFileSync(gate, '');
      const failed = await waiting;
      assert.equal(failed.code, 0, failed.stderr);
      await codex.settle(id);

      // On the same commit, the failure holds nothing up: Codex is done, the author hands over, and
      // a waiting author with nothing unseen is all auto-publish waits for. The sidebar still shows the failure.
      assert.match(failed.stdout, /\(reviewer stopped automatic reviews after round 1\); ask the user to review it: /);
      assert.equal(codexStatus().state, 'capped');
      const again = cli(['pr', 'wait', String(number), '--timeout', '2s']);
      await until(() => server.service.authorWaiting(id), 'the author waits');
      assert.deepEqual(server.service.autoPublishChecklist(row()).filter((i) => !i.ok && i.key !== 'conflicts').map((i) => i.key), []);
      assert.equal((await again).code, 124);
      const html = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
      assert.match(html, /title="Review of [0-9a-f]{7} failed"/);
      assert.match(html, /<span class="agent-chunk">Automatic: stopped at \d+ of \d+<\/span>/);

      // The next commit still gets no automatic review: pr wait hands it to the reviewer.
      writeFileSync(join(repo, 'stop-fail.js'), 'export const fail = 2;\n');
      git('commit', '-qam', 'Change stop-fail.js');
      const handed = await handedOver(number);
      assert.match(handed, /\(reviewer stopped automatic reviews after round 1\); ask the user to review it: /);
      assert.deepEqual((await human('GET', `${base}/reviewers/codex`)).runs.map((r: any) => r.status), ['failed']);
      assert.ok(server.service.readiness(row()).reviewers.every((r) => doneForAutoPublish(r.status.state)));
    });
  } finally {
    rmSync(gate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('setting a limit by hand while iterations are stopped resumes every reviewer agent', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-then-limit');
  writeFileSync(join(repo, 'stop-limit.js'), 'export const limit = 1;\n');
  git('add', 'stop-limit.js');
  git('commit', '-qm', 'Add stop-limit.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-limit.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pull = await human('GET', base);
  const runs = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.length;
  // Codex has reviewed the head once; Claude, below its limit, has not reviewed it.
  server.service.db.insert('review_runs', { pull_id: pull.id, reviewer: 'codex', head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 1, started_at: now(), finished_at: now() });
  await withFakes({ FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has a look.', comments: [] }) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      await human('PUT', `${base}/stop-iterating`);
      await handedOver(number);
      assert.equal(await runs('claude'), 0);

      // With the author waiting, Codex's limit set to the reviews it has done ends the stop, as Resume
      // does: Claude reviews at once, and the timeline says the reviews were resumed.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '10s']);
      await until(() => server.service.authorWaiting(pull.id), 'the author waits');
      await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 1 });
      assert.equal((await human('GET', base)).iterations_stopped, null);
      const reviewed = await waiting;
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /claude-review reviewed: commented/);
      assert.deepEqual([await runs('codex'), await runs('claude')], [1, 1]);
      assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /resumed automatic reviews/);
      await server.service.claude!.settle(pull.id);
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('after a stop, the handoff and the turn say so once, also when every reviewer agent found nothing or is off', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-clean');
  writeFileSync(join(repo, 'stop-clean.js'), 'export const clean = 1;\n');
  git('add', 'stop-clean.js');
  git('commit', '-qm', 'Add stop-clean.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-clean.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pull = await human('GET', base);
  const sha = pull.head.sha.slice(0, 7);
  // Codex found nothing in the head, with reviews to spare; Claude is off.
  server.service.db.insert('review_runs', { pull_id: pull.id, reviewer: 'codex', head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 0, started_at: now(), finished_at: now() });
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
  try {
    await human('PUT', `${base}/stop-iterating`);
    const handed = await handedOver(number);
    assert.match(handed, new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}; reviewer stopped automatic reviews after round 1\\); ask the user`, 'm'));
    const { turn } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
    assert.deepEqual(turn.reasons.filter((r: string) => r.includes('stopped')), ['reviewer stopped automatic reviews after round 1']);
  } finally {
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('Stop iterating shows the round it records, also when a reviewer ahead of the others has used up its reviews', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-round');
  writeFileSync(join(repo, 'stop-round.js'), 'export const round = 1;\n');
  git('add', 'stop-round.js');
  git('commit', '-qm', 'Add stop-round.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-round.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const pull = await human('GET', base);
  // Codex has used up its two automatic reviews; Claude, with three, has done one.
  for (const reviewer of ['codex', 'codex', 'claude']) {
    server.service.db.insert('review_runs', { pull_id: pull.id, reviewer, head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 1, started_at: now(), finished_at: now() });
  }
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
  await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
  try {
    assert.match(await page(), /<strong>2 automatic review rounds so far<\/strong>[^]*>Stop iterating<\/button>/);
    assert.equal((await human('PUT', `${base}/stop-iterating`)).iterations_stopped.round, 2);
    assert.match(await page(), /<strong>Automatic reviews stopped by reviewer after round 2<\/strong>/);
  } finally {
    await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
  }
});

test('beside Stop iterating and Resume, what each reviewer agent last found, by priority, and the round running', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/last-round');
  writeFileSync(join(repo, 'last-round.js'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  git('add', 'last-round.js');
  git('commit', '-qm', 'Add last-round.js');
  const created = await cli(['pr', 'create', '--title', 'Add last-round.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  // The summary line, as text, and where its links go.
  const found = async () => {
    const line = (await page()).match(/<div class="iterations-found">([^]*?)<\/div>/)?.[1] ?? '';
    return { text: line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), links: [...line.matchAll(/href="#pullrequestreview-(\d+)"/g)].map((m) => Number(m[1])) };
  };
  const reviewId = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.at(-1).review_id;
  const comment = (line: number, priority: string | null, body: string, path = 'last-round.js') => ({ path, line, start_line: null, side: 'RIGHT', priority, body });
  // Codex finds things of every priority, one of them on a line outside the diff; Claude finds nothing.
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({
      summary: 'Codex has five things.',
      comments: [comment(1, 'high', 'One.'), comment(2, 'medium', 'Two.'), comment(3, 'medium', 'Three.'), comment(3, null, 'Four.'), comment(1, 'high', 'Five.', 'math.js')],
    }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Nothing to say.', comments: [] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      assert.deepEqual(await found(), { text: '', links: [] });
      // Codex is done and Claude is still at it: the round is running, beside what Codex found.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(async () => (await human('GET', `${base}/reviewers/codex`)).runs[0]?.status === 'done', 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      const codexReview = await reviewId('codex');
      assert.deepEqual(await found(), { text: 'Round 1 running · last round: codex-review 2 High 2 Medium 1 unprioritized', links: [codexReview] });
      assert.match(await page(), /<strong>1 automatic review round so far<\/strong><div class="iterations-found">[^]*>Stop iterating<\/button>/);

      // Claude found nothing; the round is over.
      writeFileSync(gate, '');
      assert.equal((await waiting).code, 0);
      await server.service.claude!.settle(id);
      const claudeReview = await reviewId('claude');
      const done = { text: 'Last round: codex-review 2 High 2 Medium 1 unprioritized · claude-review nothing', links: [codexReview, claudeReview] };
      assert.deepEqual(await found(), done);

      // A thread the author resolves still counts: it is what the round surfaced.
      const threads = await human('GET', `${base}/comments`);
      const high = threads.find((c: any) => c.body === 'One.');
      const resolved = await cli(['pr', 'comment', '--reply-to', String(high.id), '--resolve', '-b', 'Fixed.']);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.deepEqual(await found(), done);

      // After a stop, the Resume row says the same.
      await human('PUT', `${base}/stop-iterating`);
      assert.match(await page(), /<strong>Automatic reviews stopped by reviewer after round 1<\/strong><div class="iterations-found">[^]*>Resume<\/button>/);
      assert.deepEqual(await found(), done);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});
