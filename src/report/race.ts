import type { RunResult } from '../types.ts';
import { buildCurve } from '../metrics/curve.ts';
import { coldFrames } from '../phase.ts';
import { spread } from './aggregate.ts';
import { conditionOf, CONDITION_TAG, type Condition } from './leaderboard.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const secs = (ms: number | null): string => (ms === null ? '--' : `${(ms / 1000).toFixed(1)}s`);

/**
 * How far along the brief a frame is, in four bands.
 *
 * Bands rather than a continuous ramp so the legend can name each one and a
 * reader can tell "half done" from "done" without comparing two shades of the
 * same blue. The cut at 0.5 is the bundled briefs' `reviewableThreshold`.
 */
export type Band = 0 | 1 | 2 | 3;
export const bandOf = (score: number): Band => (score <= 0 ? 0 : score < 0.5 ? 1 : score < 1 ? 2 : 3);

const BAND_LABEL: Record<Band, string> = {
  0: 'Nothing scoreable on screen',
  1: 'Under half the brief',
  2: 'Half or more',
  3: 'The whole brief',
};

export interface RaceSegment {
  fromMs: number;
  toMs: number;
  score: number;
  band: Band;
}

export interface RaceRow {
  label: string;
  condition: Condition;
  runId: string;
  ttfnbrMs: number | null;
  /** First time the page met the whole brief, or null if it never did. */
  completeMs: number | null;
  runEndMs: number;
  /** Distinct non-zero score levels the page passed through on the way. */
  stages: number;
  segments: RaceSegment[];
}

/**
 * One row per run: the cold-start curve cut into runs of the same score, up to
 * the moment the window closed.
 *
 * Adjacent frames with the same score merge, so a step curve is exactly two
 * segments -- nothing, then everything -- and a staged one is as many as it
 * had stages. That count is the whole point of the chart.
 */
export function raceRow(r: RunResult): RaceRow {
  const endMs = r.curve.runEndMs;
  const points = buildCurve(coldFrames(r), { horizonMs: r.curve.horizonMs, runEndMs: endMs, reviewableThreshold: 0 }).filter((p) => p.tMs < endMs);
  const segments: RaceSegment[] = [];
  let prev = 0;
  let from = 0;
  for (const p of points) {
    if (p.score === prev) continue;
    if (p.tMs > from) segments.push({ fromMs: from, toMs: p.tMs, score: prev, band: bandOf(prev) });
    from = p.tMs;
    prev = p.score;
  }
  if (endMs > from) segments.push({ fromMs: from, toMs: endMs, score: prev, band: bandOf(prev) });
  const complete = segments.find((s) => s.band === 3);
  return {
    label: r.label || r.adapter,
    condition: conditionOf(r),
    runId: r.runId,
    ttfnbrMs: r.curve.ttfnbrMs,
    completeMs: complete ? complete.fromMs : null,
    runEndMs: endMs,
    stages: new Set(segments.filter((s) => s.score > 0).map((s) => s.score)).size,
    segments,
  };
}

export interface RaceGroup {
  label: string;
  medianTtfnbrMs: number | null;
  rows: RaceRow[];
}

const CONDITION_ORDER: Condition[] = ['prompted', 'staged', 'unprompted'];

/**
 * Rows grouped by agent, agents ordered by median first render.
 *
 * Inside a group, conditions keep a fixed order and repeats keep the order
 * they were given in, so the same agent told two different things sits on
 * adjacent rows -- that pairing is what the chart is for.
 */
export function raceGroups(runs: RunResult[]): RaceGroup[] {
  const byLabel = new Map<string, RaceRow[]>();
  for (const r of runs) {
    const row = raceRow(r);
    byLabel.set(row.label, [...(byLabel.get(row.label) ?? []), row]);
  }
  const groups = [...byLabel].map(([label, rows]) => ({
    label,
    medianTtfnbrMs: spread(rows.map((r) => r.ttfnbrMs)).median,
    rows: rows.sort((a, b) => CONDITION_ORDER.indexOf(a.condition) - CONDITION_ORDER.indexOf(b.condition)),
  }));
  return groups.sort((a, b) => (a.medianTtfnbrMs ?? Infinity) - (b.medianTtfnbrMs ?? Infinity));
}

export interface RaceOptions {
  title?: string;
  /** One sentence under the title. */
  subtitle?: string;
}

/**
 * A static page: every run as a horizontal bar on one time axis, shaded by
 * how much of the brief was on screen.
 *
 * The leaderboard replays screenshots, which shows what was on screen but not
 * how a run got there; when every run is a step, every panel looks the same
 * until it suddenly is not. This shows the shape directly: a step is one jump
 * from the empty track to the darkest band, a staged build is a ramp.
 */
