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
    const err = e as NodeJS.ErrnoException & {
      stdout?: string; stderr?: string; killed?: boolean; signal?: string | null; code?: unknown;
    };
    const out = typeof err.stdout === 'string' ? err.stdout : '';
    const pids = parse(out);
    // Anything parsed is real, whatever else went wrong.
    if (pids.length) return { ran: true, pids };

    // `ran` means "this tool looked and found nothing", and only a clean
    // no-match may claim it. Everything else -- the tool missing, a timeout, a
    // kill, a permission error, bad flags -- is a lookup that did not happen,
    // and saying otherwise is worse than saying nothing: `listenersOn` reports
    // the port inspected, `killPort` signals no one, and the run suppresses the
    // very warning that would explain why a leaked dev server survived.
    if (err.killed || err.signal) return { ran: false, pids: [] };
    if (typeof err.code === 'string') return { ran: false, pids: [] }; // ENOENT, EACCES, ETIMEDOUT
    if (err.stderr && err.stderr.trim()) return { ran: false, pids: [] };
    // A numeric exit status with empty output: lsof, ss and fuser all report an
    // empty match this way.
    return { ran: typeof err.code === 'number', pids: [] };
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
 *
 * Bounded by one deadline across the whole walk, not per `ps`. This runs during
 * teardown, including from a signal handler, and a teardown step that can take
 * an unbounded amount of time is a leaked dev server by another name -- which
 * is the exact thing it is here to help prevent. `process.pid` and
 * `process.ppid` need no subprocess and are the two that actually matter; the
 * rest of the chain is belt and braces, and giving up on it costs nothing
 * because the listener filter is the real protection.
 */
async function ancestorPids(budgetMs = 1500): Promise<Set<number>> {
  const chain = new Set<number>([process.pid]);
  if (typeof process.ppid === 'number' && process.ppid > 1) chain.add(process.ppid);
  const deadline = Date.now() + budgetMs;
  let pid = typeof process.ppid === 'number' ? process.ppid : 0;
  for (let depth = 0; depth < 12 && pid > 1 && Date.now() < deadline; depth++) {
    try {
      const { stdout } = await run('ps', ['-o', 'ppid=', '-p', String(pid)], {
        timeout: Math.max(200, deadline - Date.now()),
      });
      const parent = Number(stdout.trim());
      if (!Number.isInteger(parent) || parent <= 1 || chain.has(parent)) break;
      chain.add(parent);
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

  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(pid, sig);
    } catch { /* already gone, or not ours to signal */ }
  };

  // Success is measured by asking the port again, not by asking whether the pid
  // still exists.
  //
  // `process.kill(pid, 0)` succeeds for a *zombie* -- a killed child still in
  // the process table because nothing has reaped it -- so a pid check reports a
  // dead server as a survivor indefinitely. It is also the wrong question: what
  // the next run needs to know is whether anything is still listening, and a
  // process that has released the port is no longer this function's problem.
  const stillListening = async (): Promise<number[]> =>
    targets.length ? (await listenersOn(port)).pids.filter((p) => targets.includes(p)) : [];

  for (const pid of targets) signal(pid, 'SIGTERM');
  for (let i = 0; i < 8; i++) {
    await sleep(150);
    if (!(await stillListening()).length) break;
  }
  for (const pid of await stillListening()) signal(pid, 'SIGKILL');
  await sleep(200);

  const survivors = await stillListening();
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
