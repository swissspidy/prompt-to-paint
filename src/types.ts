/**
 * Core vocabulary for the prompt-to-paint harness.
 *
 * Time discipline: every timestamp in the system is `tMs`, milliseconds since
 * `t0Epoch` (a single `Date.now()` captured when the run starts). Shims run in
 * separate processes and cannot share a monotonic clock with the harness, so
 * wall-clock epoch is the only common origin available. At a 1s poll interval,
 * clock drift over a 10-minute run is far below measurement resolution.
 */

// ---------------------------------------------------------------------------
// Briefs
// ---------------------------------------------------------------------------

/** A thing the brief asked for, used for the mechanical reviewability test. */
export interface Entity {
  id: string;
  /** Surface forms to look for in rendered text. Matched case-insensitively. */
  aliases: string[];
  weight?: number;
}

/** A binary, auditable claim about a screenshot. Judges fill these in. */
export interface Criterion {
  id: string;
  /** Written so a judge can answer yes/no from a screenshot alone. */
  description: string;
  weight: number;
}

/** One edit in the iteration loop: a prompt plus a mechanical success test. */
export interface IterationSpec {
  id: string;
  prompt: string;
  /**
   * JS expression evaluated in the page. Must return truthy once the edit has
   * visibly landed. Mechanical on purpose: the iteration metric should not
   * depend on a judge's mood.
   */
  check: string;
  /** Human description, also used if a judge has to adjudicate a tie. */
  description: string;
  /** Consecutive passing frames required before the change counts as landed. */
  confirmFrames?: number;
}

