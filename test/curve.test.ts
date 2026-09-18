import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, integrate, buildCurve } from '../src/metrics/curve.ts';
import type { ScoredFrame } from '../src/types.ts';

function frame(tMs: number, score: number, over: Partial<ScoredFrame> = {}): ScoredFrame {
  return {
    index: 0,
    tMs,
    class: score > 0 ? 'render' : 'blank',
    reason: 'test',
    screenshotPath: null,
    dhash: null,
    colorSig: null,
    inkRatio: score > 0 ? 0.2 : 0,
    text: '',
    title: '',
    favicon: null,
    tabSignal: false,
    httpStatus: 200,
    consoleErrors: [],
    entityCoverage: score,
    entitiesFound: [],
    domSignature: '',
    captureMs: 10,
    score,
    scoreSource: 'judge',
    ...over,
  };
}

const S = 1000;
const opts = { horizonMs: 600 * S, runEndMs: 300 * S, reviewableThreshold: 0.5 };

test('integrate holds each score forward to the next sample', () => {
  const pts = [
    { tMs: 0, score: 0 },
    { tMs: 100, score: 1 },
  ];
  // 0 for [0,100), 1 for [100,200) => half the window.
  assert.equal(integrate(pts, 200), 0.5);
});

test('integrate clips at the horizon rather than extrapolating past it', () => {
  const pts = [
    { tMs: 0, score: 0 },
    { tMs: 50, score: 1 },
    { tMs: 500, score: 1 },
  ];
  assert.equal(integrate(pts, 100), 0.5);
});

test('early-and-crude beats late-and-perfect at equal final score', () => {
  // The scenario the metric exists to capture.
  const crudeThenRefined = [frame(20 * S, 0.4), frame(120 * S, 0.9), frame(300 * S, 0.9)];
  const blankThenNails = [frame(20 * S, 0), frame(239 * S, 0), frame(240 * S, 0.9)];

  const a = computeMetrics(crudeThenRefined, opts);
  const b = computeMetrics(blankThenNails, opts);

  assert.equal(a.finalScore, b.finalScore, 'final scores must tie for the test to mean anything');
  assert.ok(a.auc > b.auc, `expected ${a.auc} > ${b.auc}`);
  // 100s at 0.4 plus 480s at 0.9, over a 600s horizon.
  assert.ok(Math.abs(a.auc - (100 * 0.4 + 480 * 0.9) / 600) < 1e-9);
  assert.ok(Math.abs(b.auc - (360 * 0.9) / 600) < 1e-9);
});

test('ttfnbr ignores blank and error frames, ttfrr needs entity coverage', () => {
  const frames = [
    frame(5 * S, 0, { class: 'unreachable', entityCoverage: 0 }),
    frame(10 * S, 0, { class: 'error', entityCoverage: 0 }),
    frame(15 * S, 0, { class: 'blank', entityCoverage: 0 }),
    // Renders, but almost nothing the brief named is on screen yet.
    frame(20 * S, 0.1, { class: 'render', entityCoverage: 0.2 }),
    frame(30 * S, 0.6, { class: 'render', entityCoverage: 0.7 }),
  ];
  const m = computeMetrics(frames, opts);
  assert.equal(m.ttfnbrMs, 20 * S);
  assert.equal(m.ttfrrMs, 30 * S);
});

test('regression is reported when an agent breaks its own work', () => {
  const frames = [frame(10 * S, 0.9), frame(200 * S, 0.3, { class: 'error' })];
  const m = computeMetrics(frames, opts);
  assert.equal(m.peakScore, 0.9);
  assert.equal(m.finalScore, 0.3);
  assert.ok(Math.abs(m.regression - 0.6) < 1e-9);
});

test('a run that never renders scores zero, not NaN', () => {
  const m = computeMetrics([frame(10 * S, 0, { class: 'blank' })], opts);
  assert.equal(m.auc, 0);
  assert.equal(m.ttfnbrMs, null);
  assert.equal(m.ttfrrMs, null);
});

test('frames past the horizon do not contribute', () => {
  const frames = [frame(10 * S, 0.5), frame(900 * S, 1.0)];
  const m = computeMetrics(frames, opts);
  assert.equal(m.peakScore, 0.5, 'the late perfect frame is outside the horizon');
  assert.ok(Math.abs(m.auc - (590 * 0.5) / 600) < 1e-9);
});

test('buildCurve always anchors at zero so pre-render time is counted', () => {
  const pts = buildCurve([frame(60 * S, 1)], opts);
  assert.deepEqual(pts[0], { tMs: 0, score: 0 });
});
