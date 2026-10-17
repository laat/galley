import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown } from '../src/server/web/markdown.ts';
import { closingIssues, pullReferences, type ReferenceContext } from '../src/server/web/references.ts';
import { issueSummary, type Ctx, type Service } from '../src/server/service.ts';
import { Repo, type Commit } from '../src/server/git.ts';
import type { PullRow, RepoRow } from '../src/server/db.ts';

const OWN = 'abc1234def5678abc1234def5678abc1234def56';
const refs: ReferenceContext = {
  slug: 'acme/widgets',
  commits: new Map([
    ['abc1234', { href: `/acme/widgets/pull/3/files?commit=${OWN}`, title: 'Add mul' }],
    ['9f8e7d6c5b4a', { href: 'https://github.com/acme/widgets/commit/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432' }],
  ]),
  issue: (slug, n) => (slug === 'acme/widgets' && n === 12 ? { title: 'Widgets <wobble>', state: 'Open issue' } : null),
};
const md = (text: string, references: ReferenceContext | undefined = refs) => renderMarkdown(text, { references }).trim();
const issueLink = (href: string, text: string, title = '') => `<a class="issue-link" href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;

test('#N and GH-N link to the issue or pull request on GitHub, with its title when known', () => {
  assert.equal(md('Fixes #12.'), `<p>Fixes ${issueLink('https://github.com/acme/widgets/issues/12', '#12', 'Widgets &lt;wobble&gt; · Open issue')}.</p>`);
  assert.equal(md('(GH-5)'), `<p>(${issueLink('https://github.com/acme/widgets/issues/5', 'GH-5')})</p>`);
  assert.equal(md('**#7**, - #8'), `<p><strong>${issueLink('https://github.com/acme/widgets/issues/7', '#7')}</strong>, - ${issueLink('https://github.com/acme/widgets/issues/8', '#8')}</p>`);
  assert.match(md('- #9\n\n| a |\n|---|\n| #10 |'), /<li><a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/9"[^]*<td><a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/10"/);
});

test('owner/repo#N links to that repository', () => {
  assert.equal(md('See laat/stage-pr#16 and my.org-x/re_po.js#3'), `<p>See ${issueLink('https://github.com/laat/stage-pr/issues/16', 'laat/stage-pr#16')} and my.org-x/re_po.js#3</p>`);
  assert.equal(md('see other-org/re_po.js#3'), `<p>see ${issueLink('https://github.com/other-org/re_po.js/issues/3', 'other-org/re_po.js#3')}</p>`);
});

test('@user links to the profile on GitHub', () => {
  const mention = (login: string) => `<a class="user-mention" href="https://github.com/${login}" target="_blank" rel="noopener noreferrer">@${login}</a>`;
  assert.equal(md('cc @laat and @foo-bar.'), `<p>cc ${mention('laat')} and ${mention('foo-bar')}.</p>`);
  // npm scopes, decorators and addresses are not mentions.
  assert.equal(md('@types/node, @example.com and x@laat'), '<p>@types/node, @example.com and x@laat</p>');
});

test('commit SHAs the context knows link to their commit, shown short', () => {
  assert.equal(
    md('Done in abc1234, see 9f8e7d6c5b4a.'),
    `<p>Done in <a class="commit-link" href="/acme/widgets/pull/3/files?commit=${OWN}" title="Add mul"><code>abc1234</code></a>, see <a class="commit-link" href="https://github.com/acme/widgets/commit/9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" target="_blank" rel="noopener noreferrer"><code>9f8e7d6</code></a>.</p>`,
  );
  // Hex words that name no commit, and SHAs inside other words, stay text.
  assert.equal(md('deadbeef 1234567 abc1234.js abc12345 gabc1234 abc1234-dirty'), '<p>deadbeef 1234567 abc1234.js abc12345 gabc1234 abc1234-dirty</p>');
});

