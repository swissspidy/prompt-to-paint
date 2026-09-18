import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { listenersOn } from '../../src/port.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrief } from '../../src/brief.ts';
import { runBenchmark } from '../../src/run.ts';
import { ScriptedAdapter } from '../../src/adapters/scripted.ts';
import { ExecAdapter } from '../../src/adapters/exec.ts';
import { NullBackend } from '../../src/judge/backends.ts';
import { salvageRun } from '../../src/salvage.ts';
import type { JudgeBackend } from '../../src/judge/backends.ts';
import { coldFrames } from '../../src/phase.ts';
import { findChromium } from '../../src/probe/browser.ts';
import { serveStatic } from '../../src/static-server.ts';
import type { Brief, RunResult } from '../../src/types.ts';

const run = promisify(execFile);
const hasBrowser = Boolean(findChromium());
const needsBrowser = hasBrowser ? false : 'no chromium available';

/**
 * A skipped suite must not be a green build.
 *
 * The browser tests are the only ones that exercise what this project actually
 * measures. When Chromium cannot be found they skip, the run reports success,
 * and nothing is being tested -- which is the exact failure this harness spends
 * its time detecting in other people's runs. CI sets P2P_REQUIRE_BROWSER=1 so
 * that a silent skip is a red build instead.
 */
test('a browser is available wherever one is required', () => {
  if (process.env.P2P_REQUIRE_BROWSER !== '1') return;
  assert.ok(
    hasBrowser,
    'P2P_REQUIRE_BROWSER=1 but no Chromium was found, so the end-to-end tests would have skipped and reported success.',
  );
});
const S = 1000;

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// The calibration: a signal whose true answer is known in advance.
// ---------------------------------------------------------------------------

