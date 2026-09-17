import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type {
  Adapter, AgentEvent, AgentRunHandle, Brief, Frame, RunEndReason, RunResult, IterationResult,
  ScoredFrame,
} from './types.ts';
import { Prober } from './probe/prober.ts';
import { entityCoverage } from './probe/entities.ts';
import { setupShims } from './decompose/shims.ts';
import { parsePhaseLog, attributeAgentStream, decompose } from './decompose/attribute.ts';
import { computeMetrics } from './metrics/curve.ts';
import { judgeRun, mechanicalScores } from './judge/judge.ts';
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
  /**
   * End the cold-start window after this long with no visible change, no agent
   * output and no toolchain activity. 0 disables it. The curve holds its last
   * value to the horizon either way, so stopping a settled run early changes
   * the AUC by nothing and saves the rest of the horizon.
   */
  quietForMs?: number;
  /** Drop the "render something early" clause from the protocol suffix. */
  noRenderEarly?: boolean;
  /** Show the prober's browser window. Needs a display. */
  headed?: boolean;
  /** Record the prober's session to this path as WebM. */
  videoPath?: string;
  onLog?: (msg: string) => void;
  onFrame?: (f: Frame) => void;
  onAgentEvent?: (e: AgentEvent) => void;
}

/**
 * The file an agent creates to say it is finished.
 *
 * A sentinel rather than a stream event because it works for every adapter,
 * including the ones whose event stream this harness can only partly read. An
 * agent whose last act is starting a dev server never emits a turn-complete
 * event at all -- the server holds the tool call open forever -- so without
 * this the run had no way to end except the horizon.
 */
export const DONE_SENTINEL = '.p2p-done';

/**
 * Extra observation after the final iteration lands, before teardown.
 *
 * Short on purpose: it is outside every measured window, so it buys the last
 * edit's finished state without touching a single number.
 */
export const ITERATION_SETTLE_MS = 3000;

export interface ProtocolOptions {
  /**
   * Ask for an early rough render. On by default, and identical for every
   * agent, so the metric measures who acts on it rather than who happens to
   * work that way. Turn it off to measure unprompted behaviour instead --
   * a different experiment, and not comparable with the default one.
   */
  renderEarly?: boolean;
}

/**
 * Every agent is told the same thing about how the run is observed, so a run
 * is never lost to a port mismatch, a foreground dev server, or an agent that
 * builds the whole app before serving any of it. This is part of the protocol,
 * not a hint: it is appended verbatim to every brief for every agent.
 *
 * The earlier version of this said "when the app is ready to look at, serve
 * it", which asked for exactly the behaviour the metric is built to catch --
 * every frame before the end blank, and the first render already the finished
 * app. Telling every agent the clock is running is the fair version of that
 * instruction.
 */
