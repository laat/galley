// Which computer a request comes from, for what galley does only on the computer it is asked
// from: a page opened in the browser hands off to the desktop app on the same computer, not to
// one on another (public/app.js), and so do the CLI's links (src/cli/open.ts). galley listens on
// 127.0.0.1 by default, and a proxy in front of it, such as tailscale serve, passes on a request
// from another computer with that computer's address last in X-Forwarded-For.
import { AsyncLocalStorage } from 'node:async_hooks';
import { networkInterfaces } from 'node:os';

/** The computer galley runs on, which reaches it at one of its own addresses, loopback among them. */
export const THIS_COMPUTER = 'this';

/** The computer of the request being handled (createApp sets it): THIS_COMPUTER, or another's address. */
export const requestComputer = new AsyncLocalStorage<string>();

/** The computer the request being handled comes from; this one outside a request. */
export function askingComputer(): string {
  return requestComputer.getStore() ?? THIS_COMPUTER;
}

/**
 * The computer at `remote`, the connection's other end, or, when that is a proxy on this computer,
 * the one the proxy names last in `forwardedFor`, which it added itself: THIS_COMPUTER, or the
 * other computer's address. A proxy that leaves the header out makes every request this
 * computer's. A client on another computer that connects directly has no say in it.
 */
export function computerOf(remote: string | undefined, forwardedFor: string | undefined): string {
  const peer = address(remote);
  if (!isThis(peer)) return peer;
  const forwarded = address(forwardedFor?.split(',').at(-1));
  return isThis(forwarded) ? THIS_COMPUTER : forwarded;
}

function address(text: string | undefined): string {
  return (text ?? '')
    .trim()
    .replace(/^::ffff:/i, '')
    .replace(/%.*$/, '')
    .toLowerCase();
}

/** Whether `address` is this computer's: loopback, or one of its interfaces'. None counts as this one. */
function isThis(address: string): boolean {
  if (!address || address.startsWith('127.') || address === '::1') return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address.toLowerCase() === address));
}
