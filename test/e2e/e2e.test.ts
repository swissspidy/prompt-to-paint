import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrief } from '../../src/brief.ts';
import { runBenchmark } from '../../src/run.ts';
import { ScriptedAdapter } from '../../src/adapters/scripted.ts';
import { ExecAdapter } from '../../src/adapters/exec.ts';
import { NullBackend } from '../../src/judge/backends.ts';
import { findChromium } from '../../src/probe/browser.ts';
import { serveStatic } from '../../src/static-server.ts';
import type { Brief } from '../../src/types.ts';

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
