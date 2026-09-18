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
    /** Called when the prompt goes out: frames only appear after it. */
    release(): void {
      frames.push(...afterPrompt);
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
