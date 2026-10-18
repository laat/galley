// Opening a page of the web UI for `galley browse` and `--web`: in the desktop app's window while
// the app runs and opens galley links, through the page's galley:// link (src/app-link.ts), as a
// page opened in the browser would hand off to it; otherwise in the browser. The links the CLI
// prints stay http.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_SCHEME, appLink } from '../app-link.ts';
import type { Client } from './client.ts';

/**
 * Open `url`, a page of the web UI, in the desktop app or the browser, and say which: the app when
 * the server says it runs on this computer and opens galley links, and macOS knows an app here
 * for galley:// links.
 */
export async function openPage(client: Client, url: string): Promise<'app' | 'browser'> {
  const where = (await client.desktopAppOpensLinks()) && (await appForLinks()) ? 'app' : 'browser';
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [where === 'app' ? appLink(url) : url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
  return where;
}

/** Whether LaunchServices knows an app that opens galley:// links: macOS only. */
async function appForLinks(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const script = `ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('${APP_SCHEME}://')); app.isNil() ? '' : app.path.js`;
  try {
    const { stdout } = await promisify(execFile)('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}
