import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief } from '../src/brief.ts';

const valid = {
  id: 'b', title: 'B', prompt: 'build a thing', horizonSec: 60, reviewableThreshold: 0.5,
  entities: [{ id: 'e', aliases: ['x'] }],
  rubric: [{ id: 'r', description: 'renders', weight: 1 }],
};

test('a valid brief round-trips', () => {
  const b = parseBrief(valid, 'test');
  assert.equal(b.id, 'b');
  assert.equal(b.rubric.length, 1);
});

test('an empty rubric is rejected, not defaulted', () => {
  // An empty rubric would score every frame 1.0: the run completes and the
  // number is meaningless, which is the worst possible failure mode.
  assert.throws(() => parseBrief({ ...valid, rubric: [] }, 't'), /non-empty/);
  assert.throws(() => parseBrief({ ...valid, entities: [] }, 't'), /non-empty/);
});

test('rubric weights and ids are validated', () => {
  assert.throws(() => parseBrief({ ...valid, rubric: [{ id: 'r', description: 'd', weight: 0 }] }, 't'), /positive weight/);
  assert.throws(() => parseBrief({
    ...valid,
    rubric: [{ id: 'r', description: 'd', weight: 1 }, { id: 'r', description: 'e', weight: 1 }],
  }, 't'), /duplicate/);
});

test('reviewableThreshold must be a usable fraction', () => {
  assert.throws(() => parseBrief({ ...valid, reviewableThreshold: 0 }, 't'), /\(0, 1\]/);
  assert.throws(() => parseBrief({ ...valid, reviewableThreshold: 1.5 }, 't'), /\(0, 1\]/);
});

test('an iteration without a mechanical check is rejected', () => {
  // Iteration success has to be decided by a predicate, not a judge.
  assert.throws(
    () => parseBrief({ ...valid, iterations: [{ id: 'i', prompt: 'p', check: '', description: 'd' }] }, 't'),
    /mechanical/,
  );
});

test('the bundled briefs are all valid', async () => {
  const { loadBrief } = await import('../src/brief.ts');
  for (const id of ['todo-app', 'landing-page', 'static-page']) {
    const b = await loadBrief(`briefs/${id}.json`);
    assert.ok(b.rubric.length > 0, id);
    for (const it of b.iterations ?? []) {
      // A check that references nothing from the page cannot be verifying it.
      assert.match(it.check, /document|getComputedStyle/, `${id}/${it.id} must inspect the page`);
    }
  }
});
