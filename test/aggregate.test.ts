import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spread, aggregate } from '../src/report/aggregate.ts';
import type { RunResult } from '../src/types.ts';

test('spread reports median, range, and how often the thing never happened', () => {
  const s = spread([1, 5, 3]);
  assert.equal(s.median, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.missing, 0);
});

test('spread averages the middle pair for an even count', () => {
  assert.equal(spread([10, 20, 30, 40]).median, 25);
});

test('a run that never rendered is counted, not silently dropped', () => {
  // Treating "never rendered" as a missing sample would flatter an agent that
  // fails outright, so it is reported separately rather than averaged away.
  const s = spread([2000, null, 4000]);
  assert.equal(s.median, 3000);
  assert.equal(s.missing, 1);
  assert.equal(s.n, 3);
});

test('all-null spread yields nulls rather than NaN', () => {
  const s = spread([null, null]);
  assert.equal(s.median, null);
  assert.equal(s.min, null);
  assert.equal(s.missing, 2);
});

/** A minimal successful run, with only the fields aggregate() reads. */
const runFor = (over: Partial<RunResult> = {}): RunResult => ({
  schema: 1, runId: 'r', brief: 'static-page', briefPath: '', adapter: 'claude-code',
  model: 'claude-opus-5', label: 'a', startedAt: '', t0Epoch: 0, wallMs: 1000, url: '',
  curve: {
    horizonMs: 300_000, auc: 0.9, ttfnbrMs: 10_000, ttfrrMs: 10_000, finalScore: 1,
    peakScore: 1, timeToPeakMs: 10_000, regression: 0, heldToHorizon: true, runEndMs: 1000,
  },
  decomposition: {
    wallMs: 1000,
    buckets: { model: 1000, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
  },
  iterations: [], frames: [], phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'anthropic:claude-sonnet-5', framesJudged: 1, degraded: false, temperature: 0 },
  viewport: { width: 1280, height: 800 }, agentFailure: null, endReason: 'signal',
  protocol: { renderEarly: true }, warnings: [],
  ...over,
});

const withAuc = (auc: number, over: Partial<RunResult> = {}): RunResult =>
  runFor({ ...over, curve: { ...runFor().curve, auc } });

test('repeats exclude runs whose agent never started, and say how many', () => {
  // An exhausted API retry exits cleanly and leaves a clean 0.000. Averaged in,
  // it reports the provider being busy as agent latency.
  const failed = withAuc(0, {
    agentFailure: { exitCode: null, atMs: 4200, logPath: '/a/agent.log', message: 'API Error: 529' },
  });
  const agg = aggregate([withAuc(0.9), withAuc(0.8), failed]);
  assert.equal(agg.runs, 2, 'the failure is not a repeat of anything');
  assert.equal(Number(agg.auc.median!.toFixed(4)), 0.85, 'and does not drag the median to the floor');
  assert.ok(agg.warnings.some((w) => /1 of 3 run\(s\) failed/.test(w)), agg.warnings.join(' | '));
});

test('when every repeat failed the numbers are kept but called what they are', () => {
  const failed = withAuc(0, { agentFailure: { exitCode: null, atMs: 1, logPath: '/a/agent.log' } });
  const agg = aggregate([failed, failed]);
  assert.equal(agg.runs, 2);
  assert.ok(agg.warnings.some((w) => /All 2 run\(s\) failed/.test(w)), agg.warnings.join(' | '));
});
