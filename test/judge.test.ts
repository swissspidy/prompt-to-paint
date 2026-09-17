import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, scoreFromVerdict, selectFramesToJudge, buildJudgePrompt } from '../src/judge/judge.ts';
import type { Brief, Frame } from '../src/types.ts';

const brief: Brief = {
  id: 'b', title: 'B', prompt: 'p', horizonSec: 100, reviewableThreshold: 0.5,
  entities: [{ id: 'e', aliases: ['x'] }],
  rubric: [
    { id: 'renders', description: 'renders', weight: 1 },
    { id: 'columns', description: 'columns', weight: 3 },
  ],
};

test('parseVerdict accepts bare JSON, fenced JSON, and JSON wrapped in prose', () => {
  const bare = parseVerdict('{"criteria":{"renders":{"met":true}}}');
  assert.equal(bare?.criteria.renders?.met, true);

  const fenced = parseVerdict('Sure.\n```json\n{"criteria":{"renders":{"met":false}}}\n```\n');
  assert.equal(fenced?.criteria.renders?.met, false);

  const prose = parseVerdict('Here is my answer: {"criteria":{"renders":{"met":true}}} Hope that helps.');
  assert.equal(prose?.criteria.renders?.met, true);
});

test('parseVerdict survives braces and escaped quotes inside note strings', () => {
  const raw = '{"criteria":{"renders":{"met":true,"note":"shows {a} and \\"b\\" on screen"}},"overall":"ok"}';
  const v = parseVerdict(raw);
  assert.equal(v?.criteria.renders?.met, true);
  assert.equal(v?.overall, 'ok');
});

test('parseVerdict returns null rather than guessing', () => {
  assert.equal(parseVerdict('I think it looks pretty good honestly'), null);
  assert.equal(parseVerdict('{"not_criteria": 1}'), null);
  assert.equal(parseVerdict('{"criteria":'), null);
});

test('scoreFromVerdict weights criteria and ignores unknown ids', () => {
  assert.equal(scoreFromVerdict(brief, { criteria: { renders: { met: true }, columns: { met: false } } }), 0.25);
  assert.equal(scoreFromVerdict(brief, { criteria: { renders: { met: false }, columns: { met: true } } }), 0.75);
  assert.equal(scoreFromVerdict(brief, { criteria: { bogus: { met: true } } }), 0);
  assert.equal(scoreFromVerdict(brief, { criteria: {} }), 0);
});

test('a missing criterion counts as unmet, never as absent from the denominator', () => {
  // Otherwise a judge that forgets a criterion silently inflates the score.
  assert.equal(scoreFromVerdict(brief, { criteria: { renders: { met: true } } }), 0.25);
});

const frame = (index: number, dhash: string, cls: Frame['class'] = 'render'): Frame => ({
  index, tMs: index * 1000, class: cls, reason: '', screenshotPath: `f${index}.png`,
  dhash, colorSig: null, inkRatio: 0.2, text: '', title: '', httpStatus: 200, consoleErrors: [],
  entityCoverage: 0, entitiesFound: [], domSignature: '', captureMs: 5,
});

test('selectFramesToJudge skips frames identical to the last judged one', () => {
  const same = 'aaaaaaaaaaaaaaaa';
  const frames = [frame(0, same), frame(1, same), frame(2, same)];
  const picked = selectFramesToJudge(frames, { distinctThreshold: 6, maxJudged: 60 });
  assert.deepEqual(picked, [0], 'three identical frames cost exactly one model call');
});

test('selectFramesToJudge picks up visually distinct frames', () => {
  const frames = [frame(0, '0000000000000000'), frame(1, '0000000000000000'), frame(2, 'ffffffffffffffff')];
  assert.deepEqual(selectFramesToJudge(frames, { distinctThreshold: 6, maxJudged: 60 }), [0, 2]);
});

test('the final rendering frame is always judged', () => {
  // A run that drifts slowly into a broken state never trips the threshold, so
  // the end state has to be judged explicitly or the final score is a guess.
  const frames = [
    frame(0, '0000000000000000'),
    frame(1, '0000000000000001'),
    frame(2, '0000000000000003'),
  ];
  const picked = selectFramesToJudge(frames, { distinctThreshold: 6, maxJudged: 60 });
  assert.ok(picked.includes(2), 'last render must be judged');
});

test('non-rendering frames never cost a model call', () => {
  const frames = [frame(0, 'aaaaaaaaaaaaaaaa', 'blank'), frame(1, 'bbbbbbbbbbbbbbbb', 'error')];
  assert.deepEqual(selectFramesToJudge(frames, { distinctThreshold: 6, maxJudged: 60 }), []);
});

test('maxJudged caps cost and keeps the endpoints', () => {
  const frames = Array.from({ length: 200 }, (_, i) =>
    frame(i, i.toString(16).padStart(16, '0')),
  );
  const picked = selectFramesToJudge(frames, { distinctThreshold: 0, maxJudged: 10 });
  assert.ok(picked.length <= 10, `expected <=10, got ${picked.length}`);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), 199);
});

test('the judge prompt states the rubric and forbids crediting the unseen', () => {
  const p = buildJudgePrompt(brief);
  assert.ok(p.includes('renders'));
  assert.ok(p.includes('columns'));
  assert.ok(/only what is visible/i.test(p));
});
