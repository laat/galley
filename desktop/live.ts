// The app's one live-update stream: the server's /events, which the pages hear through their
// SharedWorker (public/live-worker.js). It runs in the main process, on Node's fetch, so it takes
// none of the six connections Chromium allows the windows per host.
import { setTimeout as sleep } from 'node:timers/promises';
import { identify } from '../src/cli/client.ts';
import type { ChangeEvent } from '../src/server/service.ts';

export interface Follower {
  stop(): void;
}

/**
 * Follow the server's live updates at `base`: `up` once the stream is open, `change` for each
 * change to a pull request, and `down` when an attempt fails or the stream ends, after which it
 * tries again every `retryMs` until stopped. A stream that says nothing for `idleMs` (the server
 * pings every 20 seconds) counts as ended. Only galley's counts: another program on its port
 * is an attempt that fails.
 */
export function follow(base: string, on: { up(): void; down(): void; change(e: ChangeEvent): void }, o: { retryMs?: number; idleMs?: number } = {}): Follower {
  const stopping = new AbortController();
  const call = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  };
  (async () => {
    while (!stopping.signal.aborted) {
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      stopping.signal.addEventListener('abort', abort);
      let idle: NodeJS.Timeout | undefined;
      const alive = () => {
        clearTimeout(idle);
        idle = setTimeout(abort, o.idleMs ?? 60_000);
      };
      try {
        alive();
        // As the CLI makes sure before its first request (Client.check).
        if ((await identify(base)) !== 'galley') throw new Error(`galley does not answer at ${base}`);
        const res = await fetch(`${base}/events`, { headers: { accept: 'text/event-stream' }, signal: attempt.signal });
        if (!res.ok || !res.body) throw new Error(`/events answered ${res.status}`);
        call(on.up);
        let buffer = '';
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          alive();
          buffer += chunk.replace(/\r\n?/g, '\n');
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const message = parseMessage(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            if (message?.type === 'change') call(() => on.change(message.event as ChangeEvent));
          }
        }
      } catch {}
      clearTimeout(idle);
      stopping.signal.removeEventListener('abort', abort);
      if (stopping.signal.aborted) return;
      call(on.down);
      await sleep(o.retryMs ?? 1000, undefined, { signal: stopping.signal }).catch(() => {});
    }
  })();
  return { stop: () => stopping.abort() };
}

/** One server-sent event: the message the server sent ({ type, event }), or null for a ping. */
export function parseMessage(block: string): { type: string; event: unknown } | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    // A line starting with a colon is a comment.
    if (colon === 0) continue;
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  if (name !== 'message' || !data.length) return null;
  try {
    return JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
}
