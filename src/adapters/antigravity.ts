import { resolve } from 'node:path';
import type { Adapter, AgentContext, AgentEvent, AgentRunHandle, IterationMode } from '../types.ts';
import { startStreamingProcess } from './streaming-process.ts';

export interface AntigravityOptions {
  bin?: string;
  model?: string;
  /** low | medium | high */
  effort?: string;
  agent?: string;
  skipPermissions?: boolean;
  /** agy defaults to a 5m print timeout, far below a realistic build horizon. */
  printTimeout?: string;
  /**
   * Bind the workdir with `--add-dir`. On by default; see the note on
   * `WORKSPACE_NOTE` for why this is a default rather than a certainty, and
   * turn it off to test another mechanism.
   */
  addDir?: boolean;
  extraArgs?: string[];
}

/**
 * Why this adapter passes `--add-dir`, and why that is not settled.
 *
 * Antigravity's own docs say a conversation that is not in a Project "runs in
 * an isolated local scratch folder", and that is exactly what a run of this
 * harness produced: the agent built and served an app out of
 * `~/.gemini/antigravity-cli/scratch/<name>/`, so the page rendered, the curve
 * was a curve, and the workdir the harness handed it stayed empty. Nothing in
 * the run directory reproduced the thing that had just been measured.
 *
 * Two mechanisms could bind the workdir instead, and the published headless
 * documentation describes neither: `--add-dir <path>`, which the CLI reference
 * documents as "add a directory to the workspace" and which another harness
 * adopted for this exact symptom, and Antigravity's Project concept
 * (`--project`, `--new-project`), which is the feature the scratch-folder
 * sentence is contrasting against.
 *
 * `--add-dir` is the default because it is the narrower claim -- it names a
 * directory rather than creating persistent state on the user's machine -- but
 * it has not been checked against a real binary here. `--no-add-dir` and
 * `--agent-arg` exist so the alternative can be tried without editing this
 * file, and the run verifies the outcome either way: the adapter reads the cwd
 * agy reports in its `init` event, and the harness fails the run loudly when it
 * is not the directory it handed over.
 */
const WORKSPACE_NOTE =
  'agy runs conversations outside a Project in an isolated scratch folder. The harness passes ' +
  '--add-dir to bind the run workdir; if that is not the right mechanism for your agy version, ' +
  'pass --no-add-dir and try --agent-arg --new-project (or --agent-arg --project=<id>).';

interface StepLike {
  [k: string]: unknown;
}

export interface ToolSignal {
  id: string;
  name: string;
  phase: 'start' | 'end';
}

const START_WORDS = new Set(['start', 'started', 'starting', 'running', 'in_progress', 'pending']);
const END_WORDS = new Set(['end', 'ended', 'complete', 'completed', 'finished', 'success', 'succeeded', 'error', 'failed', 'done']);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Best-effort extraction of a tool boundary from a `step_update`.
 *
 * Antigravity's headless docs specify the outer event names (`init`,
 * `step_update`, `result`) but not what a step carries, and this adapter was
 * written without a binary to check against. So this probes the shapes such
 * payloads usually take and reports whether it found anything, rather than
 * assuming a layout. If it finds nothing, the adapter downgrades its own
 * fidelity instead of letting tool time be silently booked as thinking -- the
 * failure this harness exists to avoid.
 */
export function detectToolSignal(step: StepLike): ToolSignal | null {
  const nested = (step.tool ?? step.tool_call ?? step.toolCall ?? step) as StepLike;
  if (!nested || typeof nested !== 'object') return null;

  const name =
    str(nested.tool_name) ?? str(nested.toolName) ?? str(nested.name) ?? str(step.tool_name) ?? str(step.toolName);
  if (!name) return null;

  const rawPhase = (
    str(nested.status) ?? str(nested.state) ?? str(nested.phase) ??
    str(step.status) ?? str(step.state) ?? str(step.phase) ?? ''
  ).toLowerCase();
  if (!rawPhase) return null;

  const phase = START_WORDS.has(rawPhase) ? 'start' : END_WORDS.has(rawPhase) ? 'end' : null;
  if (!phase) return null;

  const id =
    str(nested.tool_call_id) ?? str(nested.toolCallId) ?? str(nested.id) ??
    str(step.tool_call_id) ?? str(step.toolCallId) ?? str(step.id) ?? name;

  return { id, name, phase };
}

