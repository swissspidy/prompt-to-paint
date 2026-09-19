import type { RunResult } from '../types.ts';
import { BUCKET_ORDER, BUCKET_LABEL } from './palette.ts';

export interface Spread {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
  /** Count of runs where the value never happened (e.g. never rendered). */
  missing: number;
}

/**
 * Median, range, and how many runs the value never happened in.
 *
 * Runs where the thing never happened are counted separately rather than
 * averaged away, since treating them as missing would flatter an agent that
 * failed outright.
 */
export function spread(values: Array<number | null>): Spread {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const missing = values.length - present.length;
  if (!present.length) return { n: values.length, median: null, min: null, max: null, missing };
  const mid = Math.floor(present.length / 2);
  const median =
    present.length % 2 ? present[mid]! : (present[mid - 1]! + present[mid]!) / 2;
  return { n: values.length, median, min: present[0]!, max: present.at(-1)!, missing };
}

export interface Aggregate {
  brief: string;
  label: string;
  runs: number;
  /**
   * Which judge scored these, so two aggregates cannot be laid side by side
   * without it being visible that they were scored by different models.
   * `null` when the runs disagreed, which is itself the answer.
   */
  judge: string | null;
  auc: Spread;
  ttfnbrMs: Spread;
  ttfrrMs: Spread;
  finalScore: Spread;
  /**
   * Median wall clock across the runs. The denominator the bucket medians are
   * shown against -- and the reason they are not shown as percentages of each
   * other; see `renderAggregate`.
   */
  wallMs: Spread;
  bucketMedians: Record<string, number>;
  runIds: string[];
  warnings: string[];
}

/**
 * Summarise repeated runs of one agent on one brief.
 */
export function aggregate(all: RunResult[]): Aggregate {
  // A run whose agent never started is not a repeat of anything. An exhausted
  // API retry exits cleanly and leaves a clean 0.000, so three repeats of which
  // two failed would report a median of 0.000 as though the agent had been
  // measured three times -- ranking a model by its provider's capacity that
  // afternoon. Excluded from every statistic below and reported separately.
  const failedRuns = all.filter((r) => r.agentFailure);
  // If every run failed there is nothing to take a median of. Keep them so the
  // caller still gets a shaped result and let the warning carry the meaning.
  const runs = failedRuns.length < all.length ? all.filter((r) => !r.agentFailure) : all;
  const bucketMedians: Record<string, number> = {};
  for (const b of BUCKET_ORDER) {
    bucketMedians[b] = spread(runs.map((r) => r.decomposition.buckets[b])).median ?? 0;
  }
  // Two names for the judge, because they answer different questions. The model
  // is what a reader wants printed; the identity is what decides whether these
  // runs may be pooled at all, and it includes the sampling temperature -- the
  // same model at two settings is two scorers, so a median across them mixes
  // agent variance with sampler variance.
  const named = (r: RunResult): string => r.judge.model ?? `none:${r.judge.backend}`;
  const models = [...new Set(runs.map(named))];
  const identities = [...new Set(runs.map((r) => `${named(r)}@${r.judge.temperature ?? 'unrecorded'}`))];
  const warnings: string[] = [];
  if (failedRuns.length)
    warnings.push(
      failedRuns.length === all.length
        ? `All ${all.length} run(s) failed before the agent did any work, so the numbers below describe ` +
          'failures rather than the agent. Re-run them.'
        : `${failedRuns.length} of ${all.length} run(s) failed before the agent did any work and were left ` +
          `out of these numbers, which are the median of the ${runs.length} that ran. A failed run scores a ` +
          'clean 0.000, so averaging it in would have reported the provider being busy as agent latency.',
    );
  if (models.length > 1)
    warnings.push(
      `These runs were scored by different judges (${models.join(', ')}), so the spread below mixes ` +
        'agent variance with judge disagreement and cannot be read as either.',
    );
  else if (identities.length > 1)
    warnings.push(
      `These runs were scored by ${models[0]} at different temperatures (${identities.join(', ')}). The ` +
        'same model samples differently at each, so part of the spread below is the sampler rather than ' +
        'the agent.',
    );
  const viewports = [...new Set(runs.map((r) => {
    const v = r.viewport ?? { width: 1280, height: 800 };
    return `${v.width}x${v.height}`;
  }))];
  if (viewports.length > 1)
    warnings.push(
      `These runs were observed through different viewports (${viewports.join(', ')}), which decides what ` +
        'the judge could see. Their scores are not on one scale.',
    );
  if (runs.some((r) => r.judge.degraded) && !runs.every((r) => r.judge.degraded))
    warnings.push(
      'Some of these runs were scored by a rubric and some by entity coverage. Those are different ' +
        'quantities, and a median over both is not a measurement of anything.',
    );
  return {
    brief: runs[0]?.brief ?? '',
    label: runs[0]?.label ?? '',
    runs: runs.length,
    judge: identities.length === 1 ? models[0]! : null,
    auc: spread(runs.map((r) => r.curve.auc)),
    ttfnbrMs: spread(runs.map((r) => r.curve.ttfnbrMs)),
    ttfrrMs: spread(runs.map((r) => r.curve.ttfrrMs)),
    finalScore: spread(runs.map((r) => r.curve.finalScore)),
    wallMs: spread(runs.map((r) => r.decomposition.wallMs)),
    bucketMedians,
    runIds: runs.map((r) => r.runId),
    warnings,
  };
}

