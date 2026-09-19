import type { RunResult } from '../types.ts';
import { coldFrames } from '../phase.ts';

/**
 * Does the correctness curve carry anything its endpoints do not?
 *
 * The headline number here is the area under a curve, which is only worth
 * integrating if the curve has a shape. An agent that shows a blank page and
 * then the finished app draws a step, and the area under a step is fixed by
 * two numbers already printed beside it:
 *
 *     AUC = finalScore x (1 - timeToFirstRender / horizon)
 *
 * When that identity holds, ranking on AUC is ranking on those two numbers in a
 * trenchcoat. It is not wrong, but it is not new information either, and a
 * project that refuses to let two incomparable runs share a table should be the
 * first to say so about its own metric.
 *
 * This is the self-check. It exists because the identity held exactly on 8 of
 * the first 9 measured runs, and the exception was the one run where an agent
 * did what the protocol asks: rendered a crude page early (complete but
 * unstyled, 0.833 at 6.8s) and refined it in place (1.000 at 27.4s).
 */

export interface RunTrajectory {
  label: string;
  model: string | null;
  aucMeasured: number;
  /** finalScore x (1 - ttfr/horizon): the area under the step this would be. */
  aucFromEndpoints: number | null;
  residual: number | null;
  /** Distinct scores the cold-start frames were given. A step visits two. */
  levels: number;
  /**
   * Was this run ever scored at something other than zero and its own final
   * score? That is what "rendered something partial, then improved it" looks
   * like in the data, and it is the only thing that gives the curve a shape.
   */
  progressive: boolean;
  rendered: boolean;
}

export interface TrajectoryReport {
  runs: RunTrajectory[];
  progressive: number;
  /** Runs where the endpoint identity holds to within `EPSILON`. */
  stepwise: number;
  neverRendered: number;
  maxResidual: number;
}

/** Floating-point slack. Observed residuals are exactly zero or ~1e-2. */
export const EPSILON = 1e-6;

export function trajectory(runs: readonly RunResult[]): TrajectoryReport {
  const out: RunTrajectory[] = runs.map((r) => {
    const c = r.curve;
    const rendered = c.ttfnbrMs !== null;
    const cold = coldFrames(r);
    const scores = new Set(cold.map((f) => f.score));
    // "Partial" means a score that is neither nothing nor the final answer.
    const progressive = [...scores].some((s) => s > 0 && Math.abs(s - c.finalScore) > EPSILON);
    const predicted = rendered ? c.finalScore * (1 - c.ttfnbrMs! / c.horizonMs) : null;
    return {
      label: r.label,
      model: r.model ?? null,
      aucMeasured: c.auc,
      aucFromEndpoints: predicted,
      residual: predicted === null ? null : c.auc - predicted,
      levels: scores.size,
      progressive,
      rendered,
    };
  });
  const residuals = out.map((r) => r.residual).filter((x): x is number => x !== null);
  return {
    runs: out,
    progressive: out.filter((r) => r.progressive).length,
    stepwise: out.filter((r) => r.residual !== null && Math.abs(r.residual) <= EPSILON).length,
    neverRendered: out.filter((r) => !r.rendered).length,
    maxResidual: residuals.length ? Math.max(...residuals.map(Math.abs)) : 0,
  };
}

const f = (x: number | null, d = 3): string => (x === null ? '--'.padStart(d + 2) : x.toFixed(d).padStart(d + 2));

export function renderTrajectory(rep: TrajectoryReport): string {
  const L: string[] = [];
  const n = rep.runs.length;
  L.push('', `  Does the curve carry anything its endpoints do not?  (${n} run${n === 1 ? '' : 's'})`);
  L.push('  ' + '-'.repeat(72));
  L.push('  run                              AUC   endpoints  residual  levels  partial');
  for (const r of rep.runs) {
    const name = (r.model ?? r.label).slice(0, 30).padEnd(31);
    L.push(
      `  ${name}${f(r.aucMeasured)}     ${f(r.aucFromEndpoints)}  ` +
      `${r.residual === null ? '      --' : r.residual.toFixed(5).padStart(8)}  ` +
      `${String(r.levels).padStart(6)}  ${r.progressive ? 'yes' : 'no'}`,
    );
  }
  L.push('');
  L.push(`    AUC == finalScore x (1 - ttfr/horizon)     ${rep.stepwise} / ${n} runs`);
  L.push(`    ever scored at a partial state            ${rep.progressive} / ${n} runs`);
  L.push(`    largest residual                          ${rep.maxResidual.toFixed(5)}`);
  if (rep.neverRendered) L.push(`    never rendered at all                     ${rep.neverRendered} / ${n} runs`);
  L.push('');

  if (rep.progressive === 0 && n > 0) {
    L.push('  ! No run here ever rendered a partial page: every one went from nothing to');
    L.push('    its final answer in a single step. For a step, the area under the curve is');
    L.push('    finalScore x (1 - ttfr/horizon) -- two numbers already in this report -- so');
    L.push('    ranking on AUC ranks on those. The curve is not measuring anything extra');
    L.push('    until an agent renders something and then improves it.');
  } else if (rep.stepwise === n - rep.progressive && rep.progressive < n / 2) {
    L.push(`  ! Only ${rep.progressive} of ${n} runs rendered a partial page and improved it. The rest are`);
    L.push('    steps, and for those the AUC restates finalScore and time-to-first-render.');
    L.push('    The metric is doing real work on the minority that refine in place.');
  } else {
    L.push('  The curve has a shape the endpoints do not predict, so the area under it is');
    L.push('  carrying information that finalScore and time-to-first-render do not.');
  }
  L.push('');
  return L.join('\n');
}
