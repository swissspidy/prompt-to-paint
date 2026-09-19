import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trajectory, renderTrajectory } from '../src/report/trajectory.ts';
import type { RunResult, ScoredFrame } from '../src/types.ts';

const frame = (index: number, score: number): ScoredFrame => ({
  index, tMs: index * 1000, class: score > 0 ? 'render' : 'blank', reason: '',
  screenshotPath: `/f${index}.png`, dhash: null, colorSig: null, inkRatio: score,
  text: '', offscreenTextChars: 0, title: '', favicon: null, tabSignal: false,
  httpStatus: 200, consoleErrors: [], entityCoverage: score, entitiesFound: [],
  domSignature: '', captureMs: 1, score, scoreSource: 'judge', phase: 'cold',
});

const run = (over: { frames: ScoredFrame[]; auc: number; ttfr: number | null; final: number; model?: string }): RunResult => ({
  schema: 1, runId: 'r', brief: 'static-page', briefPath: '', adapter: 'claude-code',
  model: over.model ?? 'claude-sonnet-5', label: 'l', startedAt: '', t0Epoch: 0, wallMs: 1000, url: '',
  curve: {
    horizonMs: 300_000, auc: over.auc, ttfnbrMs: over.ttfr, ttfrrMs: over.ttfr,
    finalScore: over.final, peakScore: over.final, timeToPeakMs: 0, regression: 0,
    heldToHorizon: true, runEndMs: 1000,
  },
  decomposition: {
    wallMs: 1000,
    buckets: { model: 1000, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
  },
  iterations: [], frames: over.frames, phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'anthropic:claude-sonnet-5', framesJudged: 1, degraded: false, temperature: 0 },
  viewport: { width: 1280, height: 800 }, agentFailure: null, endReason: 'signal',
  protocol: { renderEarly: true }, warnings: [],
});

/** Blank until 15s, then the finished page: the shape almost every run has. */
const step = (): RunResult => run({
  frames: [frame(0, 0), frame(1, 0), frame(2, 1), frame(3, 1)],
  ttfr: 15_000, final: 1, auc: 1 * (1 - 15_000 / 300_000),
});

test('a step is recognised as carrying nothing the endpoints do not', () => {
  const rep = trajectory([step()]);
  assert.equal(rep.progressive, 0);
  assert.equal(rep.stepwise, 1);
  assert.equal(rep.maxResidual, 0);
  assert.equal(rep.runs[0]!.levels, 2, 'a step visits exactly two score levels');
});

test('a run scored part-done is the one the curve is for', () => {
  // The real case this was written from: complete but unstyled at 6.8s, styled
  // at 27.4s. The endpoints predict a larger area than the run actually earned,
  // because it spent twenty seconds below its final score.
  const rep = trajectory([run({
    frames: [frame(0, 0), frame(1, 0.833), frame(2, 0.833), frame(3, 1)],
    ttfr: 6_800, final: 1, auc: 0.9658, model: 'claude-opus-5',
  })]);
  assert.equal(rep.progressive, 1);
  assert.equal(rep.stepwise, 0, 'the endpoint identity does not hold here');
  assert.ok(rep.runs[0]!.residual! < 0, 'time spent below the final score costs area');
  assert.equal(rep.runs[0]!.levels, 3);
});

test('a run that scored below 1 throughout is still a step, not a trajectory', () => {
  // finalScore 0.833 reached in one go. The identity holds with finalScore in
  // it, which is exactly why the prediction is a product and not 1 - ttfr/H:
  // reading this as "the curve has a shape" would be wrong.
  const rep = trajectory([run({
    frames: [frame(0, 0), frame(1, 0.833), frame(2, 0.833)],
    ttfr: 12_300, final: 0.833, auc: 0.833 * (1 - 12_300 / 300_000),
  })]);
  assert.equal(rep.progressive, 0);
  assert.equal(rep.stepwise, 1);
});

test('a run that never rendered is counted, not divided by', () => {
  const rep = trajectory([run({ frames: [frame(0, 0)], ttfr: null, final: 0, auc: 0 })]);
  assert.equal(rep.neverRendered, 1);
  assert.equal(rep.runs[0]!.aucFromEndpoints, null);
  assert.equal(rep.runs[0]!.residual, null);
  assert.doesNotThrow(() => renderTrajectory(rep));
});

test('the verdict says plainly when nothing in the set has a shape', () => {
  const text = renderTrajectory(trajectory([step(), step(), step()]));
  assert.match(text, /No run here ever rendered a partial page/);
  assert.match(text, /ranking on AUC ranks on those/);
});
