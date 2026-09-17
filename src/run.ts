import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Adapter, AgentEvent, AgentRunHandle, Brief, RunResult, IterationResult } from './types.ts';
import { Prober } from './probe/prober.ts';
import { entityCoverage } from './probe/entities.ts';
import { setupShims } from './decompose/shims.ts';
import { parsePhaseLog, attributeAgentStream, decompose } from './decompose/attribute.ts';
import { computeMetrics } from './metrics/curve.ts';
import { judgeRun } from './judge/judge.ts';
import type { JudgeBackend } from './judge/backends.ts';
import { runIteration } from './iterate.ts';
import { serveStatic } from './static-server.ts';
import { ensureFreePort, killPort } from './port.ts';
import { sleep } from './sleep.ts';

export interface RunOptions {
  brief: Brief;
  /** Where the brief came from; recorded so `rescore` can find it again. */
  briefPath?: string;
  adapter: Adapter;
  runDir: string;
  label: string;
  judgeBackend: JudgeBackend;
  /** Extra observation after the agent stops, to catch late breakage. */
  settleMs?: number;
  /**
   * End the cold-start window this long after the app first renders, instead
   * of waiting for the agent to finish. A dev server never exits, so a control
   * run would otherwise always burn the full horizon.
   */
  stopAfterRenderMs?: number;
  /** Free the target port before starting instead of refusing to run. */
  killPort?: boolean;
  /** Leave any server the run started alive (for debugging a finished run). */
  keepServer?: boolean;
  pollMs?: number;
  iterationPollMs?: number;
  skipIterations?: boolean;
  onLog?: (msg: string) => void;
}

/**
 * Every agent is told the same thing about where to serve, so a run is never
 * lost to a port mismatch. This is part of the protocol, not a hint: it is
 * appended verbatim to every brief for every agent.
 */
export function protocolSuffix(url: string): string {
  return `\n\nWhen the app is ready to look at, serve it at ${url} and leave the server running. Do not stop the server when you are done.`;
}

/**
 * Run one agent against one brief and produce every number in the report.
 *
 * The run is measured, then torn down, then analysed. Judging happens after
 * cleanup on purpose: it can take minutes, and nothing it does should sit
 * inside the window being measured or hold the browser open.
 */
