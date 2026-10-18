// Builds galley.app in out/, unsigned: signed ad hoc on macOS, for this computer only.
// The app is Electron and a loader that runs main.ts from this checkout, as the CLI's symlink runs
// bin/galley.ts: it follows the checkout, and the server it starts is the checkout's.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packager } from '@electron/packager';
import { APP_SCHEME } from '../src/app-link.ts';

const here = import.meta.dirname;
const electron = JSON.parse(readFileSync(join(here, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const app = mkdtempSync(join(tmpdir(), 'galley-app-'));
try {
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'galley', productName: 'galley', version: '0.1.0', type: 'module', main: 'main.js' }));
  writeFileSync(join(app, 'main.js'), `await import(${JSON.stringify(pathToFileURL(join(here, 'main.ts')).href)});\n`);
  let icon: string | undefined;
  if (process.platform === 'darwin') {
    // The icon in the sizes macOS asks for, from the 1024-pixel one.
    const set = join(app, 'icon.iconset');
    mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
        execFileSync('sips', ['-z', String(size * scale), String(size * scale), join(here, 'icons', 'icon.png'), '--out', join(set, `icon_${size}x${size}${suffix}.png`)], { stdio: 'ignore' });
      }
    }
    icon = join(app, 'icon.icns');
    execFileSync('iconutil', ['-c', 'icns', set, '-o', icon]);
    rmSync(set, { recursive: true });
  }
  const [path] = await packager({
    dir: app,
    out: join(here, 'out'),
    name: 'galley',
    electronVersion: electron,
    appBundleId: 'io.github.laat.galley',
    // CFBundleURLTypes in its Info.plist: macOS sends it galley:// links (src/app-link.ts).
    protocols: [{ name: 'galley link', schemes: [APP_SCHEME] }],
    icon,
    asar: false,
    overwrite: true,
    ignore: [/icon\.icns$/],
  });
  // Packaging breaks the signature Electron came with. Signed ad hoc, the app is valid on this computer.
  if (process.platform === 'darwin') execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(path, 'galley.app')], { stdio: 'inherit' });
  console.log(`Built ${process.platform === 'darwin' ? join(path, 'galley.app') : path}`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
