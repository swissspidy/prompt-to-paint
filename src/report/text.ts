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
      L.push(`    ${it.id.padEnd(16)} first change ${secs(it.timeToFirstChangeMs).padStart(7)}   correct ${secs(it.timeToCorrectChangeMs).padStart(7)}${it.brokenMs > 0 ? `   broken ${secs(it.brokenMs)}` : ''}${it.baselineAlreadyPassing ? '   VOID (check already passed)' : it.ok ? '' : '   NEVER LANDED'}`);
      // An edit that reached the screen only because the harness refreshed the
      // page is a different experience from one that arrived on its own, and
      // everything after the refresh includes a page load. Said on its own line
      // rather than folded into the timings, which do not distinguish them.
      //
      // Worded as what was seen, not as what it means: the harness observed a
      // page that had not moved and refreshed it. Whether the app had no way to
      // push the change or merely had not yet is not something a screenshot can
      // say.
      if (it.refreshedAtMs != null)
        L.push(
          `    ${' '.repeat(16)} nothing had changed on screen when the agent stopped; refreshed at ${
            secs(it.refreshedAtMs - it.promptSentMs).trim()
          } (the timings after it include a page load)`,
        );
      const w = it.work;
      if (!w && it.afterAgentMs == null) continue;
      // The second line is the answer to "whose time was that". An edit that
      // took eight seconds of which the agent spent two is a toolchain result,
      // not an agent one, and the headline number cannot say which it was.
      const bits: string[] = [];
      if (w?.toolCalls !== null && w?.toolCalls !== undefined)
        bits.push(`${w.toolCalls} tool call${w.toolCalls === 1 ? '' : 's'}${
          w.toolNames.length ? ` (${[...new Set(w.toolNames)].slice(0, 4).join(', ')})` : ''}`);
      else if (w) bits.push('tool calls not visible in this adapter\'s stream');
      if (w?.modelMs != null) bits.push(`thinking ${secs(w.modelMs)}`);
      if (it.afterAgentMs != null)
        bits.push(
          it.afterAgentMs >= 0
            ? `${secs(it.afterAgentMs)} waiting on the toolchain after the agent finished`
            : `on screen ${secs(-it.afterAgentMs)} before the agent finished`,
        );
      const phases = (w?.phases ?? []).filter((p) => p.ms !== null && p.ms > 500);
      if (phases.length)
        bits.push(phases.map((p) => `${p.kind} ${secs(p.ms)}`).join(' + '));
      if (bits.length) L.push(`    ${' '.repeat(16)} ${bits.join('  ·  ')}`);
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
