// A sandbox for installing a pull request's dependencies, for a reviewing tool that has no way
// to run a command in a sandbox of its own (Claude Code sandboxes only the commands it runs
// itself). On macOS it is Seatbelt, as Codex's and Claude Code's sandboxes are: everything is
// denied but what a package manager needs. It may use the network and read everything, and it
// writes only to the given directories; the paths kept read-only (the checkout's .git, which
// points into the user's repository) stay so even inside them. Elsewhere there is none yet.

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
 * symlinks) and not to `readOnly` within them; null where laatsux has no sandbox. `exec` stands
 * in for sandbox-exec (in tests).
 */
export function sandboxed(command: string[], o: { writable: string[]; readOnly: string[] }, exec?: string): { bin: string; args: string[] } | null {
  if (!exec && process.platform !== 'darwin') return null;
  const params = [...o.writable.map((p, i) => [`WRITABLE_${i}`, p]), ...o.readOnly.map((p, i) => [`READ_ONLY_${i}`, p])];
  const rules = [
    PROFILE,
    `(allow file-write* ${o.writable.map((_, i) => `(subpath (param "WRITABLE_${i}"))`).join(' ')})`,
    ...o.readOnly.map((_, i) => `(deny file-write* (subpath (param "READ_ONLY_${i}")))`),
  ];
  return { bin: exec ?? '/usr/bin/sandbox-exec', args: ['-p', rules.join('\n'), ...params.map(([k, v]) => `-D${k}=${v}`), ...command] };
}
