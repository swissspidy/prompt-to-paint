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

test('a bundled check that reads innerText matches case-insensitively', async () => {
  // innerText is the text *as rendered*, so CSS decides its case. A column
  // header styled `text-transform: uppercase` -- an ordinary design choice, and
  // what a real agent produced -- reads BLOCKED, and the case-sensitive check
  // that shipped here reported NEVER LANDED for an edit visible in the
  // screenshot beside it. Entity coverage has always matched case-insensitively
  // (`norm` lowercases); the iteration checks have to agree, or one half of the
  // harness credits a word the other half cannot see.
  const { loadBrief } = await import('../src/brief.ts');
  for (const id of ['todo-app', 'landing-page', 'static-page']) {
    const b = await loadBrief(`briefs/${id}.json`);
    for (const it of b.iterations ?? []) {
      if (!/innerText/.test(it.check)) continue;
      assert.doesNotMatch(
        it.check,
        /\.includes\(|\.indexOf\(|\.startsWith\(|\.endsWith\(/,
        `${id}/${it.id} compares innerText with a case-sensitive string method`,
      );
      assert.match(it.check, /\/i[.)\s]/, `${id}/${it.id} must match innerText case-insensitively`);
    }
  }
});

test('two iterations cannot share an id', () => {
  // Iteration ids key results, report rows and the scripted adapter's steps.
  // Two that share one silently measure the wrong edit.
  assert.throws(
    () => parseBrief({ ...valid, iterations: [
      { id: 'blue', prompt: 'p', check: 'true', description: 'd' },
      { id: 'blue', prompt: 'q', check: 'true', description: 'd' },
    ] }, 'b.json'),
    /duplicate iteration id "blue"/,
  );
});

test('a target that cannot be observed is refused up front', () => {
  assert.throws(() => parseBrief({ ...valid, target: { port: 0 } }, 'b.json'), /target\.port/);
  assert.throws(() => parseBrief({ ...valid, target: { port: 99999 } }, 'b.json'), /target\.port/);
  assert.throws(
    () => parseBrief({ ...valid, target: { viewport: { width: 1280, height: 10 } } }, 'b.json'),
    /target\.viewport/,
  );
  // An explicit null passes `!== undefined`, and reading `.width` off it would
  // throw a TypeError from inside the validator whose job is to name the file.
  assert.throws(() => parseBrief({ ...valid, target: { viewport: null } }, 'b.json'), /target\.viewport/);
  assert.throws(() => parseBrief({ ...valid, target: { viewport: 'big' } }, 'b.json'), /target\.viewport/);
  assert.doesNotThrow(
    () => parseBrief({ ...valid, target: { port: 5173, viewport: { width: 1280, height: 2400 } } }, 'b.json'),
  );
});
