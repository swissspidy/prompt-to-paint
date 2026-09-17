import { setTimeout as delay } from 'node:timers/promises';

/**
 * Sleep, optionally cancellable.
 *
 * A pending timer keeps Node's event loop alive, so the losing branch of a
 * `Promise.race` outlives the race that discarded it. The cold-start window
 * races the agent's first turn against the brief's horizon, and the horizon is
 * minutes long: without cancellation the CLI sat there doing nothing for the
 * remainder of it, long after the report had been written and the browser
 * closed. Handing the race's signal to every branch clears those timers the
 * moment the race is decided.
 *
 * Cancellation resolves rather than throws. Every caller here is a branch that
 * has already lost, and a rejection nobody is waiting on is an unhandled one.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => undefined);
}
