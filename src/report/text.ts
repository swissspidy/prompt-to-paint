import type { RunResult } from '../types.js';
import { BUCKET_ORDER, BUCKET_LABEL, BUCKET_SIDE } from './palette.js';

const secs = (ms: number | null): string => (ms === null ? '  --  ' : `${(ms / 1000).toFixed(1)}s`);
const bar = (frac: number, width = 24): string =>
  '#'.repeat(Math.round(frac * width)).padEnd(width, '.');

export function renderText(r: RunResult): string {
  const L: string[] = [];
  L.push(`\n  ${r.brief} / ${r.label}  (${r.adapter})`);
  L.push(`  ${'-'.repeat(64)}`);
  L.push(`  AUC (headline)        ${r.curve.auc.toFixed(3)}   ${bar(r.curve.auc)}`);
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
    L.push('  Iteration (prompt -> visible change)');
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
