import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combine, transitions, beforeAfter, parseChoice } from '../src/judge/pairwise.ts';
import type { ScoredFrame } from '../src/types.ts';

const f = (tMs: number, shot: string | null, cls: ScoredFrame['class'] = 'render'): ScoredFrame =>
  ({ index: tMs, tMs, class: cls, screenshotPath: shot, score: 1, scoreSource: 'judge' }) as ScoredFrame;

test('a preference counts only if it survives swapping the order', () => {
  // Forward shows earlier then later; swapped shows later then earlier.
  assert.deepEqual(combine('second', 'first'), { verdict: 'better', inconsistent: false });
  assert.deepEqual(combine('first', 'second'), { verdict: 'worse', inconsistent: false });
  assert.deepEqual(combine('tie', 'tie'), { verdict: 'same', inconsistent: false });
  // The same position won both times: that is the judge preferring a slot,
  // not a page, and it must not be reported as a change for better or worse.
  assert.deepEqual(combine('second', 'second'), { verdict: 'same', inconsistent: true });
  assert.deepEqual(combine('first', 'first'), { verdict: 'same', inconsistent: true });
  // A tie on one side and a preference on the other is a weak preference, kept.
  assert.deepEqual(combine('tie', 'second'), { verdict: 'worse', inconsistent: false });
  assert.deepEqual(combine('second', 'tie'), { verdict: 'better', inconsistent: false });
});

test('only changes between rendered states are compared', () => {
  // Blank to rendered is the first render, which the curve already prices; a
  // repeated screenshot is not a change; an error frame has no page to compare.
  const pairs = transitions([
    f(0, 'a.png', 'blank'),
    f(1000, 'b.png'),
    f(2000, 'b.png'),
    f(3000, 'c.png', 'error'),
    f(4000, 'd.png'),
    f(5000, 'e.png'),
  ]);
  assert.deepEqual(pairs.map((p) => [p.from.tMs, p.to.tMs]), [[1000, 4000], [4000, 5000]]);
});

test('notes say before and after, not first and second', () => {
  assert.equal(beforeAfter('First has more polish than second'), 'Before has more polish than after');
  assert.equal(beforeAfter('Screenshot 2 aligns the numbers'), 'After aligns the numbers');
});

test('a choice is read out of prose or fences, and junk is refused', () => {
  assert.deepEqual(parseChoice('```json\n{"better": "Second", "note": "adds the chart"}\n```'), {
    better: 'second', note: 'adds the chart',
  });
  assert.equal(parseChoice('I think the second one'), null);
});
