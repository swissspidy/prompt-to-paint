import type { AgentEvent, Frame, FrameClass } from './types.ts';

/**
 * The live status line shown while a run is in flight.
 *
 * A run is minutes of silence with a browser and an agent working in the
 * background, and the CLI printed nothing for all of it. The first symptom
 * anyone notices is not a wrong number: it is not knowing whether the thing is
 * working at all. This shows, on one line, the two facts that answer that --
 * what is on screen right now, and what the agent last did.
 *
 * On a TTY the line is redrawn in place. Everywhere else (CI, a pipe, a log
 * file) it degrades to a timestamped line every `quietLogMs`, because a
 * carriage return in a log file is noise rather than progress.
 */
export interface ProgressOptions {
  /** Force the in-place renderer on or off. Defaults to whether stdout is a TTY. */
  tty?: boolean;
  /** How often to emit a line when not on a TTY. */
  quietLogMs?: number;
  write?: (s: string) => void;
  now?: () => number;
  columns?: () => number;
}

const STATE_GLYPH: Record<FrameClass, string> = {
  render: '●',      // filled: something is on screen
  blank: '○',       // hollow: served, nothing to look at
  error: '✕',       // cross: error page or overlay
  unreachable: '·', // dot: nothing listening yet
};

const STATE_WORD: Record<FrameClass, string> = {
  render: 'rendering',
  blank: 'blank',
  error: 'error',
  unreachable: 'no server',
};

/** mm:ss, because a run is minutes long and a float in seconds reads badly. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * One line describing the state of a run, at most `width` characters.
 *
 * Pure so it can be tested without a terminal: the renderer below only decides
 * when to call it and how to erase what it wrote last.
 */
export function statusLine(
  st: {
    elapsedMs: number;
    frame: Frame | null;
    frames: number;
    shots: number;
    activity: string;
    /** ms since the last agent event, or null if the agent has said nothing. */
    silentForMs: number | null;
    horizonMs: number;
  },
  width = 100,
): string {
  const cls = st.frame?.class ?? 'unreachable';
  // How long the agent has been silent is the one number that distinguishes
  // "working" from "wedged", and it is the question anyone watching a run that
  // has printed nothing for four minutes is actually asking.
  const quiet = st.silentForMs !== null && st.silentForMs > 5000 ? ` (${clock(st.silentForMs)} ago)` : '';

  // Least to most droppable. A narrow terminal loses detail rather than
  // wrapping: a status line that wraps stops being one line, and the in-place
  // redraw then leaves a trail of half-erased rows behind it.
  const parts = [
    `${clock(st.elapsedMs)}/${clock(st.horizonMs)}`,
    `${STATE_GLYPH[cls]} ${STATE_WORD[cls]}`,
    `${((st.frame?.entityCoverage ?? 0) * 100).toFixed(0)}% of brief on screen`,
    `${st.frames} frames / ${st.shots} distinct`,
  ];
  let line = '  ';
  for (const [i, part] of parts.entries()) {
    const next = i === 0 ? part : `  ·  ${part}`;
    if (line.length + next.length > width) return line;
    line += next;
  }
  const room = width - line.length - 5 - quiet.length;
  return st.activity && room > 12 ? `${line}  ·  ${truncate(st.activity, room)}${quiet}` : line;
}

/** Trim to width, keeping the front, which is the part that identifies it. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Turn one agent event into the short phrase shown on the status line.
 *
 * Tool names are the useful signal -- "Write src/App.tsx" says more about where
 * a run is than any token count -- so they win over prose when an adapter
 * exposes them. Adapters that only emit turns fall back to the assistant text,
 * and the ones that emit neither say so rather than showing a stale phrase.
 */
export function describeEvent(e: AgentEvent): string | null {
  if (e.type === 'tool_use') return `tool: ${e.toolName ?? 'unknown'}`;
  if (e.type === 'tool_result') return null; // the start line already said it
  if (e.type === 'assistant') {
    if (e.subtype === 'error') return `agent error: ${e.text ?? 'unknown'}`;
    return e.text ? `agent: ${e.text}` : 'agent: working';
  }
  if (e.type === 'result') return 'agent: turn complete';
  if (e.type === 'system') return 'agent: started';
  return null;
}

export class Progress {
  private opts: Required<Omit<ProgressOptions, 'tty' | 'columns'>> & {
    tty: boolean;
    columns: () => number;
  };
  private startedAt: number;
  private horizonMs: number;
  private frame: Frame | null = null;
  private frames = 0;
  private shots = 0;
  private lastShotPath: string | null = null;
  private activity = 'waiting for the agent';
  private lastEventAt: number | null = null;
  private painted = false;
  private timer: NodeJS.Timeout | null = null;
  private lastLoggedAt = 0;

  constructor(horizonMs: number, opts: ProgressOptions = {}) {
    this.horizonMs = horizonMs;
    this.opts = {
      tty: opts.tty ?? Boolean(process.stdout.isTTY),
      quietLogMs: opts.quietLogMs ?? 15_000,
      write: opts.write ?? ((s) => process.stdout.write(s)),
      now: opts.now ?? Date.now,
      columns: opts.columns ?? (() => process.stdout.columns || 100),
    };
    this.startedAt = this.opts.now();
  }

  /** Begin redrawing. A no-op off a TTY, where lines are emitted on change. */
  start(): void {
    if (!this.opts.tty) return;
    this.timer = setInterval(() => this.paint(), 500);
    // Never hold the process open for a progress line.
    this.timer.unref?.();
  }

  onFrame(f: Frame): void {
    this.frame = f;
    this.frames++;
    if (f.screenshotPath && f.screenshotPath !== this.lastShotPath) {
      this.shots++;
      this.lastShotPath = f.screenshotPath;
    }
    this.tick();
  }

  onAgentEvent(e: AgentEvent): void {
    this.lastEventAt = this.opts.now();
    const d = describeEvent(e);
    if (d) this.activity = d;
    this.tick();
  }

  /**
   * Print a line that outlives the status line.
   *
   * The status line is erased first and repainted after, so a log line never
   * ends up with half a status line welded to its tail.
   */
  log(msg: string): void {
    this.erase();
    this.opts.write(`  · ${msg}\n`);
    this.painted = false;
    this.paint();
  }

  /** Stop redrawing and leave the cursor on a clean line. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.erase();
  }

  private tick(): void {
    if (this.opts.tty) return; // the interval paints
    const now = this.opts.now();
    if (now - this.lastLoggedAt < this.opts.quietLogMs) return;
    this.lastLoggedAt = now;
    this.opts.write(`${this.line()}\n`);
  }

  private line(): string {
    const now = this.opts.now();
    return statusLine(
      {
        elapsedMs: now - this.startedAt,
        frame: this.frame,
        frames: this.frames,
        shots: this.shots,
        activity: this.activity,
        silentForMs: this.lastEventAt === null ? null : now - this.lastEventAt,
        horizonMs: this.horizonMs,
      },
      this.opts.columns(),
    );
  }

  private paint(): void {
    if (!this.opts.tty) return;
    this.opts.write(`\r[2K${this.line()}`);
    this.painted = true;
  }

  private erase(): void {
    if (this.opts.tty && this.painted) this.opts.write('\r[2K');
    this.painted = false;
  }
}