test('no links inside code, links, URLs, email addresses or words', () => {
  assert.equal(md('`#12 @laat abc1234`'), '<p><code>#12 @laat abc1234</code></p>');
  assert.equal(md('```\n#12 @laat abc1234\n```'), '<pre><code class="hljs">#12 @laat abc1234</code></pre>');
  assert.equal(md('    #12 @laat abc1234'), '<pre><code class="hljs">#12 @laat abc1234</code></pre>');
  assert.equal(md('[#12 @laat abc1234](https://example.com)'), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">#12 @laat abc1234</a></p>');
  assert.equal(md('<a href="/x">#12 @laat abc1234</a>'), '<p><a href="/x">#12 @laat abc1234</a></p>');
  assert.equal(
    md('https://github.com/acme/widgets/pull/1#issuecomment-12 and https://example.com/@laat/abc1234'),
    '<p><a href="https://github.com/acme/widgets/pull/1#issuecomment-12" target="_blank" rel="noopener noreferrer">https://github.com/acme/widgets/pull/1#issuecomment-12</a> and <a href="https://example.com/@laat/abc1234" target="_blank" rel="noopener noreferrer">https://example.com/@laat/abc1234</a></p>',
  );
  assert.equal(md('user@example.com'), '<p><a href="mailto:user@example.com">user@example.com</a></p>');
  assert.equal(md('foo#12 a.b/c#1 #12abc #1.5 #12-x #0 \\#12'), '<p>foo#12 a.b/c#1 #12abc #1.5 #12-x #0 #12</p>');
});

test('no links inside HTML anchors, however their tags are written', () => {
  // Marked itself only knows "<a " and "</a>".
  assert.equal(md('<a\nhref="/x">#12 @laat abc1234</a> <a\thref="/y">#12</a>'), '<p><a href="/x">#12 @laat abc1234</a> <a href="/y">#12</a></p>');
  assert.equal(md('<a href="/x">#12</a > #5'), `<p><a href="/x">#12</a> ${issueLink('https://github.com/acme/widgets/issues/5', '#5')}</p>`);
});

test('no links inside HTML code, kbd or pre, and they close no issues', () => {
  assert.equal(md('x <code>#12 @laat abc1234</code> <kbd>#12</kbd> <code\nclass="x">#12</code>'), '<p>x <code>#12 @laat abc1234</code> <kbd>#12</kbd> <code>#12</code></p>');
  assert.doesNotMatch(md('x <pre>#12 @laat abc1234</pre>'), /<a /);
  assert.deepEqual(closingIssues('<code>fixes #12</code>, and fixes <code>#13</code>', refs), []);
});

test('no links inside nested HTML code, kbd or pre, and they close no issues', () => {
  // Leaving the inner element does not leave the outer one.
  assert.equal(md('x <kbd><code>#12</code> or #13</kbd> #5'), `<p>x <kbd><code>#12</code> or #13</kbd> ${issueLink('https://github.com/acme/widgets/issues/5', '#5')}</p>`);
  assert.deepEqual(closingIssues('x <kbd>fixes <code>#12</code>, fixes #13</kbd>', refs), []);
});

test('email addresses and bare URLs stay whole, as marked links them without references', () => {
  for (const text of [
    'mail first+deadbeef@example.com',
    'ask first+abc1234@example.com',
    'mail a+@laat.com',
    // References in the middle of an address, which on their own would end cleanly.
    'mail first+GH-1+u@example.com',
    'mail first+abc1234+u@example.com',
    'see https://x.test/a#12, www.x.test/@laat, https://x.test/?q=1&r=#12 and https://x.test/+abc1234',
    // References that would take the start of a URL.
    'see @https://x.test/a and o/www.x.test#1',
  ]) {
    assert.equal(md(text), renderMarkdown(text).trim(), text);
  }
  assert.equal(md('mail first+deadbeef@example.com'), '<p>mail <a href="mailto:first+deadbeef@example.com">first+deadbeef@example.com</a></p>');
});

test('a reference that starts an email address is left to the address', () => {
  // abc1234 is a commit, #12 and GH-1 issues and @laat a user, but here each begins an address.
  for (const text of ['mail abc1234+user@example.com', 'mail #12+u@example.com', 'mail GH-1+u@example.com', 'mail @laat+u@example.com', 'mail abc1234.x@example.com']) {
    assert.equal(md(text), renderMarkdown(text).trim(), text);
  }
  assert.equal(md('mail abc1234+user@example.com'), '<p>mail <a href="mailto:abc1234+user@example.com">abc1234+user@example.com</a></p>');
  // Not followed by an address, they still link.
  assert.match(md('abc1234+1 and #12+1'), /^<p><a class="commit-link"[^]*\+1 and <a class="issue-link"[^]*\+1<\/p>$/);
});

// The oracle for everything above: references only wrap text in links. Without those links (keeping
// their text), the HTML is what marked renders without references.
const oracleRefs: ReferenceContext = { ...refs, commits: new Map([['abc1234', { href: '/c' }], ['deadbee', { href: '/d' }]]) };
const unlinked = (html: string) => html.replace(/<a class="(?:issue-link|user-mention)" [^>]*>(.*?)<\/a>|<a class="commit-link" [^>]*><code>(.*?)<\/code><\/a>/g, '$1$2');
function onlyAddsLinks(text: string, references = oracleRefs): void {
  assert.equal(unlinked(renderMarkdown(text, { references })), renderMarkdown(text), JSON.stringify(text));
}

test('a reference next to emphasis delimiters leaves the emphasis to marked', () => {
  // marked links the URL with its "*/", and reads none of the stars as emphasis.
  assert.equal(md('See #12*/https://example.com/path*/'), `<p>See ${issueLink('https://github.com/acme/widgets/issues/12', '#12', 'Widgets &lt;wobble&gt; · Open issue')}*/<a href="https://example.com/path*/" target="_blank" rel="noopener noreferrer">https://example.com/path*/</a></p>`);
  assert.doesNotMatch(md('#12**: done**'), /<strong>/);
  for (const text of ['See #12*/https://example.com/path*/', '#12**: done**', '#12*x*', 'abc1234_x_ and _abc1234_', '@laat~~x~~', '**#12**: done', 'x**#12**']) onlyAddsLinks(text);
});

test('mailto: and xmpp: autolinks stay whole', () => {
  // No mention of @mailto or @xmpp: what follows the "@" is marked's link.
  for (const text of ['@mailto:user@example.com', '@xmpp:user@example.com/home', '#12mailto:user@example.com']) {
    assert.equal(md(text), renderMarkdown(text).trim(), text);
  }
  onlyAddsLinks('GH-1 xmpp:abc1234@example.com and mailto:abc1234+1@example.com');
});

test('references only add links to what marked renders, in random texts', () => {
  const pieces = [
    'a', 'x', '1', '12', ' ', ' ', ' ', '\n', '\n\n', '- ', '> ', '1. ', '# ', '| a | b |\n|---|---|\n| ', '```\n', '    ',
    '*', '**', '_', '__', '~', '~~', '`', '``', '\\', '\\#', '<', '>', '[', ']', '(', ')', '[l](u)', '![i](u)', '[l]: u', '<u@x.co>',
    '@', '@laat', '#', '#12', '#1', 'GH-1', 'o/r#3', 's#5', 'abc1234', 'deadbee', 'deadbeef', '0123456789abcdef0123',
    'mailto:', 'mailto:u@x.co', 'xmpp:', 'xmpp:u@x.co/r', 'http://', 'https://x.test/', 'HTTP://X.test', 'www.', 'www.x.test', 'ftp://f.x',
    'u@x.co', 'first+abc1234@example.com', 'e.com', '+', '.', '-', '/', ':', ',', '!', '?', '&', '&amp;', '&#35;', '&#x23;', '&#12;',
    '<code>', '</code>', '<kbd>', '</kbd>', '<pre>', '</pre>', '<a href="/z">', '<a\nhref="/z">', '</a>', '</a >', '<b>', '</b>', '<!-- c -->',
  ];
  let seed = 16;
  const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let i = 0; i < 3000; i++) onlyAddsLinks(Array.from({ length: 1 + random(24) }, () => pieces[random(pieces.length)]).join(''));
});

