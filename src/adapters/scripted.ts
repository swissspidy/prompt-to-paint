import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Adapter, AgentContext, AgentRunHandle, IterationMode, StreamFidelity } from '../types.js';
import { withShimPath } from '../decompose/shims.js';

export interface ScriptedStep {
  /** When to fire, relative to the start of this turn. */
  atMs: number;
  write?: { path: string; content: string };
  sh?: string;
  /** Simulated thinking, recorded as a model interval in the event stream. */
  think?: number;
}

export interface ScriptedOptions {
  steps: ScriptedStep[];
  /** Steps for follow-up prompts, keyed by iteration id or index. */
  iterationSteps?: Record<string, ScriptedStep[]>;
}

/**
 * An agent with a known-correct answer.
 *
 * Every other adapter measures something noisy and unrepeatable, which makes it
 * impossible to tell a harness bug from agent variance. This one renders on a
 * schedule the test already knows, so the pipeline can be checked against a
 * signal whose true AUC, TTFNBR and TTFRR were computed by hand. It is a
 * calibration instrument, not a mock.
 */
export class ScriptedAdapter implements Adapter {
  readonly name = 'scripted';
  readonly iterationMode: IterationMode = 'live-session';
  readonly streamFidelity: StreamFidelity = 'full';
  constructor(private opts: ScriptedOptions) {}

  async start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle> {
    let turnsCompleted = 0;
    let waiters: Array<{ after: number; resolve: () => void }> = [];
    const timers: NodeJS.Timeout[] = [];
    let stopped = false;

    const completeTurn = (): void => {
      turnsCompleted++;
      const ready = waiters.filter((w) => turnsCompleted > w.after);
      waiters = waiters.filter((w) => turnsCompleted <= w.after);
      ready.forEach((w) => w.resolve());
    };

    const applyStep = async (s: ScriptedStep): Promise<void> => {
      if (stopped) return;
      const tMs = Date.now() - ctx.t0Epoch;
      if (s.write) {
        const full = join(ctx.workdir, s.write.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, s.write.content);
        ctx.onEvent({ tMs, type: 'assistant', text: `write ${s.write.path}`, raw: { message: { content: [{ type: 'tool_use' }] } } });
        ctx.onEvent({ tMs: Date.now() - ctx.t0Epoch, type: 'tool_result' });
      }
      if (s.sh) {
        ctx.onEvent({ tMs, type: 'assistant', text: s.sh, raw: { message: { content: [{ type: 'tool_use' }] } } });
        await new Promise<void>((resolve) => {
          const child = spawn('/bin/bash', ['-lc', withShimPath(s.sh!)], {
            cwd: ctx.workdir,
            env: { ...process.env, ...ctx.env },
            stdio: 'ignore',
            detached: false,
          });
          // Dev servers never exit; give them a moment then move on.
          const t = setTimeout(() => resolve(), 1500);
          timers.push(t);
          child.on('close', () => {
            clearTimeout(t);
            resolve();
          });
        });
        ctx.onEvent({ tMs: Date.now() - ctx.t0Epoch, type: 'tool_result' });
      }
    };

    const runTimeline = async (steps: ScriptedStep[]): Promise<void> => {
      const base = Date.now();
      for (const s of [...steps].sort((a, b) => a.atMs - b.atMs)) {
        const wait = Math.max(0, s.atMs - (Date.now() - base));
        await new Promise<void>((r) => {
          const t = setTimeout(r, wait);
          timers.push(t);
        });
        await applyStep(s);
      }
      ctx.onEvent({ tMs: Date.now() - ctx.t0Epoch, type: 'result', subtype: 'success' });
      completeTurn();
    };

    const first = runTimeline(this.opts.steps);
    let iterationIndex = 0;

    return {
      done: first.then(() => ({ exitCode: 0, reportedApiMs: null })),
      events: [],
      turns: () => turnsCompleted,
      waitForTurn: (after) =>
        turnsCompleted > after
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiters.push({ after, resolve })),
      send: async (text) => {
        const key = String(iterationIndex++);
        const steps = this.opts.iterationSteps?.[key] ?? this.opts.iterationSteps?.[text] ?? [];
        void runTimeline(steps);
      },
      stop: async () => {
        stopped = true;
        timers.forEach(clearTimeout);
      },
    };
  }
}
