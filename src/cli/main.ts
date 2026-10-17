import { parseArgs } from 'node:util';
import { ApiError, CliError, Client, identify } from './client.ts';
import { pr } from './pr.ts';
import { api } from './api.ts';
import { browse } from './browse.ts';
import { reviewers } from './reviewers.ts';
import { err, out } from './output.ts';
import { DEFAULT_PORT, VERSION, dataDir, fromEnv } from '../config.ts';

const USAGE = `galley: a staging area for pull requests.

Agents stage pull requests with a CLI that mirrors gh. You review them in a
GitHub-like web UI, loop with the agent, and publish to GitHub when they are right.

USAGE
  galley <command> <subcommand> [flags]

COMMANDS
  pr:          Work with staged pull requests (like \`gh pr\`)
  api:         Make an API request (like \`gh api\`)
  serve:       Run the server and web UI
  browse:      Print and open the web UI's URL for a pull request, file or directory (like \`gh browse\`)
  reviewers:   List the reviewer agents that review the repository

ENVIRONMENT
  GALLEY_URL     Server URL (default http://localhost:${DEFAULT_PORT})
  GALLEY_ACTOR   Who the CLI acts as (default: detected agent, or you)
  GALLEY_HOME    Data directory for the server (default ${dataDir()})
`;

/** How long a stopping server lets running reviews finish before it interrupts them. */
const STOP_GRACE_MS = 10 * 60 * 1000;

async function serve(args: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', default: '127.0.0.1' },
      open: { type: 'boolean' },
      // Stop at the first signal, interrupting running reviews.
      now: { type: 'boolean' },
    },
  });
  const { startServer } = await import('../server/server.ts');
  const port = Number(v.port ?? fromEnv('PORT') ?? DEFAULT_PORT);
  const server = await startServer({ port, host: String(v.host), dataDir: dataDir(), moveFromLaatsux: true }).catch(async (e) => {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    const url = `http://localhost:${port}`;
    const found = await identify(url).catch(() => 'other');
    if (found === 'galley' || found === 'starting') throw new CliError(`galley is already running at ${url}`);
    const by = found === 'silent' ? 'a program that does not answer (galley stuck, or another one)' : 'another program';
    throw new CliError(`port ${port} is taken by ${by}. Run galley on another port with GALLEY_PORT=<port> or --port, and set GALLEY_PORT for your agents too.`);
  });
  out(`galley is serving ${server.url} (data in ${dataDir()})`);
  if (v.open) (await import('node:child_process')).spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [server.url], { stdio: 'ignore' });
  await new Promise<void>((resolve) => {
    // The first signal lets running reviews finish; a second one, or --now, interrupts them, and
    // they run again on the next start.
    let stopping = false;
    const stop = () => {
      const now = stopping || !!v.now;
      stopping = true;
      const running = server.service.reviewsRunning();
      const reviews = running === 1 ? '1 review' : `${running} reviews`;
      if (running && now) out(`Interrupting ${reviews}; ${running === 1 ? 'it runs' : 'they run'} again on the next start.`);
      else if (running) out(`Waiting up to ${STOP_GRACE_MS / 60000} minutes for ${reviews} to finish before stopping. Press Ctrl-C (or send SIGTERM) again to stop now.`);
      // Exit once closed; open live-update streams would otherwise keep timers alive for a while.
      server.close({ graceMs: now ? 0 : STOP_GRACE_MS }).then(() => process.exit(0), resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
  const client = new Client();
  try {
    switch (cmd) {
      case 'pr':
        return await pr(client, cwd, rest);
      case 'api':
        return await api(client, cwd, rest);
      case 'serve':
      case 'server':
        return await serve(rest);
      case 'browse':
        return await browse(client, cwd, rest);
      case 'reviewers':
        return await reviewers(client, cwd, rest);
      case '--version':
      case 'version':
        out(`galley version ${VERSION}`);
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        out(USAGE);
        return 0;
      default:
        err(`unknown command "${cmd}" for "galley"\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      err(e.message);
      return e.code;
    }
    if (e instanceof CliError) {
      err(e.message);
      return e.code;
    }
    throw e;
  }
}
