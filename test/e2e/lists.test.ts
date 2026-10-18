// The lists of pull requests and repositories: tabs, pins, the repositories beside them, and a
// repository renamed on GitHub.
import '../helpers/env.ts';
import { cli, dir, human, scratchRepo, server, startHarness } from '../helpers/harness.ts';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

startHarness();

test('the list has a tab for each state: staged, published and open on GitHub, and done', async () => {
  // A repository of its own, so the tabs count only these pull requests.
  const tabs = join(dir, 'tabs');
  const tabsRemote = join(dir, 'tabs.git');
  execFileSync('git', ['init', '-q', '--bare', tabsRemote]);
  execFileSync('git', ['init', '-q', '-b', 'main', tabs]);
  const g = (...args: string[]) => execFileSync('git', ['-C', tabs, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args]);
  g('remote', 'add', 'origin', 'https://github.com/acme/tabs.git');
  g('config', `url.${tabsRemote}.pushInsteadOf`, 'https://github.com/acme/tabs.git');
  writeFileSync(join(tabs, 'a.js'), 'export {};\n');
  g('add', '.');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', 'origin', 'main');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  await human('POST', '/api/repos', { path: tabs });
  const api = '/api/repos/acme/tabs/pulls';
  /** A pull request with a commit on a branch of its own, staged by the agent. */
  const stage = async (name: string): Promise<{ id: number; number: number }> => {
    g('checkout', '-q', 'main');
    g('checkout', '-qb', name);
    writeFileSync(join(tabs, `${name}.js`), 'export {};\n');
    g('add', '.');
    g('commit', '-qm', `Add ${name}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${name}`, head: name, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const staged = await stage('staged');
  const published = await stage('published');
  const merged = await stage('merged');
  const closedOnGithub = await stage('closed-on-github');
  const closedHere = await stage('closed-here');
  for (const p of [published, merged, closedOnGithub]) await human('POST', `${api}/${p.number}/publish`, { sign: false });
  await human('PATCH', `${api}/${closedHere.number}`, { state: 'closed' });
  // What GitHub says about the published ones.
  const node = (state: string, by: string | null) => ({
    state,
    mergedAt: state === 'MERGED' ? '2026-10-16T09:00:00Z' : null,
    closedAt: state === 'OPEN' ? null : '2026-10-16T09:00:00Z',
    mergedBy: state === 'MERGED' ? { login: by } : null,
    mergeCommit: state === 'MERGED' ? { oid: 'e468a4e' + '1'.repeat(33) } : null,
    timelineItems: { nodes: by ? [{ __typename: 'ClosedEvent', actor: { login: by } }] : [] },
  });
  const repository = { [`p${published.id}`]: node('OPEN', null), [`p${merged.id}`]: node('MERGED', 'laat'), [`p${closedOnGithub.id}`]: node('CLOSED', 'octocat') };
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository } }));
  try {
    await server.service.followGithub();
  } finally {
    rmSync(join(dir, 'gh-pulls.json'), { force: true });
  }

  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** The tabs and their counts. */
  const counts = (html: string) => Object.fromEntries([...html.matchAll(/<a class="list-tab[^"]*" href="\/acme\/tabs\?state=(\w+)">[^]*?<\/svg> <span data-content="[^"]*">(\d+) /g)].map((m) => [m[1], Number(m[2])]));
  /** The pull requests a page lists, by number. */
  const listed = (html: string) => [...html.matchAll(/href="\/acme\/tabs\/pull\/(\d+)">s#\1<\/a>/g)].map((m) => Number(m[1])).sort();
  const front = await page('/acme/tabs');
  // Each pull request is in one tab; Staged is the first, and shown unless another is asked for.
  assert.deepEqual(counts(front), { staged: 1, published: 1, done: 3 });
  assert.match(front, /<a class="list-tab selected" href="\/acme\/tabs\?state=staged">/);
  // Each label carries its bold copy (data-content), so it is as wide whether selected or not and selecting a tab moves no other.
  assert.match(front, /href="\/acme\/tabs\?state=published"><svg [^>]*>[^]*?<\/svg> <span data-content="1 Published">1 Published<\/span><\/a>/);
  assert.deepEqual(listed(front), [staged.number]);
  const publishedTab = await page('/acme/tabs?state=published');
  assert.deepEqual(listed(publishedTab), [published.number]);
  const done = await page('/acme/tabs?state=done');
  assert.deepEqual(listed(done), [merged.number, closedOnGithub.number, closedHere.number].sort());
  // Done says how each ended, in the colours of the states: purple merged, red closed. Open on GitHub is green.
  // What GitHub did opens it there, with GitHub's mark; a close here opens it here.
  const row = (html: string, n: number) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/tabs/pull/${n}"`))!;
  assert.match(row(done, merged.number), /octicon-git-merge color-fg-done[^]*<a class="Label Label--merged" href="https:\/\/github\.com\/[^"]+" target="_blank" rel="noopener"><svg [^>]*octicon-mark-github[^]*?<\/svg> Merged<\/a>/);
  assert.match(row(done, closedOnGithub.number), /octicon-git-pull-request-closed color-fg-closed[^]*<a class="Label Label--closed" href="https:\/\/github\.com\/[^"]+" target="_blank" rel="noopener"><svg [^>]*octicon-mark-github[^]*?<\/svg> Closed on GitHub<\/a>/);
  assert.match(row(done, closedHere.number), new RegExp(`octicon-git-pull-request-closed color-fg-closed[^]*<a class="Label Label--closed" href="/acme/tabs/pull/${closedHere.number}">Closed</a>`));
  assert.match(row(publishedTab, published.number), /octicon-mark-github color-fg-open/);
  // A published pull request's title opens it on GitHub, and a staged one's here.
  assert.match(row(publishedTab, published.number), /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add published<\/a>/);
  assert.match(row(front, staged.number), new RegExp(`<a class="pr-row-title" href="/acme/tabs/pull/${staged.number}">Add staged</a>`));
  // The staged one waits for the reviewer: its tab says so, whichever tab is shown. The published one waits on GitHub.
  assert.match(done, /href="\/acme\/tabs\?state=staged">[^]*?>1 Staged<\/span> <span class="list-tab-turn" title="1 pull request waiting for you">/);
  assert.match(front, /<h2 class="turn-group-title">Your turn<\/h2>[^]*?href="\/acme\/tabs\/pull\/1">/);
  assert.match(publishedTab, /<h2 class="turn-group-title">Waiting on GitHub<\/h2>/);
  // Staged in a colour of its own, and said in words: staged, not asking to merge.
  const pullPage = await page(`/acme/tabs/pull/${staged.number}`);
  assert.match(pullPage, /<span class="State State--staged"><svg [^>]*octicon-git-pull-request[^>]*>[^]*?<\/svg> Staged<\/span>/);
  assert.match(pullPage, />agent<\/a><span class="Label Label--bot">bot<\/span> staged 1 commit for\s*<span class="branch-name">main<\/span>/);

  // The REST API keeps GitHub's open and closed, with the staging state as an extension.
  const rest = async (state: string) => ((await human('GET', `${api}?state=${state}`)) as any[]).map((p) => [p.number, p.state, p.staging_state]).sort();
  assert.deepEqual(await rest('open'), [[staged.number, 'open', 'staged'], [published.number, 'open', 'published']]);
  assert.deepEqual(await rest('closed'), [[merged.number, 'closed', 'done'], [closedOnGithub.number, 'closed', 'done'], [closedHere.number, 'closed', 'done']].sort());
  assert.deepEqual(await rest('staged'), [[staged.number, 'open', 'staged']]);
  assert.deepEqual(await rest('published'), [[published.number, 'open', 'published']]);
  assert.deepEqual((await rest('done')).length, 3);
  assert.deepEqual(await rest('merged'), [[merged.number, 'closed', 'done']]);
  const bad = await fetch(`${server.url}${api}?state=opened`);
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).message, /^state must be one of staged, published, done, merged, open, closed, all$/);

  // gh's JSON names the state; --state open finds the staged and the published ones, as gh finds open ones.
  const list = async (...args: string[]) => {
    const r = await cli(['pr', 'list', '-R', 'acme/tabs', '--json', 'number,state', ...args]);
    assert.equal(r.code, 0, r.stderr);
    return (JSON.parse(r.stdout) as { number: number; state: string }[]).map((p) => [p.number, p.state]).sort();
  };
  assert.deepEqual(await list(), [[staged.number, 'STAGED'], [published.number, 'PUBLISHED']]);
  assert.deepEqual(await list('--state', 'staged'), [[staged.number, 'STAGED']]);
  assert.deepEqual(await list('--state', 'done'), [[merged.number, 'MERGED'], [closedOnGithub.number, 'CLOSED'], [closedHere.number, 'CLOSED']].sort());
  assert.deepEqual(await list('--state', 'closed'), await list('--state', 'done'));
  const wrong = await cli(['pr', 'list', '-R', 'acme/tabs', '--state', 'opened']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /state must be one of staged, published, done/);
});

