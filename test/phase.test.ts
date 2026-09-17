import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coldFrames } from '../src/phase.ts';
import { mechanicalScores } from '../src/judge/judge.ts';
import type { Frame, RunResult, ScoredFrame } from '../src/types.ts';

const frame = (index: number, tMs: number, over: Partial<Frame> = {}): Frame => ({
  index, tMs, class: 'render', reason: 'r', screenshotPath: `f${index}.png`,
  dhash: 'a'.repeat(16), colorSig: '0'.repeat(16), inkRatio: 0.5, text: 'Orbit',
  title: 'Orbit', httpStatus: 200, consoleErrors: [], entityCoverage: 0.5,
  entitiesFound: [], domSignature: 'DIVD3', captureMs: 10, ...over,
});

const result = (frames: ScoredFrame[], runEndMs: number): RunResult =>
  ({ curve: { runEndMs }, frames }) as unknown as RunResult;

test('coldFrames keeps the measured window and drops the iteration tail', () => {
  const frames: ScoredFrame[] = [
    { ...frame(0, 1000), score: 0.5, scoreSource: 'judge', phase: 'cold' },
    { ...frame(1, 2000), score: 0.9, scoreSource: 'judge', phase: 'cold' },
    { ...frame(2, 9000), score: 0.2, scoreSource: 'mechanical', phase: 'iteration' },
  ];
  assert.deepEqual(coldFrames(result(frames, 3000)).map((f) => f.index), [0, 1]);
});

test('coldFrames falls back to the recorded window for results written before phases', () => {
  // No `phase` anywhere: every frame up to runEndMs is cold, as it was then.
  const frames: ScoredFrame[] = [
    { ...frame(0, 1000), score: 0.5, scoreSource: 'judge' },
    { ...frame(1, 5000), score: 0.9, scoreSource: 'judge' },
  ];
  assert.deepEqual(coldFrames(result(frames, 3000)).map((f) => f.index), [0]);
});

test('mechanicalScores scores renders by entity coverage and nothing else', () => {
  const scored = mechanicalScores([
    frame(0, 0, { class: 'blank', entityCoverage: 0.8 }),
    frame(1, 1000, { entityCoverage: 0.6 }),
    frame(2, 2000, { class: 'unreachable', entityCoverage: 0.4 }),
  ]);
  assert.deepEqual(scored.map((f) => [f.score, f.scoreSource]), [
    [0, 'non-render'],
    [0.6, 'mechanical'],
    [0, 'non-render'],
  ]);
});
