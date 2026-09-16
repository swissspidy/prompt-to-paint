import type { RunResult } from '../types.js';
import { buildCurve } from '../metrics/curve.js';
import { SERIES_LIGHT, SERIES_DARK } from './palette.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const secs = (ms: number | null): string => (ms === null ? '--' : `${(ms / 1000).toFixed(1)}s`);

export interface Ranked {
  label: string;
  auc: number;
  finalScore: number;
  ttfnbrMs: number | null;
  ttfrrMs: number | null;
  rankAuc: number;
  rankFinal: number;
  rankTtfrr: number;
}

const rankBy = <T>(items: T[], key: (t: T) => number | null, asc: boolean): Map<T, number> => {
  const sorted = [...items].sort((a, b) => {
    const av = key(a), bv = key(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // never happened: always last
    if (bv === null) return -1;
    return asc ? av - bv : bv - av;
  });
  return new Map(sorted.map((t, i) => [t, i + 1]));
};

/**
 * Rank a set of runs three ways.
 *
 * The point of the comparison is the disagreement. If AUC and final score
 * produced the same ordering there would be no reason to measure the
 * trajectory, so the table shows all three orderings side by side and flags
 * every run whose position moves.
 */
export function rank(runs: RunResult[]): Ranked[] {
  const byAuc = rankBy(runs, (r) => r.curve.auc, false);
  const byFinal = rankBy(runs, (r) => r.curve.finalScore, false);
  const byTtfrr = rankBy(runs, (r) => r.curve.ttfrrMs, true);
  return runs.map((r) => ({
    label: r.label || r.adapter,
    auc: r.curve.auc,
    finalScore: r.curve.finalScore,
    ttfnbrMs: r.curve.ttfnbrMs,
    ttfrrMs: r.curve.ttfrrMs,
    rankAuc: byAuc.get(r)!,
    rankFinal: byFinal.get(r)!,
    rankTtfrr: byTtfrr.get(r)!,
  })).sort((a, b) => a.rankAuc - b.rankAuc);
}

/**
 * AUC has the horizon in its denominator, so two runs scored against different
 * horizons are not on the same scale and ranking them together is meaningless.
 * Throwing beats printing a plausible table nobody can trust.
 */
export function assertComparable(runs: RunResult[]): void {
  const horizons = [...new Set(runs.map((r) => r.curve.horizonMs))];
  if (horizons.length > 1) {
    throw new Error(
      `cannot compare runs with different horizons (${horizons.map((h) => `${h / 1000}s`).join(', ')}): ` +
        'AUC is normalised by horizon, so the numbers are not on the same scale.',
    );
  }
  const briefs = [...new Set(runs.map((r) => r.brief))];
  if (briefs.length > 1) {
    throw new Error(`cannot compare runs from different briefs (${briefs.join(', ')}): rubrics differ.`);
  }
}

export function renderCompareText(runs: RunResult[]): string {
  assertComparable(runs);
  const rows = rank(runs);
  const L: string[] = [];
  L.push('');
  L.push('  ' + 'run'.padEnd(22) + 'AUC'.padStart(7) + 'final'.padStart(8) + 'first'.padStart(9) + 'reviewable'.padStart(12) + '   rank: auc/final/reviewable');
  L.push('  ' + '-'.repeat(88));
  for (const r of rows) {
    const moved = r.rankAuc !== r.rankFinal ? '  <- ranking differs' : '';
    L.push(
      '  ' + r.label.slice(0, 21).padEnd(22) +
      r.auc.toFixed(3).padStart(7) +
      r.finalScore.toFixed(2).padStart(8) +
      secs(r.ttfnbrMs).padStart(9) +
      secs(r.ttfrrMs).padStart(12) +
      `      ${r.rankAuc}/${r.rankFinal}/${r.rankTtfrr}` + moved,
    );
  }
  const disagree = rows.filter((r) => r.rankAuc !== r.rankFinal).length;
  L.push('');
  L.push(`  ${disagree === 0 ? 'AUC and final score agree on the ordering here.' : `${disagree} of ${rows.length} runs rank differently by AUC than by final score.`}`);
  L.push('');
  return L.join('\n');
}

export function renderCompareHtml(runs: RunResult[]): string {
  assertComparable(runs);
  const W = 900, H = 320, M = { l: 48, r: 120, t: 16, b: 34 };
  const PW = W - M.l - M.r, PH = H - M.t - M.b;
  const hz = Math.max(...runs.map((r) => r.curve.horizonMs));
  const x = (t: number) => M.l + (Math.min(t, hz) / hz) * PW;
  const y = (s: number) => M.t + (1 - s) * PH;

  const series = runs.map((r, i) => {
    const pts = buildCurve(r.frames, {
      horizonMs: r.curve.horizonMs, runEndMs: r.curve.runEndMs, reviewableThreshold: 0,
    });
    let prev = pts[0]?.score ?? 0;
    let d = `M ${x(0)} ${y(prev)}`;
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k]!;
      d += ` L ${x(p.tMs)} ${y(prev)} L ${x(p.tMs)} ${y(p.score)}`;
      prev = p.score;
    }
    d += ` L ${x(hz)} ${y(prev)}`;
    return { label: r.label || r.adapter, d, endY: y(prev), slot: (i % 6) + 1, auc: r.curve.auc };
  });

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line class="grid" x1="${M.l}" x2="${M.l + PW}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`).join('');
  const xticks = Array.from({ length: 7 }, (_, i) => {
    const t = (hz / 6) * i;
    return `<text class="tick" x="${x(t)}" y="${H - 10}" text-anchor="middle">${Math.round(t / 1000)}s</text>`;
  }).join('');

  const rows = rank(runs);
  const vars = (list: string[]) => list.map((c, i) => `--series-${i + 1}: ${c};`).join(' ');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Prompt-to-paint comparison</title>
