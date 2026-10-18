// The desktop app's live-update stream: the server's /events, followed from the main process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { follow, parseMessage } from '../live.ts';
import { until } from '../../test/helpers/until.ts';

test('reads the messages the server sends, and skips pings and comments', () => {
  assert.deepEqual(parseMessage('data: {"type":"change","event":{"pullId":1}}'), { type: 'change', event: { pullId: 1 } });
  assert.deepEqual(parseMessage('id: 3\ndata: {"type":"change",\ndata: "event":null}'), { type: 'change', event: null });
  assert.equal(parseMessage('event: ping\ndata: '), null);
  assert.equal(parseMessage(': a comment'), null);
  assert.equal(parseMessage('data: not json'), null);
});

/**
 * A stand-in for galley: what /api/meta says, and /events, which holds each stream open until the
 * test ends it. Starting, it answers 503 to both, as galley does; another program answers /events
 * with a page of its own.
 */
async function eventServer() {
  const streams: { res: ServerResponse; closed: boolean; url: string }[] = [];
  let as: 'galley' | 'starting' | 'other' = 'galley';
  const server = createServer((req, res) => {
    if (as === 'other') return void res.writeHead(/^\/events(\?|$)/.test(req.url!) ? 200 : 404, { 'content-type': 'text/html' }).end('<!doctype html>');
    const status = as === 'starting' ? 503 : 200;
    if (req.url === '/api/meta') return void res.writeHead(status, { 'content-type': 'application/json' }).end('{"name":"galley","version":"0.1.0"}');
    if (!/^\/events(\?|$)/.test(req.url!) || status !== 200) return void res.writeHead(status).end('starting');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
    const stream = { res, closed: false, url: req.url! };
    res.on('close', () => (stream.closed = true));
    streams.push(stream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    streams,
    send: (text: string) => streams.at(-1)!.res.write(text),
    answerAs: (what: typeof as) => (as = what),
    /** Ends every stream, as a server that stops does. */
    drop: () => server.closeAllConnections(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('follows the changes, and the stream again after the server goes away', async () => {
  const events = await eventServer();
  const heard: string[] = [];
  const live = follow(events.base, { up: () => heard.push('up'), down: () => heard.push('down'), change: (e) => heard.push(`change ${e.type}`) }, { retryMs: 20 });
  try {
    await until(() => heard.includes('up'), 'the stream is open');
    // Split across writes, with CRLF, a ping and a progress event in between.
    events.send('event: ping\ndata: \n\ndata: {"type":"change","event":{"pullId":1,"type":"comm');
    events.send('ent","actor":"agent","source":null}}\r\n\r\ndata: {"type":"progress","event":{"pullId":1}}\n\n');
    await until(() => heard.includes('change comment'), 'the change is heard');
    assert.deepEqual(heard, ['up', 'change comment']);
    // Away, and starting again: down until galley answers.
    events.answerAs('starting');
    events.drop();
    await until(() => heard.filter((h) => h === 'down').length >= 2, 'it tries again');
    assert.equal(heard.filter((h) => h === 'up').length, 1);
    events.answerAs('galley');
    await until(() => heard.filter((h) => h === 'up').length === 2, 'the stream is open again');
    events.send('data: {"type":"change","event":{"pullId":2,"type":"pushed","actor":"agent","source":null}}\n\n');
    await until(() => heard.includes('change pushed'), 'a change after it is heard');
  } finally {
    live.stop();
    events.drop();
    await events.close();
  }
});

test('another program on the port is never followed, whatever it answers at /events', async () => {
  const events = await eventServer();
  events.answerAs('other');
  const heard: string[] = [];
  const live = follow(events.base, { up: () => heard.push('up'), down: () => heard.push('down'), change() {} }, { retryMs: 20 });
  try {
    await until(() => heard.length >= 3, 'it tries a few times');
    assert.deepEqual(new Set(heard), new Set(['down']));
  } finally {
    live.stop();
    await events.close();
  }
});

test('a stream that says nothing for too long counts as ended', async () => {
  const events = await eventServer();
  const heard: string[] = [];
  const live = follow(events.base, { up: () => heard.push('up'), down: () => heard.push('down'), change() {} }, { retryMs: 20, idleMs: 200 });
  try {
    await until(() => heard.filter((h) => h === 'up').length === 2, 'it opens a new stream');
    assert.deepEqual(heard.slice(0, 3), ['up', 'down', 'up']);
    assert.ok(events.streams.length >= 2);
  } finally {
    live.stop();
    events.drop();
    await events.close();
  }
});

test('stopped, it hears nothing more and opens no stream', async () => {
  const events = await eventServer();
  const heard: string[] = [];
  const live = follow(events.base, { up: () => heard.push('up'), down: () => heard.push('down'), change: () => heard.push('change') }, { retryMs: 20 });
  try {
    await until(() => heard.includes('up'), 'the stream is open');
    live.stop();
    await until(() => events.streams.at(-1)!.closed, 'the stream is closed');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(heard, ['up']);
    assert.equal(events.streams.length, 1);
  } finally {
    events.drop();
    await events.close();
  }
});

test('the stream opens at the path it is given then, and opens again at once when told, without going down', async () => {
  const events = await eventServer();
  let path = '/events?desktop=1&open_links=1';
  const heard: string[] = [];
  const live = follow(events.base, { up: () => heard.push('up'), down: () => heard.push('down'), change() {} }, { retryMs: 20, path: () => path });
  try {
    await until(() => heard.includes('up'), 'the stream is open');
    path = '/events?desktop=1';
    live.reopen();
    await until(() => heard.length === 2, 'the stream is open again');
    assert.deepEqual(heard, ['up', 'up']);
    assert.deepEqual(events.streams.map((st) => st.url), ['/events?desktop=1&open_links=1', '/events?desktop=1']);
    await until(() => events.streams[0].closed, 'the first stream is closed');
    // Down, it opens at the path it is given then, as before.
    path = '/events?desktop=1&open_links=1';
    events.drop();
    await until(() => heard.filter((h) => h === 'up').length === 3, 'the stream is open after the drop');
    assert.deepEqual(heard, ['up', 'up', 'down', 'up']);
    assert.equal(events.streams.at(-1)!.url, '/events?desktop=1&open_links=1');
  } finally {
    live.stop();
    events.drop();
    await events.close();
  }
});
