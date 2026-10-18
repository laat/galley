// galley's pre-receive hook for its clones (Service.registerGithub), which `git receive-pack` runs
// for each push to the git endpoint (git-http.ts runs it with core.hooksPath). It reads git's
// "<old> <new> <ref>" lines, says on stderr why it refuses a ref (the pusher sees "remote: galley:
// …"), and refuses the whole push when it refuses one.
//
// It takes branches only: galley's other refs are its own (refs/remotes/origin/*, fetched from
// GitHub, and refs/galley/*). It deletes none. And it replaces a branch galley has only by a
// fast-forward, or with a lease on the commit galley has there now: the push option
// `lease=<branch>:<sha>`, an empty <sha> for a branch galley does not have, as in
// `git push --force-with-lease=<branch>:<sha> -o lease=<branch>:<sha>`. git checks
// --force-with-lease in the pushing client only, and tells the server nothing of it: without the
// push option, `git push --force` would replace whatever galley has, such as another machine's
// branch of the same name, which the pusher never saw.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** A git command's output, or null when it failed. */
function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'no commit');

// The leases the push names, by ref.
const leases = new Map<string, string>();
for (let i = 0; i < Number(process.env.GIT_PUSH_OPTION_COUNT ?? 0); i++) {
  const m = process.env[`GIT_PUSH_OPTION_${i}`]?.match(/^lease=(.+):([0-9a-f]*)$/);
  if (m) leases.set(m[1].startsWith('refs/') ? m[1] : `refs/heads/${m[1]}`, m[2]);
}

let refused = false;
const refuse = (ref: string, why: string) => {
  console.error(`galley: ${ref.replace(/^refs\/heads\//, '')}: ${why}`);
  refused = true;
};

for (const line of readFileSync(0, 'utf8').split('\n')) {
  const [, to, ref] = line.split(' ');
  if (!ref) continue;
  if (!ref.startsWith('refs/heads/')) {
    refuse(ref, 'galley takes branches only (refs/heads/…); its other refs are its own');
    continue;
  }
  if (/^0+$/.test(to)) {
    refuse(ref, 'galley does not delete branches');
    continue;
  }
  const head = git('rev-parse', '--verify', '--quiet', ref);
  const lease = leases.get(ref);
  if (lease !== undefined) {
    const expected = lease ? git('rev-parse', '--verify', '--quiet', `${lease}^{commit}`) : null;
    if (lease ? !expected || expected !== head : head !== null) refuse(ref, `galley has it at ${short(head)}, not at ${lease ? short(lease) : 'no commit'} as the lease says`);
    continue;
  }
  if (!head || head === to || git('merge-base', '--is-ancestor', head, to) !== null) continue;
  refuse(ref, `galley has it at ${short(head)}, which this push does not have. galley replaces a branch only by a fast-forward, or with a lease on the commit it has there (-o lease=${ref.slice('refs/heads/'.length)}:<sha>)`);
}

process.exit(refused ? 1 : 0);
