import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db, type ActorType } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';
import { CodexReviewer } from '../src/server/reviewers/codex.ts';
import { avatarUrl, userJson } from '../src/server/github.ts';
import { avatar } from '../src/server/web/html.ts';

const CLAUDE = 'https://avatars.githubusercontent.com/in/1236702?s=80&v=4';
const CODEX = 'https://avatars.githubusercontent.com/in/1144995?s=80&v=4';
const OPENCODE = 'https://avatars.githubusercontent.com/in/1549082?s=80&v=4';

test('known agents get their official logos, with the generated avatar as the fallback', () => {
  const db = new Db(':memory:');
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:7171' });
    s.setViewerLogin('reviewer');
    const codex = new CodexReviewer(s);
    s.codex = codex;
    const url = (login: string, type: ActorType = 'Bot') => userJson(s, db.actor(login, type)).avatar_url;

    assert.equal(url('claude'), CLAUDE);
    assert.equal(url('codex-agent'), CODEX);
    assert.equal(url('opencode'), OPENCODE);
    // The Codex reviewer is known by identity, whatever its name; a bot that takes its old name is not it.
    codex.rename('robo');
    assert.equal(userJson(s, codex.actor()).avatar_url, CODEX);
    assert.equal(url('codex'), 'http://localhost:7171/avatars/codex.svg');
    assert.equal(url('agent'), 'http://localhost:7171/avatars/agent.svg');
    assert.equal(url('someone', 'User'), 'http://localhost:7171/avatars/someone.svg');
    assert.equal(url('reviewer', 'User'), 'https://github.com/reviewer.png?size=80');

    // Pages swap an image from elsewhere for the generated one when it can't load (public/app.js).
    const img = (login: string) => String(avatar(avatarUrl(s, db.actor(login, 'Bot')), login, 20));
    assert.equal(img('claude'), `<img class="avatar " src="${CLAUDE.replace('&', '&amp;')}" data-fallback="/avatars/claude.svg" width="20" height="20" alt="@claude" loading="lazy">`);
    assert.match(String(avatar(avatarUrl(s, s.viewer()), 'reviewer')), / data-fallback="\/avatars\/reviewer\.svg"/);
    assert.doesNotMatch(img('agent'), /data-fallback/);
  } finally {
    db.sql.close();
  }
});
