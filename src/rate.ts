import type { RunResult, ScoredFrame } from './types.ts';
import { coldFrames } from './phase.ts';

/**
 * Human validation of "reviewable".
 *
 * `ttfrrMs` -- time to first *reviewable* render -- is the metric this project
 * leans on hardest, and it is operationalised as a score crossing
 * `reviewableThreshold`. That threshold is currently a number somebody chose.
 * Until a person has looked at the same frames and said whether they could
 * actually give feedback on them, "reviewable" is an assertion with a decimal
 * point in it.
 *
 * These functions build the instrument that settles it: a blinded rating sheet,
 * and the arithmetic that turns returned ratings into an agreement rate and a
 * threshold fitted to people rather than to taste.
 */

export interface RateItem {
  runId: string;
  /** Frame index within the run, the half of the join key ratings carry back. */
  index: number;
  tMs: number;
  /** The screenshot, already encoded, because the sheet has to travel. */
  dataUri: string;
}

export interface Rating {
  runId: string;
  index: number;
  /** Could a person give useful feedback on this frame? */
  reviewable: boolean;
}

/**
 * Deterministic shuffle, so a sheet can be regenerated identically.
 *
 * Order is randomised because frames arrive in time order, and a rater shown a
 * run's frames oldest-first is really being asked "has it improved yet" -- they
 * would anchor on the previous frame instead of judging this one. Mulberry32:
 * the seed is part of the instrument, not an implementation detail.
 */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Pick frames to rate, spread across the score range.
 *
 * Stratified rather than uniform: a run holds its first score for most of its
 * length, so sampling by time would hand a rater the same finished page twenty
 * times and nothing near the boundary, which is the only place the threshold is
 * decided. One frame per distinct screenshot, because rating the same picture
 * twice measures the rater's memory.
 */
export function sampleForRating(r: RunResult, perRun: number): ScoredFrame[] {
  const seen = new Set<string>();
  const distinct = coldFrames(r).filter((f) => {
    if (!f.screenshotPath || seen.has(f.screenshotPath)) return false;
    seen.add(f.screenshotPath);
    return true;
  });
  if (distinct.length <= perRun) return distinct;
  // The even-spread formula divides by perRun - 1, so one frame is its own case
  // rather than a NaN index and an undefined in the returned array.
  if (perRun <= 1) return distinct.slice(0, Math.max(0, perRun));
  // Spread the picks evenly over the score-sorted list so both ends and the
  // middle are represented whatever the distribution looks like.
  const sorted = [...distinct].sort((a, b) => a.score - b.score);
  const out: ScoredFrame[] = [];
  for (let i = 0; i < perRun; i++) {
    out.push(sorted[Math.round((i * (sorted.length - 1)) / (perRun - 1))]!);
  }
  return [...new Set(out)];
}

export interface Calibration {
  n: number;
  /** Fraction of rated frames a person called reviewable. */
  humanRate: number;
  currentThreshold: number;
  currentAgreement: number;
  bestThreshold: number;
  bestAgreement: number;
  /** Agreement at each candidate threshold, for plotting or eyeballing. */
  sweep: Array<{ threshold: number; agreement: number }>;
  /** Rated frames the join could not match to a scored frame. */
  unmatched: number;
}

/**
 * How well does a score threshold reproduce human judgement?
 *
 * Agreement, not correlation: the threshold's whole job is a binary call, so
 * the question is how often it makes the same one a person did. The sweep
 * reports the threshold that agrees most, which is the number
 * `reviewableThreshold` should be -- fitted, rather than chosen.
 */