/**
 * Drives the Antigravity CLI (`agy`) in headless streaming mode.
 *
 * Uses `--input-format stream-json` so follow-up prompts reach the same
 * process; the docs note that subsequent turns then skip startup and reuse the
 * warmed conversation, which is exactly the loop the iteration metric wants.
 *
 * Flags follow the published headless documentation. They have not been run
 * against a real binary here -- Antigravity ships through Google's own
 * installer rather than npm -- so treat a first run as a smoke test and check
 * agent.log if nothing appears.
 */
export class AntigravityAdapter implements Adapter {
  readonly name = 'antigravity';
  readonly iterationMode: IterationMode = 'live-session';

  private sawToolBoundary = false;
  private sawSteps = false;
  private initCwd: string | null = null;

  /** The cwd agy announced in its `init` event, if it announced one. */
  get reportedWorkdir(): string | null {
    return this.initCwd;
  }

  /** Printed with the mismatch warning, so the next thing to try is in the message. */
  static readonly workspaceNote = WORKSPACE_NOTE;

  private opts: AntigravityOptions;

  constructor(opts: AntigravityOptions = {}) {
    this.opts = opts;
  }

  /**
   * Full only once real tool boundaries have been seen. Otherwise the model and
   * tool split is not supportable and the report routes that time to the
   * residual with an explanation.
   */
  get streamFidelity(): 'full' | 'turns-only' | 'none' {
    if (this.sawToolBoundary) return 'full';
    return this.sawSteps ? 'turns-only' : 'none';
  }

  /**
   * Launch `agy` and submit the brief as the first stream-json message.
   */
  async start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle> {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    // See WORKSPACE_NOTE: a child-process cwd alone does not bind the workdir,
    // and an unbound session works in agy's own scratch folder.
    if (this.opts.addDir !== false) args.push('--add-dir', resolve(ctx.workdir));
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    if (this.opts.agent) args.push('--agent', this.opts.agent);
    // The 5m default would cut off a realistic greenfield build mid-run.
    args.push('--print-timeout', this.opts.printTimeout ?? '30m');
    if (this.opts.skipPermissions) args.push('--dangerously-skip-permissions');
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

    const proc = startStreamingProcess({
      bin: this.opts.bin ?? 'agy',
      args,
      cwd: ctx.workdir,
      env: ctx.env,
      logPath: ctx.logPath,
      t0Epoch: ctx.t0Epoch,
      encodePrompt: (text) => JSON.stringify({ event: 'user', message: { content: text } }),
      onObject: (obj, tMs) => {
        for (const e of this.translate(obj, tMs)) {
          proc.events.push(e);
          ctx.onEvent(e);
        }
        const kind = (obj.event ?? obj.type) as string | undefined;
        if (kind === 'result') proc.completeTurn();
      },
    });

    await proc.send(prompt);
    return {
      done: proc.done,
      events: proc.events,
      send: proc.send,
      turns: proc.turns,
      waitForTurn: proc.waitForTurn,
      stop: proc.stop,
    };
  }

  /** Public so the wire format can be tested without spawning a binary. */
  translate(obj: Record<string, unknown>, tMs: number): AgentEvent[] {
    const kind = (obj.event ?? obj.type) as string | undefined;
    if (kind === 'init') {
      // The headless docs specify that `init` carries a `cwd`. It is the only
      // thing agy says about where it is actually working, and comparing it to
      // the directory we handed over is the difference between finding out now
      // and finding out from an empty workdir after the run.
      const cwd = (obj.cwd ?? (obj.data as Record<string, unknown> | undefined)?.cwd) as unknown;
      if (typeof cwd === 'string' && cwd) this.initCwd = cwd;
      return [{ tMs, type: 'system', subtype: 'init', raw: obj }];
    }
    if (kind === 'result') {
      // `duration_seconds` is wall clock for the turn, not API time, so it is
      // deliberately not fed to the model-time cross-check: comparing wall
      // clock against attributed thinking would invent a disagreement.
      return [{ tMs, type: 'result', subtype: 'result', raw: obj }];
    }
    if (kind === 'step_update') {
      this.sawSteps = true;
      const step = (obj.step ?? obj.data ?? obj) as StepLike;
      const tool = detectToolSignal(step);
      if (tool) {
        this.sawToolBoundary = true;
        return [
          {
            tMs,
            type: tool.phase === 'start' ? 'tool_use' : 'tool_result',
            toolId: tool.id,
            toolName: tool.name,
            raw: obj,
          },
        ];
      }
      return [{ tMs, type: 'assistant', subtype: 'step_update', raw: obj }];
    }
    return [{ tMs, type: 'raw', raw: obj }];
  }
}