// The quadratic first version took 28 s for 5,000 characters; a linear one takes milliseconds,
// so the limit is generous enough for a slow or busy machine.
test('rendering stays linear: 20,000 characters of adversarial text take under 2 seconds', () => {
  const n = 20_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const inputs = [
    'x ' + 'a'.repeat(n) + ' #12', // one long word of hex letters
    fill('0123456789abcdef'), // one long run of hex
    fill('deadbeef cafe123 abc1234 '), // hex words, one of them a commit
    fill('0123456789abcdef0123456789abcdef01234567 '), // 40-character hex words
    'x ' + fill('+GH-1'), // references chained into one run of email characters
    'x ' + fill('+abc1234'),
    'x+' + 'a'.repeat(n) + '@example.com', // one long address
    fill('a@b@'),
    fill('#'),
    fill('@'),
    fill('x! ') + ' #12', // marked's text stops at every "!", and the next reference is far away
  ];
  renderMarkdown('warm up #1 @laat abc1234', { references: refs });
  for (const text of inputs) {
    for (const references of [undefined, refs]) {
      const started = performance.now();
      renderMarkdown(text, { references });
      const ms = performance.now() - started;
      assert.ok(ms < 2000, `${ms.toFixed(0)} ms for ${JSON.stringify(text.slice(0, 24))}…${references ? ' with references' : ''}`);
    }
  }
});

