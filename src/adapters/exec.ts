import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Adapter, AgentContext, AgentRunHandle, IterationMode, StreamFidelity } from '../types.ts';
import { withShimPath } from '../decompose/shims.ts';
import { describeSpawnError } from './spawn-error.ts';

export interface ExecOptions {
  /** Shell command. {{PROMPT}} and {{WORKDIR}} are substituted. */
  command: string;
  /** Command for follow-up prompts. Defaults to `command`. */
  iterationCommand?: string;
  /**
   * Set to 'live-session' only if `iterationCommand` genuinely resumes the
   * previous session (a --resume/--continue flag). Left alone, a follow-up is
   * a cold restart and the report says so.
   */
  iterationMode?: IterationMode;
  shell?: string;
}

/**
 * POSIX single-quoting.
 *
 * The substituted value ends up inside a `bash -lc` command line. JSON quoting
 * is not shell quoting: a JSON string is double-quoted, and `$(...)`, backticks
 * and `${...}` all stay live inside double quotes, so a brief could run
 * commands simply by naming them in its prompt. Single quotes suppress every
 * expansion, and the only character needing care is the quote itself.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const fill = (tpl: string, prompt: string, workdir: string): string =>
  tpl.replaceAll('{{PROMPT}}', shellQuote(prompt)).replaceAll('{{WORKDIR}}', shellQuote(workdir));

/**
 * Runs any agent that is a command line.
 *
 * Two fidelity limits, both reported rather than hidden. There is no event
 * stream to mine, so model and tool time cannot be separated and that time
 * lands in the residual bucket. And a follow-up prompt re-runs the command
 * rather than continuing a session, so iteration timings include process
 * startup and context re-read unless the caller supplies an `iterationCommand`
 * that resumes and says so via `iterationMode`.
 *
 * Wall clock, the curve, and every phase the shims catch stay fully valid, so a
 * third-party agent is still comparable on the headline number.
 */
export class ExecAdapter implements Adapter {
  readonly name = 'exec';
  readonly streamFidelity: StreamFidelity = 'none';
  private opts: ExecOptions;

  constructor(opts: ExecOptions) {
    this.opts = opts;
  }

  /**
   * Restart unless the caller states that `iterationCommand` really resumes.
   */
  get iterationMode(): IterationMode {
    return this.opts.iterationMode ?? 'restart';
  }

  /**
   * Run the command, treating its exit as the end of a turn.
   */
  async start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle> {
    const log = createWriteStream(ctx.logPath, { flags: 'a' });
    let turnsCompleted = 0;
    let waiters: Array<{ after: number; resolve: () => void }> = [];
    const completeTurn = (): void => {
      turnsCompleted++;
      const ready = waiters.filter((w) => turnsCompleted > w.after);
      waiters = waiters.filter((w) => turnsCompleted <= w.after);
      ready.forEach((w) => w.resolve());
    };

    const shell = this.opts.shell ?? '/bin/bash';
    let current: ReturnType<typeof spawn> | null = null;

    const run = (cmd: string): Promise<number | null> =>
      new Promise((resolve) => {
        const child = spawn(shell, ['-lc', withShimPath(cmd)], {
          cwd: ctx.workdir,
          env: { ...process.env, ...ctx.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        current = child;
        child.stdout?.on('data', (d: Buffer) => log.write(d));
        child.stderr?.on('data', (d: Buffer) => log.write(d));
        const finish = (code: number | null): void => {
          ctx.onEvent({ tMs: Date.now() - ctx.t0Epoch, type: 'result', subtype: `exit-${code}` });
          completeTurn();
          resolve(code);
        };
        child.on('close', finish);
        // Unhandled, a failed spawn would terminate the harness instead of
        // being recorded as a failed run.
        child.on('error', (err: NodeJS.ErrnoException) => {
          log.write(`\n${describeSpawnError(err, shell)}\n`);
          finish(127);
        });
      });

    const first = run(fill(this.opts.command, prompt, ctx.workdir));
    const done = first.then((exitCode) => ({ exitCode, reportedApiMs: null }));

    return {
      done,
      events: [],
      turns: () => turnsCompleted,
      waitForTurn: (after) =>
        turnsCompleted > after
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiters.push({ after, resolve })),
      send: async (text) => {
        void run(fill(this.opts.iterationCommand ?? this.opts.command, text, ctx.workdir));
      },
      stop: async () => {
        current?.kill('SIGTERM');
        log.end();
      },
    };
  }
}
