// What a pull request's link may be (src/pull-link.ts), and what its button says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKnownAppLink, linkLabel, pullLink } from '../src/pull-link.ts';

test("a link is an absolute URL, kept as a browser reads it, of any scheme but those that run script or show content in galley's place", () => {
  const thread = 't3code://threads/80bfeaad-cd4a-455e-b90e-9b5805ecbfcd/be3e88e5-6e9b-463a-b73b-a02ea2550806';
  assert.deepEqual(pullLink(thread), { href: thread });
  assert.deepEqual(pullLink('https://example.com/a b'), { href: 'https://example.com/a%20b' });
  assert.deepEqual(pullLink('vscode://file/x'), { href: 'vscode://file/x' });
  // What a browser would make of it is what is checked: it drops tabs and newlines, and ignores case.
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:text/html,x', 'blob:https://example.com/1', 'file:///etc/passwd', 'about:blank']) {
    assert.ok('error' in pullLink(bad), bad);
  }
  assert.ok('error' in pullLink('threads/1'));
  assert.ok('error' in pullLink(`https://example.com/${'x'.repeat(2000)}`));
});

test("a link's button names the app it opens, or the web page's host; the desktop app opens only the apps galley knows", () => {
  assert.equal(linkLabel('t3code://threads/a/b'), 'Open in T3 Code');
  assert.equal(linkLabel('vscode://file/x'), 'Open in vscode');
  assert.equal(linkLabel('https://example.com:8080/x'), 'example.com:8080');
  assert.equal(linkLabel('toString://x'), 'Open in tostring');
  assert.equal(isKnownAppLink('t3code://threads/a/b'), true);
  assert.equal(isKnownAppLink('T3CODE://threads/a/b'), true);
  assert.equal(isKnownAppLink('vscode://file/x'), false);
  assert.equal(isKnownAppLink('tostring://x'), false);
  assert.equal(isKnownAppLink('not a url'), false);
});
