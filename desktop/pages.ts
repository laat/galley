// Which of galley's URLs are its pages, with galley's header, which on macOS is the window's title
// bar (public/app.css), and which are not and have no header to drag the window by.
import { UPLOAD_PATH } from '../src/server/uploads.ts';

/** Whether galley's `url` is an uploaded image or a raw file rather than one of its pages. */
export function notAPage(url: string): boolean {
  const { pathname } = new URL(url);
  return UPLOAD_PATH.test(pathname) || /^\/[^/]+\/[^/]+\/raw\//.test(pathname);
}
