// galley:// links, which the desktop app opens in its window (desktop/main.ts): galley://<path>
// is the page at /<path> on the server the app is a window onto. `galley browse` and `--web` open
// them while the app runs (src/cli/open.ts), and so does a page opened in the browser (public/app.js).

export const APP_SCHEME = 'galley';

/** The galley:// link to the page at `url`, a URL on galley's origin: its path, query and fragment. */
export function appLink(url: string): string {
  const u = new URL(url);
  return `${APP_SCHEME}://${(u.pathname + u.search + u.hash).replace(/^\/+/, '')}`;
}

/**
 * The page a galley:// link opens, as a path on `base`, galley's URL: /<path>[?query][#hash].
 * The link is a path whatever it says: galley://example.com/x and galley:////example.com/x are
 * /example.com/x. Null for any other link, and for one that would leave galley's origin all the
 * same, as one with a tab among its slashes would, which URL parsers drop.
 */
export function appLinkPath(link: string, base: string): string | null {
  if (!link.toLowerCase().startsWith(`${APP_SCHEME}:`)) return null;
  const rest = link.slice(APP_SCHEME.length + 1).replace(/^[/\\]+/, '');
  let url: URL;
  try {
    url = new URL('/' + rest, base);
  } catch {
    return null;
  }
  if (url.origin !== new URL(base).origin) return null;
  return url.pathname + url.search + url.hash;
}