test("a published pull request's row opens it here by its s#N and at the publish box by an update not published, and on GitHub by its title and GitHub's number", async () => {
  const { api, stage } = await scratchRepo('row-links');
  const pr = await stage('row-links');
  await human('POST', `${api}/${pr.number}/publish`, { sign: false });
  await human('PATCH', `${api}/${pr.number}`, { body: 'Says more now.' });
  const here = `/acme/row-links/pull/${pr.number}`;
  const page = async (path: string) => (await fetch(server.url + path)).text();
  const row = (html: string) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="${here}"`));
  // The front page's and the repository's lists, in the Published tab's Your turn and in All.
  for (const path of ['/?state=published', '/?state=all', '/acme/row-links?state=published', '/acme/row-links?state=all']) {
    const r = row(await page(path));
    assert.ok(r, path);
    assert.match(r, new RegExp(`<a class="pr-row-number" href="${here}">s#${pr.number}</a> staged`), path);
    // The update is published here, so its label opens the publish box, without GitHub's mark.
    const label = r.match(/<a class="Label Label--attention"[^]*?<\/a>/)?.[0] ?? '';
    assert.match(label, new RegExp(`^<a class="Label Label--attention" href="${here}#publish"><svg [^>]*octicon-rocket[^]*?</svg> Update not published: description</a>$`), path);
    assert.doesNotMatch(label, /mark-github/, path);
    assert.match(r, /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add row-links<\/a>/, path);
    assert.match(r, /<a href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener"><svg [^>]*octicon-mark-github[^]*?<\/svg> acme\/widgets#7<\/a>/, path);
  }
  assert.match(await page('/acme/row-links?state=published'), new RegExp(`<h2 class="turn-group-title">Your turn</h2>[^]*?href="${here}"`));
  // There, the box with Publish update.
  assert.match(await page(here), /<div class="merge-box" id="publish">[^]*?<button type="submit" class="btn btn-primary btn-publish"[^>]*><svg [^]*?<\/svg> Publish update<\/button>/);
});

