// A sandbox for installing a pull request's dependencies, for a reviewing tool that has no way
// to run a command in a sandbox of its own (Claude Code sandboxes only the commands it runs
// itself). It may use the network and read everything, and it writes only to the given
// directories; the paths kept read-only (the checkout's .git, which points into the user's
// repository) stay so even inside them. On macOS it is Seatbelt, as Codex's and Claude Code's
// sandboxes are: everything is denied but what a package manager needs. On Linux it is
// bubblewrap, as theirs are there: the whole filesystem mounted read-only with the writable
// directories over it, in namespaces of its own but for the network. Elsewhere there is none.
import { run } from '../git.ts';

/** The profile; paths come in as parameters, so none needs quoting. */
const PROFILE = `(version 1)
(deny default)
(import "system.sb")
(system-network)
(allow process-fork process-exec)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-read*)
(allow sysctl-read)
(allow pseudo-tty)
(allow ipc-posix-sem ipc-posix-shm)
(allow user-preference-read)
(allow network*)
(allow mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
(allow file-write-data file-ioctl
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/fd/"))`;

/**
 * `command` wrapped to run in the sandbox, writing only to `writable` (real paths, without
 * symlinks, that exist) and not to `readOnly` within them; null where galley has no sandbox.
 * `exec` stands in for sandbox-exec or bwrap (in tests).
 */
export function sandboxed(command: string[], o: { writable: string[]; readOnly: string[] }, exec?: string, platform = process.platform): { bin: string; args: string[] } | null {
  if (platform === 'linux') {
    const args = [
      // Its own user, PID, IPC, UTS and cgroup namespaces, and the host's network.
      '--unshare-all',
      '--share-net',
      // Killed with galley, and in a session of its own, so it can not type into galley's terminal.
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      // A later mount covers an earlier one: the writable directories cover the read-only root,
      // and the read-only paths cover them.
      ...o.writable.flatMap((p) => ['--bind', p, p]),
      ...o.readOnly.flatMap((p) => ['--ro-bind', p, p]),
      // The command starts in bwrap's working directory, as with sandbox-exec.
      '--',
      ...command,
    ];
    return { bin: exec ?? 'bwrap', args };
  }
  if (platform !== 'darwin') return null;
  const params = [...o.writable.map((p, i) => [`WRITABLE_${i}`, p]), ...o.readOnly.map((p, i) => [`READ_ONLY_${i}`, p])];
  const rules = [
    PROFILE,
    `(allow file-write* ${o.writable.map((_, i) => `(subpath (param "WRITABLE_${i}"))`).join(' ')})`,
    ...o.readOnly.map((_, i) => `(deny file-write* (subpath (param "READ_ONLY_${i}")))`),
  ];
  return { bin: exec ?? '/usr/bin/sandbox-exec', args: ['-p', rules.join('\n'), ...params.map(([k, v]) => `-D${k}=${v}`), ...command] };
}

/**
 * Why galley can not install in a sandbox here, or null when it can: none on this platform, or
 * on Linux, bwrap not installed or unable to make one. bwrap needs unprivileged user namespaces,
 * which a container, another sandbox or Ubuntu's AppArmor (23.10 and later) can take away; it
 * tries one. macOS's sandbox-exec is always there.
 */
export async function noSandbox(exec?: string, platform = process.platform): Promise<string | null> {
  const s = sandboxed(['true'], { writable: [], readOnly: [] }, exec, platform);
  if (!s) return `galley has no sandbox to install in on ${platform}`;
  if (platform !== 'linux') return null;
  const r = await run(s.bin, s.args, { allowFail: true, timeoutMs: 30_000 }).catch((e: NodeJS.ErrnoException) => e);
  if (r instanceof Error) return r.code === 'ENOENT' ? `${s.bin} not found: install bubblewrap` : `could not run ${s.bin}: ${r.message}`;
  if (r.code !== 0) return `${s.bin} could not make a sandbox (it needs unprivileged user namespaces): ${r.stderr.trim() || (r.timedOut ? 'timed out' : `exited with ${r.code}`)}`;
  return null;
}