export function calibrate(
  ratings: readonly Rating[],
  frames: ReadonlyMap<string, ScoredFrame>,
  currentThreshold: number,
): Calibration {
  const joined: Array<{ score: number; reviewable: boolean }> = [];
  let unmatched = 0;
  for (const r of ratings) {
    const f = frames.get(`${r.runId}:${r.index}`);
    if (!f) { unmatched++; continue; }
    joined.push({ score: f.score, reviewable: r.reviewable });
  }
  const agreementAt = (t: number): number =>
    joined.length === 0
      ? NaN
      : joined.filter((j) => (j.score >= t) === j.reviewable).length / joined.length;

  // Candidates are the observed scores themselves plus the midpoints between
  // them: a threshold only changes its mind when it crosses a score that was
  // actually recorded, so sweeping a fixed grid would miss the best cut and
  // report a worse number than the data supports.
  const scores = [...new Set(joined.map((j) => j.score))].sort((a, b) => a - b);
  const candidates = new Set<number>([0, 1, ...scores]);
  for (let i = 1; i < scores.length; i++) candidates.add((scores[i - 1]! + scores[i]!) / 2);

  const sweep = [...candidates]
    .sort((a, b) => a - b)
    .map((threshold) => ({ threshold, agreement: agreementAt(threshold) }));
  const best = sweep.reduce((a, b) => (b.agreement > a.agreement ? b : a), sweep[0] ?? { threshold: NaN, agreement: NaN });

  return {
    n: joined.length,
    humanRate: joined.length ? joined.filter((j) => j.reviewable).length / joined.length : NaN,
    currentThreshold,
    currentAgreement: agreementAt(currentThreshold),
    bestThreshold: best.threshold,
    bestAgreement: best.agreement,
    sweep,
    unmatched,
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A self-contained rating sheet.
 *
 * One file, no server, no build: the rater opens it, answers, and gets a JSON
 * file back. Anything that needs hosting or a login does not get done by the
 * three people whose judgement the metric actually rests on.
 *
 * The sheet never shows the machine's score, the run's label, or the frame's
 * timestamp. A rater who can see that the harness called a frame 0.85 is no
 * longer an independent measurement of whether it was reviewable -- they are
 * agreeing with a number, and the agreement rate that comes back would be
 * evidence of nothing.
 */
export function ratingSheet(items: readonly RateItem[], briefPrompt: string, seed = 1): string {
  const order = shuffled(items, seed);
  const payload = order.map((i) => ({ runId: i.runId, index: i.index, src: i.dataUri }));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Is this reviewable?</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#2f6fd0; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --fg:#eceff4; --muted:#9aa3b2; --line:#2a2f37; --accent:#6aa3f0; } }
  body { background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         margin:0; padding:24px; max-width:1000px; margin-inline:auto; }
  .brief { border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-bottom:20px; }
  .brief h2 { margin:0 0 6px; font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  img { max-width:100%; border:1px solid var(--line); border-radius:6px; display:block; }
  .bar { display:flex; gap:10px; margin:14px 0 6px; flex-wrap:wrap; }
  button { font:inherit; padding:10px 16px; border-radius:6px; border:1px solid var(--line); background:transparent;
           color:var(--fg); cursor:pointer; }
  button.primary { border-color:var(--accent); color:var(--accent); font-weight:600; }
  .muted { color:var(--muted); font-size:13px; }
  #done { display:none; }
</style></head><body>
<div class="brief"><h2>The brief the agent was given</h2><div>${esc(briefPrompt)}</div></div>

<div id="ask">
  <p class="muted">Frame <b id="n">1</b> of ${order.length}. You are looking at a web page an AI agent
  was part-way through building.</p>
  <p><b>Could you give the agent useful feedback on what you see here?</b></p>
  <img id="shot" alt="A frame from an agent run"/>
  <div class="bar">
    <button class="primary" data-v="1">Yes &mdash; I could react to this</button>
    <button data-v="0">No &mdash; nothing to react to yet</button>
    <button id="back">Back</button>
  </div>
  <p class="muted">Judge only this picture. There is no right answer and nothing is timed.</p>
</div>

<div id="done">
  <p><b>Done &mdash; thank you.</b> ${order.length} frames rated.</p>
  <div class="bar"><button class="primary" id="save">Download ratings.json</button></div>
  <p class="muted">Send that file back to whoever asked you to do this. It contains your
  yes/no answers and nothing else.</p>
</div>

<script>
const ITEMS = ${JSON.stringify(payload)};
const out = [];
let i = 0;
const shot = document.getElementById('shot');
const n = document.getElementById('n');
function show() {
  if (i >= ITEMS.length) {
    document.getElementById('ask').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    return;
  }
  n.textContent = String(i + 1);
  shot.src = ITEMS[i].src;
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll('button[data-v]')) {
  b.addEventListener('click', () => {
    out[i] = { runId: ITEMS[i].runId, index: ITEMS[i].index, reviewable: b.dataset.v === '1' };
    i++; show();
  });
}
document.getElementById('back').addEventListener('click', () => { if (i > 0) { i--; show(); } });
document.getElementById('save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ratings.json';
  a.click();
});
show();
</script>
</body></html>`;
}
