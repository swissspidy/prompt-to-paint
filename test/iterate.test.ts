import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIteration } from '../src/iterate.ts';
import type { Prober } from '../src/probe/prober.ts';
import type { AgentRunHandle, Frame, IterationSpec } from '../src/types.ts';

// A 16-cell colour signature, uniform so two of them differ by exactly zero.
const flat = (v: number): string => Buffer.alloc(48, v).toString('base64');

function frame(o: Partial<Frame>): Frame {
  return {
    index: 0,
    tMs: 0,
    class: 'render',
    reason: 'test',
    screenshotPath: null,
    dhash: '0000000000000000',
    colorSig: flat(200),
    inkRatio: 0.3,
    text: '',
    offscreenTextChars: 0,
    title: 't',
    favicon: null,
    tabSignal: false,
    httpStatus: 200,
    consoleErrors: [],
    entityCoverage: 1,
    entitiesFound: [],
    domSignature: 'd',
    captureMs: 5,
    ...o,
  };
}

/**
 * The slice of Prober that runIteration touches, scripted.
 *
 * `sample()` appends to `frames` exactly as the real one does, so the cursor
 * the measurement starts from lands where it does in a run.
 */
function fakeProber(baseline: Frame, afterPrompt: Frame[]) {
  const frames: Frame[] = [];
  let interval = 1000;
  return {
    frames,
    reloads: 0,
    get intervalMs(): number {
      return interval;
    },
    setInterval(ms: number): void {
      interval = ms;
    },
    setCheck(_expr: string | null): void {},
    async sample(): Promise<Frame | null> {
      frames.push(baseline);
      return baseline;
    },
    requestReload(): void {
      this.reloads++;
    },
    /** Called when the prompt goes out: frames only appear after it. */
    release(): void {
      frames.push(...afterPrompt);
    },
  };
}

/**
 * A prober whose page only changes once someone asks for a refresh.
 *
 * A static file server with the edit in a linked stylesheet: the served
 * document is byte-identical, so nothing the prober watches on its own will
 * ever fire, and the browser holds the old CSS until a reload.
 */
function staleProber(baseline: Frame, afterRefresh: Frame[], stale: Frame[]) {
  const frames: Frame[] = [];
  let interval = 1000;
  return {
    frames,
    reloads: 0,
    get intervalMs(): number {
      return interval;
    },
    setInterval(ms: number): void {
      interval = ms;
    },
    setCheck(_expr: string | null): void {},
    async sample(): Promise<Frame | null> {
      frames.push(baseline);
      return baseline;
    },
    requestReload(): void {
      this.reloads++;
      frames.push(...afterRefresh);
    },
    release(): void {
      frames.push(...stale);
    },
  };
}

function fakeHandle(onSend: () => void): AgentRunHandle {
  return {
    done: Promise.resolve({ exitCode: 0, reportedApiMs: null }),
    events: [],
    turns: () => 0,
    waitForTurn: async () => undefined,
    send: async () => onSend(),
    stop: async () => undefined,
  };
}

const spec: IterationSpec = {
  id: 'header-blue',
  prompt: 'Make the page heading blue.',
  check: 'true',
  description: 'the canonical small visual edit',
  confirmFrames: 2,
};

test('an edit the predicate confirms is never reported as no visible change', () => {
  // The two detectors have different sensitivities and the predicate is the
  // stricter one: recolouring an h1 on a mostly-white page flips the check
  // while moving the worst colour cell by less than the threshold. Observed on
  // a real static-page run, which reported `first change  --   correct 3.1s` --
  // "the page never moved, and here is when it moved" -- for a heading that
  // visibly went blue.
  const t0Epoch = Date.now();
  const baseline = frame({ tMs: 0, checkPassed: false });
  // Pixel-identical to the baseline, so only the predicate sees the edit.
  const after = [
    frame({ tMs: 5_000, checkPassed: true }),
    frame({ tMs: 5_250, checkPassed: true }),
  ];
  const prober = fakeProber(baseline, after);

  return runIteration(spec, {
    prober: prober as unknown as Prober,
    handle: fakeHandle(() => prober.release()),
    t0Epoch,
    intervalMs: 50,
    timeoutMs: 10_000,
  }).then((res) => {
    assert.ok(res.ok, 'the check passed twice running, so the edit landed');
    assert.notEqual(res.timeToFirstChangeMs, null, 'a confirmed edit is a visible change');
    assert.equal(
      res.timeToFirstChangeMs,
      res.timeToCorrectChangeMs,
      'with nothing else to go on, the confirmed moment is the earliest evidence',
    );
  });
});

