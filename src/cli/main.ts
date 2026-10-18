import { parseArgs } from 'node:util';
import { ApiError, CliError, Client, Help, identify } from './client.ts';
import { pr } from './pr.ts';
import { api } from './api.ts';
import { browse } from './browse.ts';
import { reviewers } from './reviewers.ts';
import { err, out } from './output.ts';
import { DEFAULT_PORT, VERSION, dataDir, fromEnv, localUrl } from '../config.ts';

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

Add --help to a command for its flags, as in \`galley pr wait --help\`.
`;

/** How long a stopping server lets running reviews finish before it interrupts them. */
const STOP_GRACE_MS = 10 * 60 * 1000;

const SERVE_USAGE = `Run the server and web UI. Other commands start it in the background when it is not running.

USAGE
  galley serve [flags]

FLAGS
  -p, --port <number>        The port to listen on (default $GALLEY_PORT, or ${DEFAULT_PORT})
      --host <address>       The address to listen on (default 127.0.0.1)
      --public-url <url>     Where other machines reach it, such as the https://<host>.<tailnet>.ts.net
                             of \`tailscale serve\`: its links start with it, and requests to its host
                             are accepted (default $GALLEY_PUBLIC_URL)
      --allowed-host <host>  Accept requests addressed to this host or host:port too; repeatable
                             (default $GALLEY_ALLOWED_HOSTS, comma-separated)
      --open                 Open the web UI in the browser
      --now                  Stop at the first Ctrl-C or SIGTERM, interrupting running reviews,
                             instead of letting them finish for up to ${STOP_GRACE_MS / 60000} minutes
      --check                Say whether this machine has what the server needs, and start nothing:
                             git, and gh logged in with the workflow scope; and, marked ! when
                             missing, what galley runs without: signing, codex and claude logged
                             in, and on Linux bwrap and socat. Exits 1 when git or gh falls short
`;

/** The public URL as given (galley serve --public-url), as its origin: http(s)://host[:port], with no path. */
function publicOrigin(given: string): string {
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new CliError(`the public URL is not a URL: "${given}"`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new CliError(`the public URL must be http(s)://host[:port], with no path: "${given}"`);
  }
  return url.origin;
}

async function serve(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string', default: '127.0.0.1' },
        'public-url': { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        open: { type: 'boolean' },
        // Stop at the first signal, interrupting running reviews.
        now: { type: 'boolean' },
        check: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
  const { values: v } = parsed;
  if (v.help) {
    out(SERVE_USAGE);
    return 0;
  }
  if (v.check) {
    const { check } = await import('../server/check.ts');
    const checks = await check();
    for (const c of checks) out(`${c.ok ? '✓' : c.optional ? '!' : '✗'} ${c.text}`);
    return checks.every((c) => c.ok || c.optional) ? 0 : 1;
  }
  const { startServer } = await import('../server/server.ts');
  const port = Number(v.port ?? fromEnv('PORT') ?? DEFAULT_PORT);
  const host = String(v.host);
  const given = v['public-url'] ?? fromEnv('PUBLIC_URL');
  const publicUrl = given ? publicOrigin(given) : undefined;
  const allowedHosts = (v['allowed-host'] ?? fromEnv('ALLOWED_HOSTS')?.split(',') ?? []).map((h) => h.trim()).filter(Boolean);
  const server = await startServer({ port, host, publicUrl, allowedHosts, dataDir: dataDir() }).catch(async (e) => {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    const url = localUrl(host, port);
    const found = await identify(url).catch(() => 'other');
    if (found === 'galley' || found === 'starting') throw new CliError(`galley is already running at ${url}`);
    const by = found === 'silent' ? 'a program that does not answer (galley stuck, or another one)' : 'another program';
    throw new CliError(`port ${port} is taken by ${by}. Run galley on another port with GALLEY_PORT=<port> or --port, and set GALLEY_PORT for your agents too.`);
  });
  out(`galley is serving ${server.url} (data in ${dataDir()})`);
  if (publicUrl) out(`Its links start with ${publicUrl}.`);
  // Beyond localhost's and the address it listens on.
  if (publicUrl || allowedHosts.length) out(`It accepts requests addressed to ${server.allowedHosts.join(', ')}.`);
  else if (host === '0.0.0.0' || host === '::') out('It listens on every address, but accepts only requests addressed to localhost: name the others with --allowed-host or GALLEY_ALLOWED_HOSTS.');
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
    if (e instanceof Help) {
      out(e.message);
      return 0;
    }
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
