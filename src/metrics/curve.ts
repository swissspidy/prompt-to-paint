import type { CurveMetrics, ScoredFrame } from '../types.ts';

export interface CurveOptions {
  horizonMs: number;
  runEndMs: number;
  /** Fraction of entity weight required for a frame to count as reviewable. */
  reviewableThreshold: number;
}

export interface CurvePoint {
  tMs: number;
  score: number;
}

/**
 * The correctness curve as a step function over [0, horizon].
 *
 * Three conventions, each of which changes the ranking, so each is stated
 * rather than assumed:
 *
 * 1. Before the first frame the score is 0. Nothing is rendering, and a run
 *    that has not started is worth exactly as much as one showing a blank page.
 * 2. A score holds until the next observation. We know the state at sample
 *    times only; holding forward is the assumption that nothing changed
 *    between polls, which is also what a human watching the tab would see.
 * 3. After the run ends the final score holds to the horizon. The app keeps
 *    serving after the agent stops, so finishing early is rewarded by the
 *    integral without penalising the agent for having stopped.
 */
export function buildCurve(frames: ScoredFrame[], opts: CurveOptions): CurvePoint[] {
  return pointsFrom([...frames].sort((a, b) => a.tMs - b.tMs), opts.horizonMs);
}

/** The step function itself, from frames already in time order. */
function pointsFrom(sorted: ScoredFrame[], horizonMs: number): CurvePoint[] {
  const pts: CurvePoint[] = [{ tMs: 0, score: 0 }];
  for (const f of sorted) {
    if (f.tMs > horizonMs) break;
    pts.push({ tMs: f.tMs, score: f.score });
  }
  return pts;
}

/** Integrate a hold-forward step function over [0, horizon], normalized to 0..1. */
export function integrate(points: CurvePoint[], horizonMs: number): number {
  if (horizonMs <= 0 || points.length === 0) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const start = Math.min(points[i]!.tMs, horizonMs);
    const end = Math.min(points[i + 1]?.tMs ?? horizonMs, horizonMs);
    if (end > start) area += points[i]!.score * (end - start);
  }
  return area / horizonMs;
}

/**
 * Derive every headline number from the scored frames.
 *
 * Frames past the horizon are excluded rather than clamped, so a late
 * improvement cannot retroactively raise a run's score.
 */
export function computeMetrics(frames: ScoredFrame[], opts: CurveOptions): CurveMetrics {
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  const inHorizon = sorted.filter((f) => f.tMs <= opts.horizonMs);
  // Already in order, so the curve is built from these directly rather than
  // handed back to buildCurve, which would sort the same frames a second time.
  const points = pointsFrom(inHorizon, opts.horizonMs);
  const auc = integrate(points, opts.horizonMs);

  const firstRender = inHorizon.find((f) => f.class === 'render');
  // Browser chrome, reported beside the render times and never folded into
  // them. It answers a different question -- when could you tell the right app
  // was starting -- and nothing here feeds the curve or the AUC.
  const firstTabSignal = inHorizon.find((f) => f.tabSignal);
  const firstReviewable = inHorizon.find(
    (f) => f.class === 'render' && f.entityCoverage >= opts.reviewableThreshold,
  );

  let peakScore = 0;
  let timeToPeakMs: number | null = null;
  for (const f of inHorizon) {
    if (f.score > peakScore) {
      peakScore = f.score;
      timeToPeakMs = f.tMs;
    }
  }
  const finalScore = inHorizon.at(-1)?.score ?? 0;

  return {
    horizonMs: opts.horizonMs,
    auc,
    ttfnbrMs: firstRender?.tMs ?? null,
    ttfrrMs: firstReviewable?.tMs ?? null,
    firstTabSignalMs: firstTabSignal?.tMs ?? null,
    finalScore,
    peakScore,
    timeToPeakMs,
    regression: Math.max(0, peakScore - finalScore),
    heldToHorizon: opts.runEndMs < opts.horizonMs,
    runEndMs: opts.runEndMs,
  };
}
