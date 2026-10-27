// Builds the npm package, galley-proof, in dist/ or the directory given: `pnpm build`, then
// `npm pack ./dist`. The release workflow (.github/workflows/release.yml) stages it on npm.
//
// Node strips types from no file under node_modules, so the package is JavaScript: each module
// in bin/ and src/ with its types stripped by Node's own stripper, the one that runs the checkout
// (types become spaces, so lines and columns stay those of the .ts), and its relative imports of
// .ts files made .js. The layout is the checkout's, so the paths from the code to public/ and to
// its own modules hold in both.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(root, 'dist'));

/** A relative module specifier in a static, dynamic or side-effect import, or an export from. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+)\2/g;

rmSync(out, { recursive: true, force: true });
for (const dir of ['bin', 'src']) {
  for (const file of readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) continue;
    const from = join(root, dir, file);
    const js = stripTypeScriptTypes(readFileSync(from, 'utf8')).replace(SPECIFIER, (_, before: string, quote: string, specifier: string) => {
      if (!existsSync(join(dirname(from), specifier))) throw new Error(`${relative(root, from)} imports ${specifier}, which is not there`);
      return `${before}${quote}${specifier.replace(/\.ts$/, '.js')}${quote}`;
    });
    const to = join(out, dir, file.replace(/\.ts$/, '.js'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, js);
  }
}
for (const path of ['public', 'README.md', 'LICENSE']) cpSync(join(root, path), join(out, path), { recursive: true });

// package.json with the built bin, and what the package needs at run time; package.json,
// README.md and LICENSE go in regardless. The checkout's is private, so that npm publishes
// only this one.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
delete pkg.private;
delete pkg.scripts;
delete pkg.devDependencies;
pkg.bin = { galley: 'bin/galley.js' };
pkg.files = ['bin', 'src', 'public'];
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
