import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shuffled, sampleForRating, calibrate, ratingSheet, type Rating } from '../src/rate.ts';
import type { RunResult, ScoredFrame } from '../src/types.ts';

const frame = (index: number, score: number, path: string | null): ScoredFrame => ({
  index, tMs: index * 1000, class: 'render', reason: 'ok', screenshotPath: path,
  dhash: null, colorSig: null, inkRatio: 0.3, text: '', offscreenTextChars: 0,
  title: 'App', favicon: null, tabSignal: true, httpStatus: 200, consoleErrors: [],
  entityCoverage: score, entitiesFound: [], domSignature: 'd', captureMs: 5,
  score, scoreSource: 'judge', phase: 'cold',
});

const run = (frames: ScoredFrame[]): RunResult => ({
  schema: 1, runId: 'r1', brief: 'b', briefPath: '', adapter: 'exec', label: 'a',
  startedAt: '', t0Epoch: 0, wallMs: 1000, url: '',
  curve: {
    horizonMs: 10_000, auc: 0.5, ttfnbrMs: 0, ttfrrMs: 0, finalScore: 1,
    peakScore: 1, timeToPeakMs: 0, regression: 0, heldToHorizon: true, runEndMs: 1000,
  },
  decomposition: {
    wallMs: 1000,
    buckets: { model: 1000, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
  },
  iterations: [], frames, phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'anthropic:claude-sonnet-5', framesJudged: 1, degraded: false, temperature: 0 },
  viewport: { width: 1280, height: 800 },
  agentFailure: null, endReason: 'signal', protocol: { renderEarly: true }, warnings: [],
});

test('the shuffle is a permutation and repeats exactly for a seed', () => {
  // The seed is part of the instrument: a sheet has to be rebuildable, or a
  // rating that comes back cannot be matched to what was actually shown.
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = shuffled(items, 7);
  const b = shuffled(items, 7);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
  assert.notDeepEqual(shuffled(items, 8), a, 'a different seed gives a different order');
});

test('sampling rates each distinct screenshot once and spans the score range', () => {
  // Forward-fill means most frames repeat a picture. Rating the same image
  // twenty times measures the rater's memory, not the threshold.
  const r = run([
    frame(0, 0, '/f0.png'),
    frame(1, 0, '/f0.png'),
    frame(2, 0.4, '/f1.png'),
    frame(3, 0.7, '/f2.png'),
    frame(4, 1, '/f3.png'),
    frame(5, 1, '/f3.png'),
  ]);
  const all = sampleForRating(r, 10);
  assert.deepEqual(all.map((f) => f.screenshotPath), ['/f0.png', '/f1.png', '/f2.png', '/f3.png']);

  const two = sampleForRating(r, 2);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((f) => f.score), [0, 1], 'both ends of the range');

  assert.deepEqual(sampleForRating(r, 1).length, 1, 'one frame is not a division by zero');
  assert.ok(sampleForRating(r, 3).every((f) => f !== undefined));
});

test('a frame with no screenshot is never put in front of a rater', () => {
  const r = run([frame(0, 0, null), frame(1, 1, '/f1.png')]);
  assert.deepEqual(sampleForRating(r, 8).map((f) => f.index), [1]);
});

test('calibrate finds the threshold that best reproduces human judgement', () => {
  // People called everything from 0.6 up reviewable. A brief claiming 0.3
  // should be told that 0.5-to-0.6 is where the line actually falls.
  const frames = new Map<string, ScoredFrame>();
  const ratings: Rating[] = [];
  const scores = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1];
  scores.forEach((s, i) => {
    frames.set(`r1:${i}`, frame(i, s, '/f.png'));
    ratings.push({ runId: 'r1', index: i, reviewable: s >= 0.6 });
  });
  const c = calibrate(ratings, frames, 0.3);
  assert.equal(c.n, 7);
  assert.equal(c.bestAgreement, 1, 'a threshold exists that reproduces every call');
  assert.ok(c.bestThreshold > 0.5 && c.bestThreshold <= 0.6, `fitted to the boundary, got ${c.bestThreshold}`);
  assert.ok(c.currentAgreement < 1, 'and the brief\'s own threshold is reported as worse');
  assert.equal(c.humanRate, 3 / 7);
});

test('ratings that match no frame are dropped and counted, not silently ignored', () => {
  const frames = new Map<string, ScoredFrame>([['r1:0', frame(0, 1, '/f.png')]]);
  const c = calibrate(
    [{ runId: 'r1', index: 0, reviewable: true }, { runId: 'gone', index: 9, reviewable: true }],
    frames,
    0.5,
  );
  assert.equal(c.n, 1);
  assert.equal(c.unmatched, 1);
});

test('the rating sheet shows the rater no score, label or timestamp', () => {
  // A rater who can see that the harness called a frame 0.85 is agreeing with a
  // number rather than judging a picture, and the agreement rate that comes
  // back would be evidence of nothing.
  const sheet = ratingSheet(
    [{ runId: 'r1', index: 3, tMs: 42_000, dataUri: 'data:image/png;base64,AAAA' }],
    'Build a conference schedule page.',
  );
  assert.ok(sheet.includes('Build a conference schedule page.'), 'the brief is shown');
  assert.ok(sheet.includes('"index":3'), 'the join key travels with the answer');
  assert.ok(!sheet.includes('42000'), 'the timestamp does not');
  assert.ok(!/"score"|scoreSource|reviewableThreshold/.test(sheet), 'and neither does any score');
});
