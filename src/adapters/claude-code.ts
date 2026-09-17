import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Adapter, AgentContext, AgentEvent, AgentRunHandle, IterationMode, StreamFidelity } from '../types.ts';
import { describeSpawnError } from './spawn-error.ts';

export interface ClaudeCodeOptions {
  bin?: string;
  model?: string;
  permissionMode?: string;
  /** Required for unattended runs; the harness refuses without a sandbox ack. */
  skipPermissions?: boolean;
  extraArgs?: string[];
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; name?: string; id?: string; text?: string }> };
  duration_api_ms?: number;
  duration_ms?: number;
  is_error?: boolean;
}

/**
 * Drives `claude` in streaming mode.
 *
 * Uses stream-json on both directions so a follow-up prompt can be injected
 * into the same live session. That matters for the iteration metric: restarting
 * the CLI would measure process startup and context re-read, not the edit loop
 * a person actually sits in.
 */
export class ClaudeCodeAdapter implements Adapter {
  readonly name = 'claude-code';
  // stream-json on stdin keeps one session alive across turns.
  readonly iterationMode: IterationMode = 'live-session';
  readonly streamFidelity: StreamFidelity = 'full';
  private opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = opts;
  }

  async start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle> {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--replay-user-messages',
      '--verbose',
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.skipPermissions) args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', this.opts.permissionMode ?? 'acceptEdits');
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const child: ChildProcessWithoutNullStreams = spawn(this.opts.bin ?? 'claude', args, {
      cwd: ctx.workdir,
      env: { ...process.env, ...ctx.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const rawLog = createWriteStream(ctx.logPath, { flags: 'a' });
    const events: AgentEvent[] = [];
    let reportedApiMs: number | null = null;
    let turnsCompleted = 0;
    let waiters: Array<{ after: number; resolve: () => void }> = [];

    const completeTurn = (): void => {
      turnsCompleted++;
      const ready = waiters.filter((w) => turnsCompleted > w.after);
      waiters = waiters.filter((w) => turnsCompleted <= w.after);
      ready.forEach((w) => w.resolve());
    };
    const releaseAll = (): void => {
      waiters.forEach((w) => w.resolve());
      waiters = [];
    };

    const emit = (e: AgentEvent): void => {
      events.push(e);
      ctx.onEvent(e);
    };

    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const tMs = Date.now() - ctx.t0Epoch;
      rawLog.write(chunk);
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line) as StreamEvent;
        } catch {
          emit({ tMs, type: 'raw', text: line.slice(0, 500) });
          continue;
        }
        this.translate(ev, tMs).forEach(emit);
        if (ev.type === 'result') {
          reportedApiMs = ev.duration_api_ms ?? reportedApiMs;
          completeTurn();
        }
      }
    });

    child.stderr.on('data', (c: Buffer) => rawLog.write(c));

    const done = new Promise<{ exitCode: number | null; reportedApiMs: number | null }>((resolve) => {
      const finish = (code: number | null): void => {
        rawLog.end();
        // Never leave a caller blocked on a turn that can no longer happen.
        releaseAll();
        resolve({ exitCode: code, reportedApiMs });
      };
      child.on('close', finish);
      // A binary that cannot start emits 'error' and never 'close'; unhandled,
      // it would take the harness down rather than record a failed run.
      child.on('error', (err: NodeJS.ErrnoException) => {
        rawLog.write(`\n${describeSpawnError(err, this.opts.bin ?? 'claude')}\n`);
        finish(127);
      });
    });

    // Writing to the stdin of a process that never started raises EPIPE. The
    // spawn failure is already recorded, so re-raising it here would turn a
    // recorded failed run into a thrown exception.
    child.stdin.on('error', () => undefined);

    const write = async (text: string): Promise<void> => {
      const msg = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      await new Promise<void>((res) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) return res();
        try {
          child.stdin.write(JSON.stringify(msg) + '\n', () => res());
        } catch {
          res();
        }
      });
    };

    const waitForTurn = (after: number): Promise<void> => {
      if (turnsCompleted > after) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ after, resolve }));
    };

    await write(prompt);

    return {
      done,
      events,
      send: write,
      turns: () => turnsCompleted,
      waitForTurn,
      stop: async () => {
        try {
          child.stdin.end();
        } catch { /* already closed */ }
        child.kill('SIGTERM');
        await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      },
    };
  }

  private translate(ev: StreamEvent, tMs: number): AgentEvent[] {
    if (ev.type === 'assistant') {
      const out: AgentEvent[] = [{ tMs, type: 'assistant', raw: ev }];
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'tool_use') out.push({ tMs, type: 'tool_use', toolName: c.name, toolId: c.id });
      }
      return out;
    }
    if (ev.type === 'user') {
      const blocks = ev.message?.content ?? [];
      const isResult = blocks.some((c) => c.type === 'tool_result');
      return [{ tMs, type: isResult ? 'tool_result' : 'user', raw: ev }];
    }
    if (ev.type === 'result') return [{ tMs, type: 'result', subtype: ev.subtype, raw: ev }];
    if (ev.type === 'system') return [{ tMs, type: 'system', subtype: ev.subtype, raw: ev }];
    return [{ tMs, type: 'raw', raw: ev }];
  }
}
