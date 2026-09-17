import type { AgentRunHandle, Frame, IterationMode, IterationResult, IterationSpec } from './types.ts';
import type { Prober } from './probe/prober.ts';
import { hamming, colorDelta } from './probe/pixels.ts';

export interface IterateOptions {
  prober: Prober;
  handle: AgentRunHandle;
  t0Epoch: number;
  /** Poll interval during iteration. Finer than cold start; edits are fast. */
  intervalMs?: number;
  timeoutMs?: number;
  /**
   * How long to keep watching after the agent says it is finished. Once the
   * turn has ended and the change has not appeared, it is not going to.
   */
  postTurnGraceMs?: number;
  /** How the follow-up is delivered; recorded so the timings can be read right. */
  mode?: IterationMode;
  /** dhash distance counting as a visible change. Lower than the judge's. */
  changeThreshold?: number;
  /** Worst-cell colour distance counting as a visible change (0..255). */
  colorThreshold?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isBroken = (c: Frame['class'] | undefined): boolean =>
  c === 'error' || c === 'blank' || c === 'unreachable';

/**
 * Measures one edit, from prompt to visible change.
 *
 * Two different things get timed, because they answer different questions.
 * Time to first change is how long the loop takes to show *any* sign of life,
 * which is what makes an edit feel responsive. Time to correct change is when
 * the edit actually landed, decided by the spec's in-page predicate. An agent
 * that repaints instantly and gets it right forty seconds later is a different
 * experience from one that does both at twelve seconds, and a single number
 * would hide that.
 *
 * Breakage is tracked separately: white-screening the app for eight seconds
 * mid-edit is a real cost that neither timestamp captures on its own.
 */
export async function runIteration(
  spec: IterationSpec,
  opts: IterateOptions,
): Promise<IterationResult> {
  const { prober, handle, t0Epoch } = opts;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const changeThreshold = opts.changeThreshold ?? 3;
  const colorThreshold = opts.colorThreshold ?? 8;
  const confirmFrames = spec.confirmFrames ?? 2;

  const coldInterval = prober.intervalMs;
  prober.setInterval(opts.intervalMs ?? 250);
  prober.setCheck(spec.check);

  // Baseline: the state a human would be looking at as they type the prompt.
  const baseline = await prober.sample();
  const baselineHash = baseline?.dhash ?? null;
  const baselineSig = baseline?.colorSig ?? null;
  const firstNewFrame = prober.frames.length;

  // If the check already passes before the prompt is sent, it cannot measure
  // this edit: the very first frame would report a near-instant success for a
  // change the agent never made. That is a broken check, not a fast agent, so
  // the iteration is reported invalid rather than given a flattering number.
  const baselineAlreadyPassing = baseline?.checkPassed === true;

  const turnsBefore = handle.turns();
  const promptSentEpoch = Date.now();
  const promptSentMs = promptSentEpoch - t0Epoch;
  await handle.send?.(spec.prompt);

  let agentDoneMs: number | null = null;
  let doneAtWallMs = Number.POSITIVE_INFINITY;
  void handle.waitForTurn(turnsBefore).then(() => {
    agentDoneMs = Date.now() - t0Epoch;
    doneAtWallMs = Date.now();
  });

  let timeToFirstChangeMs: number | null = null;
  let timeToCorrectChangeMs: number | null = null;
  let consecutivePasses = 0;
  let firstPassMs: number | null = null;
  let brokenMs = 0;
  let cursor = firstNewFrame;
  // Broken time is charged to the state observed at the *start* of an interval.
  // Charging it to the frame that ends the interval would book a healthy
  // stretch as broken the moment the next sample came back blank.
  let prevBroken = isBroken(baseline?.class);
  let prevMs = promptSentMs;

  const hardDeadline = Date.now() + timeoutMs;
  const grace = opts.postTurnGraceMs ?? 20_000;
  // A failed edit should not cost the full timeout: an agent that has stopped
  // talking is not about to change the page.
  const deadline = (): number =>
    agentDoneMs === null ? hardDeadline : Math.min(hardDeadline, doneAtWallMs + grace);

  while (Date.now() < deadline() && timeToCorrectChangeMs === null) {
    await sleep(60);
    for (; cursor < prober.frames.length; cursor++) {
      const f: Frame = prober.frames[cursor]!;
      if (f.tMs < promptSentMs) continue;

      if (prevBroken) brokenMs += Math.max(0, f.tMs - prevMs);
      prevBroken = isBroken(f.class);
      prevMs = f.tMs;

      // Structure OR colour. A recolour moves the colour signature while
      // leaving the luminance hash almost untouched; a layout change does the
      // reverse. Either one is a visible change to the person watching.
      const structuralMove =
        f.dhash && baselineHash ? hamming(f.dhash, baselineHash) > changeThreshold : false;
      const colourMove = colorDelta(f.colorSig, baselineSig).max > colorThreshold;
      if (timeToFirstChangeMs === null && (structuralMove || colourMove)) {
        timeToFirstChangeMs = f.tMs - promptSentMs;
      }

      if (f.checkPassed && !baselineAlreadyPassing) {
        if (consecutivePasses === 0) firstPassMs = f.tMs;
        consecutivePasses++;
        // Require the change to persist: HMR can flash a half-applied state.
        if (consecutivePasses >= confirmFrames) {
          timeToCorrectChangeMs = (firstPassMs ?? f.tMs) - promptSentMs;
          break;
        }
      } else {
        consecutivePasses = 0;
        firstPassMs = null;
      }
    }
  }

  // Charge the last observed state through to whatever ended the loop, so an
  // app left broken at the end is not silently forgiven.
  const endedMs =
    timeToCorrectChangeMs !== null ? promptSentMs + timeToCorrectChangeMs : Date.now() - t0Epoch;
  if (prevBroken) brokenMs += Math.max(0, endedMs - prevMs);

  prober.setCheck(null);
  prober.setInterval(coldInterval);

  return {
    id: spec.id,
    baselineAlreadyPassing,
    mode: opts.mode ?? 'restart',
    prompt: spec.prompt,
    promptSentMs,
    timeToFirstChangeMs,
    timeToCorrectChangeMs,
    agentDoneMs,
    brokenMs,
    ok: timeToCorrectChangeMs !== null && !baselineAlreadyPassing,
  };
}
