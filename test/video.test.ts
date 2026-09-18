import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  buildSegments,
  inferIntervalMs,
  renderConcat,
  ffmpegArgs,
  pngColorType,
  timelineSpanMs,
} from '../src/report/video.ts';
import type { ScoredFrame } from '../src/types.ts';

function frame(tMs: number, screenshotPath: string | null): ScoredFrame {
  return {
    index: 0,
    tMs,
    class: screenshotPath ? 'render' : 'blank',
    reason: 'test',
    screenshotPath,
    dhash: null,
    colorSig: null,
    inkRatio: 0,
    text: '',
    title: '',
    favicon: null,
    tabSignal: false,
    offscreenTextChars: 0,
    httpStatus: 200,
    consoleErrors: [],
    entityCoverage: 0,
    entitiesFound: [],
    domSignature: '',
    captureMs: 10,
    score: 0,
    scoreSource: 'judge',
  };
}

const OPTS = { tailMs: 1000 };

test('the stretch before the first observation is blank, not the first frame held back', () => {
  const segs = buildSegments([frame(1600, '/f/a.png')], OPTS);
  assert.equal(segs[0]?.startMs, 0);
  assert.equal(segs[0]?.endMs, 1600);
  assert.equal(segs[0]?.src, null, 'nothing was observed yet, so nothing may be shown');
  // Holding the first frame backwards would claim the app was on screen before
  // the browser had looked at it even once.
  assert.equal(segs[1]?.src, '/f/a.png');
  assert.equal(segs[1]?.startMs, 1600);
});

test('a run whose first observation is at zero gets no lead-in', () => {
  const segs = buildSegments([frame(0, '/f/a.png')], OPTS);
  assert.equal(segs.length, 1);
  assert.equal(segs[0]?.src, '/f/a.png');
});

test('each image is held until the next observation', () => {
  const segs = buildSegments(
    [frame(0, '/f/a.png'), frame(1000, '/f/b.png'), frame(2500, '/f/c.png')],
    OPTS,
  );
  assert.deepEqual(
    segs.map((s) => [s.src, s.startMs, s.endMs]),
    [['/f/a.png', 0, 1000], ['/f/b.png', 1000, 2500], ['/f/c.png', 2500, 3500]],
  );
});

test('repeated screenshots collapse into one segment of the full duration', () => {
  // The prober gives consecutive identical captures the same file, so this is
  // the common case, not an edge one.
  const segs = buildSegments(
    [frame(0, '/f/a.png'), frame(1000, '/f/a.png'), frame(2000, '/f/a.png')],
    OPTS,
  );
  assert.equal(segs.length, 1);
  assert.deepEqual([segs[0]?.startMs, segs[0]?.endMs], [0, 3000]);
});

test('a failed capture holds what was already showing', () => {
  const segs = buildSegments([frame(0, '/f/a.png'), frame(1000, null), frame(2000, '/f/b.png')], OPTS);
  // No change was observed, so inventing a cut to blank would be a lie about
  // the run rather than a gap in the record.
  assert.deepEqual(
    segs.map((s) => [s.src, s.startMs, s.endMs]),
    [['/f/a.png', 0, 2000], ['/f/b.png', 2000, 3000]],
  );
});

test('the last observation holds to the horizon when asked', () => {
  const frames = [frame(0, '/f/a.png'), frame(1000, '/f/b.png')];
  assert.equal(timelineSpanMs(buildSegments(frames, OPTS)), 2000);
  // Equal length is what lets two runs' videos be played side by side.
  assert.equal(timelineSpanMs(buildSegments(frames, { ...OPTS, holdToMs: 60_000 })), 60_000);
  // A horizon already behind the last frame must not shorten the video.
  assert.equal(timelineSpanMs(buildSegments(frames, { ...OPTS, holdToMs: 500 })), 2000);
});

test('frames out of order are still placed on the real clock', () => {
  const segs = buildSegments([frame(2000, '/f/c.png'), frame(1000, '/f/b.png')], OPTS);
  assert.deepEqual(segs.map((s) => s.src), [null, '/f/b.png', '/f/c.png']);
  assert.equal(segs[0]?.endMs, 1000);
});

test('an empty run produces no segments rather than a zero-length video', () => {
  assert.deepEqual(buildSegments([], OPTS), []);
});

test('the poll interval is recovered from the frames themselves', () => {
  assert.equal(inferIntervalMs([frame(0, null), frame(250, null), frame(500, null)]), 250);
  // One overrun tick must not drag the estimate: the median ignores it.
  assert.equal(inferIntervalMs([frame(0, null), frame(1000, null), frame(2000, null), frame(9000, null)]), 1000);
  assert.equal(inferIntervalMs([frame(0, null)]), 1000, 'a single frame falls back');
});

test('the concat script repeats its last entry and totals the timeline', () => {
  const segs = buildSegments([frame(1600, '/f/a.png'), frame(2600, '/f/b.png')], OPTS);
  const text = renderConcat(segs, '/f/blank.png');

  assert.match(text, /^ffconcat version 1\.0\n/);
  // The demuxer ignores the final entry's duration, so the last image is listed
  // twice; without it the video ends a whole segment early.
  const files = [...text.matchAll(/^file '(.+)'$/gm)].map((m) => m[1]);
  assert.deepEqual(files, ['/f/blank.png', '/f/a.png', '/f/b.png', '/f/b.png']);

  const durations = [...text.matchAll(/^duration ([\d.]+)$/gm)].map((m) => Number(m[1]));
  assert.equal(durations.length, 3);
  assert.equal(
    Math.round(durations.reduce((a, b) => a + b, 0) * 1000),
    timelineSpanMs(segs),
    'the declared durations must add up to the timeline, or every later timestamp is wrong',
  );
});

test('a path with a quote in it cannot break out of the concat script', () => {
  const text = renderConcat([{ src: "/f/it's.png", startMs: 0, endMs: 1000 }], '/f/blank.png');
  assert.match(text, /file '\/f\/it'\\''s\.png'/);
});

test('the output codec follows the file extension', () => {
  assert.ok(ffmpegArgs('/c.txt', '/out.mp4', 30).includes('libx264'));
  assert.ok(ffmpegArgs('/c.txt', '/out.webm', 30).includes('libvpx-vp9'));
  assert.ok(ffmpegArgs('/c.txt', '/OUT.WEBM', 30).includes('libvpx-vp9'));
  // Variable-rate in, constant-rate out, or the result plays differently
  // depending on the player.
  assert.ok(ffmpegArgs('/c.txt', '/out.mp4', 25).some((a) => a.includes('fps=25')));
});

test('a synthesised blank can be told to match a screenshot', () => {
  // The concat demuxer silently drops inputs whose stream parameters differ
  // from the first one, which cost the blank lead-in its entire duration.
  const rgb = PNG.sync.write(new PNG({ width: 4, height: 4 }), { colorType: 2 });
  const rgba = PNG.sync.write(new PNG({ width: 4, height: 4 }), { colorType: 6 });
  assert.equal(pngColorType(rgb), 2);
  assert.equal(pngColorType(rgba), 6);
  assert.equal(pngColorType(Buffer.alloc(4)), 2, 'a truncated file is treated as truecolour');
});