const fmtMs = (v: number | null): string => (v === null ? '--' : `${(v / 1000).toFixed(1)}s`);
const fmtN = (v: number | null): string => (v === null ? '--' : v.toFixed(3));

/**
 * Format one metric row with its range and any never-happened count.
 */
function line(name: string, s: Spread, fmt: (v: number | null) => string): string {
  const range = s.median === null ? '' : `  [${fmt(s.min)} .. ${fmt(s.max)}]`;
  const miss = s.missing ? `  (${s.missing}/${s.n} never happened)` : '';
  return `    ${name.padEnd(20)} ${fmt(s.median).padStart(8)}${range}${miss}`;
}

/**
 * Report a distribution, never a point estimate.
 *
 * Agent runs vary enough that a single number invites false confidence. The
 * median with its full range makes the spread impossible to overlook, and a
 * range wider than the gap between two agents is the signal to stop ranking
 * them and collect more runs.
 */
export function renderAggregate(a: Aggregate): string {
  const L: string[] = [];
  L.push(`\n  ${a.brief} / ${a.label}  --  ${a.runs} runs (median, [min .. max])`);
  L.push(`  judge: ${a.judge ?? 'MIXED -- see the warning below'}`);
  L.push(`  ${'-'.repeat(64)}`);
  L.push(line('AUC', a.auc, fmtN));
  L.push(line('First render', a.ttfnbrMs, fmtMs));
  L.push(line('First reviewable', a.ttfrrMs, fmtMs));
  L.push(line('Final score', a.finalScore, fmtN));
  L.push('');
  // Absolute medians only, with no percentage beside them.
  //
  // Each bucket's median is taken independently, so they describe no single run
  // and need not add up to one: the median install and the median build can
  // come from different runs, and their sum can exceed the median wall clock.
  // Rendering each as a share of that sum -- which this did -- produced a
  // tidy-looking breakdown of a run that never happened.
  L.push(`  Median time per phase  (each median taken independently; they do not sum to a run)`);
  for (const b of BUCKET_ORDER) {
    const ms = a.bucketMedians[b] ?? 0;
    if (ms <= 0) continue;
    L.push(`    ${BUCKET_LABEL[b].padEnd(20)} ${(ms / 1000).toFixed(1).padStart(7)}s`);
  }
  if (a.wallMs.median !== null)
    L.push(`    ${'-'.repeat(30)}`);
  if (a.wallMs.median !== null)
    L.push(`    ${'median wall clock'.padEnd(20)} ${(a.wallMs.median / 1000).toFixed(1).padStart(7)}s`);
  if (a.auc.median !== null && a.auc.max !== null && a.auc.min !== null) {
    const width = a.auc.max - a.auc.min;
    if (width > 0.15) {
      L.push('');
      L.push(`  ! AUC ranges over ${width.toFixed(3)} across ${a.runs} runs. Treat any ranking against`);
      L.push('    another agent as unresolved unless the gap exceeds that.');
    }
  }
  for (const w of a.warnings) {
    L.push('');
    L.push(`  ! ${w}`);
  }
  L.push('');
  return L.join('\n');
}
