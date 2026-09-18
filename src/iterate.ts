import type { AgentRunHandle, Frame, IterationMode, IterationResult, IterationSpec } from './types.ts';
import type { Prober } from './probe/prober.ts';
import { hamming, colorDelta } from './probe/pixels.ts';
import { sleep } from './sleep.ts';

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
  /**
   * Baseline samples taken before the prompt is sent.
   *
   * More than one because the check is arbitrary JavaScript evaluated in a live
   * page: it throws mid-reload, and it reads a style that has not been applied
   * yet. A single sample that happened to land in one of those moments reports
   * a header that was already blue as not-blue, and the very first frame after
   * the prompt then scores a near-instant success for an edit the agent never
   * made. Two samples cost a few hundred milliseconds before the clock starts.
   */
  baselineSamples?: number;
}

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
  const samples: Array<Awaited<ReturnType<typeof prober.sample>>> = [];
  for (let i = 0; i < Math.max(1, opts.baselineSamples ?? 2); i++) {
    samples.push(await prober.sample());
  }
  const baseline = samples.at(-1) ?? null;
  const baselineHash = baseline?.dhash ?? null;
  const baselineSig = baseline?.colorSig ?? null;
  const firstNewFrame = prober.frames.length;

  // If the check already passes before the prompt is sent, it cannot measure
  // this edit: the very first frame would report a near-instant success for a
  // change the agent never made. That is a broken check, not a fast agent, so
  // the iteration is reported invalid rather than given a flattering number.
  //
  // *Any* sample passing is enough. The two mistakes are not symmetrical: a
  // false "void" costs one measurement and says exactly why, while a false
  // "already correct at 0.2s" is a wrong number that looks like a very good
  // one and will be believed.
  const checks = samples.map((f) => f?.checkPassed === true);
  const baselineAlreadyPassing = checks.some(Boolean);
  // Disagreement means the predicate itself is flapping, so neither answer
  // about this edit is worth anything -- including a later "it landed".
  const baselineUnstable = checks.some(Boolean) && !checks.every(Boolean);

  const turnsBefore = handle.turns();
  const promptSentEpoch = Date.now();
  const promptSentMs = promptSentEpoch - t0Epoch;
  await handle.send?.(spec.prompt);

  let agentDoneMs: number | null = null;
  let doneAtWallMs = Number.POSITIVE_INFINITY;
  // Kept, not discarded: a fast loop finishes the *edit* before the agent
  // finishes the *turn*, and in that case this promise is the only thing that
  // will ever know when the turn ended. See the bounded wait below.
  const turnDone = handle.waitForTurn(turnsBefore).then(() => {
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

  // Wait for the turn to end before asking when it ended.
  //
  // The measurement loop stops the moment the check passes, which on a fast
  // loop is *before* the agent stops talking -- exactly the case the signed
  // `afterAgentMs` exists to describe. Reading it right there found
  // `agentDoneMs` still null and reported no answer for the one situation the
  // number was introduced to show. Nothing measured is affected: `endedMs` and
  // `brokenMs` above are already fixed, and this window sits outside every
  // clock. Bounded, because a turn that never completes must not hold the run.
  if (timeToCorrectChangeMs !== null && agentDoneMs === null) {
    const waitCtl = new AbortController();
    try {
      await Promise.race([turnDone, sleep(grace, waitCtl.signal)]);
    } finally {
      waitCtl.abort();
    }
  }

  // The part of the edit the agent is not accountable for: it had finished and
  // the page had not caught up. Deliberately signed -- a negative number means
  // the change was on screen before the agent stopped talking, which is what a
  // fast loop looks like and is worth being able to see.
  const correctAtMs = timeToCorrectChangeMs !== null ? promptSentMs + timeToCorrectChangeMs : null;
  const afterAgentMs =
    correctAtMs !== null && agentDoneMs !== null ? correctAtMs - agentDoneMs : null;

  return {
    id: spec.id,
    baselineAlreadyPassing,
    baselineUnstable,
    mode: opts.mode ?? 'restart',
    prompt: spec.prompt,
    promptSentMs,
    timeToFirstChangeMs,
    timeToCorrectChangeMs,
    agentDoneMs,
    afterAgentMs,
    endedMs,
    brokenMs,
    ok: timeToCorrectChangeMs !== null && !baselineAlreadyPassing,
  };
}
