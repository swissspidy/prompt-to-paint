import { relative, dirname } from 'node:path';
import type { Bucket, RunResult } from '../types.js';
import { buildCurve } from '../metrics/curve.js';
import { BUCKET_ORDER, BUCKET_LABEL, BUCKET_SIDE, bucketVar, SERIES_LIGHT, SERIES_DARK } from './palette.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const secs = (ms: number | null): string =>
  ms === null ? '--' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;

const W = 880, H = 260, M = { l: 46, r: 18, t: 14, b: 34 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;

function curveChart(r: RunResult): string {
  const pts = buildCurve(r.frames, {
    horizonMs: r.curve.horizonMs,
    runEndMs: r.curve.runEndMs,
    reviewableThreshold: 0,
  });
  const hz = r.curve.horizonMs;
  const x = (t: number) => M.l + (Math.min(t, hz) / hz) * PW;
  const y = (s: number) => M.t + (1 - s) * PH;

  // Step geometry: a score holds until the next observation, so the path runs
  // horizontally at the old value and then jumps to the new one.
  let prev = pts[0]?.score ?? 0;
  let d = `M ${x(0)} ${y(prev)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    d += ` L ${x(p.tMs)} ${y(prev)} L ${x(p.tMs)} ${y(p.score)}`;
    prev = p.score;
  }
  const lastScore = prev;
  const lastT = pts.at(-1)?.tMs ?? 0;
  d += ` L ${x(hz)} ${y(lastScore)}`;
  const area = `${d} L ${x(hz)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  const gridY = [0, 0.25, 0.5, 0.75, 1]
    .map((v) => `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`)
    .join('');

  const ticks = 6;
  const gridX = Array.from({ length: ticks + 1 }, (_, i) => {
    const t = (hz / ticks) * i;
    return `<text class="tick" x="${x(t)}" y="${H - 10}" text-anchor="middle">${Math.round(t / 1000)}s</text>`;
  }).join('');

  // Stagger labels that would otherwise land on top of each other. On a fast
  // run first render and first reviewable are often the same frame, and two
  // labels at one x position render as illegible overlapping text.
  const drawn: number[] = [];
  const marker = (t: number | null, label: string, color: string): string => {
    if (t === null || t > hz) return '';
    const px = x(t);
    let row = 0;
    while (drawn.some((d, i) => i === row && Math.abs(d - px) < 78)) row++;
    drawn[row] = px;
    const ty = M.t + 12 + row * 15;
    return `<line class="marker" x1="${px}" x2="${px}" y1="${M.t}" y2="${M.t + PH}" stroke="${color}"/>
      <text class="marker-label" x="${px + 5}" y="${ty}" fill="${color}">${label}</text>`;
  };

  // The held tail is drawn differently: it is an assumption, not an observation.
  const held = r.curve.heldToHorizon
    ? `<rect class="held" x="${x(lastT)}" y="${M.t}" width="${Math.max(0, x(hz) - x(lastT))}" height="${PH}"/>
       <text class="tick" x="${(x(lastT) + x(hz)) / 2}" y="${M.t + PH - 8}" text-anchor="middle">held after run end</text>`
    : '';

  const dots = r.frames
    .filter((f) => f.scoreSource === 'judge' && f.tMs <= hz)
    .map((f) => `<circle class="judged" cx="${x(f.tMs)}" cy="${y(f.score)}" r="4"><title>${secs(f.tMs)} - score ${f.score.toFixed(2)} (judged)</title></circle>`)
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Correctness over time, area under the curve ${r.curve.auc.toFixed(3)}">
    ${held}${gridY}${gridX}
    <path class="area" d="${area}"/>
    <path class="line" d="${d}"/>
    ${marker(r.curve.ttfnbrMs, 'first render', 'var(--series-2)')}
    ${marker(r.curve.ttfrrMs, 'reviewable', 'var(--series-3)')}
    ${dots}
    <rect id="hit" x="${M.l}" y="${M.t}" width="${PW}" height="${PH}" fill="transparent"/>
    <line id="cross" class="cross" y1="${M.t}" y2="${M.t + PH}" style="display:none"/>
  </svg>
  <div id="tip" class="tip" hidden></div>`;
}

function stackedBar(buckets: Record<Bucket, number>, totalMs: number, id: string): string {
  if (totalMs <= 0) return '<p class="muted">No time to attribute.</p>';
  const segs = BUCKET_ORDER.filter((b) => buckets[b] > 0);
  return `<div class="stack" id="${id}">${segs
    .map((b) => {
      const pct = (buckets[b] / totalMs) * 100;
      return `<div class="seg" style="width:${pct}%;background:${bucketVar(b)}" title="${BUCKET_LABEL[b]}: ${secs(buckets[b])} (${pct.toFixed(1)}%)">
        <span class="seg-label">${pct >= 7 ? `${pct.toFixed(0)}%` : ''}</span></div>`;
    })
    .join('')}</div>
  <div class="legend">${segs
    .map((b) => `<span class="key"><i style="background:${bucketVar(b)}"></i>${BUCKET_LABEL[b]} <b>${secs(buckets[b])}</b></span>`)
    .join('')}</div>`;
}

function sideSplit(r: RunResult): string {
  const totals = { agent: 0, toolchain: 0, unknown: 0 };
  for (const b of BUCKET_ORDER) totals[BUCKET_SIDE[b]] += r.decomposition.buckets[b];
  const all = totals.agent + totals.toolchain + totals.unknown;
  if (all <= 0) return '';
  const row = (k: 'agent' | 'toolchain' | 'unknown', color: string, label: string): string =>
    `<div class="seg" style="width:${(totals[k] / all) * 100}%;background:${color}" title="${label}: ${secs(totals[k])}">
      <span class="seg-label">${totals[k] / all >= 0.08 ? `${((totals[k] / all) * 100).toFixed(0)}%` : ''}</span></div>`;
  return `<div class="stack">${row('agent', 'var(--series-1)', 'Agent')}${row('toolchain', 'var(--series-3)', 'Toolchain')}${row('unknown', 'var(--muted-fill)', 'Unaccounted')}</div>
    <div class="legend">
      <span class="key"><i style="background:var(--series-1)"></i>Agent (model + tool round trips) <b>${secs(totals.agent)}</b></span>
      <span class="key"><i style="background:var(--series-3)"></i>Toolchain (install + build + boot + paint) <b>${secs(totals.toolchain)}</b></span>
      <span class="key"><i style="background:var(--muted-fill)"></i>Unaccounted <b>${secs(totals.unknown)}</b></span>
    </div>`;
}

function decompTable(r: RunResult): string {
  const rows = BUCKET_ORDER.map(
    (b) => `<tr><td><i class="swatch" style="background:${bucketVar(b)}"></i>${BUCKET_LABEL[b]}</td>
      <td class="num">${secs(r.decomposition.buckets[b])}</td>
      <td class="num">${((r.decomposition.buckets[b] / r.decomposition.wallMs) * 100).toFixed(1)}%</td>
      <td>${BUCKET_SIDE[b]}</td></tr>`,
  ).join('');
  return `<table class="data"><thead><tr><th>Phase</th><th class="num">Time</th><th class="num">Share</th><th>Side</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>Wall clock (cold start)</td><td class="num">${secs(r.decomposition.wallMs)}</td><td class="num">100%</td><td></td></tr></tfoot></table>`;
}

function iterationTable(r: RunResult): string {
  if (!r.iterations.length) return '<p class="muted">No iterations were run.</p>';
  return `<table class="data"><thead><tr><th>Edit</th><th class="num">First visible change</th><th class="num">Correct change</th><th class="num">Agent done</th><th class="num">Broken for</th></tr></thead><tbody>
    ${r.iterations
      .map(
        (it) => `<tr><td>${esc(it.prompt)}${it.ok ? '' : ' <span class="bad">never landed</span>'}</td>
        <td class="num">${secs(it.timeToFirstChangeMs)}</td>
        <td class="num"><b>${secs(it.timeToCorrectChangeMs)}</b></td>
        <td class="num">${secs(it.agentDoneMs === null ? null : it.agentDoneMs - it.promptSentMs)}</td>
        <td class="num">${it.brokenMs > 0 ? secs(it.brokenMs) : '--'}</td></tr>`,
      )
      .join('')}</tbody></table>`;
}

function filmstrip(r: RunResult, outDir: string): string {
  const judged = r.frames.filter((f) => f.scoreSource === 'judge' && f.screenshotPath);
  if (!judged.length) return '<p class="muted">No frames were judged.</p>';
  return `<div class="strip">${judged
    .map((f) => {
      const src = relative(outDir, f.screenshotPath!);
      return `<figure><img src="${esc(src)}" alt="Frame at ${secs(f.tMs)}" loading="lazy"/>
        <figcaption><b>${secs(f.tMs)}</b> · score ${f.score.toFixed(2)}${f.judgeNote ? `<br><span class="muted">${esc(f.judgeNote)}</span>` : ''}</figcaption></figure>`;
    })
    .join('')}</div>`;
}

export function renderHtml(r: RunResult, outDir: string): string {
  const vars = (list: string[]): string => list.map((c, i) => `--series-${i + 1}: ${c};`).join('\n    ');
  const warn = r.warnings.length
    ? `<section class="panel warn"><h2>Caveats</h2><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></section>`
    : '';
  const notes = r.decomposition.notes.length
    ? `<ul class="notes">${r.decomposition.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';
  const cc = r.decomposition.crossCheck;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(r.brief)} · ${esc(r.label)}</title>
<style>
  :root {
    color-scheme: light;
    --surface-0: #f6f5f2; --surface-1: #fcfcfb; --border: #e2e1dc;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #77756f;
    --muted-fill: #c9c8c2; --grid: #e8e7e2;
    ${vars(SERIES_LIGHT)}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface-0: #111110; --surface-1: #1a1a19; --border: #302f2d;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
      --muted-fill: #4a4946; --grid: #2a2a28;
      ${vars(SERIES_DARK)}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-0: #111110; --surface-1: #1a1a19; --border: #302f2d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
    --muted-fill: #4a4946; --grid: #2a2a28;
    ${vars(SERIES_DARK)}
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-0); color: var(--text-primary);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 0 0 14px; color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .sub { color: var(--text-secondary); margin: 0 0 24px; font-size: 14px; }
  .panel { background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 20px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .tile .k { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .tile .v { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; margin-top: 4px;
    font-variant-numeric: tabular-nums; }
  .tile .n { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .chart { width: 100%; height: auto; display: block; overflow: visible; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { fill: var(--text-muted); font-size: 11px; }
  .area { fill: var(--series-1); opacity: 0.16; }
  .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; }
  .judged { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
  .marker { stroke-width: 2; stroke-dasharray: 3 3; opacity: 0.9; }
  .marker-label { font-size: 11px; font-weight: 600; }
  .held { fill: var(--muted-fill); opacity: 0.12; }
  .cross { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 2 2; }
  .tip { position: fixed; pointer-events: none; background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 12px;
    font-variant-numeric: tabular-nums; box-shadow: 0 4px 14px rgba(0,0,0,.14); z-index: 10; }
  .stack { display: flex; height: 30px; border-radius: 6px; overflow: hidden; gap: 2px; margin-bottom: 12px; }
  .seg { position: relative; min-width: 2px; display: grid; place-items: center; }
  .seg:first-child { border-radius: 6px 0 0 6px; } .seg:last-child { border-radius: 0 6px 6px 0; }
  .seg-label { font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.45);
    font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--text-secondary); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .key i, .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
  .swatch { margin-right: 8px; vertical-align: -1px; }
  table.data { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
  table.data th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-secondary); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  table.data td { padding: 7px 8px; border-bottom: 1px solid var(--border); }
  table.data tfoot td { font-weight: 650; border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .strip { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .strip figure { margin: 0; }
  .strip img { width: 100%; border: 1px solid var(--border); border-radius: 8px; display: block; background: #fff; }
  .strip figcaption { font-size: 12px; color: var(--text-secondary); margin-top: 5px; font-variant-numeric: tabular-nums; }
  .muted { color: var(--text-muted); }
  .bad { color: var(--series-2); font-weight: 600; }
  .warn { border-color: var(--series-4); }
  .warn li, .notes li { margin-bottom: 5px; }
  ul.notes { color: var(--text-secondary); font-size: 13px; padding-left: 18px; margin: 12px 0 0; }
  @media (max-width: 560px) { .wrap { padding: 20px 16px 48px; } .tile .v { font-size: 24px; } }
</style></head>
<body><div class="wrap">
  <h1>${esc(r.brief)} · ${esc(r.label)}</h1>
  <p class="sub">${esc(r.adapter)} · started ${esc(r.startedAt)} · horizon ${r.curve.horizonMs / 1000}s ·
    judge ${esc(r.judge.backend)}${r.judge.model ? ` (${esc(r.judge.model)})` : ''}, ${r.judge.framesJudged} frames scored${r.judge.degraded ? ' · <b>degraded: no judge</b>' : ''}</p>

  <div class="tiles">
    <div class="tile"><div class="k">Area under curve</div><div class="v">${r.curve.auc.toFixed(3)}</div><div class="n">headline, 0-1</div></div>
    <div class="tile"><div class="k">First render</div><div class="v">${secs(r.curve.ttfnbrMs)}</div><div class="n">anything on screen</div></div>
    <div class="tile"><div class="k">First reviewable</div><div class="v">${secs(r.curve.ttfrrMs)}</div><div class="n">worth feedback</div></div>
    <div class="tile"><div class="k">Final score</div><div class="v">${r.curve.finalScore.toFixed(2)}</div><div class="n">${r.curve.regression > 0.01 ? `peaked at ${r.curve.peakScore.toFixed(2)}` : 'no regression'}</div></div>
  </div>

  <section class="panel"><h2>Correctness over time</h2>${curveChart(r)}</section>

  <section class="panel"><h2>Where the time went</h2>
    ${stackedBar(r.decomposition.buckets, r.decomposition.wallMs, 'decomp')}
    ${decompTable(r)}
    <h2 style="margin-top:22px">Agent or toolchain</h2>
    ${sideSplit(r)}
    <p class="muted" style="font-size:13px;margin:10px 0 0">
      Accounted for: ${(r.decomposition.coverage * 100).toFixed(1)}% of wall clock.
      ${cc.reportedApiMs !== null ? `Agent reported ${secs(cc.reportedApiMs)} of API time; this run attributed ${secs(cc.attributedModelMs)} (delta ${secs(Math.abs(cc.deltaMs ?? 0))}).` : ''}
    </p>
    ${notes}
  </section>

  <section class="panel"><h2>Iteration: prompt to visible change</h2>${iterationTable(r)}</section>
  <section class="panel"><h2>Judged frames</h2>${filmstrip(r, outDir)}</section>
  ${warn}
</div>
<script>
(() => {
  const svg = document.querySelector('.chart');
  if (!svg) return;
  const hit = svg.querySelector('#hit'), cross = svg.querySelector('#cross'), tip = document.getElementById('tip');
  const pts = ${JSON.stringify(
    buildCurve(r.frames, { horizonMs: r.curve.horizonMs, runEndMs: r.curve.runEndMs, reviewableThreshold: 0 }),
  )};
  const hz = ${r.curve.horizonMs}, M = ${JSON.stringify(M)}, PW = ${PW};
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const scale = ${W} / box.width;
    const sx = (e.clientX - box.left) * scale;
    const t = Math.max(0, Math.min(hz, ((sx - M.l) / PW) * hz));
    let score = 0;
    for (const p of pts) { if (p.tMs <= t) score = p.score; else break; }
    cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
    cross.style.display = '';
    tip.hidden = false;
    tip.textContent = (t / 1000).toFixed(1) + 's  ·  score ' + score.toFixed(2);
    tip.style.left = Math.min(window.innerWidth - 140, e.clientX + 14) + 'px';
    tip.style.top = (e.clientY - 34) + 'px';
  });
  hit.addEventListener('pointerleave', () => { cross.style.display = 'none'; tip.hidden = true; });
})();
</script>
</body></html>`;
}
