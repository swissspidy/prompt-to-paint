import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { Adapter, AgentEvent, Brief, RunResult, IterationResult } from './types.js';
import { Prober } from './probe/prober.js';
import { entityCoverage } from './probe/entities.js';
import { setupShims } from './decompose/shims.js';
import { parsePhaseLog, attributeAgentStream, decompose } from './decompose/attribute.js';
import { computeMetrics } from './metrics/curve.js';
import { judgeRun } from './judge/judge.js';
import type { JudgeBackend } from './judge/backends.js';
import { runIteration } from './iterate.js';
import { serveStatic } from './static-server.js';
import { ensureFreePort, killPort } from './port.js';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every agent is told the same thing about where to serve, so a run is never
 * lost to a port mismatch. This is part of the protocol, not a hint: it is
 * appended verbatim to every brief for every agent.
 */
export function protocolSuffix(url: string): string {
  return `\n\nWhen the app is ready to look at, serve it at ${url} and leave the server running. Do not stop the server when you are done.`;
}

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

  let staticServer: Server | null = null;
  if (brief.target?.serveStatic) {
    staticServer = await serveStatic(workdir, port);
    log(`serving ${workdir} statically on ${url}`);
  }

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
  await prober.start();

  const agentEvents: AgentEvent[] = [];
  const agentLogPath = join(opts.runDir, 'agent.log');
  const handle = await adapter.start(brief.prompt + protocolSuffix(url), {
    workdir,
    env: shims.env,
    t0Epoch,
    onEvent: (e) => agentEvents.push(e),
    logPath: agentLogPath,
  });

  // An agent that dies on its own -- bad flags, refused permissions, a crash --
  // produces a run that looks exactly like an agent which built nothing: a
  // clean 0.000 with no errors. Catching the early exit is what separates
  // "measured a failure" from "measured nothing".
  let agentFailure: RunResult['agentFailure'] = null;
  let stopping = false;
  void handle.done.then(({ exitCode }) => {
    if (!stopping && exitCode !== 0) {
      agentFailure = { exitCode, atMs: Date.now() - t0Epoch, logPath: agentLogPath };
    }
  });

  // The cold-start window closes when the agent finishes its first turn, or at
  // the horizon, whichever comes first. Probing until the horizon regardless
  // would multiply benchmark wall time for no extra signal, since the curve
  // holds its last value anyway.
  type EndReason = 'turn' | 'horizon' | 'rendered';
  const races: Array<Promise<EndReason>> = [
    handle.waitForTurn(0).then((): EndReason => 'turn'),
    sleep(horizonMs).then((): EndReason => 'horizon'),
  ];
  if (opts.stopAfterRenderMs !== undefined) {
    const settleAfterRender = opts.stopAfterRenderMs;
    races.push(
      (async (): Promise<EndReason> => {
        while (!prober.frames.some((f) => f.class === 'render')) await sleep(250);
        await sleep(settleAfterRender);
        return 'rendered';
      })(),
    );
  }
  const ended = await Promise.race(races);
  if (ended === 'horizon')
    warnings.push(`Agent did not finish within the ${brief.horizonSec}s horizon.`);
  log(
    ended === 'horizon' ? 'horizon reached'
      : ended === 'rendered' ? 'app rendered; ending cold-start window'
      : 'agent finished first turn',
  );

  // Keep watching briefly: builds land after the agent stops talking, and some
  // agents break the page on their way out. A run that stopped on the render
  // condition has already waited, so it does not wait again.
  const settleMs = ended === 'rendered' ? 0 : (opts.settleMs ?? 15_000);
  const settleStartMs = Date.now() - t0Epoch;
  await sleep(settleMs);
  const coldEndMs = Date.now() - t0Epoch;

  // Time the harness spent deliberately watching an idle app is not
  // "unattributed": we know exactly what was happening, which is nothing. If it
  // were charged to the residual bucket, a control run that starts fast would
  // report low attribution coverage and warn that its own split is untrustworthy,
  // which is the opposite of the truth.
  const observationOnlyMs =
    (coldEndMs - settleStartMs) + (ended === 'rendered' ? (opts.stopAfterRenderMs ?? 0) : 0);
  const activeWallMs = Math.max(0, coldEndMs - observationOnlyMs);

  const iterations: IterationResult[] = [];
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
          intervalMs: opts.iterationPollMs ?? 250,
        });
        iterations.push(res);
        if (!res.ok) warnings.push(`Iteration "${spec.id}" never landed within its timeout.`);
      }
    }
  }

  stopping = true;
  await handle.stop();
  await prober.stop();
  staticServer?.close();
  // Terminating the agent does not reliably take its dev server with it, and a
  // survivor would corrupt the next run against this port.
  if (!opts.keepServer) await killPort(port);
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

  const serverReadyMs = prober.frames.find((f) => f.httpStatus !== null)?.tMs ?? null;
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
  const decomposition = decompose({
    wallMs: activeWallMs,
    phases,
    stream,
    hasStream: agentEvents.some((e) => e.type === 'assistant'),
    serverReadyMs,
    firstPaintMs,
    reportedApiMs,
  });

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
