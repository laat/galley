import { spawnSync } from 'node:child_process';
import { CliError } from './client.ts';

export const isTTY = !!process.stdout.isTTY;
const color = isTTY && !process.env.NO_COLOR;

const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function out(s = ''): void {
  process.stdout.write(s.endsWith('\n') || s === '' ? s : s + '\n');
}

export function err(s: string): void {
  process.stderr.write(s.endsWith('\n') ? s : s + '\n');
}

export function runJq(expr: string, json: string): string {
  const r = spawnSync('jq', ['-r', expr], { input: json, encoding: 'utf8' });
  if (r.error) throw new CliError('--jq needs the `jq` binary on PATH');
  if (r.status !== 0) throw new CliError(r.stderr.trim() || `jq exited with ${r.status}`);
  return r.stdout;
}

/** Print data the way gh does for --json, honouring --jq. */
export function printJson(data: unknown, jq?: string): void {
  const text = JSON.stringify(data, null, 2);
  if (jq) process.stdout.write(runJq(jq, text));
  else out(text);
}

export function checkFields(requested: string, available: readonly string[]): string[] {
  const fields = requested.split(',').map((f) => f.trim()).filter(Boolean);
  if (fields.length === 0) {
    throw new CliError(`Specify one or more comma-separated fields for \`--json\`:\n  ${available.join('\n  ')}`);
  }
  const unknown = fields.find((f) => !available.includes(f));
  if (unknown) throw new CliError(`Unknown JSON field: "${unknown}"\nAvailable fields:\n  ${available.join('\n  ')}`);
  return fields;
}

export function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((l) => (l ? prefix + l : l))
    .join('\n');
}

/** Parse "90", "90s", "10m", "1h" into milliseconds. */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new CliError(`invalid duration "${s}" (use e.g. 30s, 10m, 1h)`);
  const n = parseFloat(m[1]);
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
}
