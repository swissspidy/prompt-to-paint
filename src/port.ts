import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from './sleep.ts';

const run = promisify(execFile);

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

interface ProbeResult {
  /** The tool exists and answered. */
  ran: boolean;
  pids: number[];
}

/**
 * Run a lookup tool, separating "not installed" from "found nothing".
 *
 * The difference decides whether the next strategy is worth trying and whether
 * an empty answer means the port is clear or merely unexamined -- and an
 * unexamined port is how a leaked dev server survives into the next run.
 */
async function probe(file: string, args: string[], parse: (out: string) => number[]): Promise<ProbeResult> {
  try {
    const { stdout } = await run(file, args, { timeout: 5000 });
    return { ran: true, pids: parse(stdout) };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    // ENOENT is the tool missing; anything else means it ran and disliked
    // something. lsof and ss both exit non-zero on an empty match, which is an
    // answer -- the port has no listener -- not a failure.
    if (err.code === 'ENOENT') return { ran: false, pids: [] };
    const out = typeof err.stdout === 'string' ? err.stdout : '';
    const pids = parse(out);
    // A non-empty stderr with no pids is a real error (bad flags, no
    // permission), not an empty result, so let the next strategy try.
    const noisy = Boolean(err.stderr && err.stderr.trim());
    return { ran: !noisy || pids.length > 0, pids };
  }
}

const barePids = (out: string): number[] => uniqPids(out.split(/\s+/));
const ssPids = (out: string): number[] => uniqPids(out.match(/pid=(\d+)/g)?.map((m) => m.slice(4)) ?? []);

function uniqPids(tokens: Array<string | undefined>): number[] {
  const seen = new Set<number>();
  for (const t of tokens) {
    const n = Number(t);
    // pid 1 is init; killing it is never the right answer.
    if (Number.isInteger(n) && n > 1) seen.add(n);
  }
  return [...seen];
}

/**
 * Processes *listening* on a TCP port.
 *
 * The listener restriction is the whole point. `lsof -i tcp:PORT` matches every
 * socket with that number at either end, so it also returns every *client* of
 * the port -- including this harness, which polls the app under test once a
 * second from `Prober.probeServer`. Piping that list into `kill -9` made the
 * harness kill itself during teardown: the run died with SIGKILL after the last
 * measured frame, taking result.json, the judging pass and the report with it,
 * and leaving a frames/ directory with no timeline to read it by.
 *
 * It only reproduced on macOS. Linux has `fuser`, which matches local ports
 * only and was tried first, so CI never saw it; macOS has no `fuser` and fell
 * through to the lsof line every time.
 */
export async function listenersOn(port: number): Promise<{ pids: number[]; probed: boolean }> {
  const strategies: Array<() => Promise<ProbeResult>> = [
    // -sTCP:LISTEN is the fix: listening sockets only, never a client of the port.
    () => probe('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN', '-P', '-n'], barePids),
    () => probe('ss', ['-lptnH', `sport = :${port}`], ssPids),
    // fuser matches local ports only, so it is listener-safe, but it is Linux-only.
    () => probe('fuser', ['-n', 'tcp', String(port)], barePids),
  ];
  let probed = false;
  for (const strategy of strategies) {
    const res = await strategy();
    probed ||= res.ran;
    if (res.pids.length) return { pids: res.pids, probed: true };
  }
  return { pids: [], probed };
}

/**
 * This process and everything that started it.
 *
 * A dev server the agent started is a descendant, so it is never in here; the
 * shell, npm and node wrappers above us always are. Nothing on this list may be
 * killed to free a port, whatever a lookup tool reports about it.
 */
async function ancestorPids(): Promise<Set<number>> {
  const chain = new Set<number>([process.pid]);
  let pid = typeof process.ppid === 'number' ? process.ppid : 0;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    chain.add(pid);
    try {
      const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 });
      const parent = Number(stdout.trim());
      if (!Number.isInteger(parent) || parent <= 1 || chain.has(parent)) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return chain;
}

export interface KillPortResult {
  /** Listeners that are gone now. */
  killed: number[];
  /** Listeners that survived SIGKILL, or that we were not allowed to signal. */
  survivors: number[];
  /** PIDs left alone because killing them would end this run. */
  skippedSelf: number[];
  /** False when no lookup tool was available, so nothing could be checked. */
  probed: boolean;
}

/**
 * Kill whatever is listening on a port.
 *
 * Agents start dev servers as children of a shell inside a tool call, so
 * terminating the agent does not reliably take the server with it. A leaked
 * server is not a tidiness problem -- it is a correctness one. The next run
 * against that port would find something already serving and report a
 * time-to-first-render near zero, for an app the agent under test never built.
 *
 * SIGTERM first: a dev server that shuts down cleanly releases the port faster
 * than one that has to be reaped, and some of them have their own children to
 * take with them.
 */
export async function killPort(port: number): Promise<KillPortResult> {
  const { pids, probed } = await listenersOn(port);
  const mine = await ancestorPids();
  const skippedSelf = pids.filter((p) => mine.has(p));
  const targets = pids.filter((p) => !mine.has(p));

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means it exists and is not ours; ESRCH means it is gone.
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(pid, sig);
    } catch { /* already gone, or not ours to signal */ }
  };

  for (const pid of targets) signal(pid, 'SIGTERM');
  for (let i = 0; i < 10 && targets.some(alive); i++) await sleep(150);
  for (const pid of targets.filter(alive)) signal(pid, 'SIGKILL');
  await sleep(150);

  const survivors = targets.filter(alive);
  return {
    killed: targets.filter((p) => !survivors.includes(p)),
    survivors,
    skippedSelf,
    probed,
  };
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
  const res = await killPort(port);
  // Give the socket a moment to be released before declaring victory.
  for (let i = 0; i < 10; i++) {
    if (!(await isOccupied(url))) return;
    await sleep(300);
  }
  throw new PortInUseError(
    `Could not free port ${port}; something is still serving at ${url}.` +
      (res.probed
        ? res.survivors.length
          ? ` PID(s) ${res.survivors.join(', ')} survived SIGKILL.`
          : ''
        : ' No way to look up the listener here: install lsof, ss or fuser.'),
  );
}