export function protocolSuffix(url: string, opts: ProtocolOptions = {}): string {
  const L = [
    '',
    '---',
    'How this run is observed:',
    '',
    `- A browser is already open at ${url} and screenshots it every second, starting`,
    '  now. Serve the app there, and leave the server running when you are done.',
  ];
  if (opts.renderEarly !== false)
    L.push(
      '- Get something on screen as early as you can and then refine it in place. A',
      '  rough page that renders in the first minute counts for more here than a',
      '  perfect one that only appears at the end.',
    );
  L.push(
    '- Start the dev server in the background so it does not block you, e.g.',
    '  `npm run dev > dev.log 2>&1 &`. A server left in the foreground never returns,',
    '  so your turn can never finish.',
    `- When you consider the app done, create an empty file named \`${DONE_SENTINEL}\` in the`,
    '  project root. That is what stops the clock. Do not create it before the app is',
    '  serving, and do not stop the server after creating it.',
  );
  return `\n\n${L.join('\n')}\n`;
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
    headed: opts.headed,
    videoPath: opts.videoPath,
    onFrame: opts.onFrame,
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
  let lastIterationOk = false;
  let endReason: RunEndReason = 'horizon';

  // Shared by every branch of the end-of-window race below. The losing branches
  // keep running after Promise.race resolves, and a pending timer holds the
  // whole process open, so they all take this signal.
  const raceCtl = new AbortController();
  const { signal } = raceCtl;
  const quietForMs = opts.quietForMs ?? 120_000;

  /**
   * Resolve once the run has plainly stopped moving.
   *
   * Three independent signals have to agree, because any one of them alone has
   * a false positive that would cut a working run short. The page can sit
   * unchanged through a long install; the agent can go quiet while a build
   * runs; a shimmed command can be running with nothing to show for it yet. All
   * three idle at once, with something already on screen, is a finished run.
   *
   * Cheap on purpose: the frame scan walks forward from a cursor and the
   * toolchain check is one stat() of the phase log, so this costs nothing
   * against the thing it is watching.
   */
  const waitForQuiet = async (): Promise<RunEndReason> => {
    let cursor = 0;
    let lastVisualChangeMs = 0;
    let prev: Frame | null = null;
    let lastPhaseSize = -1;
    let lastPhaseChangeMs = 0;
    for (;;) {
      await sleep(Math.min(5000, Math.max(1000, quietForMs / 10)), signal);
      // Losing the race means this promise is never awaited again; returning
      // is only a way to stop looping.
      if (signal.aborted) return 'quiet';
      for (; cursor < prober.frames.length; cursor++) {
        const f = prober.frames[cursor]!;
        const moved =
          prev === null ||
          f.dhash !== prev.dhash ||
          f.colorSig !== prev.colorSig ||
          f.domSignature !== prev.domSignature ||
          f.class !== prev.class;
        if (moved) lastVisualChangeMs = f.tMs;
        prev = f;
      }
      const size = await stat(shims.phaseLog).then((st) => st.size).catch(() => -1);
      const nowMs = Date.now() - t0Epoch;
      if (size !== lastPhaseSize) {
        lastPhaseSize = size;
        lastPhaseChangeMs = nowMs;
      }
      if (!prober.frames.some((f) => f.class === 'render')) continue;
      const lastAgentMs = agentEvents.at(-1)?.tMs ?? 0;
      const lastAnythingMs = Math.max(lastVisualChangeMs, lastAgentMs, lastPhaseChangeMs);
      if (nowMs - lastAnythingMs >= quietForMs) return 'quiet';
    }
  };

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
    // The prober stops first. Killing the agent usually takes its dev server
    // with it, and handle.stop() waits up to five seconds for that to happen,
    // so probing through it appended frames of a torn-down app to the
    // timeline: the tail of frames/ was a dead page rather than the finished
    // one. Those are not observations of the run, they are observations of the
    // teardown.
    await prober.stop().catch(() => undefined);
    if (handle) await handle.stop().catch(() => undefined);
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

    const prompt =
      brief.prompt + protocolSuffix(url, { renderEarly: !opts.noRenderEarly });
    await writeFile(join(opts.runDir, 'prompt.txt'), prompt);
    handle = await adapter.start(prompt, {
      workdir,
      env: shims.env,
      t0Epoch,
      onEvent: (e) => {
        agentEvents.push(e);
        opts.onAgentEvent?.(e);
      },
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

    // The cold-start window closes on whichever of these comes first: the
    // agent's first turn completing, the agent creating the done sentinel,
    // quiescence, the optional stop-after-render condition, or the horizon.
    // Probing until the horizon regardless would multiply benchmark wall time
    // for no extra signal, since the curve holds its last value anyway.
    // Aborting when the race is decided stops the render poll, the sentinel
    // poll and the quiescence watcher and clears the horizon timer together.
    // Waiting out an eight-minute horizon that the agent beat in thirty seconds
    // is not a hypothetical: the CLI printed its report and then sat idle for
    // the rest of it.
    const races: Array<Promise<RunEndReason>> = [
      handle.waitForTurn(0).then((): RunEndReason => 'turn'),
      sleep(horizonMs, raceCtl.signal).then((): RunEndReason => 'horizon'),
    ];

    // The agent's own "I am done". The only end condition that survives an
    // agent whose last act is a foreground dev server, which never returns and
    // so never completes a turn.
    const donePath = join(workdir, DONE_SENTINEL);
    races.push(
      (async (): Promise<RunEndReason> => {
        while (!signal.aborted && !existsSync(donePath)) await sleep(500, signal);
        return 'signal';
      })(),
    );

    if (quietForMs > 0) races.push(waitForQuiet());

    if (opts.stopAfterRenderMs !== undefined) {
      const settleAfterRender = opts.stopAfterRenderMs;
      races.push(
        (async (): Promise<RunEndReason> => {
          while (!signal.aborted && !prober.frames.some((f) => f.class === 'render'))
            await sleep(250, signal);
          if (!signal.aborted) await sleep(settleAfterRender, signal);
          return 'rendered';
        })(),
      );
    }
    let ended: RunEndReason;
    try {
      ended = await Promise.race(races);
    } finally {
      raceCtl.abort();
    }
    endReason = ended;

    if (ended === 'horizon')
      warnings.push(`Agent did not finish within the ${brief.horizonSec}s horizon.`);
    if (ended === 'quiet')
      warnings.push(
        `The cold-start window was closed by quiescence: nothing on the page changed, the ` +
          `agent emitted nothing, and no shimmed command ran for ${(quietForMs / 1000).toFixed(0)}s. ` +
          `The agent had not reported finishing. The curve holds its last value to the horizon ` +
          `either way, so this does not change the AUC, but a late improvement would have been missed.`,
      );
    log(
      ended === 'horizon' ? 'horizon reached'
        : ended === 'rendered' ? 'app rendered; ending cold-start window'
        : ended === 'signal' ? `agent signalled done (${DONE_SENTINEL})`
        : ended === 'quiet' ? `nothing changed for ${(quietForMs / 1000).toFixed(0)}s; ending cold-start window`
        : 'agent finished first turn',
    );

    // Keep watching briefly: builds land after the agent stops talking, and
    // some agents break the page on their way out. A run that stopped on the
    // render condition or on quiescence has already waited, so it does not
    // wait again.
    const settleMs = ended === 'rendered' || ended === 'quiet' ? 0 : (opts.settleMs ?? 15_000);
    const settleStartMs = Date.now() - t0Epoch;
    await sleep(settleMs);
    coldEndMs = Date.now() - t0Epoch;

    // Time the harness spent deliberately watching an idle app is not
    // "unattributed": we know exactly what was happening, which is nothing. If
    // it were charged to the residual bucket, a control run that starts fast
    // would report low attribution coverage and warn that its own split is
    // untrustworthy, which is the opposite of the truth. The quiescence window
    // is the same thing by a different name -- it is defined as a stretch in
    // which nothing happened -- so it is excluded on the same grounds.
    const deliberateIdleMs =
      ended === 'rendered' ? (opts.stopAfterRenderMs ?? 0) : ended === 'quiet' ? quietForMs : 0;
    observationOnlyMs = (coldEndMs - settleStartMs) + deliberateIdleMs;
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
          lastIterationOk = res.ok;
          if (res.baselineAlreadyPassing) {
            warnings.push(
              `Iteration "${spec.id}" is void: its check already passed before the prompt was sent, so it cannot measure this edit. Fix the check in the brief.`,
            );
          } else if (!res.ok) {
            warnings.push(`Iteration "${spec.id}" never landed within its timeout.`);
          }
        }
        // An iteration returns the moment its predicate has held for a couple
        // of frames, which is mid-edit: the agent is usually still settling the
        // layout. Without this the run tore down on that frame and the last
        // screenshot of the last edit was never taken.
        if (lastIterationOk) await sleep(ITERATION_SETTLE_MS);
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
  // original brief would blend two measurements into one number. The iteration
  // frames are still kept -- see assemble() -- they just never reach the curve.
  const coldFrames = prober.frames.filter((f) => f.tMs <= coldEndMs);
  const iterationFrames = prober.frames.filter((f) => f.tMs > coldEndMs);

  // "Ready" means actually serving the app. The prober keeps retrying a 4xx or
  // 5xx, so counting the first error response as ready would cut dev-server
  // boot short and start the first-paint window before anything could paint.
  const serverReadyMs =
    prober.frames.find((f) => f.httpStatus !== null && f.httpStatus < 400)?.tMs ?? null;
  // Classification does not depend on scoring, so this is the same answer the
  // judged frames would give, available before the judge has run.
  const firstPaintMs = coldFrames.find((f) => f.class === 'render')?.tMs ?? null;

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
  if (prober.repeatedShots > 0 && prober.distinctShots > 0)
    log(
      `${prober.frames.length} frames, ${prober.distinctShots} distinct screenshots ` +
        `(${prober.repeatedShots} repeats share a file)`,
    );
  if (prober.skippedTicks > 0)
    warnings.push(`${prober.skippedTicks} poll ticks were skipped because a capture overran the interval.`);
  if (prober.shotFailures.length)
    warnings.push(
      `${prober.shotFailures.length} frame(s) have no screenshot: the browser refused to capture one ` +
        `even after retries (first: ${prober.shotFailures[0]}). Those frames are still on the timeline, ` +
        `but they are holes in the filmstrip and in any video built from it.`,
    );
  if (prober.reloadCount > prober.frames.length * 0.25)
    warnings.push(
      `The prober reloaded ${prober.reloadCount} times across ${prober.frames.length} frames. The served document changes on nearly every request (a per-request nonce or timestamp), so reload-driven timings here are unreliable.`,
    );

  // Entity coverage was computed during the run from the full text; what is
  // stored is for eyeballing why a frame scored as it did. Keeping 20KB of DOM
  // text per frame would make result.json hundreds of megabytes on a long run.
  const STORED_TEXT = 4000;
  const slim = (f: ScoredFrame): ScoredFrame =>
    f.text.length > STORED_TEXT
      ? { ...f, text: `${f.text.slice(0, STORED_TEXT)}\n...[truncated ${f.text.length - STORED_TEXT} chars]` }
      : f;

  const resultPath = join(opts.runDir, 'result.json');

  /**
   * Build the result from whatever scoring is available.
   *
   * Everything above this point is judge-independent, so the same assembly
   * serves the provisional write and the final one; only the frame scores and
   * the judge block differ between them.
   */
  const assemble = (
    scoredCold: ScoredFrame[],
    judge: RunResult['judge'],
    judgeWarnings: string[],
  ): RunResult => ({
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
    // Cold frames only, always: the headline numbers describe the cold-start
    // window and nothing else.
    curve: computeMetrics(scoredCold, {
      horizonMs,
      runEndMs: coldEndMs,
      reviewableThreshold: brief.reviewableThreshold,
    }),
    decomposition: {
      ...decomposition,
      notes: [
        ...decomposition.notes,
        ...(observationOnlyMs > 1000
          ? [
              `Excludes ${(observationOnlyMs / 1000).toFixed(1)}s of deliberate idle observation ` +
                `(${endReason === 'quiet' ? 'quiescence window plus settle' : 'settle window'}); the curve still covers it.`,
            ]
          : []),
      ],
    },
    iterations,
    // The whole timeline, tagged by phase. The iteration frames carry
    // mechanical scores and are excluded from every metric, but without them
    // the run could only ever be replayed up to the moment the window closed --
    // so a video of a run with iterations stopped before the edits it measured.
    frames: [
      ...scoredCold.map((f): ScoredFrame => ({ ...f, phase: 'cold' })),
      ...mechanicalScores(iterationFrames).map((f): ScoredFrame => ({ ...f, phase: 'iteration' })),
    ].map(slim),
    phases,
    agentEvents,
    judge,
    agentFailure,
    endReason,
    protocol: { renderEarly: !opts.noRenderEarly },
    artifacts: {
      videoPath: prober.videoPath,
      promptPath: join(opts.runDir, 'prompt.txt'),
      distinctShots: prober.distinctShots,
      repeatedShots: prober.repeatedShots,
    },
    warnings: [...warnings, ...judgeWarnings],
  });

  const writeResult = async (r: RunResult): Promise<void> => {
    await writeFile(resultPath, JSON.stringify(r, null, 2));
  };

  // Write the run out before scoring it.
  //
  // Judging happens after teardown and can take minutes -- the CLI judge shells
  // out once per frame -- so the browser closes long before result.json used to
  // appear. Anything that interrupted that gap took the entire run with it:
  // the screenshots survived on disk but the timeline behind them did not, and
  // result.json is the only place it lives, so `p2p video` and `p2p rescore`
  // were both dead ends for a run that had already finished. Writing first
  // costs one extra file write and makes the run recoverable from here on.
  const provisional = assemble(
    mechanicalScores(coldFrames),
    {
      backend: opts.judgeBackend.name,
      model: opts.judgeBackend.model,
      framesJudged: 0,
      degraded: true,
      pending: true,
    },
    [
      'judge: scores in this file are provisional -- the scoring pass had not finished when it ' +
        `was written. The timeline is complete, so the run can be replayed; run \`p2p rescore ${opts.runDir}\` to score it.`,
    ],
  );
  await writeResult(provisional);

  log(`judging ${coldFrames.length} cold-start frames`);
  let judged;
  try {
    judged = await judgeRun(coldFrames, brief, {
      backend: opts.judgeBackend,
      onProgress: (d, t) => d % 5 === 0 && log(`  judged ${d}/${t}`),
    });
  } catch (e) {
    // The run itself succeeded; only the scoring of it failed. Keep the
    // provisional file rather than throwing the measurement away.
    provisional.warnings.push(
      `judge: the scoring pass failed (${String(e).slice(0, 200)}), so the scores here are entity ` +
        `coverage, not rubric correctness. The timeline is intact; fix the judge and run ` +
        `\`p2p rescore ${opts.runDir}\`.`,
    );
    await writeResult(provisional);
    return provisional;
  }

  const result = assemble(
    judged.frames,
    {
      backend: opts.judgeBackend.name,
      model: opts.judgeBackend.model,
      framesJudged: judged.framesJudged,
      degraded: judged.degraded,
    },
    judged.warnings,
  );
  await writeResult(result);
  return result;
}
