import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, IterationResult, RunEndReason, RunResult, ScoredFrame } from './types.ts';
import { mechanicalScores } from './judge/judge.ts';
import { computeMetrics } from './metrics/curve.ts';

/** The header `runBenchmark` writes before the agent starts. */
export interface RunHeader {
  schema: 1;
  runId: string;
  brief: string;
  briefPath: string;
  adapter: string;
  /** Absent on run.json headers written before the model was recorded. */
  model?: string | null;
  label: string;
  url: string;
  t0Epoch: number;
  startedAt: string;
  horizonMs: number;
  framesDir: string;
  framesLogPath: string;
}

export interface SidecarContents {
  frames: Frame[];
  iterations: IterationResult[];
  coldEndMs: number | null;
  endReason: RunEndReason | null;
  /** A final line that was being written when the process died. */
  truncated: boolean;
  /** Lines that parsed but were not anything we recognise. */
  skipped: number;
}

/**
 * Read the append-only timeline back.
 *
 * Every failure mode here is the one this file exists for: the process was
 * killed mid-append, so the last line is half an object. That line is dropped
 * and reported; nothing before it is affected, which is the whole reason the
 * timeline is newline-delimited rather than one JSON document.
 */
export function parseSidecar(text: string): SidecarContents {
  const out: SidecarContents = {
    frames: [], iterations: [], coldEndMs: null, endReason: null, truncated: false, skipped: 0,
  };
  const lines = text.split('\n');
  // A complete file ends with a newline, so the last element is empty. Anything
  // else there is a line that was still being written.
  const lastIsPartial = lines.at(-1) !== '';
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && lastIsPartial) out.truncated = true;
      else out.skipped++;
      continue;
    }
    if (!obj || typeof obj !== 'object') { out.skipped++; continue; }
    const rec = obj as Record<string, unknown>;
    if (rec.__p2p === 'cold-end') {
      out.coldEndMs = typeof rec.tMs === 'number' ? rec.tMs : null;
      out.endReason = (rec.endReason as RunEndReason | undefined) ?? null;
    } else if (rec.__p2p === 'iteration' && rec.iteration) {
      out.iterations.push(rec.iteration as IterationResult);
    } else if (typeof rec.tMs === 'number' && typeof rec.index === 'number' && typeof rec.class === 'string') {
      out.frames.push(rec as unknown as Frame);
    } else {
      out.skipped++;
    }
  }
  return out;
}

export interface SalvageOutcome {
  result: RunResult;
  frameCount: number;
  truncated: boolean;
}

/**
 * Rebuild a run from what was written while it was happening.
 *
 * Not a substitute for a finished run and never presented as one: the agent's
 * event stream, the toolchain phases and the whole latency decomposition live
 * only in memory until `result.json` is assembled, so a salvaged run has a
 * timeline and no attribution, and says so in its warnings. What it does give
 * back is the thing that is otherwise unrecoverable -- which screenshot was on
 * screen when, and what the page was doing -- so `p2p video`, `p2p rescore` and
 * the report all work against a run whose process did not survive to write
 * itself out.
 */
export async function salvageRun(runDir: string): Promise<SalvageOutcome> {
  const headerPath = join(runDir, 'run.json');
  if (!existsSync(headerPath))
    throw new Error(
      `${headerPath} does not exist, so there is nothing to salvage.\n` +
        '  Only runs started by a version that writes run.json can be recovered; ' +
        'for older ones the timeline was never on disk.',
    );
  const header = JSON.parse(await readFile(headerPath, 'utf8')) as RunHeader;

  const logPath = header.framesLogPath || join(runDir, 'frames.ndjson');
  if (!existsSync(logPath)) throw new Error(`${logPath} does not exist, so no frames were recorded.`);
  const side = parseSidecar(await readFile(logPath, 'utf8'));
  if (!side.frames.length) throw new Error(`${logPath} holds no frames.`);

  // Frames after the cold-start window belong to the edits, exactly as during a
  // normal run: scoring them against the cold-start rubric would blend two
  // measurements. With no marker -- the run died before the window closed --
  // every frame is cold, which is then true.
  const coldEndMs = side.coldEndMs ?? side.frames.at(-1)!.tMs;
  const cold = side.frames.filter((f) => f.tMs <= coldEndMs);
  const iterationFrames = side.frames.filter((f) => f.tMs > coldEndMs);

  const warnings = [
    'SALVAGED RUN: rebuilt from frames.ndjson after the run failed to write result.json. ' +
      'The timeline, the screenshots and any completed iterations are real measurements.',
    'Salvaged runs carry no latency decomposition: the agent event stream and the toolchain ' +
      'phases were never written to disk, so every bucket here is zero and the split is not ' +
      'missing, it is absent. Do not put this run on a leaderboard beside a complete one.',
    `judge: scores in this file are entity coverage, not rubric correctness. Run ` +
      `\`p2p rescore ${runDir}\` to score the salvaged frames with a judge.`,
  ];
  if (side.truncated)
    warnings.push(
      'The last line of frames.ndjson was incomplete, so the final frame was dropped. That is the ' +
        'expected signature of a process killed mid-write, not of a corrupt file.',
    );
  if (side.skipped)
    warnings.push(`${side.skipped} unrecognised line(s) in frames.ndjson were ignored.`);
  if (side.coldEndMs === null)
    warnings.push(
      'The run never recorded the end of its cold-start window, so it died while still measuring. ' +
        'Every frame is treated as cold-start and the curve is held to the last one observed.',
    );

  const scoredCold: ScoredFrame[] = mechanicalScores(cold).map((f) => ({ ...f, phase: 'cold' }));
  const result: RunResult = {
    schema: 1,
    runId: header.runId,
    brief: header.brief,
    briefPath: header.briefPath,
    adapter: header.adapter,
    model: header.model ?? null,
    label: header.label,
    startedAt: header.startedAt,
    t0Epoch: header.t0Epoch,
    // The marker can be the last thing written: a process that died between
    // closing the cold-start window and capturing the next frame leaves
    // coldEndMs later than any frame, and a run whose runEndMs exceeds its
    // wallMs is not a run anyone should have to reconcile.
    wallMs: Math.max(side.frames.at(-1)!.tMs, coldEndMs),
    url: header.url,
    curve: computeMetrics(scoredCold, {
      horizonMs: header.horizonMs,
      runEndMs: coldEndMs,
      // The brief is not read here -- salvage must work without it -- so the
      // threshold is the default the bundled briefs use. `p2p rescore --brief`
      // recomputes this against the real one.
      reviewableThreshold: 0.5,
    }),
    decomposition: {
      wallMs: 0,
      buckets: {
        model: 0, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0,
      },
      coverage: 0,
      crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null },
      notes: ['Not measured: this run was salvaged from its frame log.'],
    },
    iterations: side.iterations,
    frames: [
      ...scoredCold,
      ...mechanicalScores(iterationFrames).map((f): ScoredFrame => ({ ...f, phase: 'iteration' })),
    ],
    phases: [],
    agentEvents: [],
    judge: { backend: 'none', model: null, framesJudged: 0, degraded: true, pending: true },
    agentFailure: null,
    ...(side.endReason ? { endReason: side.endReason } : {}),
    artifacts: {
      framesLogPath: logPath,
      promptPath: join(runDir, 'prompt.txt'),
      distinctShots: new Set(side.frames.map((f) => f.screenshotPath).filter(Boolean)).size,
    },
    warnings,
  };
  return { result, frameCount: side.frames.length, truncated: side.truncated };
}
