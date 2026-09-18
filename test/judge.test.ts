import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, scoreFromVerdict, selectFramesToJudge, buildJudgePrompt, keyOf } from '../src/judge/judge.ts';
import { PNG } from 'pngjs';
import { dhash, decodeGray } from '../src/probe/pixels.ts';
import { readdir, readFile } from 'node:fs/promises';

/** A flat page with thin dark runs: enough to move a hash, or not to. */
function flatPng(w: number, h: number, runs: Array<[number, number]>): Buffer {
  const p = new PNG({ width: w, height: h });
  p.data.fill(255);
  for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  for (const [row, len] of runs) {
    for (let y = row; y < row + 2 && y < h; y++)
      for (let x = 20; x < Math.min(20 + len, w); x++) {
        const o = (y * w + x) * 4;
        p.data[o] = 20; p.data[o + 1] = 20; p.data[o + 2] = 20;
      }
  }
  return PNG.sync.write(p);
}
import { parseJudge, pickBackend, preflightJudge, DEFAULT_JUDGE } from '../src/judge/backends.ts';
import { judgeRun } from '../src/judge/judge.ts';
import type { JudgeBackend } from '../src/judge/backends.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  dhash, colorSig: null, inkRatio: 0.2, text: '', title: '', favicon: null, tabSignal: false, offscreenTextChars: 0,
  httpStatus: 200, consoleErrors: [],
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

// ---------------------------------------------------------------------------
// The verdict cache
// ---------------------------------------------------------------------------

/** A judge with a fixed answer, which counts how often it is actually asked. */
function fakeJudge(model: string, met: boolean): JudgeBackend & { calls: number } {
  return {
    name: 'ai',
    model,
    concurrency: 1,
    calls: 0,
    async ask(): Promise<string> {
      this.calls++;
      return JSON.stringify({ criteria: { renders: { met } } });
    },
  };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('two judges do not share a verdict cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judgecache-'));
  try {
    const shot = join(dir, 'f.png');
    await writeFile(shot, PNG_1X1);
    const cacheDir = join(dir, 'cache');
    const frames = [{
      index: 0, tMs: 1000, class: 'render' as const, reason: 'r', screenshotPath: shot,
      dhash: 'abcdef0123456789', colorSig: '0'.repeat(16), inkRatio: 0.5, text: 'x',
      title: 't', favicon: null, tabSignal: false, offscreenTextChars: 0, httpStatus: 200, consoleErrors: [], entityCoverage: 0.5,
      entitiesFound: ['x'], domSignature: 'D', captureMs: 1,
    }];
    const single: Brief = { ...brief, rubric: [{ id: 'renders', description: 'renders', weight: 1 }] };

    const first = fakeJudge('anthropic:claude-sonnet-5', true);
    const a = await judgeRun(frames, single, { backend: first, cacheDir });
    assert.equal(first.calls, 1);
    assert.equal(a.frames[0]?.score, 1);

    // The same brief, the same screenshot, a different judge. Verdicts are
    // keyed by screenshot hash, so a shared cache file would hand this one the
    // first judge's answer and record it under this judge's name -- which
    // would make a rescore report perfect agreement between any two judges.
    const second = fakeJudge('google:gemini-2.5-flash', false);
    const b = await judgeRun(frames, single, { backend: second, cacheDir });
    assert.equal(second.calls, 1, 'the second judge was asked for its own verdict');
    assert.equal(b.frames[0]?.score, 0, 'and its own verdict is what got recorded');

    // Re-running the first judge still hits its own cache, which is the point
    // of having one.
    const again = fakeJudge('anthropic:claude-sonnet-5', true);
    await judgeRun(frames, single, { backend: again, cacheDir });
    assert.equal(again.calls, 0, 'the same judge reuses its cached verdict');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a judge that cannot answer is reported before the run, not after it', async () => {
  // The provider is the only thing that knows whether a model id exists, and it
  // takes milliseconds to ask. Discovering it at the end of a fifteen-minute run
  // is the failure this exists to remove.
  const dead = {
    name: 'ai', model: 'google:gemini-3.5-flash-low', concurrency: 1,
    ask: async (): Promise<string> => { throw new Error('unused'); },
    preflight: async (): Promise<void> => {
      throw new Error('models/gemini-3.5-flash-low is not found for API version v1beta');
    },
  };
  assert.match(String(await preflightJudge(dead)), /gemini-3\.5-flash-low is not found/);
});