export async function runBenchmark(opts: RunOptions): Promise<RunResult> {
  const { brief, adapter } = opts;
  const log = opts.onLog ?? (() => {});
  const runId = `${brief.id}-${adapter.name}-${Date.now().toString(36)}`;
  const workdir = join(opts.runDir, 'workdir');
  const framesDir = join(opts.runDir, 'frames');
  await mkdir(workdir, { recursive: true });

  const port = brief.target?.port ?? 5173;
  const url = brief.target?.url ?? `http://127.0.0.1:${port}/`;
  const horizonMs = brief.horizonSec * 1000;
  const warnings: string[] = [];

  // Refuse to measure whatever a previous run left behind.
  await ensureFreePort(url, port, opts.killPort ?? false);

  const shims = await setupShims(opts.runDir);
  const t0Epoch = Date.now();

  const prober = new Prober({
    url,
    framesDir,
    t0Epoch,
    intervalMs: opts.pollMs ?? 1000,
    analyze: (text) => {
      const c = entityCoverage(text, brief.entities);
      return { entityCoverage: c.coverage, entitiesFound: c.found };
    },
  });

  const agentEvents: AgentEvent[] = [];
  const agentLogPath = join(opts.runDir, 'agent.log');
  const iterations: IterationResult[] = [];

  let staticServer: Server | null = null;
  let handle: AgentRunHandle | null = null;
  let agentFailure: RunResult['agentFailure'] = null;
  let stopping = false;
  let coldEndMs = 0;
  let activeWallMs = 0;
  let observationOnlyMs = 0;
  let cleaned = false;

  /**
   * Stop everything this run started.
   *
   * Runs before the analysis rather than after it, because judging can take
   * minutes and there is no reason to hold Chromium, the agent and its dev
   * server open through it. Each step is independently guarded so one failure
   * cannot strand the rest, and the whole thing is idempotent so the success
   * path and the failure path can both call it.
   */
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    stopping = true;
    if (handle) await handle.stop().catch(() => undefined);
    await prober.stop().catch(() => undefined);
    try {
      staticServer?.close();
    } catch { /* already closed */ }
    // Terminating the agent does not reliably take its dev server with it, and
    // a survivor would corrupt the next run against this port.
    if (!opts.keepServer) await killPort(port).catch(() => undefined);
  };

  try {
    if (brief.target?.serveStatic) {
      staticServer = await serveStatic(workdir, port);
      log(`serving ${workdir} statically on ${url}`);
    }

    await prober.start();

    handle = await adapter.start(brief.prompt + protocolSuffix(url), {
      workdir,
      env: shims.env,
      t0Epoch,
      onEvent: (e) => agentEvents.push(e),
      logPath: agentLogPath,
    });

    // An agent that dies on its own -- bad flags, refused permissions, a crash
    // -- produces a run that looks exactly like an agent which built nothing: a
    // clean 0.000 with no errors. Catching the early exit is what separates
    // "measured a failure" from "measured nothing".
    void handle.done.then(({ exitCode }) => {
      if (!stopping && exitCode !== 0) {
        agentFailure = { exitCode, atMs: Date.now() - t0Epoch, logPath: agentLogPath };
      }
    });

    // The cold-start window closes when the agent finishes its first turn, or
    // at the horizon, whichever comes first. Probing until the horizon
    // regardless would multiply benchmark wall time for no extra signal, since
    // the curve holds its last value anyway.
    type EndReason = 'turn' | 'horizon' | 'rendered';
    // The losing branches keep running after Promise.race resolves, and a
    // pending timer holds the whole process open. Waiting out an eight-minute
    // horizon that the agent beat in thirty seconds is not a hypothetical: the
    // CLI printed its report and then sat idle for the rest of it. Aborting
    // stops the render poll and clears the horizon timer together.
    const raceCtl = new AbortController();
    const races: Array<Promise<EndReason>> = [
      handle.waitForTurn(0).then((): EndReason => 'turn'),
      sleep(horizonMs, raceCtl.signal).then((): EndReason => 'horizon'),
    ];
    if (opts.stopAfterRenderMs !== undefined) {
      const settleAfterRender = opts.stopAfterRenderMs;
      const { signal } = raceCtl;
      races.push(
        (async (): Promise<EndReason> => {
          while (!signal.aborted && !prober.frames.some((f) => f.class === 'render'))
            await sleep(250, signal);
          if (!signal.aborted) await sleep(settleAfterRender, signal);
          return 'rendered';
        })(),
      );
    }
    let ended: EndReason;
    try {
      ended = await Promise.race(races);
    } finally {
      raceCtl.abort();
    }

    if (ended === 'horizon')
      warnings.push(`Agent did not finish within the ${brief.horizonSec}s horizon.`);
    log(
      ended === 'horizon' ? 'horizon reached'
        : ended === 'rendered' ? 'app rendered; ending cold-start window'
        : 'agent finished first turn',
    );

    // Keep watching briefly: builds land after the agent stops talking, and
    // some agents break the page on their way out. A run that stopped on the
    // render condition has already waited, so it does not wait again.
    const settleMs = ended === 'rendered' ? 0 : (opts.settleMs ?? 15_000);
    const settleStartMs = Date.now() - t0Epoch;
    await sleep(settleMs);
    coldEndMs = Date.now() - t0Epoch;

    // Time the harness spent deliberately watching an idle app is not
    // "unattributed": we know exactly what was happening, which is nothing. If
    // it were charged to the residual bucket, a control run that starts fast
    // would report low attribution coverage and warn that its own split is
    // untrustworthy, which is the opposite of the truth.
    observationOnlyMs =
      (coldEndMs - settleStartMs) + (ended === 'rendered' ? (opts.stopAfterRenderMs ?? 0) : 0);
    activeWallMs = Math.max(0, coldEndMs - observationOnlyMs);

    const rendering = prober.frames.some((f) => f.class === 'render');
    if (!opts.skipIterations && brief.iterations?.length) {
      if (!rendering) {
        warnings.push('Skipped iterations: the app never rendered, so there is nothing to edit.');
      } else if (!handle.send) {
        warnings.push('Skipped iterations: this adapter cannot send follow-up prompts.');
      } else {
        for (const spec of brief.iterations) {
          log(`iteration: ${spec.id}`);
          const res = await runIteration(spec, {
            prober,
            handle,
            t0Epoch,
            mode: adapter.iterationMode ?? 'restart',
            intervalMs: opts.iterationPollMs ?? 250,
          });
          iterations.push(res);
          if (res.baselineAlreadyPassing) {
            warnings.push(
              `Iteration "${spec.id}" is void: its check already passed before the prompt was sent, so it cannot measure this edit. Fix the check in the brief.`,
            );
          } else if (!res.ok) {
            warnings.push(`Iteration "${spec.id}" never landed within its timeout.`);
          }
        }
      }
    }
  } finally {
    // A throw anywhere above would otherwise leave Chromium, the static server,
    // the agent and its dev server running, and a survivor on this port would
    // corrupt the next run.
    await cleanup();
  }

  if (coldEndMs === 0) coldEndMs = Date.now() - t0Epoch;
  const wallMs = Date.now() - t0Epoch;

  // ---- analysis (strictly after the run; never inside the measured window) --
  const phaseText = existsSync(shims.phaseLog) ? await readFile(shims.phaseLog, 'utf8') : '';
  const phases = parsePhaseLog(phaseText, t0Epoch);

  // The cold-start curve must not see the iteration edits: turning the header
  // blue is a different experiment, and scoring those frames against the
  // original brief would blend two measurements into one number.
  const coldFrames = prober.frames.filter((f) => f.tMs <= coldEndMs);

  log(`judging ${coldFrames.length} cold-start frames`);
  const judged = await judgeRun(coldFrames, brief, {
    backend: opts.judgeBackend,
    onProgress: (d, t) => d % 5 === 0 && log(`  judged ${d}/${t}`),
  });
  warnings.push(...judged.warnings);

  // "Ready" means actually serving the app. The prober keeps retrying a 4xx or
  // 5xx, so counting the first error response as ready would cut dev-server
  // boot short and start the first-paint window before anything could paint.
  const serverReadyMs =
    prober.frames.find((f) => f.httpStatus !== null && f.httpStatus < 400)?.tMs ?? null;
  const firstPaintMs = judged.frames.find((f) => f.class === 'render')?.tMs ?? null;

  const curve = computeMetrics(judged.frames, {
    horizonMs,
    runEndMs: coldEndMs,
    reviewableThreshold: brief.reviewableThreshold,
  });

  // Compare like with like: the agent's self-reported API time for the
  // cold-start turn, not the whole session. Reading it off the final result
  // event would fold in the iteration turns and show a phantom disagreement.
  const coldResult = agentEvents.find((e) => e.type === 'result' && e.tMs <= coldEndMs);
  const reportedApiMs =
    (coldResult?.raw as { duration_api_ms?: number } | undefined)?.duration_api_ms ?? null;

  const stream = attributeAgentStream(agentEvents, coldEndMs);
  // An adapter whose stream shows turns but not tool boundaries cannot support
  // a model-versus-tool split, so that time is left unattributed rather than
  // all booked as thinking.
  const fidelity = adapter.streamFidelity ?? 'none';
  const sawActivity = agentEvents.some((e) => e.type === 'assistant' || e.type === 'tool_use');
  if (fidelity === 'turns-only' && sawActivity) {
    warnings.push(
      `The ${adapter.name} adapter could see this run's turns but not its tool boundaries, so thinking and tool time are not separated and land in the residual. The toolchain phases from the shims are unaffected.`,
    );
  }
  const decomposition = decompose({
    wallMs: activeWallMs,
    phases,
    stream: fidelity === 'full' ? stream : { model: [], tool: [] },
    hasStream: fidelity === 'full' && sawActivity,
    serverReadyMs,
    firstPaintMs,
    reportedApiMs,
  });

  if (iterations.some((i) => i.mode === 'restart')) {
    warnings.push(
      'Iteration timings come from re-running the agent, not from continuing a live session, so they include process startup and however long the agent takes to re-read the project. They are not comparable to live-session iteration numbers from another adapter.',
    );
  }
  const erroredTurns = agentEvents.filter((e) => e.type === 'assistant' && e.subtype === 'error');
  if (erroredTurns.length) {
    warnings.unshift(
      `AGENT REPORTED ERRORS: ${erroredTurns.length} turn(s) ended in an error (first: ${
        erroredTurns[0]?.text ?? 'unknown'
      }). These numbers describe a failed run, not agent performance.`,
    );
  }
  if (agentFailure) {
    const f = agentFailure as NonNullable<RunResult['agentFailure']>;
    warnings.unshift(
      `AGENT FAILED: the agent process exited with code ${f.exitCode} after ${(f.atMs / 1000).toFixed(1)}s, before the harness stopped it. ` +
        `These numbers measure a failed run, not agent performance. See ${f.logPath}.`,
    );
  } else if (adapter.name !== 'exec' && !agentEvents.some((e) => e.type === 'assistant')) {
    warnings.unshift(
      'AGENT PRODUCED NO OUTPUT: no assistant events were seen. The adapter may not have started the agent correctly; check agent.log.',
    );
  }
  if (prober.skippedTicks > 0)
    warnings.push(`${prober.skippedTicks} poll ticks were skipped because a capture overran the interval.`);
  if (prober.reloadCount > prober.frames.length * 0.25)
    warnings.push(
      `The prober reloaded ${prober.reloadCount} times across ${prober.frames.length} frames. The served document changes on nearly every request (a per-request nonce or timestamp), so reload-driven timings here are unreliable.`,
    );

  // Entity coverage was computed during the run from the full text; what is
  // stored is for eyeballing why a frame scored as it did. Keeping 20KB of DOM
  // text per frame would make result.json hundreds of megabytes on a long run.
  const STORED_TEXT = 4000;
  const slimFrames = judged.frames.map((f) =>
    f.text.length > STORED_TEXT
      ? { ...f, text: `${f.text.slice(0, STORED_TEXT)}\n...[truncated ${f.text.length - STORED_TEXT} chars]` }
      : f,
  );

  const result: RunResult = {
    schema: 1,
    runId,
    brief: brief.id,
    briefPath: opts.briefPath ?? '',
    adapter: adapter.name,
    label: opts.label,
    startedAt: new Date(t0Epoch).toISOString(),
    t0Epoch,
    wallMs,
    url,
    curve,
    decomposition: {
      ...decomposition,
      notes: [
        ...decomposition.notes,
        ...(observationOnlyMs > 1000
          ? [
              `Excludes ${(observationOnlyMs / 1000).toFixed(1)}s of deliberate idle observation (settle window); the curve still covers it.`,
            ]
          : []),
      ],
    },
    iterations,
    frames: slimFrames,
    phases,
    agentEvents,
    judge: {
      backend: opts.judgeBackend.name,
      model: opts.judgeBackend.model,
      framesJudged: judged.framesJudged,
      degraded: judged.degraded,
    },
    agentFailure,
    warnings,
  };

  await writeFile(join(opts.runDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