export function renderRace(runs: RunResult[], opts: RaceOptions = {}): string {
  if (!runs.length) throw new Error('race needs at least one run');
  const briefs = new Set(runs.map((r) => r.brief));
  if (briefs.size > 1) throw new Error(`cannot race runs of different briefs (${[...briefs].join(', ')})`);
  const groups = raceGroups(runs);
  const maxEnd = Math.max(...runs.map((r) => r.curve.runEndMs));
  const stepS = maxEnd > 120_000 ? 30 : maxEnd > 60_000 ? 20 : 10;
  const axisMs = Math.ceil(maxEnd / 1000 / stepS) * stepS * 1000;
  const pct = (ms: number): string => `${((ms / axisMs) * 100).toFixed(3)}%`;
  const conditions = new Set(runs.map(conditionOf));
  const mixed = conditions.size > 1;
  const title = opts.title ?? `${[...briefs][0]}: time to first render`;

  const ticks: string[] = [];
  for (let s = 0; s * 1000 <= axisMs; s += stepS) {
    ticks.push(`<span class="tick" style="left:${pct(s * 1000)}">${s}s</span>`);
  }

  const rowHtml = (row: RaceRow, i: number): string => {
    const segs = row.segments
      .map(
        (s) =>
          `<span class="seg b${s.band}" style="left:${pct(s.fromMs)};width:${pct(s.toMs - s.fromMs)}"` +
          ` data-tip="${esc(`${row.label}${mixed ? ` (${CONDITION_TAG[row.condition]})` : ''}, run ${i + 1}: ` +
            `${secs(s.fromMs)}–${secs(s.toMs)}, score ${s.score.toFixed(2)}`)}"></span>`,
      )
      .join('');
    const fr =
      row.ttfnbrMs === null ? '' : `<span class="fr" style="left:${pct(row.ttfnbrMs)}" aria-hidden="true"></span>`;
    return `<tr>
  <th scope="row" class="rlabel">${mixed ? `<span class="ctag c-${row.condition}">${esc(CONDITION_TAG[row.condition])}</span>` : ''}<span class="rep">run ${i + 1}</span></th>
  <td class="trackcell"><div class="track" role="img" aria-label="${esc(
      `${row.label} run ${i + 1}: first render ${secs(row.ttfnbrMs)}, whole brief ${secs(row.completeMs)}, ${row.stages} stage${row.stages === 1 ? '' : 's'}`,
    )}">${segs}${fr}</div></td>
  <td class="num">${secs(row.ttfnbrMs)}</td><td class="num hide-sm">${secs(row.completeMs)}</td>
  <td class="num ${row.stages > 1 ? 'staged' : ''}">${row.stages}</td></tr>`;
  };

  const body = groups
    .map((g) => {
      // Number repeats within each condition, so "run 2" means the second
      // repeat of that agent told that thing.
      const seen = new Map<Condition, number>();
      const rows = g.rows
        .map((row) => {
          const n = seen.get(row.condition) ?? 0;
          seen.set(row.condition, n + 1);
          return rowHtml(row, n);
        })
        .join('');
      return `<tbody><tr class="ghead"><th colspan="5" scope="rowgroup">${esc(g.label)}</th></tr>${rows}</tbody>`;
    })
    .join('');

  const all = groups.flatMap((g) => g.rows);
  const staged = all.filter((r) => r.stages > 1).length;
  const summary =
    opts.subtitle ??
    (staged === 0
      ? `${all.length} runs. None put a partial page on screen first: every one went from nothing to its final page in one step.`
      : `${all.length} runs. ${staged} of them put a partial page on screen before the finished one; the other ${
          all.length - staged
        } went from nothing to their final page in one step.`);

  const legend = ([0, 1, 2, 3] as Band[])
    .map((b) => `<span class="key"><span class="sw b${b}"></span>${BAND_LABEL[b]}</span>`)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>
:root { color-scheme: light; --surface-0:#f6f5f2; --surface-1:#fcfcfb; --border:#e2e1dc;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#77756f; --grid:#e8e7e2;
  --track:#eeede9; --b1:#86b6ef; --b2:#3987e5; --b3:#184f95; --mark:#0b0b0b; --accent:#eb6834; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --surface-0:#111110; --surface-1:#1a1a19; --border:#302f2d; --text-primary:#fff;
  --text-secondary:#c3c2b7; --text-muted:#8f8e86; --grid:#2a2a28; --track:#232321;
  --b1:#1c5cab; --b2:#3987e5; --b3:#86b6ef; --mark:#fff; --accent:#d95926; } }
:root[data-theme="dark"] { color-scheme: dark; --surface-0:#111110; --surface-1:#1a1a19;
  --border:#302f2d; --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8f8e86;
  --grid:#2a2a28; --track:#232321; --b1:#1c5cab; --b2:#3987e5; --b3:#86b6ef; --mark:#fff; --accent:#d95926; }
* { box-sizing:border-box; }
body { margin:0; background:var(--surface-0); color:var(--text-primary);
  font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width:1100px; margin:0 auto; padding:28px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; letter-spacing:-0.01em; }
.sub { color:var(--text-secondary); margin:0 0 18px; }
.panel { background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:18px; }
.legend { display:flex; flex-wrap:wrap; gap:6px 18px; margin:0 0 14px; font-size:13px; color:var(--text-secondary); }
.key { display:inline-flex; align-items:center; gap:6px; }
.sw { width:14px; height:10px; border-radius:3px; display:inline-block; }
.sw.b0 { background:var(--track); outline:1px solid var(--border); }
.frkey { width:2px; height:14px; background:var(--mark); display:inline-block; }
table { width:100%; border-collapse:collapse; font-size:13px; }
thead th { font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-secondary);
  font-weight:600; text-align:left; padding:4px 8px 8px; }
.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; padding:3px 8px; }
th.num { text-align:right; }
.ghead th { text-align:left; font-size:14px; font-weight:600; padding:14px 8px 4px;
  border-top:1px solid var(--border); }
tbody:first-of-type .ghead th { border-top:0; }
.rlabel { font-weight:400; color:var(--text-secondary); white-space:nowrap; padding:3px 8px; text-align:left; width:1%; }
.rep { font-variant-numeric:tabular-nums; }
.ctag { font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--border);
  margin-right:6px; color:var(--text-secondary); }