export interface Brief {
  id: string;
  title: string;
  /** Verbatim text handed to the agent under test. */
  prompt: string;
  /** Metric horizon H in seconds. The curve is integrated over [0, H]. */
  horizonSec: number;
  entities: Entity[];
  rubric: Criterion[];
  /** Fraction of entity weight that must be present for "reviewable". */
  reviewableThreshold: number;
  iterations?: IterationSpec[];
  /** Where the harness expects the app to appear. */
  target?: {
    url?: string;
    port?: number;
    /**
     * Serve the workdir over HTTP instead of waiting for the agent to.
     * Only for briefs that genuinely ask for a static file; for an app brief,
     * getting it running is part of the task.
     */
    serveStatic?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export type FrameClass =
  | 'unreachable' // nothing listening, or navigation failed outright
  | 'error'       // served, but an error page / dev-server overlay / 4xx-5xx
  | 'blank'       // served and no error, but nothing a human could react to
  | 'render';     // something is on screen

export interface Frame {
  index: number;
  tMs: number;
  class: FrameClass;
  /** Why the classifier decided that, for auditability. */
  reason: string;
  screenshotPath: string | null;
  /** 64-bit difference hash as hex, for dedupe. Null if no screenshot. */
  dhash: string | null;
  /** Coarse colour grid. Catches hue changes that luminance hashing misses. */
  colorSig: string | null;
  /** Fraction of non-uniform pixels; drives the blank test. */
  inkRatio: number;
  text: string;
  title: string;
  /**
   * Absolute href of the icon the page declares, or null if it declares none.
   *
   * Browser chrome, not pixels: it is not in the screenshot, so nothing that
   * reads a frame's image can see it.
   */
  favicon: string | null;
  /**
   * The tab is identifying the app while the viewport may still be empty -- a
   * real `<title>`, a declared icon, or both.
   *
   * Deliberately not an input to `classify()`. A titled blank page is still a
   * blank page to the person waiting for it, and letting this move the class
   * would change every AUC ever recorded. It is reported beside the render
   * times instead, as the separate thing it is.
   */
  tabSignal: boolean;
  httpStatus: number | null;
  consoleErrors: string[];
  /** Weighted fraction of brief entities visible in the rendered text. */
  entityCoverage: number;
  entitiesFound: string[];
  /** Cheap structural fingerprint, catches DOM change without pixel change. */
  domSignature: string;
  /** How long this capture took. Measurement overhead, kept off the timeline. */
  captureMs: number;
  /** Result of the active iteration check, when one is armed. */
  checkPassed?: boolean | null;
}

export type ScoreSource =
  | 'judge'         // a model looked at this exact frame
  | 'forward-fill'  // visually identical to the last judged frame
  | 'non-render'    // blank/error/unreachable, scored 0 without a model call
  | 'mechanical';   // no judge available; entity coverage used as a proxy

/** Which window of the run a stored frame belongs to. */
export type FramePhase =
  | 'cold'       // the measured cold-start window; every headline number comes from these
  | 'iteration'; // after the window closed, while follow-up edits were measured

export interface ScoredFrame extends Frame {
  score: number;
  scoreSource: ScoreSource;
  /**
   * Cold-start frames are what the curve, the AUC and every headline number
   * are computed from. Iteration frames are kept so a run can be replayed in
   * full -- the edits are half of what a run shows -- but they are never
   * scored against the cold-start rubric and never enter the curve, because
   * "make the header blue" is a different experiment from the brief.
   *
   * Absent on results written before v0.4; read those as all-cold.
   */
  phase?: FramePhase;
  criteria?: Record<string, { met: boolean; note?: string }>;
  judgeNote?: string;
}

// ---------------------------------------------------------------------------
// Latency decomposition
// ---------------------------------------------------------------------------

export type PhaseKind =
  | 'install'
  | 'build'
  | 'devserver_boot'
  | 'devserver'
  | 'test'
  | 'scaffold'
  | 'other';

export interface PhaseEvent {
  kind: PhaseKind;
  cmd: string;
  argv: string[];
  startMs: number;
  endMs: number | null;
  exitCode: number | null;
  source: 'shim' | 'harness';
  /** For dev servers: when the process announced it was listening. */
  readyMs?: number;
}

export type Bucket =
  | 'model'
  | 'tool_overhead'
  | 'install'
  | 'build'
  | 'devserver_boot'
  | 'first_paint'
  | 'residual';

export interface Decomposition {
  wallMs: number;
  buckets: Record<Bucket, number>;
  /** Share of wall clock we can account for. Below ~0.85, distrust the split. */
  coverage: number;
  crossCheck: {
    /** Agent's self-reported API time, when the adapter can supply it. */
    reportedApiMs: number | null;
    attributedModelMs: number;
    /** Positive means we attributed more model time than the agent claims. */
    deltaMs: number | null;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Agent adapters
// ---------------------------------------------------------------------------

export interface AgentEvent {
  tMs: number;
  type: 'system' | 'assistant' | 'user' | 'result' | 'tool_use' | 'tool_result' | 'raw';
  subtype?: string;
  toolName?: string;
  toolId?: string;
  text?: string;
  raw?: unknown;
}

export interface AgentRunHandle {
  /** Resolves when the agent process exits. */
  done: Promise<{ exitCode: number | null; reportedApiMs: number | null }>;
  /** Send a follow-up prompt into the same live session, for iteration runs. */
  send?: (prompt: string) => Promise<void>;
  /** Completed turns so far. */
  turns: () => number;
  /**
   * Resolves once more than `after` turns have completed.
   *
   * Counter-based rather than event-based on purpose: callers read the count,
   * send a prompt, then wait on that count, so a turn that finishes before the
   * caller starts waiting cannot be missed.
   */
  waitForTurn: (after: number) => Promise<void>;
  stop: () => Promise<void>;
  events: AgentEvent[];
}

export interface AgentContext {
  workdir: string;
  /** Prepend-to-PATH shim dir and P2P_PHASE_LOG live here. */
  env: Record<string, string>;
  t0Epoch: number;
  onEvent: (e: AgentEvent) => void;
  logPath: string;
}

/**
 * How an adapter delivers a follow-up prompt.
 *
 * This decides what the iteration numbers mean, so it travels with the result.
 * A `live-session` edit measures the loop a person sits in. A `restart` re-runs
 * the agent from scratch, so its timings also contain process startup and
 * whatever re-reading of the project the agent does before it can act -- often
 * seconds, and not the thing the metric is supposed to be about. The two are
 * not comparable, and a report that showed them side by side without saying so
 * would be quietly wrong.
 */
export type IterationMode = 'live-session' | 'restart' | 'none';

/**
 * How much of the agent's internals its event stream exposes.
 *
 * `turns-only` is the important one: it means we can see the agent working but
 * cannot tell thinking from tool execution. That time goes to the residual,
 * because a split we cannot substantiate is worse than an admitted gap.
 */
export type StreamFidelity = 'full' | 'turns-only' | 'none';

export interface Adapter {
  name: string;
  /** Defaults to 'restart' when an adapter does not declare one. */
  readonly iterationMode?: IterationMode;
  /** May be computed at the end of a run from what was actually parsed. */
  readonly streamFidelity?: StreamFidelity;
  /**
   * Where the agent says it is working, if its stream says so at all.
   *
   * Read after the run and compared against the workdir it was handed. An
   * agent that is building somewhere else produces a run that looks almost
   * right -- it serves an app, the page renders, the curve is a curve -- while
   * nothing in the run directory reproduces any of it. Null means the adapter
   * cannot tell, which is not the same as agreeing.
   */
  readonly reportedWorkdir?: string | null;
  start(prompt: string, ctx: AgentContext): Promise<AgentRunHandle>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CurveMetrics {
  horizonMs: number;
  /** Normalized area under the correctness curve, 0..1. The headline number. */
  auc: number;
  /** First frame that is neither blank, error, nor unreachable. */
  ttfnbrMs: number | null;
  /** First frame a human could give useful feedback on. */
  ttfrrMs: number | null;
  /**
   * First frame where the tab said something -- title or favicon -- however
   * empty the page still was.
   *
   * Separate from `ttfnbrMs` on purpose, and never mixed into it: this is the
   * stretch where a person can tell the build is alive but has nothing to
   * react to yet. Absent on results written before v0.5.
   */
  firstTabSignalMs?: number | null;
  finalScore: number;
  peakScore: number;
  timeToPeakMs: number | null;
  /** peak - final. Non-zero means the agent broke its own work. */
  regression: number;
  /** True if the run ended before the horizon and the curve was held flat. */
  heldToHorizon: boolean;
  runEndMs: number;
}

export interface IterationResult {
  id: string;
  /** How the follow-up was delivered. Decides what these timings include. */
  mode: IterationMode;
  /**
   * The check was already satisfied before the prompt was sent, so this edit
   * cannot be measured and the result is void. A broken check, not a fast agent.
   */
  baselineAlreadyPassing: boolean;
  prompt: string;
  promptSentMs: number;
  /** First visually distinct frame after the prompt. Loop responsiveness. */
  timeToFirstChangeMs: number | null;
  /** First frame where the mechanical check passes and stays passing. */
  timeToCorrectChangeMs: number | null;
  /** When the agent stopped talking. Usually later than the visible change. */
  agentDoneMs: number | null;
  /** Total ms the app spent blank/error between prompt and correct change. */
  brokenMs: number;
  ok: boolean;
  /**
   * The check was already passing in one baseline sample but not the other, so
   * it is flapping and neither answer about this edit can be trusted.
   */
  baselineUnstable?: boolean;
  /** When this edit's observation window closed, relative to t0. */
  endedMs?: number;
  /**
   * Time between the agent finishing its turn and the change reaching the
   * screen.
   *
   * This is the part of an edit's latency the agent is not responsible for:
   * HMR, a rebuild, a dev server that has to restart. Negative means the page
   * updated while the agent was still working, which is what a fast loop looks
   * like. Null when the edit never landed or the turn never completed.
   */
  afterAgentMs?: number | null;
  /**
   * What the agent actually did for this edit.
   *
   * Time to correct change is wall clock, and wall clock says nothing about
   * whose time it was. One tool call behind a twelve-second Vite rebuild and
   * nine tool calls of flailing produce the same number, and ranking agents on
   * it alone would charge the model for a slow toolchain. Absent when the run
   * predates this, or when the adapter's stream cannot show it.
   */
  work?: IterationWork;
}

export interface IterationWork {
  /**
   * Tool calls the agent made inside this edit's window. Null when the
   * adapter's stream does not expose tool boundaries -- which is not zero, and
   * must never be rendered as zero.
   */
  toolCalls: number | null;
  /** Their names in order, so "it only wrote one file" is checkable. */
  toolNames: string[];
  /** Attributed thinking time inside the window. Null without a full stream. */
  modelMs: number | null;
  /** Attributed tool-execution time inside the window. */
  toolMs: number | null;
  /** Toolchain commands the shims saw run inside the window. */
  phases: Array<{ kind: PhaseKind; cmd: string; ms: number | null }>;
}

/**
 * Why the cold-start observation window closed.
 *
 * Travels with the result because it changes how the tail of the curve should
 * be read. `turn` and `signal` mean the agent said it was finished; `quiet`
 * means it stopped doing anything observable and we inferred it; `horizon`
 * means it never stopped, and the run was cut off mid-flight.
 */
export type RunEndReason =
  | 'turn'      // the adapter saw the agent complete its first turn
  | 'signal'    // the agent created the done sentinel in its workdir
  | 'quiet'     // page, agent stream and toolchain all idle long enough
  | 'rendered'  // stop-after-render was set and the app rendered
  | 'horizon';  // the brief's horizon ran out first

export interface RunResult {
  schema: 1;
  runId: string;
  brief: string;
  /** Path the brief was loaded from, so a run can be re-scored later. */
  briefPath: string;
  adapter: string;
  label: string;
  startedAt: string;
  t0Epoch: number;
  wallMs: number;
  url: string;
  curve: CurveMetrics;
  decomposition: Decomposition;
  iterations: IterationResult[];
  frames: ScoredFrame[];
  phases: PhaseEvent[];
  agentEvents: AgentEvent[];
  judge: {
    backend: string;
    model: string | null;
    framesJudged: number;
    degraded: boolean;
    /**
     * Written before judging, so an interrupted or failed scoring pass still
     * leaves a replayable run on disk. `p2p rescore` clears it.
     */
    pending?: boolean;
  };
  /**
   * Set when the agent process died before the harness stopped it. A run that
   * failed to launch must never be mistaken for an agent that built nothing.
   */
  agentFailure: { exitCode: number | null; atMs: number; logPath: string } | null;
  /** Why the cold-start window closed. Absent on results written before v0.2. */
  endReason?: RunEndReason;
  /**
   * What the agent was told about how the run is observed.
   *
   * `renderEarly` is the whole comparison: with it the agent knows the clock is
   * running and that a rough early page beats a perfect late one, and the number
   * says how fast it renders when told to. Without it, the number says whether
   * it does so unprompted. Those are different questions, and a result that does
   * not record which one it answers cannot be placed next to another.
   *
   * Absent on results written before v0.3; every one of those was prompted.
   */
  protocol?: { renderEarly: boolean };
  /** Files and counts produced beside result.json. */
  artifacts?: {
    /** Session recording, when --video was on. */
    videoPath?: string | null;
    /** The exact text handed to the agent, protocol suffix included. */
    promptPath?: string;
    /** Screenshots actually written; repeats share one file. */
    distinctShots?: number;
    repeatedShots?: number;
    /**
     * Append-only copy of the timeline, written frame by frame during the run.
     *
     * result.json is assembled once, at the end. Anything that kills the
     * process before then -- an OOM, a stray SIGKILL, a Ctrl-C -- used to take
     * the whole run with it, leaving screenshots nobody could put in order.
     * This file is on disk the moment each frame is, so `p2p salvage` can
     * rebuild a run from it.
     */
    framesLogPath?: string;
    /**
     * What the agent left in its working directory, sampled before teardown.
     *
     * An empty workdir beside a page that rendered is the signature of an agent
     * that built somewhere else, so the fact is recorded rather than left for
     * someone to notice afterwards.
     */
    workdir?: {
      path: string;
      entries: string[];
      fileCount: number;
      empty: boolean;
      /** What the agent itself said its working directory was, when it says. */
      reportedByAgent?: string | null;
    };
  };
  warnings: string[];
}
