import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrief } from '../src/brief.js';
import { runBenchmark } from '../src/run.js';
import { ScriptedAdapter } from '../src/adapters/scripted.js';
import { NullBackend } from '../src/judge/backends.js';
import { findChromium } from '../src/probe/browser.js';
import { readFile } from 'node:fs/promises';

/**
 * End-to-end calibration against a signal whose answer is known in advance.
 *
 * The scripted adapter renders on a fixed schedule -- blank, then a page with
 * one of four entities at 4s, then all four at 9s -- so the true curve can be
 * integrated by hand and compared against what the harness reports. Every other
 * adapter measures something noisy, which makes a harness bug indistinguishable
 * from agent variance. This one does not.
 */
const hasBrowser = Boolean(findChromium());

test('harness recovers a known curve end to end', { skip: hasBrowser ? false : 'no chromium available', timeout: 180_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-cal-'));
  try {
    const brief = await loadBrief('test/fixtures/calibration-brief.json');
    const timeline = JSON.parse(await readFile('test/fixtures/calibration-timeline.json', 'utf8'));
    const result = await runBenchmark({
      brief,
      adapter: new ScriptedAdapter(timeline),
      runDir: dir,
      label: 'calibration',
      judgeBackend: new NullBackend(),
      settleMs: 3000,
    });

    const S = 1000;
    // Content lands at 4s and 9s; allow a poll interval plus reload latency.
    assert.ok(
      result.curve.ttfnbrMs !== null && result.curve.ttfnbrMs >= 3 * S && result.curve.ttfnbrMs <= 7 * S,
      `first render ${result.curve.ttfnbrMs}ms should be near 4s`,
    );
    assert.ok(
      result.curve.ttfrrMs !== null && result.curve.ttfrrMs >= 8 * S && result.curve.ttfrrMs <= 13 * S,
      `first reviewable ${result.curve.ttfrrMs}ms should be near 9s`,
    );
    assert.equal(result.curve.finalScore, 1, 'all four entities are on screen at the end');
    assert.equal(result.curve.regression, 0);

    // Integrate the true curve with the timestamps the harness actually
    // observed: the metric, not the poll jitter, is what is under test.
    const expected =
      ((result.curve.ttfrrMs! - result.curve.ttfnbrMs!) * 0.25 +
        (result.curve.horizonMs - result.curve.ttfrrMs!) * 1.0) /
      result.curve.horizonMs;
    assert.ok(
      Math.abs(result.curve.auc - expected) < 0.02,
      `AUC ${result.curve.auc.toFixed(3)} should match hand-integrated ${expected.toFixed(3)}`,
    );

    const iter = result.iterations[0];
    assert.ok(iter, 'the iteration phase ran');
    assert.ok(iter.ok, 'the blue-heading edit was detected');
    assert.ok(
      iter.timeToCorrectChangeMs !== null && iter.timeToCorrectChangeMs < 6 * S,
      `correct change ${iter.timeToCorrectChangeMs}ms should be near the scripted 1.5s`,
    );
    // A recolour barely moves a luminance hash, so this only passes because
    // change detection also watches colour.
    assert.ok(
      iter.timeToFirstChangeMs !== null,
      'first visible change must be detected for a pure colour edit',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