test('harness recovers a known curve end to end', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-cal-');
  try {
    const brief = await loadBrief('test/fixtures/calibration-brief.json');
    const timeline = JSON.parse(await readFile('test/fixtures/calibration-timeline.json', 'utf8'));
    const result = await runBenchmark({
      brief, adapter: new ScriptedAdapter(timeline), runDir: dir,
      label: 'calibration', judgeBackend: new NullBackend(), settleMs: 3000, killPort: true,
    });

    // Content lands at 4s and 9s; allow a poll interval plus reload latency.
    assert.ok(
      result.curve.ttfnbrMs !== null && result.curve.ttfnbrMs >= 3 * S && result.curve.ttfnbrMs <= 7 * S,
      `first render ${result.curve.ttfnbrMs}ms should be near 4s`,
    );
    assert.ok(
      result.curve.ttfrrMs !== null && result.curve.ttfrrMs >= 8 * S && result.curve.ttfrrMs <= 13 * S,
      `first reviewable ${result.curve.ttfrrMs}ms should be near 9s`,
    );
    assert.equal(result.curve.finalScore, 1);
    assert.equal(result.curve.regression, 0);

    // Integrate the true curve at the timestamps actually observed: the metric
    // is under test here, not the poll jitter.
    const expected =
      ((result.curve.ttfrrMs! - result.curve.ttfnbrMs!) * 0.25 +
        (result.curve.horizonMs - result.curve.ttfrrMs!) * 1.0) / result.curve.horizonMs;
    assert.ok(Math.abs(result.curve.auc - expected) < 0.02,
      `AUC ${result.curve.auc.toFixed(3)} vs hand-integrated ${expected.toFixed(3)}`);

    const iter = result.iterations[0];
    assert.ok(iter?.ok, 'the blue-heading edit was detected');
    assert.ok(iter.timeToCorrectChangeMs !== null && iter.timeToCorrectChangeMs < 6 * S);
    // A recolour barely moves a luminance hash; this only passes because
    // change detection also watches colour.
    assert.ok(iter.timeToFirstChangeMs !== null, 'a pure colour edit must register as a change');
    assert.equal(iter.mode, 'live-session');

    // The run must leave nothing behind.
    const res = await fetch(result.url).catch(() => null);
    assert.equal(res, null, 'the served app must be gone once the run ends');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A third-party CLI agent, driven through exec. No credentials required.
// ---------------------------------------------------------------------------

test('a third-party CLI agent is measured through exec', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-exec-');
  try {
    const agent = join(dir, 'agent.sh');
    await writeFile(agent, `#!/bin/bash
# Stands in for any agent that is a command line.
PROMPT="$*"
if [[ "$PROMPT" == *blue* ]]; then
  sed -i 's|<h1>|<h1 style="color:#1544d6">|' index.html
  exit 0
fi
sleep 1
printf '%s' '<!doctype html><meta charset=utf-8><body style="padding:40px"><h1>DevConf 2026</h1></body>' > index.html
sleep 3
printf '%s' '<!doctype html><meta charset=utf-8><body style="padding:40px"><h1>DevConf 2026</h1><ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>' > index.html
`);
    await chmod(agent, 0o755);

    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const brief: Brief = { ...base, horizonSec: 40, target: { ...base.target, port: 5288 } };
    const result = await runBenchmark({
      brief,
      adapter: new ExecAdapter({ command: `${agent} {{PROMPT}}` }),
      runDir: dir, label: 'third-party', judgeBackend: new NullBackend(),
      settleMs: 3000, killPort: true,
    });

    assert.ok(result.curve.ttfnbrMs !== null, 'the app rendered');
    assert.equal(result.curve.finalScore, 1, 'all entities present at the end');

    // No event stream, so thinking and tool time must not be invented.
    assert.equal(result.decomposition.buckets.model, 0);
    assert.equal(result.decomposition.buckets.tool_overhead, 0);
    assert.ok(result.decomposition.buckets.residual > 0);
    assert.ok(result.decomposition.notes.some((n) => n.includes('exposes no event stream')));

    // Iteration works, but must be labelled as a restart rather than a live edit.
    const iter = result.iterations[0];
    assert.ok(iter, 'iteration ran');
    assert.equal(iter.mode, 'restart');
    assert.ok(result.warnings.some((w) => w.includes('re-running the agent')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failure modes must be loud, never a tidy zero.
// ---------------------------------------------------------------------------

test('a crashed agent is reported as a failure, not as a zero score', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-fail-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 12, iterations: [], target: { ...base.target, port: 5289 } },
      adapter: new ExecAdapter({ command: 'echo "simulated launch failure" >&2; exit 3' }),
      runDir: dir, label: 'crash', judgeBackend: new NullBackend(), settleMs: 1000, killPort: true,
    });
    assert.ok(result.agentFailure, 'the early non-zero exit is recorded');
    assert.equal(result.agentFailure?.exitCode, 3);
    assert.match(result.warnings[0] ?? '', /AGENT FAILED/);
    assert.equal(result.curve.auc, 0, 'still zero -- but now explained');
    // exec's contract is that the command exiting *is* the turn ending, so a
    // command that ran and failed did complete one. Contrast the streaming
    // adapter below, where nothing of the sort happened.
    assert.equal(result.endReason, 'turn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent binary that does not exist fails the run instead of the harness', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-enoent-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const { PiAdapter } = await import('../../src/adapters/pi.ts');
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 10, iterations: [], target: { ...base.target, port: 5290 } },
      adapter: new PiAdapter({ bin: '/nonexistent/definitely-not-an-agent' }),
      runDir: dir, label: 'enoent', judgeBackend: new NullBackend(), settleMs: 500, killPort: true,
    });
    // An unhandled spawn 'error' event would have taken the process down
    // before this assertion could run.
    assert.ok(result.agentFailure, 'the failed spawn is recorded as a failed run');
    const log = await readFile(join(dir, 'agent.log'), 'utf8');
    assert.match(log, /not found on PATH/);
    // A streaming adapter releases the turn wait when its process goes away, so
    // that a crash does not hold the run to its horizon. Recording that release
    // as a completed turn would put "the agent completed its first turn" in
    // result.json for a binary that never existed.
    assert.equal(result.endReason, 'exit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an iteration whose check already passes is reported void, not fast', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-void-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    // The page is blue from the very first frame, so the "make it blue" check
    // is satisfied before the prompt is ever sent.
    const blue = '<!doctype html><meta charset=utf-8><body><h1 style="color:#1544d6">DevConf 2026</h1>'
      + '<ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>';
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 30, target: { ...base.target, port: 5291 } },
      adapter: new ScriptedAdapter({
        steps: [{ atMs: 0, write: { path: 'index.html', content: blue } }],
        iterationSteps: { '0': [] },
      }),
      runDir: dir, label: 'void-iter', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });
    const iter = result.iterations[0];
    assert.ok(iter, 'the iteration ran');
    assert.equal(iter.baselineAlreadyPassing, true);
    assert.equal(iter.ok, false, 'a check that was already true cannot report success');
    assert.equal(iter.timeToCorrectChangeMs, null);
    assert.ok(result.warnings.some((w) => w.includes('void')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('iteration frames are kept for replay but never scored or counted', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-iterframes-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const page = (color: string): string =>
      `<!doctype html><meta charset=utf-8><body><h1 style="color:${color}">DevConf 2026</h1>`
      + '<ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>';
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 40, target: { ...base.target, port: 5295 } },
      adapter: new ScriptedAdapter({
        steps: [{ atMs: 0, write: { path: 'index.html', content: page('#111111') } }],
        // The edit the iteration measures: the heading goes blue.
        iterationSteps: { '0': [{ atMs: 200, write: { path: 'index.html', content: page('#1544d6') } }] },
      }),
      runDir: dir, label: 'iter-frames', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });

    const cold = result.frames.filter((f) => f.phase === 'cold');
    const iter = result.frames.filter((f) => f.phase === 'iteration');
    assert.ok(cold.length > 0, 'the cold-start window was captured');
    assert.ok(iter.length > 0, 'the iteration frames survived into the result');
    assert.equal(cold.length + iter.length, result.frames.length, 'every frame carries a phase');

    // The whole point: the edit is on the timeline, so a video of this run
    // shows it. Before, the result stopped when the window closed.
    assert.ok(
      iter.every((f) => f.tMs > result.curve.runEndMs),
      'iteration frames all sit after the measured window',
    );
    // ...and the numbers still describe the cold start alone.
    assert.ok(
      iter.every((f) => f.scoreSource !== 'judge' && f.scoreSource !== 'forward-fill'),
      'no iteration frame is scored against the cold-start rubric',
    );
    assert.deepEqual(coldFrames(result).map((f) => f.index), cold.map((f) => f.index));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the run is on disk before it is scored, so an interrupted judge loses nothing', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-provisional-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const resultPath = join(dir, 'result.json');

    /**
     * Reads result.json the first time it is asked to score anything.
     *
     * Judging runs after teardown and can take minutes, so whatever is on disk
     * at this moment is all a Ctrl-C would leave behind. It has to be a
     * complete, replayable run.
     */
    class SpyBackend implements JudgeBackend {
      readonly name = 'spy';
      readonly model = 'spy';
      readonly concurrency = 1;
      onDisk: RunResult | null = null;
      async ask(): Promise<string> {
        this.onDisk ??= JSON.parse(await readFile(resultPath, 'utf8')) as RunResult;
        throw new Error('this backend never returns a verdict');
      }
    }
    const spy = new SpyBackend();

    const result = await runBenchmark({
      brief: { ...base, horizonSec: 30, iterations: [], target: { ...base.target, port: 5296 } },
      adapter: new ScriptedAdapter({
        steps: [{
          atMs: 0,
          write: {
            path: 'index.html',
            content: '<!doctype html><meta charset=utf-8><body><h1>DevConf 2026</h1>'
              + '<ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>',
          },
        }],
      }),
      runDir: dir, label: 'provisional', judgeBackend: spy, settleMs: 2000, killPort: true,
    });

    const early = spy.onDisk;
    assert.ok(early, 'result.json existed before the first frame was judged');
    assert.equal(early.judge.pending, true, 'and says its scores are not final');
    assert.deepEqual(
      early.frames.map((f) => f.tMs),
      result.frames.map((f) => f.tMs),
      'the provisional timeline is the whole timeline, so the run can be replayed from it',
    );
    assert.ok(early.frames.some((f) => f.screenshotPath), 'with screenshots to replay');
    // The finished file supersedes it: scoring was attempted, so it is no
    // longer pending, even though this backend never returned a verdict.
    assert.notEqual(result.judge.pending, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run killed before it writes itself out is recoverable from its frame log', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-sidecar-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 25, iterations: [], target: { ...base.target, port: 5298 } },
      adapter: new ScriptedAdapter({
        steps: [{
          atMs: 0,
          write: {
            path: 'index.html',
            content: '<!doctype html><meta charset=utf-8><title>DevConf 2026</title>'
              + '<link rel="icon" href="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
              + '<body><h1>DevConf 2026</h1><ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul>'
              + '<footer>See you in Berlin</footer></body>',
          },
        }],
      }),
      runDir: dir, label: 'sidecar', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });

    // Both files exist because they were written while the run was happening,
    // not because it finished. This is everything a SIGKILL would have left.
    assert.equal(result.artifacts?.framesLogPath, join(dir, 'frames.ndjson'));
    const header = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { brief: string; horizonMs: number };
    assert.equal(header.brief, base.id);

    // Simulate the loss: the run directory keeps its frames and its log, and
    // loses the file that is only written at the very end.
    await rm(join(dir, 'result.json'));
    const { result: salvaged, frameCount } = await salvageRun(dir);

    assert.equal(frameCount, result.frames.length, 'every frame reached the log');
    assert.deepEqual(
      salvaged.frames.map((f) => f.tMs),
      result.frames.map((f) => f.tMs),
      'the salvaged timeline is the run timeline',
    );
    assert.deepEqual(
      salvaged.frames.map((f) => f.screenshotPath),
      result.frames.map((f) => f.screenshotPath),
      'and still points at the screenshots on disk',
    );
    assert.equal(salvaged.curve.ttfnbrMs, result.curve.ttfnbrMs, 'first render survives the round trip');
    assert.ok(salvaged.warnings.some((w) => w.startsWith('SALVAGED RUN')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a page whose tab names the app before it paints is measured saying so', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-tab-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    // A title and an icon with nothing in the body: the state the run is meant
    // to distinguish -- a grey viewport whose tab already says the right thing.
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 25, iterations: [], target: { ...base.target, port: 5299 } },
      adapter: new ScriptedAdapter({
        steps: [
          {
            atMs: 0,
            write: {
              path: 'index.html',
              content: '<!doctype html><meta charset=utf-8><title>DevConf 2026</title>'
                + '<link rel="icon" href="data:image/gif;base64,R0lGODlhAQABAAAAACw="><body></body>',
            },
          },
          {
            atMs: 6000,
            write: {
              path: 'index.html',
              content: '<!doctype html><meta charset=utf-8><title>DevConf 2026</title>'
                + '<body><h1>DevConf 2026</h1><ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul>'
                + '<footer>See you in Berlin</footer></body>',
            },
          },
        ],
      }),
      runDir: dir, label: 'tab', judgeBackend: new NullBackend(), settleMs: 3000, killPort: true,
    });

    const tab = result.curve.firstTabSignalMs;
    assert.ok(tab !== null && tab !== undefined, 'the tab signal was seen');
    assert.ok(result.curve.ttfnbrMs !== null, 'and the page did eventually render');
    assert.ok(tab <= result.curve.ttfnbrMs, `tab signal ${tab}ms should not be after first render ${result.curve.ttfnbrMs}ms`);
    // The thing that must not have happened: a titled empty page counting as a
    // render would move every AUC ever recorded.
    const titledButEmpty = result.frames.filter((f) => f.tabSignal && f.class !== 'render');
    assert.ok(titledButEmpty.length > 0, 'the empty-but-titled window was actually observed');
    assert.ok(titledButEmpty.every((f) => f.score === 0), 'and scored nothing, exactly as before');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an edit records what the agent did, so a slow toolchain is not charged to it', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-iterwork-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const page = (color: string): string =>
      `<!doctype html><meta charset=utf-8><body><h1 style="color:${color}">DevConf 2026</h1>`
      + '<ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>';

    // One tool call, then a long wait before the page changes. Wall clock says
    // this edit took many seconds; the agent was responsible for almost none of
    // them, and the point of the split is to be able to tell.
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 40, target: { ...base.target, port: 5297 } },
      adapter: new ScriptedAdapter({
        steps: [{ atMs: 0, write: { path: 'index.html', content: page('#111111') } }],
        iterationSteps: { '0': [{ atMs: 6000, write: { path: 'index.html', content: page('#1544d6') } }] },
      }),
      runDir: dir, label: 'iter-work', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });

    const it = result.iterations[0];
    assert.ok(it, 'the iteration ran');
    assert.equal(it.ok, true, 'the edit landed');
    assert.ok(it.work, 'the edit records what the agent did');
    assert.equal(it.work.toolCalls, 1, 'one tool call, not a number of seconds');
    assert.ok(typeof it.endedMs === 'number' && it.endedMs >= it.promptSentMs);

    // The headline number for this edit is several seconds; the agent's own
    // share of it is a fraction. Without this an agent behind a slow dev server
    // ranks below one in front of a fast one, for the same work.
    assert.ok(it.timeToCorrectChangeMs !== null && it.timeToCorrectChangeMs > 3000);
    assert.ok(it.afterAgentMs !== null && it.afterAgentMs !== undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('what the judge sees and what counts as reviewable are the same rectangle', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-fold-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    // Everything the brief names is in the document, but pushed far below the
    // fold. The judge is shown a viewport screenshot and told to credit only
    // what it can see; entity coverage used to read the whole document, so the
    // two halves of one metric disagreed and a page nobody could see was called
    // reviewable.
    const buried = '<!doctype html><meta charset=utf-8><body><div style="height:3000px"></div>'
      + '<h1>DevConf 2026</h1><ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul>'
      + '<footer>See you in Berlin</footer></body>';

    const below = await runBenchmark({
      brief: { ...base, horizonSec: 25, iterations: [], target: { ...base.target, port: 5292 } },
      adapter: new ScriptedAdapter({ steps: [{ atMs: 0, write: { path: 'index.html', content: buried } }] }),
      runDir: dir, label: 'below-fold', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });

    const last = [...below.frames].reverse().find((f) => f.class === 'render' || f.offscreenTextChars > 0);
    assert.ok(last, 'the page was observed');
    assert.ok(last.offscreenTextChars > 0, 'the buried text is recorded as outside the viewport');
    assert.equal(last.entityCoverage, 0, 'and does not count towards reviewable');
    assert.equal(below.curve.ttfnbrMs, null, 'an empty viewport is not a render, whatever the DOM holds');
    assert.ok(
      below.warnings.some((w) => /THE PAGE IS OUTSIDE THE VIEWPORT/.test(w)),
      'and the run says so, rather than reading as an agent that built nothing',
    );

    // The same page through a window tall enough to contain it. This is what a
    // brief whose rubric asks about below-the-fold content has to do.
    const dir2 = await tmp('p2p-fold2-');
    try {
      const tall = await runBenchmark({
        brief: {
          ...base, horizonSec: 25, iterations: [],
          target: { ...base.target, port: 5293, viewport: { width: 1280, height: 3600 } },
        },
        adapter: new ScriptedAdapter({ steps: [{ atMs: 0, write: { path: 'index.html', content: buried } }] }),
        runDir: dir2, label: 'tall', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
      });
      assert.ok(tall.curve.ttfrrMs !== null, 'the same page is reviewable through a window that shows it');
      assert.ok(
        !tall.warnings.some((w) => /OUTSIDE THE VIEWPORT|outside the .* viewport/.test(w)),
        'and nothing is being hidden from the judge',
      );
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }

    // One paragraph that begins inside the viewport and runs past the fold.
    // Crediting the whole text node because its first line is visible would let
    // an entity below the fold count as reviewable -- the same confusion
    // between "in the DOM" and "on screen", one node lower down.
    const dir3 = await tmp('p2p-fold3-');
    try {
      const filler = Array.from({ length: 200 }, (_, i) => `filler${i}`).join(' ');
      const wrapped = '<!doctype html><meta charset=utf-8><body style="margin:0;font:16px/24px monospace">'
        + `<p style="margin:0">DevConf 2026 ${filler} See you in Berlin</p></body>`;
      const run3 = await runBenchmark({
        brief: {
          ...base, horizonSec: 25, iterations: [],
          target: { ...base.target, port: 5294, viewport: { width: 400, height: 200 } },
        },
        adapter: new ScriptedAdapter({ steps: [{ atMs: 0, write: { path: 'index.html', content: wrapped } }] }),
        runDir: dir3, label: 'wrapped', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
      });
      const f = [...run3.frames].reverse().find((fr) => fr.text.length > 0);
      assert.ok(f, 'the page was observed');
      assert.ok(f.text.includes('DevConf 2026'), 'the visible start of the paragraph counts');
      assert.ok(
        !f.text.includes('See you in Berlin'),
        'its tail, far below the fold, does not -- even though one node holds both',
      );
      assert.ok(f.offscreenTextChars > 0, 'and the hidden part is counted as hidden');
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Ctrl-C takes the agent\'s dev server with it', { skip: needsBrowser, timeout: 180_000 }, async () => {
  // A leaked dev server is not untidiness. It keeps answering on the target
  // port, so the *next* run finds something already serving and reports a
  // near-zero first render for an app nobody built -- a wrong number that looks
  // entirely plausible, which is the failure this project exists to refuse.
  //
  // This was broken in a way nothing local would show: Playwright installs its
  // own SIGINT/SIGTERM/SIGHUP handlers by default, and they kill the browser
  // and exit the process. The harness's teardown got as far as closing the
  // browser and was then pre-empted, so a Ctrl-C looked tidy -- the window
  // vanished -- while the agent and its server ran on.
  // A port the OS just handed out, not a fixed one. This test has to clear
  // whatever ends up listening afterwards, and on a fixed port that could be a
  // developer's or a CI service's own process rather than anything it started.
  // Asking for port 0 and reading back what was assigned means anything found
  // on it later can only have come from here.
  const PORT = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => (p ? resolve(p) : reject(new Error('no port assigned'))));
    });
  });
  const dir = await tmp('p2p-sigint-');
  const serve = `node -e "require('http').createServer((q,s)=>s.end('<h1>Orbit</h1>')).listen(${PORT},'127.0.0.1')" & sleep 600`;

  assert.deepEqual((await listenersOn(PORT)).pids, [], 'the reserved port starts clear');

  // The agent serves this port itself, so the brief must target it and must not
  // ask the harness to serve the workdir -- otherwise the port under test is not
  // the one teardown clears.
  const base = JSON.parse(await readFile('test/fixtures/calibration-brief.json', 'utf8'));
  const briefPath = join(dir, 'brief.json');
  await mkdir(dir, { recursive: true });
  await writeFile(briefPath, JSON.stringify({
    ...base, horizonSec: 300, iterations: [], target: { port: PORT },
  }));

  const cli = spawn(process.execPath, [
    'src/cli.ts', 'run',
    '--brief', briefPath,
    '--adapter', 'exec', '--command', serve,
    '--judge', 'none', '--out', dir, '--no-progress', '--no-iterate',
  ], { cwd: process.cwd(), stdio: 'ignore' });

  try {
    // Wait for the agent's server to come up *and* for the run to be underway:
    // interrupting before the first frame lands would test nothing about what
    // survives an interrupt.
    const runDir = async (): Promise<string | null> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const d = entries.find((e) => e.isDirectory());
      return d ? join(dir, d.name) : null;
    };
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const rd = await runDir();
      ready = (await listenersOn(PORT)).pids.length > 0 && rd !== null && existsSync(join(rd, 'frames.ndjson'));
    }
    assert.ok(ready, 'the agent had a server listening and the run had started');

    cli.kill('SIGINT');
    await once(cli, 'exit');

    // The harness waits for its own teardown before exiting, so by the time the
    // process is gone the port should be too.
    let free = false;
    for (let i = 0; i < 20 && !free; i++) {
      free = (await listenersOn(PORT)).pids.length === 0;
      if (!free) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(free, `port ${PORT} is still held after the harness exited`);

    // And the run it was interrupted mid-flight is still readable.
    const runDirs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.equal(runDirs.length, 1);
    assert.ok(existsSync(join(dir, runDirs[0]!, 'frames.ndjson')), 'the timeline survived the interrupt');
  } finally {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    // Safe because the port was reserved above and verified empty: anything on
    // it now was started by this test.
    for (const pid of (await listenersOn(PORT)).pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('a frame log that cannot be written says so instead of promising recovery', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-badlog-');
  try {
    // A directory where the log file should go: every append fails with EISDIR,
    // which stands in for the full disk or removed directory this guards. The
    // appends are fire-and-forget so one bad write cannot take the run down,
    // and that is exactly how an incomplete frames.ndjson used to go unnoticed
    // while the run still advertised `p2p salvage` as the way back.
    await mkdir(join(dir, 'frames.ndjson'), { recursive: true });

    const base = await loadBrief('test/fixtures/calibration-brief.json');
    const result = await runBenchmark({
      brief: { ...base, horizonSec: 20, iterations: [], target: { ...base.target, port: 5290 } },
      adapter: new ScriptedAdapter({
        steps: [{ atMs: 0, write: { path: 'index.html', content: '<!doctype html><h1>DevConf 2026</h1>' } }],
      }),
      runDir: dir, label: 'badlog', judgeBackend: new NullBackend(), settleMs: 1000, killPort: true,
    });

    assert.ok(
      result.warnings.some((w) => /frame log .* could not be written/.test(w)),
      `the run should report the failed log, got: ${result.warnings.join(' | ')}`,
    );
    // And the run itself is unharmed: result.json is the primary record.
    assert.ok(result.frames.length > 0, 'the timeline in the result is intact');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The control run: the toolchain measured with no model in the loop.
// ---------------------------------------------------------------------------

test('the floor control measures a toolchain with no agent', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-floor-');
  try {
    const { FLOOR_TEMPLATES, floorBrief } = await import('../../src/floor.ts');
    const template = FLOOR_TEMPLATES.static!;
    const port = 5293;
    const brief = floorBrief(template, port, 60);
    const result = await runBenchmark({
      brief,
      adapter: new ExecAdapter({ command: template.script.replaceAll('{{PORT}}', String(port)) }),
      runDir: dir, label: 'floor:static', judgeBackend: new NullBackend(),
      settleMs: 3000, stopAfterRenderMs: 3000, skipIterations: true, killPort: true,
    });

    assert.ok(result.curve.ttfnbrMs !== null, 'the floor page rendered');
    // The whole point of the control: no model was involved, so none of the
    // wall clock may be attributed to one.
    assert.equal(result.decomposition.buckets.model, 0, 'a control run has no model time');
    assert.equal(result.decomposition.buckets.tool_overhead, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The static server runs while an agent rewrites the directory under it.
// ---------------------------------------------------------------------------

test('the static server survives malformed and racing requests', async () => {
  const dir = await tmp('p2p-static-');
  const server = await serveStatic(dir, 5292);
  try {
    await writeFile(join(dir, 'index.html'), '<h1>ok</h1>');
    assert.equal((await fetch('http://127.0.0.1:5292/')).status, 200);

    // A malformed percent-escape must be a 400, not a thrown exception that
    // takes the harness down mid-measurement.
    assert.equal((await fetch('http://127.0.0.1:5292/%E0%A4%A')).status, 400);
    assert.equal((await fetch('http://127.0.0.1:5292/missing.html')).status, 404);
    assert.equal((await fetch('http://127.0.0.1:5292/../../etc/passwd')).status, 404);

    // Still serving after all of that.
    assert.equal((await fetch('http://127.0.0.1:5292/')).status, 200);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CLI itself, run the way a user runs it.
// ---------------------------------------------------------------------------

test('rescore finds its run directory whichever side of the flags it is on', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-rescore-args-');
  try {
    const base = await loadBrief('test/fixtures/calibration-brief.json');
    await runBenchmark({
      brief: { ...base, horizonSec: 30, iterations: [], target: { ...base.target, port: 5297 } },
      adapter: new ScriptedAdapter({
        steps: [{
          atMs: 0,
          write: {
            path: 'index.html',
            content: '<!doctype html><meta charset=utf-8><body><h1>DevConf 2026</h1>'
              + '<ul><li>09:00 - Opening keynote - Ada Lovelace</li></ul><footer>See you in Berlin</footer></body>',
          },
        }],
      }),
      briefPath: 'test/fixtures/calibration-brief.json',
      runDir: dir, label: 'rescore-args', judgeBackend: new NullBackend(), settleMs: 2000, killPort: true,
    });

    // Both orders have to reach the same run. The directory used to be found
    // with `argv.find(a => !a.startsWith('-'))`, which happily returned an
    // option's value: with the flags first this went looking for
    // `none/result.json` and the run was never touched.
    for (const args of [
      ['src/cli.ts', 'rescore', dir, '--judge', 'none'],
      ['src/cli.ts', 'rescore', '--judge', 'none', dir],
      ['src/cli.ts', 'rescore', '--judge', 'none', '--brief', 'test/fixtures/calibration-brief.json', dir],
    ]) {
      const { stdout } = await run(process.execPath, args);
      assert.match(stdout, /AUC \(headline\)/, args.join(' '));
    }

    // A directory with no result.json is a usage error, not a stack trace.
    await assert.rejects(
      () => run(process.execPath, ['src/cli.ts', 'rescore', '--judge', 'none', join(dir, 'nope')]),
      (e: { stderr?: string }) => {
        assert.match(e.stderr ?? '', /error: could not read/);
        assert.doesNotMatch(e.stderr ?? '', /at async main/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI runs from plain node with no loader', async () => {
  const { stdout: help } = await run(process.execPath, ['src/cli.ts', 'help']);
  assert.match(help, /prompt-to-paint/);

  const { stdout: briefs } = await run(process.execPath, ['src/cli.ts', 'briefs']);
  for (const id of ['todo-app', 'landing-page', 'static-page']) assert.match(briefs, new RegExp(id));

  const { stdout: floors } = await run(process.execPath, ['src/cli.ts', 'floors']);
  assert.match(floors, /vite-react/);
});

test('a run that beats its horizon does not wait it out', { skip: needsBrowser, timeout: 120_000 }, async () => {
  const dir = await tmp('p2p-exit-');
  try {
    const base = JSON.parse(await readFile('test/fixtures/calibration-brief.json', 'utf8'));
    // A horizon far longer than the scripted timeline needs: it is finished at 9s.
    const brief = { ...base, horizonSec: 90, target: { port: 5294, serveStatic: true } };
    delete brief.iterations;
    const briefPath = join(dir, 'brief.json');
    await writeFile(briefPath, JSON.stringify(brief));

    const started = Date.now();
    await run(process.execPath, [
      'src/cli.ts', 'run', '--brief', briefPath,
      '--adapter', 'scripted', '--script', 'test/fixtures/calibration-timeline.json',
      '--judge', 'none', '--out', join(dir, 'runs'),
      '--settle', '1000', '--no-iterate', '--kill-port',
    ], { maxBuffer: 1 << 22 });
    const elapsed = Date.now() - started;

    // What this pins is not speed but exit: the cold-start window races the
    // agent's first turn against the horizon, and the branch that loses keeps
    // its timer. A pending timer holds Node's event loop open, so the CLI used
    // to print its report and then sit idle for the rest of the horizon -- eight
    // minutes on the bundled todo-app brief.
    assert.ok(
      elapsed < 45_000,
      `the CLI took ${(elapsed / 1000).toFixed(1)}s for a run whose work was done at ~10s; ` +
        'the losing branch of the cold-start race is holding the process open.',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The failure mode this harness was built to measure, reproduced: an agent that
// builds the whole app before serving any of it, and whose last act is a dev
// server that never returns.
// ---------------------------------------------------------------------------

/** A brief with nothing serving it: getting a server up is the agent's job. */
const lateBrief = (port: number, horizonSec: number): Brief => ({
  id: 'late', title: 'Serve late', prompt: '(fixture)', horizonSec,
  reviewableThreshold: 0.5, target: { port },
  entities: [{ id: 'title', aliases: ['DevConf 2026'] }],
  rubric: [{ id: 'renders', description: 'The page shows something.', weight: 1 }],
});

const PAGE = '<!doctype html><meta charset=utf-8><body style="padding:40px"><h1>DevConf 2026</h1></body>';

/** A shell agent that writes the page after `delaySec`, then blocks forever. */
const blockingAgent = (port: number, delaySec: number, signalDone: boolean): string =>
  `sleep ${delaySec}; printf '%s' ${JSON.stringify(PAGE)} > index.html; ` +
  (signalDone
    ? `python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1 & sleep 3; : > .p2p-done; exec sleep 600`
    : `exec python3 -m http.server ${port} --bind 127.0.0.1 >/dev/null 2>&1`);

test('a foreground dev server ends the run by quiescence, not at the horizon', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-quiet-');
  try {
    // The agent never completes a turn: `python -m http.server` in the
    // foreground holds the tool call open forever. Before quiescence existed,
    // the only end condition left was the horizon, which meant minutes of
    // screenshotting an app that had been finished the whole time.
    const result = await runBenchmark({
      brief: lateBrief(5295, 300), adapter: new ExecAdapter({ command: blockingAgent(5295, 4, false) }),
      runDir: dir, label: 'blocking', judgeBackend: new NullBackend(),
      quietForMs: 10_000, skipIterations: true, killPort: true,
    });
    assert.equal(result.endReason, 'quiet');
    assert.ok(result.wallMs < 90_000, `ran for ${(result.wallMs / 1000).toFixed(1)}s against a 300s horizon`);
    assert.ok(result.warnings.some((w) => /quiescence/.test(w)), 'the run says how it ended');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an agent that signals done stops the clock immediately', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-signal-');
  try {
    const result = await runBenchmark({
      brief: lateBrief(5296, 300), adapter: new ExecAdapter({ command: blockingAgent(5296, 3, true) }),
      runDir: dir, label: 'signals', judgeBackend: new NullBackend(),
      // Long enough that quiescence cannot be what ended this run.
      quietForMs: 120_000, settleMs: 1000, skipIterations: true, killPort: true,
    });
    assert.equal(result.endReason, 'signal');
    assert.ok(result.wallMs < 60_000, `ran for ${(result.wallMs / 1000).toFixed(1)}s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the frames before anything is serving are captured, not skipped', { skip: needsBrowser, timeout: 180_000 }, async () => {
  const dir = await tmp('p2p-early-');
  try {
    // The symptom that started this: frames/ held nothing until the dev server
    // came up, so the first picture of every run was the finished app, and a
    // filmstrip made a four-minute build look instant.
    const result = await runBenchmark({
      brief: lateBrief(5297, 120), adapter: new ExecAdapter({ command: blockingAgent(5297, 8, true) }),
      runDir: dir, label: 'early-frames', judgeBackend: new NullBackend(),
      quietForMs: 30_000, settleMs: 1000, skipIterations: true, killPort: true,
    });

    const before = result.frames.filter((f) => f.tMs < result.curve.ttfnbrMs!);
    assert.ok(before.length >= 3, `expected several pre-render frames, got ${before.length}`);
    assert.ok(before.every((f) => f.screenshotPath), 'every pre-render frame has a screenshot');
    assert.ok(before.every((f) => f.class !== 'render'), 'and none of them is classified as a render');

    // Those frames all show the same thing, so they share one file: the point
    // is that the timeline is complete, not that the directory is enormous.
    assert.equal(new Set(before.map((f) => f.screenshotPath)).size, 1);
    assert.ok(
      (result.artifacts?.distinctShots ?? 0) < result.frames.length,
      'repeated screenshots are stored once',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundled briefs resolve from the package, not the working directory', async () => {
  // An installed CLI is run from somewhere else entirely.
  const elsewhere = await tmp('p2p-cwd-');
  try {
    const { stdout } = await run(process.execPath, [join(process.cwd(), 'src/cli.ts'), 'briefs'], { cwd: elsewhere });
    assert.match(stdout, /todo-app/);
  } finally {
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('compare refuses runs that are not on the same scale', async () => {
  const dir = await tmp('p2p-cmp-');
  try {
    const mk = async (name: string, horizonMs: number, brief: string) => {
      const p = join(dir, name);
      await mkdir(p, { recursive: true });
      await writeFile(join(p, 'result.json'), JSON.stringify({
        schema: 1, runId: name, brief, briefPath: '', adapter: 'scripted', label: name,
        startedAt: '', t0Epoch: 0, wallMs: 1, url: '',
        curve: { horizonMs, auc: 0.5, ttfnbrMs: 1, ttfrrMs: 2, finalScore: 1, peakScore: 1,
                 timeToPeakMs: 1, regression: 0, heldToHorizon: true, runEndMs: 1 },
        decomposition: { wallMs: 1, buckets: {}, coverage: 1, crossCheck: {}, notes: [] },
        iterations: [], frames: [], phases: [], agentEvents: [],
        judge: { backend: 'none', model: null, framesJudged: 0, degraded: true },
        agentFailure: null, warnings: [],
      }));
      return join(p, 'result.json');
    };
    const a = await mk('a', 60_000, 'x');
    const b = await mk('b', 60_000, 'x');
    const c = await mk('c', 30_000, 'x');

    const { stdout } = await run(process.execPath, ['src/cli.ts', 'compare', a, b]);
    assert.match(stdout, /AUC/);

    // AUC is normalised by horizon, so mixing horizons is meaningless.
    await assert.rejects(
      run(process.execPath, ['src/cli.ts', 'compare', a, c]),
      (err: { stderr?: string; stdout?: string }) =>
        /different horizons/.test(`${err.stderr ?? ''}${err.stdout ?? ''}`),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
