import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Adapter, AgentContext, AgentEvent, AgentRunHandle, IterationMode, StreamFidelity } from '../types.ts';
import { describeSpawnError } from './spawn-error.ts';
import { sleep } from '../sleep.ts';

export interface ClaudeCodeOptions {
  bin?: string;
  model?: string;
  permissionMode?: string;
  /** Required for unattended runs; the harness refuses without a sandbox ack. */
  skipPermissions?: boolean;
  extraArgs?: string[];
}

/**
 * Do these options ask the agent to bypass permissions?
 *
 * The Claude Code CLI refuses to do that as root, exiting in under a second
 * having built nothing, and three spellings reach the same check: the harness's
 * own `skipPermissions`, `--permission-mode bypassPermissions`, and either of
 * those forwarded verbatim through `extraArgs`, which `start` appends after its
 * own permission arguments. The caller checks this before a run so the refusal
 * arrives as a usage error rather than as a failed measurement.
 *
 * It takes the adapter's own options so the guard and the argument list it
 * guards read the same object and cannot drift apart.
 *
 * `--allow-dangerously-skip-permissions` is deliberately not matched: it offers
 * the mode rather than entering it, and refusing a run over a flag that would
 * have worked is the worse mistake.
 */
export function asksToBypassPermissions(opts: ClaudeCodeOptions): boolean {
  if (opts.skipPermissions || opts.permissionMode === 'bypassPermissions') return true;
  const args = opts.extraArgs ?? [];
  return args.some((a, i) =>
    a === '--dangerously-skip-permissions' ||
    a === '--permission-mode=bypassPermissions' ||
    (a === '--permission-mode' && args[i + 1] === 'bypassPermissions'));
}

interface ContentBlock {
  type?: string;
  name?: string;
  id?: string;
  text?: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  /**
   * Messages API shape, where `content` is either a list of blocks or a bare
   * string standing for a single text block. Both arrive here.
   */
  message?: { content?: string | ContentBlock[] };
  duration_api_ms?: number;
  duration_ms?: number;
  is_error?: boolean;
  /** The CLI's own summary of the turn, which on failure is the error text. */
  result?: string;
}

/**
 * The blocks of a stream message, whichever of the two shapes it arrived in.
 *
 * Claude Code uses the string shorthand for the synthetic user turns it injects
 * mid-session -- a background task reporting completion is one -- so a stream
 * can run for minutes of tool calls before the first one appears. Reading
 * `content` as always-array threw inside the stdout handler, which is not a
 * place a run survives a throw: the whole harness went down and took an
 * otherwise healthy measurement with it.
 */
function blocksOf(message: StreamEvent['message']): ContentBlock[] {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
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

  /**
   * Launch `claude` and submit the brief as the first stream-json message.
   */
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
        // Nothing this handler does is worth losing a run over. It is a stream
        // 'data' listener, so a throw here is an uncaught exception that takes
        // the process down mid-measurement -- minutes of agent work, the
        // frames, the phases, all of it gone over one event whose shape we did
        // not predict. Record the surprise as an event and keep reading.
        try {
          translateClaudeCodeEvent(ev, tMs).forEach(emit);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          rawLog.write(`\np2p: could not read stream event: ${why}\n`);
          emit({ tMs, type: 'raw', text: `unreadable event: ${why}`, raw: ev });
        }
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

}

/**
 * Map one Claude Code stream event onto the harness vocabulary.
 *
 * Tool boundaries are inferred from the tool_use blocks inside an assistant
 * message, since the stream does not mark them independently.
 *
 * A free function, and exported, so the event shapes this has to survive can be
 * pinned as tests without a live binary -- which is how the string-content case
 * above went unnoticed until a run died on it.
 */
export function translateClaudeCodeEvent(ev: StreamEvent, tMs: number): AgentEvent[] {
  if (ev.type === 'assistant') {
    const out: AgentEvent[] = [{ tMs, type: 'assistant', raw: ev }];
    for (const c of blocksOf(ev.message)) {
      if (c.type === 'tool_use') out.push({ tMs, type: 'tool_use', toolName: c.name, toolId: c.id });
    }
    return out;
  }
  if (ev.type === 'user') {
    const isResult = blocksOf(ev.message).some((c) => c.type === 'tool_result');
    return [{ tMs, type: isResult ? 'tool_result' : 'user', raw: ev }];
  }
  if (ev.type === 'result') {
    // `is_error` rather than `subtype`: an exhausted API retry arrives as
    // is_error with subtype 'success', so keying on the subtype misses exactly
    // the failure that matters most.
    const failed = ev.is_error === true;
    return [{
      tMs, type: 'result', subtype: ev.subtype, raw: ev,
      ...(failed ? { isError: true } : {}),
      ...(failed && typeof ev.result === 'string' ? { text: ev.result.slice(0, 500) } : {}),
    }];
  }
  if (ev.type === 'system') return [{ tMs, type: 'system', subtype: ev.subtype, raw: ev }];
  return [{ tMs, type: 'raw', raw: ev }];
}
