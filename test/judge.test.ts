import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, scoreFromVerdict, selectFramesToJudge, buildJudgePrompt } from '../src/judge/judge.ts';
import { parseJudge, pickBackend, DEFAULT_JUDGE } from '../src/judge/backends.ts';
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

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** Run with exactly these judge keys set, then put the environment back. */
function withKeys<T>(keys: Record<string, string | undefined>, fn: () => T): T {
  const names = ['ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_API_KEY'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) {
      const v = keys[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    return fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

test('parseJudge splits only known provider prefixes', () => {
  assert.deepEqual(parseJudge('google:gemini-2.5-flash'), { provider: 'google', model: 'gemini-2.5-flash' });
  assert.deepEqual(parseJudge('openai:gpt-5'), { provider: 'openai', model: 'gpt-5' });
  // A bare model, and a model whose own name contains a colon, are not judges.
  assert.equal(parseJudge('claude-sonnet-5'), null);
  assert.equal(parseJudge('us.anthropic.claude-x:0'), null);
  assert.equal(parseJudge('nosuchprovider:x'), null);
  assert.equal(parseJudge('google:'), null);
});

test('every provider reaches the judge through the one AI SDK backend', () => {
  withKeys({ GOOGLE_GENERATIVE_AI_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }, () => {
    for (const judge of ['google:gemini-2.5-flash', 'openai:gpt-5', 'anthropic:claude-sonnet-5']) {
      const b = pickBackend(judge);
      assert.equal(b.name, 'ai');
      // Qualified, so a report can never claim the wrong judge served a run.
      assert.equal(b.model, judge);
    }
  });
});

test('the default judge names its provider like any other', () => {
  withKeys({ ANTHROPIC_API_KEY: 'k' }, () => {
    const b = pickBackend();
    assert.equal(b.name, 'ai');
    assert.equal(b.model, DEFAULT_JUDGE);
    assert.match(DEFAULT_JUDGE, /^anthropic:/);
  });
});

test('a judge that cannot be served is refused up front, not once per frame', () => {
  withKeys({}, () => {
    assert.throws(() => pickBackend('google:g'), /GOOGLE_GENERATIVE_AI_API_KEY/);
    assert.throws(() => pickBackend(), /ANTHROPIC_API_KEY/);
  });
});

test('a judge that does not name a provider is an error, not a guess', () => {
  withKeys({ ANTHROPIC_API_KEY: 'k' }, () => {
    // Includes the spellings the removed backends used, which now fail the
    // same way anything else unrecognised does.
    for (const judge of ['claude-sonnet-5', 'gemini-2.5-flash', 'api', 'cli', 'auto']) {
      assert.throws(() => pickBackend(judge), /does not name a provider/, judge);
    }
  });
});

test('the null judge needs no credentials at all', () => {
  withKeys({}, () => {
    const b = pickBackend('none');
    assert.equal(b.name, 'none');
    assert.equal(b.model, null);
  });
});
