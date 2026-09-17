import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { AgentRunHandle } from '../types.ts';
import { describeSpawnError } from './spawn-error.ts';
import { sleep } from '../sleep.ts';

export interface StreamingProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  /** Called for each parsed NDJSON object, stamped on arrival. */
  onObject: (obj: Record<string, unknown>, tMs: number) => void;
  /** Called for a stdout line that is not JSON. */
  onText?: (line: string, tMs: number) => void;
  t0Epoch: number;
  /** Serialise a prompt into the line written to stdin. */
  encodePrompt: (text: string) => string;
}

export interface StreamingProcess extends AgentRunHandle {
  /** Call from onObject when the agent has finished a turn. */
  completeTurn: () => void;
  send: (prompt: string) => Promise<void>;
  /** Write a raw control line (abort, shutdown) to stdin. */
  writeRaw: (line: string) => Promise<void>;
  setReportedApiMs: (ms: number | null) => void;
}

/**
 * Plumbing shared by agents that speak newline-delimited JSON over stdio.
 *
 * Only the wire format differs between such agents; process lifecycle, line
 * buffering, arrival stamping and the turn latch are identical. The turn latch
 * is counter-based so a caller can read the count, send a prompt, then wait on
 * that count -- a turn that completes before the caller starts waiting cannot
 * be missed.
 *
 * The claude-code adapter predates this helper and keeps its own copy: it is
 * the one adapter verified against a live binary, and rewiring it for tidiness
 * would risk the only end-to-end evidence this harness has.
 */
export function startStreamingProcess(opts: StreamingProcessOptions): StreamingProcess {
  const child: ChildProcess = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rawLog = createWriteStream(opts.logPath, { flags: 'a' });

  let turnsCompleted = 0;
  let waiters: Array<{ after: number; resolve: () => void }> = [];
  let reportedApiMs: number | null = null;

  const completeTurn = (): void => {
    turnsCompleted++;
    const ready = waiters.filter((w) => turnsCompleted > w.after);
    waiters = waiters.filter((w) => turnsCompleted <= w.after);
    ready.forEach((w) => w.resolve());
  };

  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const tMs = Date.now() - opts.t0Epoch;
    rawLog.write(chunk);
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        opts.onObject(JSON.parse(line) as Record<string, unknown>, tMs);
      } catch {
        opts.onText?.(line, tMs);
      }
    }
  });
  child.stderr?.on('data', (c: Buffer) => rawLog.write(c));

  const done = new Promise<{ exitCode: number | null; reportedApiMs: number | null }>((resolve) => {
    const finish = (code: number | null): void => {
      rawLog.end();
      // Never leave a caller blocked on a turn that can no longer happen.
      waiters.forEach((w) => w.resolve());
      waiters = [];
      resolve({ exitCode: code, reportedApiMs });
    };
    child.on('close', finish);
    // An executable that cannot start emits 'error' and never 'close'. Without
    // this the event is unhandled and takes the whole harness down instead of
    // recording a failed run.
    child.on('error', (err: NodeJS.ErrnoException) => {
      rawLog.write(`\n${describeSpawnError(err, opts.bin)}\n`);
      finish(127);
    });
  });

  // A process that failed to spawn still has a stdin stream, and writing to it
  // raises EPIPE. That failure is already recorded by the 'error' handler
  // above, so surfacing it again here would turn a recorded failed run into a
  // thrown exception that takes down the whole benchmark.
  child.stdin?.on('error', () => undefined);

  const writeRaw = (line: string): Promise<void> =>
    new Promise<void>((res) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return res();
      try {
        stdin.write(line.endsWith('\n') ? line : `${line}\n`, () => res());
      } catch {
        res();
      }
    });

  return {
    done,
    events: [],
    completeTurn,
    turns: () => turnsCompleted,
    waitForTurn: (after) =>
      turnsCompleted > after
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ after, resolve })),
    send: (prompt) => writeRaw(opts.encodePrompt(prompt)),
    writeRaw,
    setReportedApiMs: (ms) => {
      reportedApiMs = ms;
    },
    stop: async () => {
      try {
        child.stdin?.end();
      } catch { /* already closed */ }
      child.kill('SIGTERM');
      // The grace timer must not outlive the process it was waiting for: a
      // pending one holds the event loop open for its full five seconds after
      // the agent has already exited.
      const grace = new AbortController();
      try {
        await Promise.race([done, sleep(5000, grace.signal)]);
      } finally {
        grace.abort();
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