test('a repository renamed on GitHub takes its new name, and its old URLs lead there', async () => {
  const { fullName, api, stage, path, g } = await scratchRepo('old-name');
  assert.equal(fullName, 'acme/old-name');
  const pr = await stage('renamed');
  const events: string[] = [];
  const listen = (e: { type: string }) => events.push(e.type);
  server.service.bus.on('change', listen);
  try {
    // The remote follows the rename on GitHub; the next CLI call registers the repository again.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/new-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/new-name');
    // Open pages hear of it, and their next refresh follows the redirect.
    assert.ok(events.includes('repo_renamed'), events.join());
    // The old pages redirect, with the rest of the URL. Browsers do not keep the redirect: the name may change back.
    for (const [from, to] of [
      [`/acme/old-name/pull/${pr.number}/files?diff=split`, `/acme/new-name/pull/${pr.number}/files?diff=split`],
      ['/acme/old-name', '/acme/new-name'],
    ]) {
      const res = await fetch(server.url + from, { redirect: 'manual' });
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get('location'), to);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.match(await (await fetch(`${server.url}/acme/old-name/pull/${pr.number}`)).text(), new RegExp(`<title>Add renamed by agent · Pull Request s#${pr.number} · acme/new-name</title>`));
    // The API answers at the old paths, for pages opened before and for scripts, in the new name.
    assert.equal((await human('GET', `${api}/${pr.number}`)).html_url, `${server.url}/acme/new-name/pull/${pr.number}`);
    await human('POST', `/api/repos/acme/old-name/issues/${pr.number}/comments`, { body: 'Still reachable' });
    assert.equal((await human('GET', `/api/repos/acme/new-name/issues/${pr.number}/comments`)).at(-1).body, 'Still reachable');

    // Renamed again while nothing registers it: the server follows the remote when it starts.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/third-name.git');
    await server.service.followRemotes();
    const keys = () => server.service.repos().map((r) => `${r.owner}/${r.name}`);
    assert.ok(keys().includes('acme/third-name'), keys().join());
    for (const old of ['acme/old-name', 'acme/new-name']) assert.equal((await human('GET', `/api/repos/${old}`)).full_name, 'acme/third-name');

    // Back to the first name: it is the repository's own again, and the others lead to it.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/old-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/old-name');
    assert.equal((await fetch(`${server.url}/acme/old-name/pull/${pr.number}`, { redirect: 'manual' })).status, 200);
    assert.equal((await fetch(`${server.url}/acme/third-name`, { redirect: 'manual' })).headers.get('location'), '/acme/old-name');

    // A repository that has a name another had before takes it; the other keeps its own.
    const other = await scratchRepo('third-name');
    assert.equal(other.fullName, 'acme/third-name');
    assert.equal((await fetch(`${server.url}/acme/third-name`, { redirect: 'manual' })).status, 200);
    // Renamed to one another repository has, it is numbered as when it was registered.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/third-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/third-name-2');
    assert.equal((await human('GET', '/api/repos/acme/third-name')).full_name, 'acme/third-name');

    // Registered before names followed GitHub, with the new one recorded but not taken: it takes it when the server starts.
    const id = server.service.repos().find((r) => r.name === 'third-name-2')!.id;
    server.service.db.update('repos', id, { name: 'from-before' });
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/from-before')).full_name, 'acme/third-name-2');

    // A number stays when the repository it made way for moves on, whose old name leads to it still.
    const twin = await scratchRepo('twin');
    const clone = await scratchRepo('twin-clone', { github: false });
    clone.g('remote', 'add', 'origin', 'https://github.com/acme/twin.git');
    assert.equal((await human('POST', '/api/repos', { path: clone.path })).full_name, 'acme/twin-2');
    twin.g('remote', 'set-url', 'origin', 'https://github.com/acme/twin-renamed.git');
    assert.equal((await human('POST', '/api/repos', { path: twin.path })).full_name, 'acme/twin-renamed');
    assert.equal((await human('POST', '/api/repos', { path: clone.path })).full_name, 'acme/twin-2');
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/twin-2')).full_name, 'acme/twin-2');
    assert.equal((await fetch(`${server.url}/acme/twin`, { redirect: 'manual' })).headers.get('location'), '/acme/twin-renamed');

    // A name that ends in digits is not numbered: renamed to the name without them, it follows.
    const dated = await scratchRepo('project-2');
    dated.g('remote', 'set-url', 'origin', 'https://github.com/acme/project.git');
    assert.equal((await human('POST', '/api/repos', { path: dated.path })).full_name, 'acme/project');

    // Renamed so before names followed GitHub, with the new name recorded but not taken: it takes it when the server starts.
    const legacy = await scratchRepo('legacy-2025');
    legacy.g('remote', 'set-url', 'origin', 'https://github.com/acme/legacy.git');
    server.service.db.run("UPDATE repos SET github_slug = 'acme/legacy' WHERE owner = 'acme' AND name = 'legacy-2025'");
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/legacy-2025')).full_name, 'acme/legacy');

    // At start, the server picks the remote as registering does: here a GitHub one added to a local repository, not called origin.
    const upstream = await scratchRepo('upstream-only', { github: false });
    assert.equal(upstream.fullName, 'local/upstream-only');
    upstream.g('remote', 'add', 'upstream', 'https://github.com/acme/upstream-only.git');
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/local/upstream-only')).full_name, 'acme/upstream-only');
  } finally {
    server.service.bus.off('change', listen);
  }
});

