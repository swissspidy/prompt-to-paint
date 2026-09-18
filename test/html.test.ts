import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { renderHtml } from '../src/report/html.ts';
import type { RunResult, ScoredFrame } from '../src/types.ts';

const frame = (over: Partial<ScoredFrame> = {}): ScoredFrame => ({
  index: 0, tMs: 1000, class: 'render', reason: 'ok', screenshotPath: null,
  dhash: null, colorSig: null, inkRatio: 0.4, text: '', offscreenTextChars: 0,
  title: 'App', favicon: null, tabSignal: true, httpStatus: 200, consoleErrors: [],
  entityCoverage: 1, entitiesFound: [], domSignature: 'd', captureMs: 10,
  score: 1, scoreSource: 'judge', phase: 'cold',
  ...over,
});

const run = (frames: ScoredFrame[]): RunResult => ({
  schema: 1, runId: 'r', brief: 'todo-app', briefPath: '', adapter: 'exec', label: 'a',
  startedAt: '', t0Epoch: 0, wallMs: 4000, url: 'http://127.0.0.1:5173/',
  curve: {
    horizonMs: 10_000, auc: 0.5, ttfnbrMs: 1000, ttfrrMs: 1000, finalScore: 1,
    peakScore: 1, timeToPeakMs: 1000, regression: 0, heldToHorizon: true, runEndMs: 4000,
  },
  decomposition: {
    wallMs: 4000,
    buckets: { model: 4000, tool_overhead: 0, install: 0, build: 0, devserver_boot: 0, first_paint: 0, residual: 0 },
    coverage: 1, crossCheck: { reportedApiMs: null, attributedModelMs: 4000, deltaMs: null }, notes: [],
  },
  iterations: [], frames, phases: [], agentEvents: [],
  judge: { backend: 'ai', model: 'anthropic:claude-sonnet-5', framesJudged: 1, degraded: false, temperature: 0 },
  viewport: { width: 1280, height: 800 },
  agentFailure: null, endReason: 'signal', protocol: { renderEarly: true }, warnings: [],
});

const png = (): Buffer => PNG.sync.write(new PNG({ width: 2, height: 2 }));

test('the report inlines its screenshots, so it renders after being moved', async () => {
  // A report that only works from inside its own run directory is not one you
  // can attach to a message or keep in an archive: copy it anywhere else and
  // every frame in it breaks.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-html-'));
  try {
    const shot = join(dir, 'f00001.png');
    await writeFile(shot, png());
    const html = renderHtml(run([frame({ screenshotPath: shot })]), dir);
    assert.ok(html.includes('data:image/png;base64,'), 'frame is inlined');
    assert.ok(!html.includes('src="f00001.png"'), 'nothing is left pointing at a sibling file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one screenshot shared by several frames is encoded once', async () => {
  // Forward-fill means judged frames can share a file. Encoding it per frame
  // would put the same megabyte in the page twice.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-html-'));
  try {
    const shot = join(dir, 'f00001.png');
    await writeFile(shot, png());
    const html = renderHtml(
      run([
        frame({ index: 0, tMs: 1000, screenshotPath: shot }),
        frame({ index: 1, tMs: 2000, screenshotPath: shot }),
      ]),
      dir,
    );
    assert.equal(html.split('data:image/png;base64,').length - 1, 2, 'both frames show the picture');
    const encoded = png().toString('base64');
    assert.equal(html.split(encoded).length - 1, 2, 'from one encode of one file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a frame missing from disk costs that picture, not the whole report', async () => {
  // Salvaged runs and half-copied directories are both real. The page still has
  // to render the numbers, which are the part that cannot be recovered.
  const dir = await mkdtemp(join(tmpdir(), 'p2p-html-'));
  try {
    const html = renderHtml(run([frame({ screenshotPath: join(dir, 'gone.png') })]), dir);
    assert.ok(html.includes('src="gone.png"'), 'points at where the frame should have been');
    assert.ok(html.includes('Where the time went'), 'the rest of the report is intact');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
