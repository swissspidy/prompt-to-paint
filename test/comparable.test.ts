import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertComparable, IncomparableRunsError } from '../src/report/compare.ts';
import { aggregate, renderAggregate } from '../src/report/aggregate.ts';
import type { RunResult } from '../src/types.ts';

/**
 * A minimal judged run. Every check below is about a table that would look
 * completely normal if it were allowed to be printed.
 */
const run = (over: Partial<RunResult> = {}): RunResult => ({
  schema: 1, runId: 'r', brief: 'todo-app', briefPath: '', adapter: 'exec', label: 'a',
  startedAt: '', t0Epoch: 0, wallMs: 4000, url: 'http://127.0.0.1:5173/',
  curve: {
    horizonMs: 10_000, auc: 0.5, ttfnbrMs: 2000, ttfrrMs: 2000, finalScore: 1,
    peakScore: 1, timeToPeakMs: 3000, regression: 0, heldToHorizon: true, runEndMs: 4000,
  },
  decomposition: {
    wallMs: 4000,
    buckets: { model: 1000, tool_overhead: 0, install: 2000, build: 0, devserver_boot: 0, first_paint: 0, residual: 1000 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
  },
  iterations: [], frames: [], phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'anthropic:claude-sonnet-5', framesJudged: 10, degraded: false, temperature: 0 },
  viewport: { width: 1280, height: 800 },
  agentFailure: null, endReason: 'signal', protocol: { renderEarly: true }, warnings: [],
  ...over,
});

test('runs on the same footing compare fine', () => {
  assert.doesNotThrow(() => assertComparable([run(), run({ label: 'b' })]));
});

test('two judges cannot be ranked against each other', () => {
  // Judges disagree at the margin; that is why rescore under a second judge is
  // a useful thing to do at all. A ranking across them is partly a ranking of
  // the judges.
  assert.throws(
    () => assertComparable([run(), run({ judge: { ...run().judge, model: 'google:gemini-2.5-flash' } })]),
    /different judges/,
  );
});

test('an unjudged run cannot be ranked against a judged one', () => {
  // Entity coverage is a text match against the brief's nouns; a rubric score
  // is not. They share a 0..1 range and nothing else.
  assert.throws(
    () => assertComparable([
      run(),
      run({ label: 'b', judge: { backend: 'none', model: null, framesJudged: 0, degraded: true } }),
    ]),
    /different quantities/,
  );
});

test('prompted and unprompted runs are one ranking only where that is the experiment', () => {
  const pair = [run(), run({ label: 'b', protocol: { renderEarly: false } })];
  // compare: a single ordering over two different questions.
  assert.throws(() => assertComparable(pair), /prompted and unprompted/);
  // leaderboard: ranks inside each condition, so it is allowed to hold both.
  assert.doesNotThrow(() => assertComparable(pair, { allowMixedConditions: true }));
});

test('an aggregate names its judge and refuses to hide a mixed one', () => {
  const same = aggregate([run(), run()]);
  assert.equal(same.judge, 'anthropic:claude-sonnet-5');
  assert.deepEqual(same.warnings, []);
  assert.match(renderAggregate(same), /judge: anthropic:claude-sonnet-5/);

  const mixed = aggregate([run(), run({ judge: { ...run().judge, model: 'google:gemini-2.5-flash' } })]);
  assert.equal(mixed.judge, null, 'no single judge to name');
  assert.ok(mixed.warnings.some((w) => /different judges/.test(w)));
  assert.match(renderAggregate(mixed), /MIXED/);
});

test('bucket medians are absolute, because they do not add up to a run', () => {
  // Each median is taken independently, so the median install and the median
  // build can come from different runs and their sum can exceed the median wall
  // clock. Rendering each as a share of that sum described a run that never
  // happened.
  const a = aggregate([
    run({ decomposition: { ...run().decomposition, buckets: { ...run().decomposition.buckets, install: 9000 } } }),
    run(),
  ]);
  const text = renderAggregate(a);
  assert.match(text, /do not sum to a run/);
  assert.doesNotMatch(text, /\d+%/, 'no percentage is offered for a breakdown of nothing');
  assert.match(text, /median wall clock/);
});

test('a run whose judging never finished is not a judged run', () => {
  // Provisional scores are entity coverage wearing a model's byline. Ranking
  // them presents one as the other.
  const partial = run({ label: 'b', judge: { ...run().judge, pending: true } });
  assert.throws(() => assertComparable([run(), partial]), /judging did not finish/);
  assert.throws(() => assertComparable([partial]), /judging did not finish/);
});

test('one model at two temperatures is two scorers', () => {
  assert.throws(
    () => assertComparable([run(), run({ label: 'b', judge: { ...run().judge, temperature: 1 } })]),
    /different judge temperatures/,
  );
  // A run from before the temperature was recorded compares with its own kind,
  // and refuses to compare with one that pinned it.
  const legacy = run({ label: 'old', judge: { ...run().judge, temperature: undefined } });
  assert.doesNotThrow(() => assertComparable([legacy, run({ label: 'old2', judge: { ...run().judge, temperature: undefined } })]));
  assert.throws(() => assertComparable([run(), legacy]), /different judge temperatures/);
});

test('two viewports are two measurements, not two agents', () => {
  // The viewport decides what the judge was shown and what counted as on
  // screen, so it moves the AUC as directly as the rubric does.
  assert.throws(
    () => assertComparable([run(), run({ label: 'b', viewport: { width: 1280, height: 2400 } })]),
    /different viewports/,
  );
  // An unrecorded viewport is the old default, so it compares with it.
  assert.doesNotThrow(() => assertComparable([run(), run({ label: 'b', viewport: undefined })]));
});

test('an aggregate separates the judge it prints from the judge it pools on', () => {
  const sameModelTwoTemps = aggregate([run(), run({ judge: { ...run().judge, temperature: 1 } })]);
  assert.equal(sameModelTwoTemps.judge, null, 'these may not be pooled');
  assert.ok(sameModelTwoTemps.warnings.some((w) => /different temperatures/.test(w)));

  const clean = aggregate([run(), run()]);
  assert.equal(clean.judge, 'anthropic:claude-sonnet-5', 'and the printed name stays readable');
});

test('a refusal to rank is typed, so the CLI can print it without a stack trace', () => {
  // Every one of these messages is decided by which runs the caller named, and
  // names a command that fixes it. The type is what lets `p2p compare` print
  // that sentence as a usage error rather than dumping a trace over it.
  assert.throws(
    () => assertComparable([run(), run({ label: 'b', curve: { ...run().curve, horizonMs: 20_000 } })]),
    IncomparableRunsError,
  );
});

test('a run whose agent never started cannot be ranked', () => {
  // An exhausted API retry exits cleanly and leaves a clean 0.000. Averaged
  // into a set of repeats it drags the median to the floor and ranks a model
  // by its provider's capacity that afternoon -- which is what happened to two
  // of nine runs in one sitting.
  assert.throws(
    () => assertComparable([
      run(),
      run({ label: 'b', agentFailure: { exitCode: null, atMs: 4200, logPath: '/a/agent.log', message: 'API Error: 529' } }),
    ]),
    /agent failed/,
  );
});