<style>
  :root { color-scheme: light; --surface-0:#f6f5f2; --surface-1:#fcfcfb; --border:#e2e1dc;
    --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#77756f; --grid:#e8e7e2; ${vars(SERIES_LIGHT)} }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
    --surface-0:#111110; --surface-1:#1a1a19; --border:#302f2d; --text-primary:#fff;
    --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2a2a28; ${vars(SERIES_DARK)} } }
  :root[data-theme="dark"] { color-scheme: dark; --surface-0:#111110; --surface-1:#1a1a19; --border:#302f2d;
    --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2a2a28; ${vars(SERIES_DARK)} }
  body { margin:0; background:var(--surface-0); color:var(--text-primary);
    font:15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:24px; margin:0 0 20px; letter-spacing:-0.01em; }
  h2 { font-size:15px; margin:0 0 14px; color:var(--text-secondary); text-transform:uppercase;
    letter-spacing:0.06em; font-weight:600; }
  .panel { background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:20px; margin-bottom:20px; }
  svg { width:100%; height:auto; overflow:visible; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .tick { fill:var(--text-muted); font-size:11px; }
  .s { fill:none; stroke-width:2; stroke-linejoin:round; }
  .lbl { font-size:12px; font-weight:600; dominant-baseline:middle; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;
    color:var(--text-secondary); padding:6px 8px; border-bottom:1px solid var(--border); }
  td { padding:7px 8px; border-bottom:1px solid var(--border); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .swatch { width:10px; height:10px; border-radius:3px; display:inline-block; margin-right:8px; }
  .moved { color:var(--series-2); font-weight:600; }
  .note { color:var(--text-secondary); font-size:13px; margin-top:14px; }
  @media (max-width:560px){ .wrap{padding:20px 16px 48px} }
</style></head><body><div class="wrap">
<h1>Prompt-to-paint comparison</h1>
<section class="panel"><h2>Correctness over time</h2>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Correctness over time for ${runs.length} runs">
  ${grid}${xticks}
  ${series.map((s) => `<path class="s" d="${s.d}" stroke="var(--series-${s.slot})"/>`).join('')}
  ${series.map((s) => `<text class="lbl" x="${M.l + PW + 8}" y="${s.endY}" fill="var(--series-${s.slot})">${esc(s.label.slice(0, 14))}</text>`).join('')}
</svg></section>
<section class="panel"><h2>Ranking</h2>
<table><thead><tr><th>Run</th><th class="num">AUC</th><th class="num">Final score</th>
<th class="num">First render</th><th class="num">First reviewable</th><th class="num">Rank by AUC</th><th class="num">Rank by final</th></tr></thead><tbody>
${rows.map((r, i) => `<tr>
  <td><span class="swatch" style="background:var(--series-${(runs.findIndex((x) => (x.label || x.adapter) === r.label) % 6) + 1})"></span>${esc(r.label)}</td>
  <td class="num"><b>${r.auc.toFixed(3)}</b></td><td class="num">${r.finalScore.toFixed(2)}</td>
  <td class="num">${secs(r.ttfnbrMs)}</td><td class="num">${secs(r.ttfrrMs)}</td>
  <td class="num">${r.rankAuc}</td>
  <td class="num ${r.rankAuc !== r.rankFinal ? 'moved' : ''}">${r.rankFinal}${r.rankAuc !== r.rankFinal ? ' ≠' : ''}</td></tr>`).join('')}
</tbody></table>
<p class="note">${rows.filter((r) => r.rankAuc !== r.rankFinal).length === 0
  ? 'AUC and final score agree on the ordering for this set.'
  : 'Highlighted rows rank differently by trajectory than by final score -- the disagreement the trajectory metric exists to surface.'}</p>
</section></div></body></html>`;
}
