// Keeps a test file off the user's own setup: their galley server, data and custom reviewers,
// the real gh, codex and claude, their git config, and the network. Import it first in every test
// file that starts a server or runs the CLI; the servers and CLIs they start inherit it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'galley-env-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

// What the user set for their own galley does not apply.
for (const name of Object.keys(process.env)) if (name.startsWith('GALLEY_')) delete process.env[name];
process.env.GALLEY_HOME = join(root, 'data');
process.env.GALLEY_CONFIG_DIR = join(root, 'config');
// Known, so no server asks gh who the user is.
process.env.GALLEY_USER = 'reviewer';
// A CLI run without a GALLEY_URL of its own fails, rather than reach the user's server or start one.
process.env.GALLEY_URL = 'http://127.0.0.1:1';
process.env.GALLEY_NO_AUTOSTART = '1';
// A server started without fakes of its own runs none of the real tools.
process.env.GALLEY_GH = 'false';
process.env.GALLEY_CODEX = 'false';
process.env.GALLEY_CLAUDE = 'false';

/**
 * Git's global config. Its https goes to a proxy that is not there, so fetches from github.com
 * fail at once. A test file that needs settings of its own appends them here.
 */
export const gitconfig = join(root, 'gitconfig');
writeFileSync(gitconfig, '[http]\n\tproxy = http://127.0.0.1:1\n');
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.NO_PROXY;
delete process.env.no_proxy;
// The CLI goes to its server directly, not through a proxy the environment names (a sandbox's), unless a test says so.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[name];
