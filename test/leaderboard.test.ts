import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack, renderLeaderboard, renderLeaderboardText } from '../src/report/leaderboard.ts';
import { rank } from '../src/report/compare.ts';
import type { RunResult, ScoredFrame } from '../src/types.ts';

function frame(tMs: number, score: number, shot: string | null, over: Partial<ScoredFrame> = {}): ScoredFrame {
  return {
    index: tMs / 1000, tMs, class: score > 0 ? 'render' : 'unreachable', reason: '',
    screenshotPath: shot, dhash: shot, colorSig: shot, inkRatio: 0.1, text: '', title: '',
    httpStatus: 200, consoleErrors: [], entityCoverage: score, entitiesFound: [],
    domSignature: '', captureMs: 5, score, scoreSource: 'judge', ...over,
  };
}

function run(over: Partial<RunResult> = {}): RunResult {
  const frames = [
    frame(0, 0, '/runs/a/frames/f00000.png'),
    frame(1000, 0, '/runs/a/frames/f00000.png'),
    frame(2000, 0.5, '/runs/a/frames/f00002.png'),
    frame(3000, 1, '/runs/a/frames/f00003.png'),
  ];
  return {
    schema: 1, runId: 'r', brief: 'todo-app', briefPath: '', adapter: 'exec', label: 'a',
    startedAt: '', t0Epoch: 0, wallMs: 4000, url: 'http://127.0.0.1:5173/',
    curve: {
      horizonMs: 10_000, auc: 0.5, ttfnbrMs: 2000, ttfrrMs: 2000, finalScore: 1,
      peakScore: 1, timeToPeakMs: 3000, regression: 0, heldToHorizon: true, runEndMs: 4000,
    },
    decomposition: {
      wallMs: 4000,
      buckets: { model: 0, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 4000 },
      coverage: 0, crossCheck: { reportedApiMs: null, attributedModelMs: 0, deltaMs: null }, notes: [],
    },
    iterations: [], frames, phases: [], agentEvents: [],
    judge: { backend: 'none', model: null, framesJudged: 0, degraded: true },
    agentFailure: null, endReason: 'signal', warnings: [],
    ...over,
  };
}

test('a track keeps every frame but stores each screenshot once', () => {
  // Every frame has to be present -- the player must be able to show the state
  // at any instant -- but the two frames that share a file must share an entry,
  // which is where all the size of a long run is.
  const t = buildTrack(run(), '/runs', '/runs/a');
  assert.equal(t.t.length, 4);
  assert.equal(t.srcs.length, 3);
  assert.deepEqual(t.shot, [0, 0, 1, 2]);
  assert.deepEqual(t.score, [0, 0, 50, 100]);
});

test('track paths are relative to the page, so a runs directory can be moved', () => {
  const t = buildTrack(run(), '/runs', '/runs/a');
  assert.deepEqual(t.srcs, ['a/frames/f00000.png', 'a/frames/f00002.png', 'a/frames/f00003.png']);
  assert.ok(!t.srcs.some((s) => s.startsWith('/')), 'no absolute paths');
});

test('a frame with no screenshot is marked, not dropped', () => {
  const r = run({ frames: [frame(0, 0, null), frame(1000, 1, '/runs/a/frames/f1.png')] });
  const t = buildTrack(r, '/runs', '/runs/a');
  assert.deepEqual(t.shot, [-1, 0]);
  assert.equal(t.t.length, 2);
});

test('frames are emitted in time order whatever order they were stored in', () => {
  const r = run({ frames: [frame(3000, 1, 'c.png'), frame(0, 0, 'a.png'), frame(1000, 0.5, 'b.png')] });
  const t = buildTrack(r, '/runs', '/runs/a');
  assert.deepEqual(t.t, [0, 1000, 3000]);
});

test('tied scores share a rank instead of manufacturing a disagreement', () => {
  // Two runs that both finish at 1.00 have no ordering by final score. Giving
  // them 1 and 2 would flag a trajectory-versus-final disagreement that is
  // pure tie-break noise -- and that disagreement is the harness's headline
  // finding, so inventing one is worse than reporting none.
  const rows = rank([
    run({ label: 'fast', curve: { ...run().curve, auc: 0.9, finalScore: 1 } }),
    run({ label: 'slow', curve: { ...run().curve, auc: 0.4, finalScore: 1 } }),
  ]);
  assert.deepEqual(rows.map((r) => r.rankAuc), [1, 2]);
  assert.deepEqual(rows.map((r) => r.rankFinal), [1, 1]);
});

test('ranked rows point back at their run by index, not by label', () => {
  // `--repeat 5` produces five runs with the same label; keying on the name
  // would line every panel up against the first of them.
  const rows = rank([
    run({ label: 'same', curve: { ...run().curve, auc: 0.2 } }),
    run({ label: 'same', curve: { ...run().curve, auc: 0.8 } }),
  ]);
  assert.deepEqual(rows.map((r) => r.index), [1, 0]);
});

test('the page carries the frames, the ranking and no live script injection', () => {
  const html = renderLeaderboard([run({ label: 'a' }), run({ label: 'b' })], '/runs/leaderboard.html', {
    title: 'Two agents',
  });
  assert.match(html, /<title>Two agents<\/title>/);
  assert.match(html, /id="tracks" type="application\/json"/);
  assert.match(html, /a\/frames\/f00000\.png/);
  assert.match(html, /id="scrub"/);
  // Two panels, two table rows.
  assert.equal(html.match(/class="panel player"/g)?.length, 2);
});

test('a label that looks like markup cannot break out of the page or the payload', () => {
  // A label is whatever someone typed after --label, and it reaches the page
  // twice: as markup, and inside the JSON the player reads. Both have to be
  // closed, and the JSON one is the easy miss -- a `</script>` in a string
  // literal ends the element regardless of the quotes around it.
  const nasty = '</script><img src=x onerror=alert(1)>';
  const html = renderLeaderboard([run({ label: nasty })], '/runs/lb.html');

  const payload = /<script id="tracks" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(payload, 'the payload element is intact');
  assert.equal(JSON.parse(payload![1]!)[0].label, nasty, 'and round-trips the label unchanged');

  const markup = html.slice(0, html.indexOf('<script id="tracks"'));
  assert.ok(!markup.includes(nasty), 'the label is escaped wherever it is rendered as markup');
  assert.match(markup, /&lt;\/script&gt;&lt;img/);
});

test('runs measured against different horizons are refused, not averaged', () => {
  const a = run();
  const b = run({ curve: { ...run().curve, horizonMs: 20_000 } });
  assert.throws(() => renderLeaderboard([a, b], '/runs/lb.html'), /horizon/i);
  assert.throws(() => renderLeaderboardText([a, b]), /horizon/i);
});

test('the terminal leaderboard says how each run ended', () => {
  // A run cut off at the horizon and one the agent finished are not the same
  // measurement, and nothing else in the numbers says which happened.
  const txt = renderLeaderboardText([
    run({ label: 'finished', endReason: 'signal' }),
    run({ label: 'cut off', endReason: 'horizon', curve: { ...run().curve, auc: 0.1 } }),
  ]);
  assert.match(txt, /finished.*signal/s);
  assert.match(txt, /cut off.*horizon/s);
});

test('a result written before end reasons existed still renders', () => {
  const legacy = run();
  delete legacy.endReason;
  assert.match(renderLeaderboardText([legacy]), /unknown/);
});
