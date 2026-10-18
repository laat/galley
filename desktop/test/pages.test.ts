// galley's URLs with no header to drag the app's window by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notAPage } from '../pages.ts';

const base = 'http://localhost:24823';

test('an uploaded image and a raw file have no header', () => {
  for (const path of [`/uploads/${'3f2a9c0d'.repeat(8)}.png`, '/acme/widgets/raw/1a2b3c/docs/logo.png', '/acme/widgets/raw/1a2b3c/notes.txt?x=1']) assert.equal(notAPage(base + path), true, path);
});

test('the pages have one, also a file named raw and the repositories of an owner named raw or uploads', () => {
  const pages = ['/', '/settings', '/acme/widgets', '/acme/widgets/pull/4/files', '/acme/widgets/blob/1a2b3c/raw/notes.md', '/acme/raw/pull/1', '/acme/widgets/runs/2'];
  for (const path of [...pages, '/uploads/widgets', '/uploads/widgets/pull/1', '/raw/widgets/pull/1'])
    assert.equal(notAPage(base + path), false, path);
});
