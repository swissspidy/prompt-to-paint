import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSidecar, salvageRun } from '../src/salvage.ts';
import type { Frame } from '../src/types.ts';

const frame = (index: number, tMs: number, over: Partial<Frame> = {}): Frame => ({
  index, tMs, class: 'render', reason: 'r', screenshotPath: `frames/f${index}.png`,
  dhash: 'a'.repeat(16), colorSig: '0'.repeat(16), inkRatio: 0.4, text: 'Orbit',
  title: 'Orbit', favicon: null, tabSignal: true, offscreenTextChars: 0, httpStatus: 200, consoleErrors: [],
  entityCoverage: 0.6, entitiesFound: ['app-name'], domSignature: 'DIVD3', captureMs: 9, ...over,
});

const ndjson = (...records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

test('the sidecar separates frames from the markers written beside them', () => {
  const side = parseSidecar(ndjson(
    frame(0, 0, { class: 'unreachable' }),
    frame(1, 1000),
    { __p2p: 'cold-end', tMs: 1500, endReason: 'horizon' },
    frame(2, 2000),
    { __p2p: 'iteration', iteration: { id: 'header-blue', ok: true } },
  ));
  assert.equal(side.frames.length, 3);
  assert.equal(side.coldEndMs, 1500);
  assert.equal(side.endReason, 'horizon');
  assert.deepEqual(side.iterations.map((i) => i.id), ['header-blue']);
  assert.equal(side.truncated, false);
});

test('a line cut off mid-write costs that line and nothing before it', () => {
  // The signature of a process killed while appending. Newline-delimited
  // records exist so this is a dropped frame rather than a dead file.
  const text = `${ndjson(frame(0, 0), frame(1, 1000))}{"index":2,"tMs":2000,"cla`;
  const side = parseSidecar(text);
  assert.equal(side.frames.length, 2);
  assert.equal(side.truncated, true);
  assert.equal(side.skipped, 0);
});

test('salvage rebuilds a run whose process never wrote result.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-salvage-'));
  try {
    await writeFile(join(dir, 'run.json'), JSON.stringify({
      schema: 1, runId: 'todo-app-antigravity-x', brief: 'todo-app', briefPath: 'briefs/todo-app.json',
      adapter: 'antigravity', label: 'antigravity:gemini', url: 'http://127.0.0.1:5173/',
      t0Epoch: 1_700_000_000_000, startedAt: '2026-01-01T00:00:00.000Z', horizonMs: 480_000,
      framesDir: join(dir, 'frames'), framesLogPath: join(dir, 'frames.ndjson'),
    }));
    await writeFile(join(dir, 'frames.ndjson'), ndjson(
      frame(0, 0, { class: 'unreachable', entityCoverage: 0, tabSignal: false }),
      frame(1, 30_000, { class: 'blank', entityCoverage: 0, tabSignal: true }),
      frame(2, 60_000),
      { __p2p: 'cold-end', tMs: 70_000, endReason: 'horizon' },
      { __p2p: 'iteration', iteration: { id: 'header-blue', ok: true, timeToCorrectChangeMs: 12_000 } },
      frame(3, 90_000),
    ));

    const { result, frameCount } = await salvageRun(dir);
    assert.equal(frameCount, 4);
    assert.equal(result.brief, 'todo-app');
    assert.equal(result.endReason, 'horizon');
    // The cold-start split is the one thing a flat list of frames could not
    // reconstruct, which is why the marker is written.
    assert.deepEqual(result.frames.map((f) => f.phase), ['cold', 'cold', 'cold', 'iteration']);
    assert.equal(result.curve.ttfnbrMs, 60_000);
    assert.equal(result.curve.firstTabSignalMs, 30_000, 'the tab spoke before the page did');
    assert.deepEqual(result.iterations.map((i) => i.id), ['header-blue']);
    // A salvaged run must never be mistaken for a complete one.
    assert.ok(result.warnings.some((w) => w.startsWith('SALVAGED RUN')));
    assert.ok(result.warnings.some((w) => /no latency decomposition/.test(w)));
    assert.equal(result.judge.degraded, true);
    assert.equal(result.decomposition.coverage, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('salvage says which file is missing rather than throwing a bare ENOENT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-salvage-'));
  try {
    await assert.rejects(salvageRun(dir), /run\.json does not exist/);
    await writeFile(join(dir, 'run.json'), JSON.stringify({ framesLogPath: join(dir, 'frames.ndjson') }));
    await assert.rejects(salvageRun(dir), /no frames were recorded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