test('a judge that answers reports no problem', async () => {
  const live = {
    name: 'ai', model: 'google:real', concurrency: 1,
    ask: async (): Promise<string> => '{}',
    preflight: async (): Promise<void> => undefined,
  };
  assert.equal(await preflightJudge(live), null);
});

test('a backend with nothing to preflight is not treated as broken', async () => {
  const old = { name: 'ai', model: 'x:y', concurrency: 1, ask: async (): Promise<string> => '{}' };
  assert.equal(await preflightJudge(old), null);
});

test('a judge that never once answers stops instead of grinding every frame', async () => {
  // Four SDK retries times sixty frames is minutes of backoff to reach a
  // conclusion that was available after three calls.
  let calls = 0;
  const backend = {
    name: 'ai', model: 'google:nope', concurrency: 1,
    ask: async (): Promise<string> => { calls++; throw new Error('404 model not found'); },
  };
  const frames = Array.from({ length: 40 }, (_, i) =>
    frame(i, (i % 2 ? 'f' : '0').repeat(16)));
  const out = await judgeRun(frames, brief, { backend, cacheDir: await mkdtemp(join(tmpdir(), 'p2p-judge-')) });
  assert.ok(calls <= 3, `stopped after ${calls} calls`);
  assert.ok(out.warnings.some((w) => /giving up after/.test(w)));
  // The run is still returned, scored mechanically and saying so.
  assert.equal(out.frames.length, 40);
  assert.ok(out.frames.every((f) => f.scoreSource !== 'judge'));
});

