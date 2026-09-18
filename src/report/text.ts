import type { RunResult } from '../types.ts';
import { BUCKET_ORDER, BUCKET_LABEL, BUCKET_SIDE } from './palette.ts';

const secs = (ms: number | null): string => (ms === null ? '  --  ' : `${(ms / 1000).toFixed(1)}s`);
const bar = (frac: number, width = 24): string =>
  '#'.repeat(Math.round(frac * width)).padEnd(width, '.');

/**
 * The terminal summary, leading with any failure that invalidates the run.
 */
export function renderText(r: RunResult): string {
  const L: string[] = [];
  L.push(`\n  ${r.brief} / ${r.label}  (${r.adapter})`);
  if (r.agentFailure) {
    L.push(`  ${'='.repeat(64)}`);
    L.push(`  AGENT FAILED (exit ${r.agentFailure.exitCode} at ${(r.agentFailure.atMs / 1000).toFixed(1)}s).`);
    L.push('  The numbers below describe a failed run, not agent performance.');
    L.push(`  Log: ${r.agentFailure.logPath}`);
    L.push(`  ${'='.repeat(64)}`);
  }
  L.push(`  ${'-'.repeat(64)}`);
  L.push(`  AUC (headline)        ${r.curve.auc.toFixed(3)}   ${bar(r.curve.auc)}`);
  // Printed above first render because it is normally the earlier of the two,
  // and the gap between them is the point: it is how long the tab says "Orbit"
  // at an empty grey page.
  if (r.curve.firstTabSignalMs != null)
    L.push(`  Tab title/icon        ${secs(r.curve.firstTabSignalMs)}`);
  L.push(`  First render          ${secs(r.curve.ttfnbrMs)}`);
  L.push(`  First reviewable      ${secs(r.curve.ttfrrMs)}`);
  L.push(`  Final / peak score    ${r.curve.finalScore.toFixed(2)} / ${r.curve.peakScore.toFixed(2)}${r.curve.regression > 0.01 ? '   <- regressed' : ''}`);
  L.push('');
  L.push(`  Where the time went   (${(r.decomposition.coverage * 100).toFixed(0)}% of wall clock accounted for)`);
  const wall = r.decomposition.wallMs || 1;
  for (const b of BUCKET_ORDER) {
    const ms = r.decomposition.buckets[b];
    if (ms <= 0) continue;
    L.push(`    ${BUCKET_LABEL[b].padEnd(20)} ${secs(ms).padStart(7)}  ${((ms / wall) * 100).toFixed(0).padStart(3)}%  ${bar(ms / wall, 18)}`);
  }
  const side = { agent: 0, toolchain: 0, unknown: 0 };
  for (const b of BUCKET_ORDER) side[BUCKET_SIDE[b]] += r.decomposition.buckets[b];
  L.push(`    ${'-'.repeat(52)}`);
  L.push(`    agent ${((side.agent / wall) * 100).toFixed(0)}%  ·  toolchain ${((side.toolchain / wall) * 100).toFixed(0)}%  ·  unaccounted ${((side.unknown / wall) * 100).toFixed(0)}%`);

  if (r.iterations.length) {
    L.push('');
    const modes = [...new Set(r.iterations.map((i) => i.mode))].join('/');
    L.push(`  Iteration (prompt -> visible change)   [${modes}]`);
    if (r.iterations.some((i) => i.mode === 'restart'))
      L.push('    note: restart mode -- these include agent startup and context re-read');
    for (const it of r.iterations) {
      L.push(`    ${it.id.padEnd(16)} first change ${secs(it.timeToFirstChangeMs).padStart(7)}   correct ${secs(it.timeToCorrectChangeMs).padStart(7)}${it.brokenMs > 0 ? `   broken ${secs(it.brokenMs)}` : ''}${it.ok ? '' : '   NEVER LANDED'}`);
    }
  }
  if (r.warnings.length) {
    L.push('');
    L.push('  Caveats');
    for (const w of r.warnings) L.push(`    ! ${w}`);
  }
  for (const n of r.decomposition.notes) L.push(`    ! ${n}`);
  L.push('');
  return L.join('\n');
}
