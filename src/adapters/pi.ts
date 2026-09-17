import type { Adapter, AgentContext, AgentEvent, AgentRunHandle, IterationMode } from '../types.ts';
import { startStreamingProcess } from './streaming-process.ts';

export interface PiOptions {
  bin?: string;
  /** Pi defaults to the google provider; set both for a reproducible run. */
  provider?: string;
  model?: string;
  /** Restrict the tool set, e.g. 'read,write,edit,bash'. */
  tools?: string;
  extraArgs?: string[];
}

interface PiEvent {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
  command?: string;
  success?: boolean;
}

/**
 * Translate one line of Pi's event stream.
 *
 * Pi reports `tool_execution_start` and `tool_execution_end` keyed by
 * `toolCallId`, which gives exact tool spans rather than the boundaries this
 * harness has to infer for agents that only emit messages. Streaming
 * `message_update` deltas are dropped: they arrive per token, and keeping them
 * would bloat result.json by orders of magnitude while telling the metric
 * nothing that `message_end` does not.
 *
 * `message_end` fires for the user's own prompt as well as the assistant's
 * reply -- confirmed against the binary -- so the role is checked. Counting the
 * echo as assistant output would let a run that produced nothing look as though
 * the agent had spoken, defeating the no-output check.
 *
 * A failed turn still streams cleanly, carrying `stopReason: "error"` on the
 * assistant message. That is tagged so the run can report it instead of
 * presenting an auth failure as an agent that simply built nothing.
 */
export function translatePiEvent(ev: PiEvent, tMs: number): AgentEvent[] {
  switch (ev.type) {
    case 'message_end': {
      if (ev.message?.role !== 'assistant') {
        return [{ tMs, type: 'system', subtype: 'message_end', raw: ev }];
      }
      const failed = ev.message.stopReason === 'error';
      return [{
        tMs,
        type: 'assistant',
        subtype: failed ? 'error' : undefined,
        text: failed ? (ev.message.errorMessage ?? 'assistant turn stopped with an error') : undefined,
        raw: ev,
      }];
    }
    case 'tool_execution_start':
      return [{ tMs, type: 'tool_use', toolId: ev.toolCallId, toolName: ev.toolName, raw: ev }];
    case 'tool_execution_end':
      return [{ tMs, type: 'tool_result', toolId: ev.toolCallId, toolName: ev.toolName, raw: ev }];
    case 'agent_end':
    case 'agent_settled':
      return [{ tMs, type: 'result', subtype: ev.type, raw: ev }];
    case 'message_update':
    case 'tool_execution_update':
    case 'queue_update':
      return []; // per-token / partial noise
    case 'session':
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'compaction_start':
    case 'compaction_end':
    case 'response':
      return [{ tMs, type: 'system', subtype: ev.type, raw: ev }];
    default:
      return [{ tMs, type: 'raw', raw: ev }];
  }
}

/** Events that mean the agent has finished everything for the current prompt. */
const SETTLED = new Set(['agent_settled', 'agent_end']);

/**
 * Drives Pi through its RPC mode.
 *
 * RPC rather than `--mode json` because it is bidirectional: a follow-up prompt
 * goes into the running session, so the iteration metric measures the edit loop
 * instead of a process restart.
 *
 * Turn completion keys off `agent_settled`/`agent_end`, never `turn_end`. In Pi
 * a turn is one model call plus its tools, so a single prompt produces many of
 * them; completing on `turn_end` would declare the agent finished as soon as it
 * made its first tool call.
 */
export class PiAdapter implements Adapter {
  readonly name = 'pi';
  readonly iterationMode: IterationMode = 'live-session';
  readonly streamFidelity = 'full' as const;

  private opts: PiOptions;

  constructor(opts: PiOptions = {}) {
    this.opts = opts;
  }

  /**
   * Launch `pi` in RPC mode and submit the brief as the first prompt.
   */
  async start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle> {
    const args = ['--mode', 'rpc'];
    if (this.opts.provider) args.push('--provider', this.opts.provider);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.tools) args.push('--tools', this.opts.tools);
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    let settledThisTurn = true;
    const proc = startStreamingProcess({
      bin: this.opts.bin ?? 'pi',
      args,
      cwd: ctx.workdir,
      env: ctx.env,
      logPath: ctx.logPath,
      t0Epoch: ctx.t0Epoch,
      encodePrompt: (text) => JSON.stringify({ type: 'prompt', message: text }),
      onObject: (obj, tMs) => {
        const ev = obj as PiEvent;
        if (ev.type === 'agent_start') settledThisTurn = false;
        for (const e of translatePiEvent(ev, tMs)) {
          proc.events.push(e);
          ctx.onEvent(e);
        }
        // Both settle events can fire for one prompt; count the turn once.
        if (ev.type && SETTLED.has(ev.type) && !settledThisTurn) {
          settledThisTurn = true;
          proc.completeTurn();
        }
      },
    });

    await proc.send(prompt);
    return {
      done: proc.done,
      events: proc.events,
      send: proc.send,
      turns: proc.turns,
      waitForTurn: proc.waitForTurn,
      stop: async () => {
        await proc.writeRaw(JSON.stringify({ type: 'abort' })).catch(() => undefined);
        await proc.stop();
      },
    };
  }
}