test('the reviewer pins pull requests to the top of the front page, until they unpin them', async () => {
  const { api, stage } = await scratchRepo('pins');
  const [a, b, c] = [await stage('pin-a'), await stage('pin-b'), await stage('pin-c')];
  const page = async (path: string) => (await fetch(server.url + path)).text();
  const titles = (html: string) => [...html.matchAll(/<a class="pr-row-title" href="\/acme\/pins\/pull\/(\d+)">/g)].map((m) => Number(m[1]));
  /** The front page's Pinned section, and the list under it. */
  const front = async (path = '/') => {
    const [top, list] = (await page(path)).split('<div class="Box pr-list"');
    return { pinned: titles(top.split('<div class="Box pinned-list">')[1] ?? ''), list: titles(list) };
  };
  /** What open pages hear of pinning. */
  const events: string[] = [];
  const listen = (e: { pullId: number | null; type: string }) => e.type.endsWith('pinned') && events.push(`${e.type} ${e.pullId}`);
  server.service.bus.on('change', listen);
  try {
    // The front page is the reviewer's: agents can not pin, or unpin.
    for (const method of ['PUT', 'DELETE']) {
      const res = await fetch(`${server.url}${api}/${a.number}/pinned`, { method, headers: { 'x-galley-actor': 'agent' } });
      assert.equal(res.status, 403);
      assert.match((await res.json()).message, /only the user can pin/);
    }

    const updated = (await human('GET', `${api}/${a.number}`)).updated_at;
    // Pinned in the same millisecond, the later pin is still the newer.
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await human('PUT', `${api}/${a.number}/pinned`);
      await human('PUT', `${api}/${c.number}/pinned`);
    } finally {
      mock.timers.reset();
    }
    // Pinned again, it keeps its place: no news.
    await human('PUT', `${api}/${a.number}/pinned`);
    assert.deepEqual(events, [`pinned ${a.id}`, `pinned ${c.id}`]);
    const rest = await human('GET', `${api}/${a.number}`);
    // Pinning is not activity.
    assert.equal(rest.updated_at, updated);
    assert.ok(rest.pinned_at < (await human('GET', `${api}/${c.number}`)).pinned_at);
    assert.equal((await human('GET', `${api}/${b.number}`)).pinned_at, null);
    for (const [n, isPinned] of [[a.number, true], [b.number, false]] as const) {
      const view = await cli(['pr', 'view', String(n), '-R', 'acme/pins', '--json', 'isPinned']);
      assert.equal(view.code, 0, view.stderr);
      assert.deepEqual(JSON.parse(view.stdout), { isPinned });
    }

    // At the top of the front page, most recently pinned first, and not again under the tabs.
    let shown = await front();
    assert.deepEqual(shown, { pinned: [c.number, a.number], list: [b.number] });
    assert.match(await page('/'), /<div class="Box-header turn-group">[^]*?<h2 class="turn-group-title">Pinned<\/h2> <span class="Counter">2<\/span> <span class="turn-group-note">most recently pinned first<\/span>/);
    // With their turn, as elsewhere.
    assert.match((await page('/')).split('<div class="Box pr-list"')[0], /<span class="turn-reason" title="agent is not waiting">agent not waiting/);
    // A repository's list has them in their place, with a pin.
    const list = await page('/acme/pins');
    assert.doesNotMatch(list, /pinned-list/);
    const row = (html: string, n: number) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/pins/pull/${n}"`))!;
    for (const n of [a.number, c.number]) assert.match(row(list, n), /<span class="pin-mark" title="Pinned to the top of the front page"><svg class="octicon octicon-pin-fill" [^>]*aria-label="Pinned"/);
    assert.doesNotMatch(row(list, b.number), /pin-mark/);
    // The pull request's pin is filled while it is pinned, and unpins.
    assert.match(await page(`/acme/pins/pull/${a.number}`), new RegExp(`<button type="button" class="btn btn-sm btn-pin js-pin selected" data-api="${api}/${a.number}/pinned" data-method="DELETE" title="Unpin" aria-label="Unpin" aria-pressed="true"><svg class="octicon octicon-pin-fill"`));
    assert.match(await page(`/acme/pins/pull/${b.number}`), new RegExp(`<button type="button" class="btn btn-sm btn-pin js-pin" data-api="${api}/${b.number}/pinned" data-method="PUT" title="Pin to the top of the front page" aria-label="Pin to the top of the front page" aria-pressed="false"><svg class="octicon octicon-pin"`));

    // Pinned through publishing, the merge, and a close here.
    await human('POST', `${api}/${a.number}/publish`, { sign: false });
    const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '1'.repeat(33) }, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'laat' } }] } };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${a.id}`]: merged } } }));
    try {
      await server.service.followGithub();
    } finally {
      rmSync(join(dir, 'gh-pulls.json'), { force: true });
    }
    await human('PATCH', `${api}/${c.number}`, { state: 'closed' });
    const done = await human('GET', `${api}/${a.number}`);
    assert.deepEqual([done.github_state, done.pinned_at], ['merged', rest.pinned_at]);
    for (const path of ['/', '/?state=done', '/?state=published']) {
      shown = await front(path);
      assert.deepEqual(shown.pinned, [c.number, a.number], path);
      assert.ok(!shown.list.includes(a.number) && !shown.list.includes(c.number), path);
    }
    assert.match((await page('/')).split('<div class="Box pr-list"')[0], /<a class="Label Label--merged" href="https:\/\/github\.com\/[^"]+" target="_blank" rel="noopener"><svg [^>]*octicon-mark-github[^]*?<\/svg> Merged<\/a>/);

    // Unpinned, it is back in its tab.
    await human('DELETE', `${api}/${a.number}/pinned`);
    await human('DELETE', `${api}/${a.number}/pinned`);
    assert.equal((await human('GET', `${api}/${a.number}`)).pinned_at, null);
    assert.deepEqual(await front('/?state=done'), { pinned: [c.number], list: [a.number] });
    await human('DELETE', `${api}/${c.number}/pinned`);
    assert.doesNotMatch(await page('/'), /pinned-list/);
    assert.deepEqual(events, [`pinned ${a.id}`, `pinned ${c.id}`, `unpinned ${a.id}`, `unpinned ${c.id}`]);
  } finally {
    server.service.bus.off('change', listen);
  }
});

test('the front page and a repository\'s list the repositories with pull requests, latest activity first, with your turn in each', async () => {
  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** The repositories beside the list: name, link, avatar, how many are your turn, whether shown, and which is selected. */
  const sidebar = async (path = '/') => {
    const html = await page(path);
    const aside = html.match(/<div class="container container-full dashboard"><aside class="dashboard-sidebar"[^]*?<\/aside>/)?.[0] ?? '';
    const all = [...aside.matchAll(/<li class="repo-list-item( selected)?" data-name="([^"]+)"( hidden)?>\s*<img class="avatar " src="([^"]+)"[^>]*>\s*<a class="repo-list-name" href="([^"]+)" title="[^"]+"( aria-current="page")?>[^<]*<\/a>\s*(?:<span class="list-tab-turn" title="([^"]+)">[^]*?<\/svg> (\d+)<\/span>)?/g)];
    const selected = all.filter((m) => m[1] && m[6]).map((m) => m[2]);
    const repos = all.map((m) => ({
      name: m[2],
      shown: !m[3],
      avatar: m[4],
      href: m[5],
      turn: m[8] ? Number(m[8]) : 0,
      title: m[7],
    }));
    return { aside, repos, selected };
  };
  const north = await scratchRepo('north');
  const south = await scratchRepo('south');
  const local = await scratchRepo('sidebar-local', { github: false });
  const n1 = await north.stage('n1');
  await south.stage('s1');
  await south.stage('s2');
  const s3 = await south.stage('s3');
  // Closed: not your turn, but activity.
  await human('PATCH', `${south.api}/${s3.number}`, { state: 'closed' });
  await local.stage('l1');

  let { repos } = await sidebar();
  const mine = (names: string[]) => repos.filter((r) => names.includes(r.name));
  // Latest activity first, each with how many are your turn; a link to the repository, and the owner's avatar.
  assert.deepEqual(mine([local.fullName, south.fullName, north.fullName]), [
    { name: local.fullName, shown: true, avatar: '/avatars/local.svg', href: `/${local.fullName}`, turn: 1, title: '1 pull request waiting for you' },
    { name: 'acme/south', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/south', turn: 2, title: '2 pull requests waiting for you' },
    { name: 'acme/north', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/north', turn: 1, title: '1 pull request waiting for you' },
  ]);
  assert.equal(repos[0].name, local.fullName);
  // A GitHub owner's avatar falls back to the generated one; a generated one needs none.
  assert.match((await sidebar()).aside, /src="https:\/\/github\.com\/acme\.png\?size=40" data-fallback="\/avatars\/acme\.svg"/);
  // A comment is activity; a repository with nothing for you has no count.
  await human('POST', `/api/repos/acme/north/issues/${n1.number}/comments`, { body: 'Moving.' });
  await human('PATCH', `${north.api}/${n1.number}`, { state: 'closed' });
  ({ repos } = await sidebar('/?state=done'));
  assert.deepEqual(repos[0], { name: 'acme/north', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/north', turn: 0, title: undefined });
  // A repository's page has the same, with that one selected; the front page has none selected.
  const front = await sidebar('/');
  assert.doesNotMatch(front.aside, /selected|aria-current/);
  const onNorth = await sidebar('/acme/north');
  assert.deepEqual(onNorth.repos, front.repos);
  assert.deepEqual(onNorth.selected, ['acme/north']);
  // A repository without pull requests has the same, with none selected.
  const empty = await scratchRepo('sidebar-empty');
  const onEmpty = await sidebar(`/${empty.fullName}`);
  assert.deepEqual(onEmpty.repos, front.repos);
  assert.deepEqual(onEmpty.selected, []);

  // Ten at most, then a filter and "Show more".
  for (let i = repos.length; i < 10; i++) await (await scratchRepo(`more-${i}`)).stage('more');
  let { aside } = await sidebar();
  ({ repos } = await sidebar());
  assert.equal(repos.length, 10);
  assert.doesNotMatch(aside, /js-repo-filter|js-repo-more/);
  await (await scratchRepo('eleventh')).stage('more');
  ({ aside, repos } = await sidebar());
  assert.equal(repos.length, 11);
  assert.deepEqual(repos.map((r) => r.shown), [...Array(10).fill(true), false]);
  assert.equal(repos[0].name, 'acme/eleventh');
  assert.match(aside, /<input type="search" class="form-control repo-filter js-repo-filter" placeholder="Find a repository…"/);
  assert.match(aside, /<ul class="repo-list js-repo-list" data-shown="10">/);
  assert.match(aside, /<button type="button" class="btn-link repo-list-more js-repo-more">Show more<\/button>/);
  // One past the first ten is shown on its page in place of the tenth, so as many are shown.
  const past = await sidebar(`/${repos[10].name}`);
  assert.deepEqual(past.selected, [repos[10].name]);
  assert.deepEqual(past.repos.map((r) => r.shown), [...Array(9).fill(true), false, true]);
  assert.match(past.aside, /js-repo-more/);
});
