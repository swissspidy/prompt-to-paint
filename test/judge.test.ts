import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, scoreFromVerdict, selectFramesToJudge, buildJudgePrompt } from '../src/judge/judge.ts';
import { parseJudgeModel, pickBackend } from '../src/judge/backends.ts';
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

test('parseJudgeModel splits only known provider prefixes', () => {
  assert.deepEqual(parseJudgeModel('google:gemini-2.5-flash'), { provider: 'google', model: 'gemini-2.5-flash' });
  assert.deepEqual(parseJudgeModel('openai:gpt-5'), { provider: 'openai', model: 'gpt-5' });
  // A bare model, and a model whose own name contains a colon, are not specs.
  assert.equal(parseJudgeModel('claude-sonnet-5'), null);
  assert.equal(parseJudgeModel('us.anthropic.claude-x:0'), null);
  assert.equal(parseJudgeModel('nosuchprovider:x'), null);
  assert.equal(parseJudgeModel('google:'), null);
});

test('a provider-qualified model picks the AI SDK backend, even under auto', () => {
  withKeys({ GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, () => {
    for (const backend of ['ai', 'auto'] as const) {
      const b = pickBackend({ backend, model: 'google:gemini-2.5-flash' });
      assert.equal(b.name, 'ai');
      // Qualified, so a report can never claim the wrong judge served a run.
      assert.equal(b.model, 'google:gemini-2.5-flash');
    }
  });
});

test('auto still prefers the Anthropic API, then the CLI, for a bare model', () => {
  withKeys({ ANTHROPIC_API_KEY: 'k' }, () => {
    assert.equal(pickBackend({ backend: 'auto' }).name, 'api');
  });
  withKeys({}, () => {
    const b = pickBackend({ backend: 'auto' });
    assert.equal(b.name, 'cli');
    assert.equal(b.model, 'claude-sonnet-5');
  });
});

test('a judge that cannot be served is refused up front, not once per frame', () => {
  withKeys({}, () => {
    // Named provider, missing key: say so before the run, not sixty times after.
    assert.throws(() => pickBackend({ backend: 'ai', model: 'google:g' }), /GOOGLE_GENERATIVE_AI_API_KEY/);
    assert.throws(() => pickBackend({ backend: 'api' }), /ANTHROPIC_API_KEY/);
    // "ai" without a provider cannot be resolved to one.
    assert.throws(() => pickBackend({ backend: 'ai', model: 'gemini-2.5-flash' }), /<provider>:<model>/);
  });
});

test('a provider prefix on an Anthropic-only backend is an error, not a silent swap', () => {
  withKeys({ ANTHROPIC_API_KEY: 'k', GOOGLE_GENERATIVE_AI_API_KEY: 'k' }, () => {
    assert.throws(
      () => pickBackend({ backend: 'api', model: 'google:gemini-2.5-flash' }),
      /names the google provider/,
    );
  });
});

test('the null backend needs no credentials at all', () => {
  withKeys({}, () => {
    const b = pickBackend({ backend: 'none', model: 'google:g' });
    assert.equal(b.name, 'none');
  });
});
