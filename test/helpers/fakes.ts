// The fake gh, codex and claude of the tests do what FAKE_* variables say. They get them from the
// server that starts them, which has this process's, and read them when they start.
import assert from 'node:assert/strict';
import type { PullRow } from '../../src/server/db.ts';
import type { Service } from '../../src/server/service.ts';

/** The FAKE_* variables as they are now. */
export function fakes(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith('FAKE_') && e[1] !== undefined));
}

/** Puts the FAKE_* variables back as `fakes()` gave them. */
function restoreFakes(saved: Record<string, string>): void {
  for (const name of Object.keys(process.env)) if (name.startsWith('FAKE_')) delete process.env[name];
  Object.assign(process.env, saved);
}

/**
 * Runs `fn` with these FAKE_* variables (undefined unsets one), then puts every FAKE_* variable
 * back as it was, also when `fn` fails, so a failing test leaves no fake failing or gated for the
 * tests after it. A fake keeps what it read when it started: what `fn` starts should be over by
 * the time it returns.
 */
export async function withFakes<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = fakes();
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    restoreFakes(saved);
  }
}

/**
 * For `afterEach`: fails a test that left a review running or about to start on one of `services`,
 * where it would answer with the fakes of the tests after it, or that left the FAKE_* variables
 * other than `starting`. Puts the variables back first, so the tests after it start from `starting`.
 */
export function assertLeftAsFound(services: Service[], starting: Record<string, string>): void {
  const left = fakes();
  restoreFakes(starting);
  const atWork = services.flatMap((s) => {
    const pulls = s.db.all<PullRow>('SELECT * FROM pulls');
    return s.reviewerAgents().flatMap((r) => pulls.filter((p) => r.atWork(p)).map((p) => `${r.key} on s#${p.number}`));
  });
  assert.deepEqual(atWork, [], 'reviews still running or about to start');
  assert.deepEqual(left, starting, 'FAKE_* variables the test changed');
}
