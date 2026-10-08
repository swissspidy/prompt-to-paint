import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceRow, raceGroups, renderRace, bandOf } from '../src/report/race.ts';
import type { RunResult, ScoredFrame } from '../src/types.ts';

const frame = (tMs: number, score: number, cls: ScoredFrame['class'] = 'render'): ScoredFrame => ({
  index: tMs, tMs, class: cls, reason: '',
  screenshotPath: `/f${tMs}.png`, dhash: null, colorSig: null, inkRatio: score,
  text: '', offscreenTextChars: 0, title: '', favicon: null, tabSignal: false,
  httpStatus: 200, consoleErrors: [], entityCoverage: score, entitiesFound: [],
  domSignature: '', captureMs: 1, score, scoreSource: 'judge', phase: 'cold',
});

const run = (over: {
  label: string; frames: ScoredFrame[]; ttfr: number | null; endMs: number; skeleton?: boolean; brief?: string;
}): RunResult => ({
  schema: 1, runId: `${over.label}-${over.ttfr}`, brief: over.brief ?? 'ops-dashboard', briefPath: '',
  adapter: 'claude-code', model: 'm', label: over.label, startedAt: '', t0Epoch: 0, wallMs: over.endMs, url: '',
  curve: {
    horizonMs: 300_000, auc: 0.9, ttfnbrMs: over.ttfr, ttfrrMs: over.ttfr,
    finalScore: 1, peakScore: 1, timeToPeakMs: 0, regression: 0, heldToHorizon: true, runEndMs: over.endMs,
  },
  decomposition: {
    wallMs: over.endMs,
    buckets: { model: 1, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
  },
  iterations: [], frames: over.frames, phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'openai:gpt-5.5', framesJudged: 1, degraded: false, temperature: null },
  viewport: { width: 1280, height: 800 }, agentFailure: null, endReason: 'signal',
  protocol: { renderEarly: true, ...(over.skeleton ? { skeletonFirst: true } : {}) }, warnings: [],
});

const step = (label: string, ttfr: number): RunResult => run({
  label, ttfr, endMs: ttfr + 15_000,
  frames: [frame(0, 0, 'error'), frame(5_000, 0, 'blank'), frame(ttfr, 1), frame(ttfr + 5_000, 1)],
});

const staged = (label: string): RunResult => run({
  label, ttfr: 8_000, endMs: 40_000, skeleton: true,
  frames: [frame(0, 0, 'error'), frame(8_000, 0.14), frame(19_000, 0.43), frame(22_000, 0.79), frame(26_000, 1)],
});

test('a step is two segments: nothing, then the whole brief', () => {
  const row = raceRow(step('a', 20_000));
  assert.deepEqual(row.segments.map((s) => [s.fromMs, s.toMs, s.band]), [[0, 20_000, 0], [20_000, 35_000, 3]]);
  assert.equal(row.stages, 1);
  assert.equal(row.completeMs, 20_000);
});

test('a staged build keeps every stage, and is complete only when it is', () => {
  const row = raceRow(staged('b'));
  assert.deepEqual(row.segments.map((s) => s.band), [0, 1, 1, 2, 3]);
  assert.equal(row.stages, 4);
  assert.equal(row.ttfnbrMs, 8_000);
  assert.equal(row.completeMs, 26_000);
  // The last segment ends where the run did, not at the horizon.
  assert.equal(row.segments.at(-1)!.toMs, 40_000);
});

test('bands split at the reviewable threshold', () => {
  assert.deepEqual([0, 0.2, 0.5, 0.99, 1].map(bandOf), [0, 1, 2, 2, 3]);
});

test('agents are ordered by median first render, conditions adjacent within one', () => {
  const groups = raceGroups([step('slow', 40_000), staged('fast'), step('fast', 18_000), step('fast', 20_000)]);
  assert.deepEqual(groups.map((g) => g.label), ['fast', 'slow']);
  assert.deepEqual(groups[0]!.rows.map((r) => r.condition), ['prompted', 'prompted', 'staged']);
});

test('the page refuses to race two briefs on one axis', () => {
  assert.throws(() => renderRace([step('a', 10_000), { ...step('b', 10_000), brief: 'todo-app' }]), /different briefs/);
  const html = renderRace([step('a', 10_000), staged('a')]);
  assert.match(html, /skeleton first/);
  assert.match(html, /1 of them put a partial page on screen/);
});