test('two different screenshots that share a perceptual hash get their own verdicts', async () => {
  // The bug this guards: the verdict cache was keyed on the frame's dhash, a
  // 64-bit perceptual hash of a 9x8 downscale. That is a near-duplicate
  // detector used with a threshold, not an identity, and it collides on pages
  // that differ only in their text -- so inside a cache file shared by every
  // run of one brief, a verdict earned by one agent's page was served for
  // another agent's different page, silently.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judge-key-'));
  try {
    const a = flatPng(1280, 800, [[300, 90]]);
    const b = flatPng(1280, 800, [[300, 40]]);
    assert.equal(dhash(decodeGray(a)), dhash(decodeGray(b)), 'these two do collide perceptually');
    assert.notEqual(keyOf(a), keyOf(b), 'but they are not the same screenshot');

    await writeFile(join(dir, 'a.png'), a);
    await writeFile(join(dir, 'b.png'), b);
    const shared = dhash(decodeGray(a));
    const frames: Frame[] = [
      { ...frame(0, shared), screenshotPath: join(dir, 'a.png'), colorSig: '0'.repeat(16) },
      { ...frame(1, shared), screenshotPath: join(dir, 'b.png'), colorSig: 'f'.repeat(16) },
    ];

    const asked: string[] = [];
    const backend: JudgeBackend = {
      name: 'ai', model: 'test:model', concurrency: 1,
      ask: async ({ png }) => {
        asked.push(keyOf(png));
        return JSON.stringify({ criteria: { renders: { met: true } } });
      },
    };
    await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0, maxImageWidth: 4096 });
    assert.equal(asked.length, 2, 'both frames were sent; neither answered for the other');
    assert.notEqual(asked[0], asked[1], 'and they were genuinely different images');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an identical screenshot is served from cache rather than re-judged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judge-hit-'));
  try {
    const png = flatPng(400, 300, [[100, 50]]);
    await writeFile(join(dir, 'a.png'), png);
    await writeFile(join(dir, 'copy.png'), png);
    const h = dhash(decodeGray(png));
    const frames: Frame[] = [
      { ...frame(0, h), screenshotPath: join(dir, 'a.png'), colorSig: '0'.repeat(16) },
      { ...frame(1, h), screenshotPath: join(dir, 'copy.png'), colorSig: 'f'.repeat(16) },
    ];
    let calls = 0;
    const backend: JudgeBackend = {
      name: 'ai', model: 'test:model', concurrency: 1,
      ask: async () => { calls++; return JSON.stringify({ criteria: { renders: { met: true } } }); },
    };
    await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0 });
    assert.equal(calls, 1, 'the same bytes are paid for once');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verdicts survive a scoring pass that does not finish', async () => {
  // The pass is the expensive part of a run; a process that died in the middle
  // of it used to lose every call it had already paid for.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judge-persist-'));
  try {
    const pngs = [10, 20, 30, 40].map((n) => flatPng(400, 300, [[n, 50]]));
    const frames: Frame[] = [];
    for (const [i, png] of pngs.entries()) {
      await writeFile(join(dir, `f${i}.png`), png);
      frames.push({ ...frame(i, dhash(decodeGray(png))), screenshotPath: join(dir, `f${i}.png`) });
    }
    const backend: JudgeBackend = {
      name: 'ai', model: 'test:model', concurrency: 1,
      ask: async () => JSON.stringify({ criteria: { renders: { met: true } } }),
    };
    const out = await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0 });
    const files = (await readdir(dir)).filter((f) => f.startsWith('judge-v2-'));
    assert.equal(files.length, 1, 'the cache is written under a v2 name');
    const saved = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as Record<string, unknown>;
    assert.ok(out.framesJudged > 0, 'something was judged');
    assert.equal(
      Object.keys(saved).length,
      out.framesJudged,
      'every verdict that was paid for reached disk',
    );
    // Keyed by the screenshot, so the entries map back to real files.
    const keys = new Set(Object.keys(saved));
    assert.ok(pngs.some((png) => keys.has(keyOf(png))), 'keyed by the screenshot itself');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a different judge width does not reuse the old width\'s verdicts', async () => {
  // The cache key is the screenshot on disk, but the judge is sent that
  // screenshot downscaled. The width is therefore an input to the verdict, and
  // a rescore at another width must not read back answers formed from pictures
  // it never sent.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judge-width-'));
  try {
    const png = flatPng(800, 600, [[100, 200]]);
    await writeFile(join(dir, 'a.png'), png);
    const frames: Frame[] = [{ ...frame(0, dhash(decodeGray(png))), screenshotPath: join(dir, 'a.png') }];

    let calls = 0;
    const backend: JudgeBackend = {
      name: 'ai', model: 'test:model', concurrency: 1,
      ask: async () => { calls++; return JSON.stringify({ criteria: { renders: { met: true } } }); },
    };
    await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0, maxImageWidth: 512 });
    assert.equal(calls, 1);
    await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0, maxImageWidth: 512 });
    assert.equal(calls, 1, 'the same width reuses the verdict');
    await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0, maxImageWidth: 256 });
    assert.equal(calls, 2, 'a different width judges the image it actually sends');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the verdict cache survives being written over and over', async () => {
  // Written every few verdicts, so a plain truncating write would leave
  // unparseable JSON if the process stopped mid-write -- and loadCache treats
  // unparseable as cold, discarding everything already paid for.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-judge-atomic-'));
  try {
    const frames: Frame[] = [];
    for (let i = 0; i < 12; i++) {
      const png = flatPng(400, 300, [[10 + i * 12, 40 + i * 3]]);
      await writeFile(join(dir, `f${i}.png`), png);
      frames.push({ ...frame(i, dhash(decodeGray(png))), screenshotPath: join(dir, `f${i}.png`) });
    }
    const backend: JudgeBackend = {
      name: 'ai', model: 'test:model', concurrency: 4,
      ask: async () => JSON.stringify({ criteria: { renders: { met: true } } }),
    };
    const out = await judgeRun(frames, brief, { backend, cacheDir: dir, distinctThreshold: 0 });
    const file = (await readdir(dir)).find((f) => f.startsWith('judge-v2-'))!;
    const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>;
    assert.equal(Object.keys(parsed).length, out.framesJudged, 'nothing was lost between writes');
    assert.equal((await readdir(dir)).filter((f) => f.endsWith('.tmp')).length, 0, 'no scratch file left behind');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