test('a pixel change the heuristic does see still reports the earlier moment', () => {
  // The clamp must not overwrite a genuine earlier sighting: an agent that
  // repaints at once and gets it right later is the case the two numbers exist
  // to tell apart.
  const t0Epoch = Date.now();
  const baseline = frame({ tMs: 0, checkPassed: false });
  const after = [
    frame({ tMs: 2_000, checkPassed: false, colorSig: flat(40) }), // repaint, wrong colour
    frame({ tMs: 6_000, checkPassed: true, colorSig: flat(40) }),
    frame({ tMs: 6_250, checkPassed: true, colorSig: flat(40) }),
  ];
  const prober = fakeProber(baseline, after);

  return runIteration(spec, {
    prober: prober as unknown as Prober,
    handle: fakeHandle(() => prober.release()),
    t0Epoch,
    intervalMs: 50,
    timeoutMs: 10_000,
  }).then((res) => {
    assert.ok(res.ok);
    assert.ok(res.timeToFirstChangeMs !== null && res.timeToCorrectChangeMs !== null);
    assert.ok(
      res.timeToFirstChangeMs < res.timeToCorrectChangeMs,
      `first change ${res.timeToFirstChangeMs} should precede correct ${res.timeToCorrectChangeMs}`,
    );
  });
});

test('a page with no update channel is refreshed once, and the edit is found', async () => {
  // Observed on a todo-app run: the agent put the blue header in style.css and
  // served the directory with a plain file server. index.html stayed
  // byte-identical, so the prober -- which reloads only when the served
  // document changes, to keep HMR timing intact -- never refreshed, and the
  // browser showed the old CSS for the rest of the run. The edit was on disk
  // and correctly served; the iteration reported NEVER LANDED.
  const t0Epoch = Date.now();
  const baseline = frame({ tMs: 0, checkPassed: false });
  const stale = [frame({ tMs: 200, checkPassed: false }), frame({ tMs: 500, checkPassed: false })];
  const landed = [
    frame({ tMs: 9_000, checkPassed: true, colorSig: flat(40) }),
    frame({ tMs: 9_250, checkPassed: true, colorSig: flat(40) }),
  ];
  const prober = staleProber(baseline, landed, stale);

  const res = await runIteration(spec, {
    prober: prober as unknown as Prober,
    handle: fakeHandle(() => prober.release()),
    t0Epoch,
    intervalMs: 50,
    timeoutMs: 10_000,
    refreshAfterMs: 120,
  });
  assert.equal(prober.reloads, 1, 'refreshed exactly once, not on every tick');
  assert.ok(res.ok, 'the edit that was already on disk is found');
  assert.notEqual(res.refreshedAtMs, null, 'the run says the change needed a refresh');
});

test('a page that moved on its own is never refreshed', async () => {
  // The refresh exists for a page with no update channel. An app with hot
  // reload has shown something by the time the agent stops -- the change, a
  // flash, an error overlay -- and reloading it would destroy the HMR state and
  // measure a page load instead of the rebuild.
  const t0Epoch = Date.now();
  const baseline = frame({ tMs: 0, checkPassed: false });
  const moved = [
    frame({ tMs: 300, checkPassed: false, colorSig: flat(40) }), // repaint, not yet right
    frame({ tMs: 9_000, checkPassed: true, colorSig: flat(40) }),
    frame({ tMs: 9_250, checkPassed: true, colorSig: flat(40) }),
  ];
  const prober = fakeProber(baseline, moved);

  const res = await runIteration(spec, {
    prober: prober as unknown as Prober,
    handle: fakeHandle(() => prober.release()),
    t0Epoch,
    intervalMs: 50,
    timeoutMs: 10_000,
    refreshAfterMs: 120,
  });
  assert.equal(prober.reloads, 0);
  assert.equal(res.refreshedAtMs, null, 'nothing to report: it arrived on its own');
  assert.ok(res.ok);
});

test('an edit that never lands still reports no visible change as none', () => {
  // The clamp keys off a confirmed edit, so an edit that never landed must be
  // left alone: "the page never moved" is the true answer here and saying
  // otherwise would invent a change out of the absence of one.
  const t0Epoch = Date.now();
  const baseline = frame({ tMs: 0, checkPassed: false });
  const after = [
    frame({ tMs: 300, checkPassed: false }),
    frame({ tMs: 600, checkPassed: false }),
  ];
  const prober = fakeProber(baseline, after);

  return runIteration(spec, {
    prober: prober as unknown as Prober,
    handle: fakeHandle(() => prober.release()),
    t0Epoch,
    intervalMs: 50,
    timeoutMs: 1_500,
    postTurnGraceMs: 400,
  }).then((res) => {
    assert.equal(res.ok, false);
    assert.equal(res.timeToCorrectChangeMs, null);
    assert.equal(res.timeToFirstChangeMs, null);
  });
});
