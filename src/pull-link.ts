// A pull request's link (pulls.link): where the user goes from galley to the author's session,
// such as its T3 Code thread (t3code://threads/<environmentId>/<threadId>). galley shows it on
// the pull request's pages, and the desktop app hands it to the app its scheme names
// (desktop/main.ts); it is never published to GitHub.

/** Schemes a link may not have: those that run script or show content in galley's place. */
const REFUSED = new Set(['javascript:', 'vbscript:', 'data:', 'blob:', 'file:', 'about:']);

export const MAX_LINK_LENGTH = 2000;

/**
 * A pull request's link as galley keeps it: an absolute URL of an allowed scheme, as a browser
 * reads it (so what is checked is what a click opens), or why it can not be one.
 */
export function pullLink(link: string): { href: string } | { error: string } {
  if (link.length > MAX_LINK_LENGTH) return { error: `link is longer than ${MAX_LINK_LENGTH} characters` };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { error: `link "${link}" is not an absolute URL` };
  }
  if (REFUSED.has(url.protocol)) return { error: `link may not be a ${url.protocol} URL` };
  return { href: url.href };
}

/** Whether a link opens in a web browser, rather than in the app its scheme names. */
export function isWebLink(link: string): boolean {
  return /^https?:/i.test(link);
}

/**
 * Apps galley knows, by scheme, for what it calls them. The desktop app opens their links without
 * asking, as a browser asks for any app's; a link to another app opens there only from a browser.
 */
const APPS: Record<string, string> = { 't3code:': 'T3 Code' };

/** Whether a link opens one of the apps galley knows. */
export function isKnownAppLink(link: string): boolean {
  try {
    return Object.hasOwn(APPS, new URL(link).protocol);
  } catch {
    return false;
  }
}

/** What a link opens, for its button: "Open in T3 Code", or a web page's host. */
export function linkLabel(link: string): string {
  const url = new URL(link);
  if (isWebLink(link)) return url.host;
  return `Open in ${Object.hasOwn(APPS, url.protocol) ? APPS[url.protocol] : url.protocol.slice(0, -1)}`;
}