.ctag.c-staged { border-color:var(--accent); color:var(--text-primary); }
.trackcell { width:100%; padding:3px 8px; }
.track { position:relative; height:16px; }
.seg { position:absolute; top:0; bottom:0; border-right:2px solid var(--surface-1); }
.seg:first-child { border-radius:4px 0 0 4px; }
.seg.b0 { background:var(--track); }
.seg.b1, .sw.b1 { background:var(--b1); }
.seg.b2, .sw.b2 { background:var(--b2); }
.seg.b3, .sw.b3 { background:var(--b3); }
.fr { position:absolute; top:-2px; bottom:-2px; width:2px; margin-left:-1px; background:var(--mark); pointer-events:none; }
.staged { color:var(--text-primary); font-weight:700; }
.axis { position:relative; height:18px; }
.tick { position:absolute; transform:translateX(-50%); font-size:11px; color:var(--text-muted);
  text-transform:none; letter-spacing:0; font-weight:400; }
.tick:first-child { transform:none; }
.tick:last-child { transform:translateX(-100%); }
.note { color:var(--text-secondary); font-size:13px; margin:14px 0 0; }
#tip { position:fixed; pointer-events:none; background:var(--surface-1); color:var(--text-primary);
  border:1px solid var(--border); border-radius:6px; padding:4px 8px; font-size:12px;
  box-shadow:0 2px 8px rgba(0,0,0,.15); display:none; z-index:2; max-width:320px; }
@media (max-width:640px) {
  .hide-sm { display:none; }
  .tick:not(:first-child):not(:last-child) { display:none; }
  .num, .rlabel, .trackcell, thead th { padding-left:4px; padding-right:4px; }
  .rlabel { width:auto; }
}
</style></head>
<body><div class="wrap">
<h1>${esc(title)}</h1>
<p class="sub">${esc(summary)}</p>
<section class="panel">
<div class="legend">${legend}<span class="key"><span class="frkey"></span>First render</span></div>
<table>
<thead><tr><th></th><th><div class="axis">${ticks.join('')}</div></th>
<th class="num">First<span class="hide-sm"> render</span></th><th class="num hide-sm">Whole brief</th><th class="num">Stages</th></tr></thead>
${body}
</table>
<p class="note">Each bar is one run, from the prompt to the moment the run ended (where the bar stops), shaded by how much of the
brief the judge could see on screen. Agents are ordered by median first render. <b>Stages</b> counts the
distinct scores the page passed through: 1 means it went from nothing to its final page in a single step.</p>
</section>
</div>
<div id="tip" role="tooltip"></div>
<script>
const tip = document.getElementById('tip');
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.style.display = 'none'; return; }
  tip.textContent = t.dataset.tip;
  tip.style.display = 'block';
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = x + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
});
</script>
</body></html>
`;
}
