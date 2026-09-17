import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spread } from '../src/report/aggregate.ts';

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