test('#N links only where GitHub links it, so staged pull requests (s#5) stay text', () => {
  // Not right after a letter or digit: no link, and no part of it linked either.
  assert.equal(md('s#5, x#5, abc#12, 1#5 and s#12'), '<p>s#5, x#5, abc#12, 1#5 and s#12</p>');
  assert.deepEqual(closingIssues('Fixes s#5', refs), []);
  // At the start, after whitespace or after punctuation it links.
  const twelve = issueLink('https://github.com/acme/widgets/issues/12', '#12', 'Widgets &lt;wobble&gt; · Open issue');
  assert.equal(md('#12 (#12), #12'), `<p>${twelve} (${twelve}), ${twelve}</p>`);
});

test('without a GitHub remote, issue references and mentions stay text; commits still link', () => {
  const local = { ...refs, slug: null };
  assert.equal(md('Fixes #12, GH-5, laat/stage-pr#16 and @laat.', local), '<p>Fixes #12, GH-5, laat/stage-pr#16 and @laat.</p>');
  assert.match(md('Done in abc1234.', local), /<a class="commit-link" href="\/acme\/widgets\/pull\/3\/files\?commit=/);
  // Without a context (as before), nothing links.
  assert.equal(renderMarkdown('Fixes #12 @laat abc1234').trim(), '<p>Fixes #12 @laat abc1234</p>');
});

test('closing keywords: the issues merging closes', () => {
  const closes = closingIssues('Fixes #12. Closes: laat/stage-pr#16, resolved #4\n\nfixes `#5`, see #6, fixes #12 again, prefixes #7', refs);
  assert.deepEqual(
    closes.map((c) => [c.text, c.href, c.title]),
    [
      ['#12', 'https://github.com/acme/widgets/issues/12', 'Widgets <wobble> · Open issue'],
      ['laat/stage-pr#16', 'https://github.com/laat/stage-pr/issues/16', undefined],
      ['#4', 'https://github.com/acme/widgets/issues/4', undefined],
    ],
  );
  assert.deepEqual(closingIssues('Fixes #12', { ...refs, slug: null }), []);
});

test('issue summaries say what GitHub would show', () => {
  assert.deepEqual(issueSummary({ __typename: 'Issue', title: 'T', state: 'OPEN' }), { title: 'T', state: 'Open issue' });
  assert.deepEqual(issueSummary({ __typename: 'Issue', title: 'T', state: 'CLOSED', stateReason: 'NOT_PLANNED' }), { title: 'T', state: 'Closed as not planned' });
  assert.deepEqual(issueSummary({ __typename: 'PullRequest', title: 'T', state: 'OPEN', isDraft: true }), { title: 'T', state: 'Draft pull request' });
  assert.deepEqual(issueSummary({ __typename: 'PullRequest', title: 'T', state: 'MERGED' }), { title: 'T', state: 'Merged pull request' });
  assert.equal(issueSummary(null), null);
});

const PLAIN_NOTE = '<p class="color-fg-muted"><em>Shown as plain text: too many emphasis markers (*, _ or ~) to render as Markdown.</em></p>\n';

test('Markdown full of emphasis markers is shown as plain text, well under a second', () => {
  // marked scans the rest of the paragraph for each of them: before, 50,000 characters of "*a " took 16 s.
  const n = 50_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  // marked takes "_" after a letter outside the Basic Multilingual Plane for one starting a word.
  for (const unit of ['*a ', '_a ', '~a ', '**a ', '*a\n', `${'*'.repeat(100)}a `, '𝒜_a ']) {
    const text = `Fixes #12 & <b>x</b>\n\n${fill(unit)}`;
    const started = performance.now();
    const rendered = renderMarkdown(text, { references: refs });
    const closes = closingIssues(text, refs);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${JSON.stringify(unit)}`);
    assert.equal(rendered, `${PLAIN_NOTE}<pre class="markdown-text">Fixes #12 &amp; &lt;b&gt;x&lt;/b&gt;\n\n${fill(unit)}</pre>\n`);
    // Without marked, references in code can't be told from the rest: none is said to close.
    assert.deepEqual(closes, []);
  }
  assert.deepEqual(closingIssues(`${'*a '.repeat(1001)}\n\n\`\`\`\nFixes #12\n\`\`\``, refs), []);
});

test('the most emphasis markers still rendered as Markdown take well under a second', () => {
  // 1,000 characters of them in one paragraph, in runs of one, two and a hundred. marked scans again for
  // each character of a run it finds no closer for.
  for (const text of ['*a '.repeat(1000), '_a '.repeat(1000), '~a '.repeat(1000), '**a '.repeat(500), `${'*'.repeat(100)}a `.repeat(10), '𝒜_a '.repeat(1000)]) {
    const started = performance.now();
    const rendered = renderMarkdown(text);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${JSON.stringify(text.slice(0, 12))}…`);
    assert.ok(!rendered.startsWith(PLAIN_NOTE), JSON.stringify(text.slice(0, 12)));
    assert.ok(renderMarkdown(`${text}*a`).startsWith(PLAIN_NOTE), JSON.stringify(text.slice(0, 12)));
  }
});

test('a long comment with emphasis in every paragraph and a long log still renders as Markdown', () => {
  // Far more markers than one paragraph may have, but in many paragraphs, table cells, and a code block.
  const section = (i: number) =>
    `## Step ${i}\n\nRan **the tests** in _src_, ~~one~~ none skipped.\n\n- **unit**: *passed*\n- **e2e**: *passed*\n\n| **a** | ***b*** |\n|---|---|\n| _c_ | ~~d~~ |\n\n***\n\n`;
  const log = Array(5000).fill('ok src/**/*.ts __init__ *ptr ~/x _y').join('\n');
  const rendered = renderMarkdown(`${Array.from({ length: 500 }, (_, i) => section(i)).join('')}\`\`\`\n${log}\n\`\`\`\n`);
  assert.equal(rendered.match(/<h2>/g)?.length, 500);
  assert.equal(rendered.match(/<table>/g)?.length, 500);
  assert.equal(rendered.match(/<hr \/>/g)?.length, 500);
  assert.equal(rendered.match(/<strong>/g)?.length, 2500);
  assert.equal(rendered.match(/<em>/g)?.length, 2500);
  assert.equal(rendered.match(/<del>/g)?.length, 1000);
  assert.ok(rendered.includes(`<pre><code class="hljs">${log}</code></pre>`));
});

// ------------------------------------------------------- SHAs in a repository

const dir = mkdtempSync(join(tmpdir(), 'laatsux-markdown-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function gitIn(cwd: string, args: string[], input?: string): string {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, input }).trim();
}
const git = (...args: string[]) => gitIn(dir, args);
const s = { githubIssue: () => null } as unknown as Service;
const pullIn = (gitDir: string, slug: string | null): Ctx => ({
  repo: { owner: 'acme', name: 'widgets', github_slug: slug, remote: 'origin' } as RepoRow,
  pull: { number: 3 } as PullRow,
  git: new Repo(gitDir),
});

test('a hex word is a SHA when it names a commit: the pull request\'s link here, pushed ones to GitHub', async () => {
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'Base');
  const pushed = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', pushed);
  git('commit', '-q', '--allow-empty', '-m', 'Replaced by a later push');
  const replaced = git('rev-parse', 'HEAD');
  git('commit', '-q', '--amend', '--allow-empty', '-m', 'Add mul', '-m', 'Details.');
  const own = git('rev-parse', 'HEAD');
  const blob = git('rev-parse', 'HEAD:a.txt');

  const ctx = pullIn(join(dir, '.git'), 'acme/widgets');
  const commits = [{ sha: own, message: 'Add mul\n\nDetails.' } as Commit];
  const text = `In ${own.slice(0, 7)} (${own}), on ${pushed.slice(0, 10)}, after ${replaced.slice(0, 8)}; not ${blob.slice(0, 7)}, deadbeef or 1234567.`;
  const view = (sha: string) => `/acme/widgets/pull/3/files?commit=${sha}`;

  const r = await pullReferences(s, ctx, commits, [text]);
  assert.deepEqual(
    [...r.commits].sort(),
    [
      [own.slice(0, 7), { href: view(own), title: 'Add mul' }],
      [own, { href: view(own), title: 'Add mul' }],
      [pushed.slice(0, 10), { href: `https://github.com/acme/widgets/commit/${pushed}` }],
      // Never on GitHub: its view here is the one that works.
      [replaced.slice(0, 8), { href: view(replaced) }],
    ].sort(),
  );
  assert.match(md(text, r), new RegExp(`after <a class="commit-link" href="${view(replaced).replace('?', '\\?')}"><code>${replaced.slice(0, 7)}</code></a>`));

  // Without a GitHub remote every commit links here.
  const local = await pullReferences(s, pullIn(join(dir, '.git'), null), commits, [text]);
  assert.deepEqual(local.commits.get(pushed.slice(0, 10)), { href: view(pushed) });
});

test('an abbreviation two commits share is no SHA, even when one of them is the pull request\'s', async () => {
  const twins = join(dir, 'twins');
  gitIn(dir, ['init', '-q', twins]);
  const tree = gitIn(twins, ['hash-object', '-t', 'tree', '-w', '--stdin'], '');
  // Commits that differ in their message only, until two SHAs start with the same seven characters.
  const body = (i: number) => `tree ${tree}\nauthor Dev <dev@example.com> 0 +0000\ncommitter Dev <dev@example.com> 0 +0000\n\nTwin ${i}\n`;
  const sha1 = (text: string) => createHash('sha1').update(`commit ${Buffer.byteLength(text)}\0${text}`).digest('hex');
  const seen = new Map<string, number>();
  let pair: number[] = [];
  for (let i = 0; !pair.length; i++) {
    const prefix = sha1(body(i)).slice(0, 7);
    if (seen.has(prefix)) pair = [seen.get(prefix)!, i];
    else seen.set(prefix, i);
  }
  const [own, other] = pair.map((i) => gitIn(twins, ['hash-object', '-t', 'commit', '-w', '--stdin'], body(i)));
  assert.equal(own.slice(0, 7), other.slice(0, 7));

  const r = await pullReferences(s, pullIn(join(twins, '.git'), null), [{ sha: own, message: 'Twin' } as Commit], [`${own.slice(0, 7)} or ${own}`]);
  assert.deepEqual([...r.commits], [[own, { href: `/acme/widgets/pull/3/files?commit=${own}`, title: 'Twin' }]]);
  assert.equal(md(`${own.slice(0, 7)} or ${own}`, r), `<p>${own.slice(0, 7)} or <a class="commit-link" href="/acme/widgets/pull/3/files?commit=${own}" title="Twin"><code>${own.slice(0, 7)}</code></a></p>`);
});
