import { relative, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { FrameClass, RunResult } from '../types.ts';
import { buildCurve } from '../metrics/curve.ts';
import { coldFrames } from '../phase.ts';
import { rank, assertComparable, type Ranked } from './compare.ts';
import { spread } from './aggregate.ts';
import { SERIES_LIGHT, SERIES_DARK } from './palette.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const secs = (ms: number | null): string => (ms === null ? '--' : `${(ms / 1000).toFixed(1)}s`);

const signedAuc = (v: number): string => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(3)}`;

/**
 * A time delta said in words rather than as a signed number.
 *
 * One of the two paired numbers is better when larger and the other when
 * smaller, so a bare sign is exactly the kind of thing a reader gets backwards.
 * Anything inside a poll interval is "same": the prober cannot resolve it.
 */
const sooner = (ms: number | null): string =>
  ms === null ? '--' : Math.abs(ms) < 1000 ? 'same' : `${(Math.abs(ms) / 1000).toFixed(1)}s ${ms > 0 ? 'sooner' : 'later'}`;

/** Inline JSON must not be able to close the script element that carries it. */
const json = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

const CLASS_CODE: Record<FrameClass, number> = { unreachable: 0, error: 1, blank: 2, render: 3 };

/** Which experiment a run belongs to. */
export type Condition = 'prompted' | 'unprompted';

export const CONDITION_LABEL: Record<Condition, string> = {
  prompted: 'Told the clock is running',
  unprompted: 'Not told (unprompted behaviour)',
};

/**
 * Whether this run was asked to render something early.
 *
 * Results written before the protocol was recorded all carried the clause, so
 * an absent field means prompted rather than unknown.
 */
export function conditionOf(r: RunResult): Condition {
  return r.protocol?.renderEarly === false ? 'unprompted' : 'prompted';
}

export interface OrderedRow {
  condition: Condition;
  /** Index into the runs array this was ordered from. */
  index: number;
  ranked: Ranked;
}

/**
 * Rank within each condition, never across them.
 *
 * An agent told that a rough early page scores better is answering a different
 * question from one that was not, so a single ordering over both would be a
 * ranking of two different experiments -- exactly the kind of plausible table
 * this project exists to refuse. Ranking inside each condition keeps every "#"
 * meaningful, and the prompt effect below is where the two meet.
 */
export function orderByCondition(runs: RunResult[]): OrderedRow[] {
  const order: Condition[] = ['prompted', 'unprompted'];
  const rows: OrderedRow[] = [];
  for (const condition of order) {
    const picked = runs
      .map((r, index) => ({ r, index }))
      .filter((e) => conditionOf(e.r) === condition);
    if (!picked.length) continue;
    for (const ranked of rank(picked.map((e) => e.r))) {
      rows.push({ condition, index: picked[ranked.index]!.index, ranked });
    }
  }
  return rows;
}

export interface PromptEffect {
  label: string;
  runs: { prompted: number; unprompted: number };
  aucPrompted: number;
  aucUnprompted: number;
  /** Prompted minus unprompted: positive means the instruction helped. */
  aucDelta: number;
  ttfnbrPromptedMs: number | null;
  ttfnbrUnpromptedMs: number | null;
  /** Unprompted minus prompted: positive means it rendered that much sooner. */
  ttfnbrDeltaMs: number | null;
}

/**
 * What counts as "the same agent" across the two conditions.
 *
 * Adapter and model, when the model is recorded, because that is the objective
 * identity of the thing measured. `label` cannot carry it: the natural way to
 * run this experiment is to name the runs after their condition -- `told-opus`
 * and `nottold-opus` -- and keying on that put every run in a cell of its own,
 * paired nothing, and made the section disappear with no explanation. Labels
 * remain the fallback for runs written before the model was recorded, where
 * matching labels were the only way to express the pairing at all.
 */
function pairingKey(r: RunResult): string {
  return r.model ? `${r.adapter}:${r.model}` : r.label || r.adapter;
}

/**
 * What the instruction was worth, for agents measured both ways.
 *
 * This is the only honest comparison across the two conditions, because it is
 * paired: same agent, same brief, one difference. A large delta says the agent
 * can render early but does not think to; a delta near zero says the ranking
 * would look the same either way, which is the more interesting result and the
 * one a merged table would have hidden.
 *
 * Both signs are oriented so that positive means the instruction helped, since
 * one of the two underlying numbers is better when larger and the other when
 * smaller. Repeats collapse to their median -- one run is not a measurement.
 */
export function promptEffects(runs: RunResult[]): PromptEffect[] {
  const cells = new Map<string, Record<Condition, RunResult[]>>();
  for (const r of runs) {
    const cell = cells.get(pairingKey(r)) ?? { prompted: [], unprompted: [] };
    cell[conditionOf(r)].push(r);
    cells.set(pairingKey(r), cell);
  }

  const effects: PromptEffect[] = [];
  for (const [label, cell] of cells) {
    if (!cell.prompted.length || !cell.unprompted.length) continue;
    const aucP = spread(cell.prompted.map((r) => r.curve.auc)).median ?? 0;
    const aucU = spread(cell.unprompted.map((r) => r.curve.auc)).median ?? 0;
    const tP = spread(cell.prompted.map((r) => r.curve.ttfnbrMs)).median;
    const tU = spread(cell.unprompted.map((r) => r.curve.ttfnbrMs)).median;
    effects.push({
      label,
      runs: { prompted: cell.prompted.length, unprompted: cell.unprompted.length },
      aucPrompted: aucP,
      aucUnprompted: aucU,
      aucDelta: aucP - aucU,
      ttfnbrPromptedMs: tP,
      ttfnbrUnpromptedMs: tU,
      ttfnbrDeltaMs: tP !== null && tU !== null ? tU - tP : null,
    });
  }
  return effects.sort((a, b) => b.aucDelta - a.aucDelta);
}

export interface LeaderboardTrack {
  label: string;
  adapter: string;
  auc: number;
  finalScore: number;
  ttfnbrMs: number | null;
  ttfrrMs: number | null;
  runEndMs: number;
  endReason: string;
  /** Distinct screenshot paths, relative to the page. */
  srcs: string[];
  /** Frame times, ms since t0. */
  t: number[];
  /** Index into `srcs` for each frame; -1 when that frame has no screenshot. */
  shot: number[];
  /** Score per frame, 0-100, so the payload stays integers. */
  score: number[];
  /** Frame class per frame, as a code. */
  cls: number[];
  /** Curve as [tMs, score*100] pairs, for the panel sparkline. */
  curve: Array<[number, number]>;
  reportHref: string | null;
  videoHref: string | null;
  condition: Condition;
}

/**
 * Turn one run into everything the player needs, and nothing else.
 *
 * Frames are emitted whole rather than sampled: the player has to be able to
 * show the state at any instant on the shared clock, and a filmstrip that
 * dropped frames would make a run look steadier than it was. What is dropped is
 * repetition -- consecutive frames that point at the same screenshot share one
 * entry in `srcs` -- which is where all the size is.
 */
export function buildTrack(r: RunResult, pageDir: string, runDir: string): LeaderboardTrack {
  const srcs: string[] = [];
  const byPath = new Map<string, number>();
  const t: number[] = [];
  const shot: number[] = [];
  const score: number[] = [];
  const cls: number[] = [];

  // Cold-start only: the scrubber is a side-by-side replay of the measured
  // window, so an extra tail of iteration frames would desynchronise two runs
  // that are otherwise directly comparable.
  for (const f of [...coldFrames(r)].sort((a, b) => a.tMs - b.tMs)) {
    let idx = -1;
    if (f.screenshotPath) {
      const rel = relative(pageDir, f.screenshotPath).split(/[\\/]/).join('/');
      idx = byPath.get(rel) ?? -1;
      if (idx < 0) {
        idx = srcs.push(rel) - 1;
        byPath.set(rel, idx);
      }
    }
    t.push(f.tMs);
    shot.push(idx);
    score.push(Math.round(f.score * 100));
    cls.push(CLASS_CODE[f.class]);
  }

  const rel = (p: string | null | undefined): string | null =>
    p && existsSync(p) ? relative(pageDir, p).split(/[\\/]/).join('/') : null;

  return {
    label: r.label || r.adapter,
    adapter: r.adapter,
    auc: r.curve.auc,
    finalScore: r.curve.finalScore,
    ttfnbrMs: r.curve.ttfnbrMs,
    ttfrrMs: r.curve.ttfrrMs,
    runEndMs: r.curve.runEndMs,
    endReason: r.endReason ?? 'unknown',
    srcs,
    t,
    shot,
    score,
    cls,
    curve: buildCurve(coldFrames(r), {
      horizonMs: r.curve.horizonMs,
      runEndMs: r.curve.runEndMs,
      reviewableThreshold: 0,
    }).map((p): [number, number] => [p.tMs, Math.round(p.score * 100)]),
    reportHref: rel(join(runDir, 'report.html')),
    videoHref: rel(r.artifacts?.videoPath),
    condition: conditionOf(r),
  };
}

/**
 * The leaderboard: a ranking, and every run replayed side by side on one clock.
 *
 * The table is the claim and the players are the evidence. A run that wins on
 * area under the curve should be visibly ahead at the four-minute mark, and if
 * it is not, the number is wrong and this is where anyone would notice. Both
 * are driven by the same frames, so they cannot drift apart.
 */
export function renderLeaderboard(
  runs: RunResult[],
  outPath: string,
  opts: { title?: string; runDirs?: string[] } = {},
): string {
  assertComparable(runs, { allowMixedConditions: true });
  const pageDir = dirname(outPath);
  const horizonMs = runs[0]?.curve.horizonMs ?? 0;
  // Ranked within each condition, never across: rows carry the index of the run
  // they came from, so panels, table rows and series colours stay lined up even
  // when several runs share a label.
  const rows = orderByCondition(runs);
  const ranked = rows.map((row) => row.ranked);
  const effects = promptEffects(runs);
  const mixed = new Set(rows.map((row) => row.condition)).size > 1;
  const tracks = rows.map((row) => buildTrack(runs[row.index]!, pageDir, opts.runDirs?.[row.index] ?? pageDir));

  const totalShots = tracks.reduce((n, t) => n + t.srcs.length, 0);
  const vars = (list: string[]): string => list.map((c, i) => `--series-${i + 1}: ${c};`).join(' ');
  const slot = (i: number): number => (i % 6) + 1;

  // --- the overlaid curves, drawn server-side so the page needs no chart lib --
  const W = 900, H = 260, M = { l: 44, r: 116, t: 14, b: 30 };
  const PW = W - M.l - M.r, PH = H - M.t - M.b;
  const x = (ms: number): number => M.l + (Math.min(ms, horizonMs) / Math.max(1, horizonMs)) * PW;
  const y = (s: number): number => M.t + (1 - s) * PH;
  const paths = tracks.map((tr, i) => {
    let prev = tr.curve[0]?.[1] ?? 0;
    let d = `M ${x(0)} ${y(prev / 100)}`;
    for (let k = 1; k < tr.curve.length; k++) {
      const [tMs, sc] = tr.curve[k]!;
      d += ` L ${x(tMs)} ${y(prev / 100)} L ${x(tMs)} ${y(sc / 100)}`;
      prev = sc;
    }
    d += ` L ${x(horizonMs)} ${y(prev / 100)}`;
    return { d, endY: y(prev / 100), slot: slot(i), label: tr.label };
  });
  const gridY = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) => `<line class="grid" x1="${M.l}" x2="${M.l + PW}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(2)}</text>`,
    )
    .join('');
  const gridX = Array.from({ length: 7 }, (_, i) => {
    const ms = (horizonMs / 6) * i;
    return `<text class="tick" x="${x(ms)}" y="${H - 8}" text-anchor="middle">${Math.round(ms / 1000)}s</text>`;
  }).join('');

  // Runs that end on the same score would otherwise stack their labels on one
  // line at the right edge and render as illegible overlapping text -- which is
  // the common case, since a set of agents that all finish the brief all end at
  // the top of the chart.
  const labelRows = (ps: Array<{ endY: number; slot: number; label: string }>): string[] => {
    const taken: number[] = [];
    return [...ps]
      .sort((a, b) => a.endY - b.endY)
      .map((p) => {
        let y = p.endY;
        while (taken.some((t) => Math.abs(t - y) < 14)) y += 14;
        taken.push(y);
        return `<text class="lbl" x="${M.l + PW + 8}" y="${y}" fill="var(--series-${p.slot})">${esc(
          p.label.slice(0, 15),
        )}</text>`;
      });
  };

  const panels = tracks
    .map(
      (tr, i) => `<figure class="panel player" data-i="${i}">
      <figcaption class="phead">
        <span class="rank">${i + 1}</span>
        <span class="plabel" style="color:var(--series-${slot(i)})">${esc(tr.label)}</span>
        <span class="pauc">AUC ${tr.auc.toFixed(3)}</span>${
        mixed ? `<span class="ctag">${tr.condition === 'prompted' ? 'told' : 'not told'}</span>` : ''
      }
      </figcaption>
      <div class="screen"><img alt="${esc(tr.label)} at the current time" decoding="async"/>
        <span class="badge"></span></div>
      <svg class="spark" viewBox="0 0 300 46" preserveAspectRatio="none" aria-hidden="true">
        <path class="sline" stroke="var(--series-${slot(i)})"/>
        <line class="splay" y1="0" y2="46"/>
      </svg>
      <div class="pfoot">
        <span class="pscore">--</span>
        <span class="pmeta">first render ${secs(tr.ttfnbrMs)} · reviewable ${secs(tr.ttfrrMs)}</span>
        <span class="plinks">${tr.reportHref ? `<a href="${esc(tr.reportHref)}">report</a>` : ''}${
          tr.videoHref ? ` <a href="${esc(tr.videoHref)}">video</a>` : ''
        }</span>
      </div>
    </figure>`,
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(opts.title ?? `Prompt-to-paint leaderboard · ${runs[0]?.brief ?? ''}`)}</title>
<style>
  :root { color-scheme: light; --surface-0:#f6f5f2; --surface-1:#fcfcfb; --surface-2:#eeede9;
    --border:#e2e1dc; --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#77756f;
    --grid:#e8e7e2; --muted-fill:#c9c8c2; ${vars(SERIES_LIGHT)} }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
    --surface-0:#111110; --surface-1:#1a1a19; --surface-2:#232321; --border:#302f2d;
    --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2a2a28;
    --muted-fill:#4a4946; ${vars(SERIES_DARK)} } }
  :root[data-theme="dark"] { color-scheme: dark; --surface-0:#111110; --surface-1:#1a1a19;
    --surface-2:#232321; --border:#302f2d; --text-primary:#fff; --text-secondary:#c3c2b7;
    --text-muted:#8f8e86; --grid:#2a2a28; --muted-fill:#4a4946; ${vars(SERIES_DARK)} }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--surface-0); color:var(--text-primary);
    font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:28px 16px 64px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-0.01em; }
  h2 { font-size:15px; margin:0 0 14px; color:var(--text-secondary); text-transform:uppercase;
    letter-spacing:0.06em; font-weight:600; }
  .sub { color:var(--text-secondary); margin:0 0 22px; font-size:14px; }
  .panel { background:var(--surface-1); border:1px solid var(--border); border-radius:12px;
    padding:18px; margin:0 0 18px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;
    color:var(--text-secondary); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--border); }
  td { padding:7px 8px; border-bottom:1px solid var(--border); }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .swatch { width:10px; height:10px; border-radius:3px; display:inline-block; margin-right:8px; }
  .moved { color:var(--series-2); font-weight:600; }
  .cgroup td { font-weight:600; padding-top:16px; color:var(--text-secondary);
    border-bottom:1px solid var(--border); }
  .ctag { font-size:11px; padding:1px 6px; border-radius:99px; border:1px solid var(--border);
    color:var(--text-secondary); margin-left:6px; }
  .delta-up { color:var(--series-3); } .delta-flat { color:var(--text-secondary); }
  svg.chart { width:100%; height:auto; overflow:visible; display:block; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .tick { fill:var(--text-muted); font-size:11px; }
  .s { fill:none; stroke-width:2; stroke-linejoin:round; }
  .lbl { font-size:12px; font-weight:600; dominant-baseline:middle; }
  #chartplay { stroke:var(--text-primary); stroke-width:1.5; opacity:.5; }

  /* ---- transport ---- */
  .transport { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:12px;
    background:var(--surface-1); border:1px solid var(--border); border-radius:12px;
    padding:12px 16px; margin:0 0 18px; flex-wrap:wrap;
    box-shadow:0 2px 10px rgba(0,0,0,.05); }
  .transport button { font:inherit; font-weight:600; cursor:pointer; color:var(--text-primary);
    background:var(--surface-2); border:1px solid var(--border); border-radius:8px; padding:6px 14px; }
  .transport button:hover { border-color:var(--text-muted); }
  .transport .t { font-variant-numeric:tabular-nums; font-weight:650; min-width:104px; }
  .transport input[type=range] { flex:1; min-width:220px; accent-color:var(--series-1); }
  .speeds { display:flex; gap:4px; }
  .speeds button { padding:6px 10px; font-size:13px; }
  .speeds button[aria-pressed="true"] { background:var(--series-1); border-color:var(--series-1); color:#fff; }
  .buffer { font-size:12px; color:var(--text-muted); font-variant-numeric:tabular-nums; }

  /* ---- players ---- */
  .grid-players { display:grid; gap:16px; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); }
  .player { padding:12px; margin:0; }
  .phead { display:flex; align-items:center; gap:8px; margin:0 0 8px; font-size:13px; }
  .rank { width:20px; height:20px; border-radius:6px; background:var(--surface-2); color:var(--text-secondary);
    display:grid; place-items:center; font-size:11px; font-weight:700; flex:none; }
  .plabel { font-weight:650; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pauc { color:var(--text-muted); font-variant-numeric:tabular-nums; }
  .screen { position:relative; aspect-ratio:16/10; background:var(--surface-2);
    border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  .screen img { width:100%; height:100%; object-fit:cover; object-position:top center; display:block; }
  .screen img[data-empty="1"] { visibility:hidden; }
  .badge { position:absolute; left:8px; bottom:8px; font-size:11px; font-weight:700;
    padding:3px 7px; border-radius:6px; background:rgba(0,0,0,.62); color:#fff; letter-spacing:.02em; }
  .spark { width:100%; height:46px; margin-top:8px; display:block; }
  .sline { fill:none; stroke-width:2; vector-effect:non-scaling-stroke; }
  .splay { stroke:var(--text-muted); stroke-width:1; vector-effect:non-scaling-stroke; }
  .pfoot { display:flex; align-items:baseline; gap:8px; margin-top:6px; font-size:12px;
    color:var(--text-secondary); flex-wrap:wrap; }
  .pscore { font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--text-primary); }
  .pmeta { color:var(--text-muted); }
  .plinks { margin-left:auto; }
  .plinks a { color:var(--text-secondary); }
  .note { color:var(--text-secondary); font-size:13px; margin:14px 0 0; }
  @media (max-width:560px) { .wrap { padding:18px 12px 48px; } .transport { position:static; } }
</style></head><body><div class="wrap">

<h1>${esc(opts.title ?? 'Prompt-to-paint leaderboard')}</h1>
<p class="sub">${esc(runs[0]?.brief ?? '')} · ${runs.length} runs · horizon ${horizonMs / 1000}s ·
  ${totalShots} distinct screenshots</p>

<div class="transport">
  <button id="playpause" aria-label="Play or pause">▶ Play</button>
  <span class="t" id="tnow">00:00 / 00:00</span>
  <input id="scrub" type="range" min="0" max="${horizonMs}" value="0" step="100" aria-label="Scrub"/>
  <span class="speeds" role="group" aria-label="Playback speed">
    <button data-speed="1">1×</button><button data-speed="4">4×</button>
    <button data-speed="10" aria-pressed="true">10×</button><button data-speed="30">30×</button>
  </span>
  <span class="buffer" id="buffer"></span>
</div>

<div class="grid-players">${panels}</div>

<section class="panel" style="margin-top:18px"><h2>Correctness over time</h2>
<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Correctness over time for ${runs.length} runs">
  ${gridY}${gridX}
  ${paths.map((p) => `<path class="s" d="${p.d}" stroke="var(--series-${p.slot})"/>`).join('')}
  ${labelRows(paths).join('')}
  <line id="chartplay" y1="${M.t}" y2="${M.t + PH}" x1="${M.l}" x2="${M.l}"/>
</svg></section>

<section class="panel"><h2>Ranking</h2>
<table><thead><tr><th>Run</th><th class="num">AUC</th><th class="num">Final</th>
<th class="num">First render</th><th class="num">First reviewable</th>
<th class="num">By AUC</th><th class="num">By final</th><th>Window closed by</th></tr></thead><tbody>
${rows
  .map((row, i) => {
    const r = row.ranked;
    const tr = tracks[i]!; // rows, ranked and tracks are built in the same order
    const head =
      mixed && (i === 0 || rows[i - 1]!.condition !== row.condition)
        ? `<tr class="cgroup"><td colspan="8">${esc(CONDITION_LABEL[row.condition])}</td></tr>`
        : '';
    return `${head}<tr>
  <td><span class="swatch" style="background:var(--series-${slot(i)})"></span>${esc(r.label)}</td>
  <td class="num"><b>${r.auc.toFixed(3)}</b></td><td class="num">${r.finalScore.toFixed(2)}</td>
  <td class="num">${secs(r.ttfnbrMs)}</td><td class="num">${secs(r.ttfrrMs)}</td>
  <td class="num">${r.rankAuc}</td>
  <td class="num ${r.rankAuc !== r.rankFinal ? 'moved' : ''}">${r.rankFinal}${r.rankAuc !== r.rankFinal ? ' ≠' : ''}</td>
  <td>${esc(tr.endReason)}</td></tr>`;
  })
  .join('')}
</tbody></table>
<p class="note">${
    ranked.filter((r) => r.rankAuc !== r.rankFinal).length === 0
      ? 'AUC and final score agree on the ordering for this set.'
      : 'Highlighted rows rank differently by trajectory than by final score — the disagreement the trajectory metric exists to surface.'
  } Playback shows the frames the scores were computed from, on one shared clock, so the ranking above and the pictures below cannot disagree.</p>
</section>
${
    effects.length
      ? `<section class="panel"><h2>What the instruction was worth</h2>
<table><thead><tr><th>Run</th><th class="num">AUC told</th><th class="num">AUC not told</th>
<th class="num">&Delta; AUC</th><th class="num">First render told</th>
<th class="num">not told</th><th>Effect on first render</th></tr></thead><tbody>
${effects
  .map(
    (e) => `<tr>
  <td>${esc(e.label)}${
      e.runs.prompted > 1 || e.runs.unprompted > 1
        ? ` <span class="ctag">medians of ${e.runs.prompted}/${e.runs.unprompted}</span>`
        : ''
    }</td>
  <td class="num">${e.aucPrompted.toFixed(3)}</td><td class="num">${e.aucUnprompted.toFixed(3)}</td>
  <td class="num ${Math.abs(e.aucDelta) < 0.02 ? 'delta-flat' : 'delta-up'}"><b>${signedAuc(e.aucDelta)}</b></td>
  <td class="num">${secs(e.ttfnbrPromptedMs)}</td><td class="num">${secs(e.ttfnbrUnpromptedMs)}</td>
  <td>${sooner(e.ttfnbrDeltaMs)}</td></tr>`,
  )
  .join('')}
</tbody></table>
<p class="note">Paired: the same agent on the same brief, with one difference &mdash; whether the
protocol asked for an early rough render. Positive means the instruction helped. A delta near zero
is the more interesting result, because it says the ranking would look the same without the
instruction; a large one says the agent can render early but does not think to. The two rankings
above are separate on purpose and must not be read as one table.</p>
</section>`
      : ''
  }

</div>
<script id="tracks" type="application/json">${json(tracks)}</script>
<script>
(() => {
  const tracks = JSON.parse(document.getElementById('tracks').textContent);
  const HZ = ${horizonMs};
  const CLASS = ['no server', 'error', 'blank', 'rendering'];
  const players = [...document.querySelectorAll('.player')].map((el, i) => ({
    el,
    tr: tracks[i],
    img: el.querySelector('img'),
    badge: el.querySelector('.badge'),
    score: el.querySelector('.pscore'),
    play: el.querySelector('.splay'),
    cursor: -1,
  }));

  // Draw each panel's own curve once, in the sparkline's own coordinate space.
  for (const p of players) {
    const path = p.el.querySelector('.sline');
    const pts = p.tr.curve;
    let prev = pts.length ? pts[0][1] : 0;
    let d = 'M 0 ' + (44 - prev * 0.42);
    for (let k = 1; k < pts.length; k++) {
      const px = Math.min(1, pts[k][0] / HZ) * 300;
      d += ' L ' + px + ' ' + (44 - prev * 0.42) + ' L ' + px + ' ' + (44 - pts[k][1] * 0.42);
      prev = pts[k][1];
    }
    d += ' L 300 ' + (44 - prev * 0.42);
    path.setAttribute('d', d);
  }

  // Warm the cache in the background. Playback works without this; it just
  // stutters on the first pass, which reads as the run being jerky when it was
  // not. Progress is shown rather than blocking the controls.
  const all = tracks.flatMap((t) => t.srcs);
  let loaded = 0;
  const bufferEl = document.getElementById('buffer');
  const showBuffer = () => {
    bufferEl.textContent = loaded >= all.length ? '' : 'buffering ' + Math.round((loaded / all.length) * 100) + '%';
  };
  showBuffer();
  for (const src of all) {
    const im = new Image();
    im.onload = im.onerror = () => { loaded++; showBuffer(); };
    im.src = src;
  }

  const chartPlay = document.getElementById('chartplay');
  const CH = { l: ${M.l}, pw: ${PW} };
  const scrub = document.getElementById('scrub');
  const tnow = document.getElementById('tnow');
  const btn = document.getElementById('playpause');
  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  /** Last frame at or before t. Frames are in time order, so this walks. */
  function seek(p, t) {
    const times = p.tr.t;
    let i = p.cursor;
    if (i < 0 || times[i] > t) i = -1;
    while (i + 1 < times.length && times[i + 1] <= t) i++;
    return i;
  }

  let clock = 0, playing = false, speed = 10, last = 0;

  function render() {
    for (const p of players) {
      const i = seek(p, clock);
      if (i === p.cursor) continue;
      p.cursor = i;
      if (i < 0) {
        p.img.dataset.empty = '1';
        p.badge.textContent = 'not started';
        p.score.textContent = '--';
      } else {
        const s = p.tr.shot[i];
        if (s >= 0) { p.img.dataset.empty = '0'; p.img.src = p.tr.srcs[s]; }
        else p.img.dataset.empty = '1';
        p.badge.textContent = CLASS[p.tr.cls[i]] + (clock > p.tr.runEndMs ? ' · run ended' : '');
        p.score.textContent = (p.tr.score[i] / 100).toFixed(2);
      }
    }
    for (const p of players) p.play.setAttribute('transform', 'translate(' + Math.min(1, clock / HZ) * 300 + ',0)');
    const px = CH.l + Math.min(1, clock / HZ) * CH.pw;
    chartPlay.setAttribute('x1', px); chartPlay.setAttribute('x2', px);
    tnow.textContent = mmss(clock) + ' / ' + mmss(HZ);
    scrub.value = String(Math.round(clock));
  }

  function frame(now) {
    if (!playing) return;
    const dt = last ? now - last : 0;
    last = now;
    clock = Math.min(HZ, clock + dt * speed);
    render();
    if (clock >= HZ) { setPlaying(false); return; }
    requestAnimationFrame(frame);
  }

  function setPlaying(on) {
    playing = on;
    btn.textContent = on ? '❚❚ Pause' : '▶ Play';
    if (on) {
      if (clock >= HZ) clock = 0;
      last = 0;
      requestAnimationFrame(frame);
    }
  }

  btn.addEventListener('click', () => setPlaying(!playing));
  scrub.addEventListener('input', () => { clock = Number(scrub.value); render(); });
  for (const b of document.querySelectorAll('.speeds button')) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.speed);
      for (const o of document.querySelectorAll('.speeds button')) o.setAttribute('aria-pressed', String(o === b));
    });
  }
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.key === 'ArrowRight') { clock = Math.min(HZ, clock + 1000); render(); }
    if (e.key === 'ArrowLeft') { clock = Math.max(0, clock - 1000); render(); }
  });

  render();
})();
</script>
</body></html>`;
}

/**
 * Terminal view of the same ranking, with the end reason spelled out.
 *
 * A run cut off at the horizon and a run the agent finished are not the same
 * measurement, and the difference is invisible in the numbers alone.
 */
export function renderLeaderboardText(runs: RunResult[]): string {
  assertComparable(runs, { allowMixedConditions: true });
  const rows = orderByCondition(runs);
  const effects = promptEffects(runs);
  const mixed = new Set(rows.map((row) => row.condition)).size > 1;
  const L: string[] = [''];

  for (const [i, row] of rows.entries()) {
    if (i === 0 || rows[i - 1]!.condition !== row.condition) {
      // A heading per condition, and a separate 1..n, because the two are
      // different experiments and one continuous ranking over both would be a
      // number nobody can act on.
      if (i > 0) L.push('');
      if (mixed) L.push(`  ${CONDITION_LABEL[row.condition]}`);
      L.push(
        '  ' + '#'.padEnd(3) + 'run'.padEnd(24) + 'AUC'.padStart(7) + 'final'.padStart(8) +
          'first'.padStart(9) + 'reviewable'.padStart(12) + '  ended by',
      );
      L.push('  ' + '-'.repeat(76));
    }
    const r = row.ranked;
    L.push(
      '  ' + String(r.rankAuc).padEnd(3) + r.label.slice(0, 23).padEnd(24) +
        r.auc.toFixed(3).padStart(7) + r.finalScore.toFixed(2).padStart(8) +
        secs(r.ttfnbrMs).padStart(9) + secs(r.ttfrrMs).padStart(12) +
        '  ' + (runs[row.index]?.endReason ?? 'unknown'),
    );
  }

  if (effects.length) {
    L.push('');
    L.push('  What the instruction was worth  (same agent, same brief, told vs not told)');
    L.push(
      '  ' + 'run'.padEnd(24) + 'AUC told'.padStart(10) + 'not told'.padStart(10) +
        'delta'.padStart(9) + '  first render',
    );
    L.push('  ' + '-'.repeat(76));
    for (const e of effects) {
      L.push(
        '  ' + e.label.slice(0, 23).padEnd(24) + e.aucPrompted.toFixed(3).padStart(10) +
          e.aucUnprompted.toFixed(3).padStart(10) + signedAuc(e.aucDelta).padStart(9) +
          '  ' + sooner(e.ttfnbrDeltaMs),
      );
    }
    L.push('  Positive means the instruction helped.');
  } else if (mixed) {
    // Both conditions are here and nothing paired. Saying nothing would let a
    // reader conclude the instruction was worth nothing, when in fact the
    // comparison was never made.
    L.push('');
    L.push('  ! Runs from both conditions are listed above, but none of them paired up,');
    L.push('    so "what the instruction was worth" could not be computed. Runs pair on');
    L.push('    adapter and model, or on an exact label match for runs that recorded no');
    L.push('    model. Measure the same agent both ways to get that row.');
  }

  L.push('');
  return L.join('\n');
}
