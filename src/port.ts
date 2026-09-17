import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './sleep.ts';

const sh = promisify(exec);

/** Is anything answering on this URL right now? */
export async function isOccupied(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    await res.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill whatever is listening on a port.
 *
 * Agents start dev servers as children of a shell inside a tool call, so
 * terminating the agent does not reliably take the server with it. A leaked
 * server is not a tidiness problem -- it is a correctness one. The next run
 * against that port would find something already serving and report a
 * time-to-first-render near zero, for an app the agent under test never built.
 */
export async function killPort(port: number): Promise<boolean> {
  const attempts = [
    `fuser -k -n tcp ${port}`,
    `lsof -ti tcp:${port} | xargs -r kill -9`,
    `ss -lptn 'sport = :${port}' | grep -oP 'pid=\\K\\d+' | xargs -r kill -9`,
  ];
  for (const cmd of attempts) {
    try {
      await sh(cmd, { timeout: 5000 });
      return true;
    } catch {
      // Tool missing or nothing matched; try the next strategy.
    }
  }
  return false;
}

export class PortInUseError extends Error {}

/**
 * Refuse to start a run against a port that is already serving something.
 *
 * Failing loudly beats producing a plausible number measured against the wrong
 * application.
 */
export async function ensureFreePort(url: string, port: number, autoKill: boolean): Promise<void> {
  if (!(await isOccupied(url))) return;
  if (!autoKill) {
    throw new PortInUseError(
      `Something is already serving at ${url}. A run started now would measure that, not the agent.\n` +
        `  Stop it, or pass --kill-port to have the harness free port ${port} first.`,
    );
  }
  await killPort(port);
  // Give the socket a moment to be released before declaring victory.
  for (let i = 0; i < 10; i++) {
    if (!(await isOccupied(url))) return;
    await sleep(300);
  }
  throw new PortInUseError(`Could not free port ${port}; something is still serving at ${url}.`);
}
