import type { AgentEvent, Bucket, Decomposition, PhaseEvent, PhaseKind } from '../types.js';

export interface Interval {
  start: number;
  end: number;
}

export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out.at(-1);
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

export function subtract(base: Interval[], cut: Interval[]): Interval[] {
  let acc = union(base);
  for (const c of union(cut)) {
    const next: Interval[] = [];
    for (const b of acc) {
      if (c.end <= b.start || c.start >= b.end) { next.push(b); continue; }
      if (c.start > b.start) next.push({ start: b.start, end: c.start });
      if (c.end < b.end) next.push({ start: c.end, end: b.end });
    }
    acc = next;
  }
  return acc;
}

export const total = (intervals: Interval[]): number =>
  union(intervals).reduce((s, i) => s + (i.end - i.start), 0);

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

const firstArg = (argv: string[]): string => argv.find((a) => !a.startsWith('-')) ?? '';

/**
 * Turn a raw command invocation into a phase.
 *
 * Kept separate from the shim so every rule here is unit testable; the shim
 * only records what ran and when.
 */
export function classifyPhase(cmd: string, argv: string[]): PhaseKind {
  const a0 = firstArg(argv);
  const joined = argv.join(' ');
  const isPm = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx'].includes(cmd);

  if (isPm) {
    if (/^(create(-\w+)?|init)$/.test(a0) || /\bcreate-[\w-]+/.test(joined)) return 'scaffold';
    if (['install', 'i', 'ci', 'add', 'update', 'up'].includes(a0)) return 'install';
    // `yarn` and `pnpm` with no arguments install.
    if (!a0 && (cmd === 'yarn' || cmd === 'pnpm')) return 'install';
    if (a0 === 'run' || a0 === 'exec' || cmd === 'npx' || cmd === 'pnpx') {
      const script = argv[argv.indexOf(a0) + 1] ?? (cmd === 'npx' ? a0 : '');
      if (/^(dev|start|serve|preview)$/.test(script)) return 'devserver';
      if (/^(build|compile|bundle)/.test(script)) return 'build';
      if (/^(test|vitest|jest)/.test(script)) return 'test';
      if (/create-/.test(script)) return 'scaffold';
      return 'other';
    }
    if (/^(dev|start|serve)$/.test(a0)) return 'devserver';
    if (/^build/.test(a0)) return 'build';
    if (/^test/.test(a0)) return 'test';
    return 'other';
  }

  if (['vite', 'next', 'astro', 'nuxt', 'remix', 'ng', 'parcel', 'react-scripts'].includes(cmd)) {
    if (/^build$/.test(a0)) return 'build';
    if (/^(test|check)$/.test(a0)) return 'test';
    // A bare bundler invocation, or an explicit dev/serve, is a dev server.
    if (!a0 || /^(dev|serve|start|preview)$/.test(a0)) return 'devserver';
    return 'other';
  }

  if (['tsc', 'webpack', 'esbuild', 'rollup'].includes(cmd)) {
    if (argv.includes('--watch') || argv.includes('-w')) return 'devserver';
    return 'build';
  }
  return 'other';
}

interface RawShimRecord {
  ev: 'start' | 'end';
  id: string;
  cmd?: string;
  argv?: string[];
  startEpoch?: number;
  endEpoch?: number;
  exit?: number | null;
  depth?: number;
}

export function parsePhaseLog(text: string, t0Epoch: number): PhaseEvent[] {
  const starts = new Map<string, RawShimRecord>();
  const ends = new Map<string, RawShimRecord>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as RawShimRecord;
      if (rec.ev === 'start') starts.set(rec.id, rec);
      else ends.set(rec.id, rec);
    } catch { /* a torn append; skip it */ }
  }
  const out: PhaseEvent[] = [];
  for (const [id, s] of starts) {
    const e = ends.get(id);
    out.push({
      kind: classifyPhase(s.cmd ?? '', s.argv ?? []),
      cmd: s.cmd ?? '',
      argv: s.argv ?? [],
      startMs: (s.startEpoch ?? t0Epoch) - t0Epoch,
      endMs: e?.endEpoch != null ? e.endEpoch - t0Epoch : null,
      exitCode: e?.exit ?? null,
      source: 'shim',
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Agent stream attribution
// ---------------------------------------------------------------------------

export interface StreamAttribution {
  model: Interval[];
  tool: Interval[];
}

/**
 * Split the agent's event stream into thinking and tool-execution intervals.
 *
 * Events are stamped on arrival at the harness, so "model" spans the wait from
 * the last thing we heard until the assistant message lands -- inference plus
 * generation plus network. "tool" spans from that message until every tool it
 * requested has reported back. Parallel tool calls close as a batch, since the
 * agent is blocked until the slowest one returns.
 */
export function attributeAgentStream(events: AgentEvent[], endMs: number): StreamAttribution {
  // An adapter that exposes no assistant events cannot tell us what the agent
  // was doing, and guessing is worse than admitting it. Without this guard a
  // wrapper with no stream -- or the floor control, which has no model at all --
  // has its entire run charged to "model thinking", which is exactly the
  // misattribution this harness exists to avoid. Returning nothing sends the
  // time to `residual`, where the coverage warning can flag it honestly.
  if (!events.some((e) => e.type === 'assistant')) return { model: [], tool: [] };

  const model: Interval[] = [];
  const tool: Interval[] = [];
  let cursor = 0;
  let pending = 0;
  let toolStart = 0;

  for (const e of events) {
    if (e.type === 'assistant') {
      if (pending === 0) {
        model.push({ start: cursor, end: e.tMs });
        cursor = e.tMs;
      }
      const uses = countToolUses(e);
      if (uses > 0) {
        if (pending === 0) toolStart = e.tMs;
        pending += uses;
      }
    } else if (e.type === 'tool_result' || (e.type === 'user' && pending > 0)) {
      pending = Math.max(0, pending - 1);
      if (pending === 0) {
        tool.push({ start: toolStart, end: e.tMs });
        cursor = e.tMs;
      }
    } else if (e.type === 'result') {
      if (pending === 0 && e.tMs > cursor) model.push({ start: cursor, end: e.tMs });
      cursor = e.tMs;
      pending = 0;
    }
  }
  // An unterminated tail means the run was cut off mid-turn; charge it to
  // whichever side was in flight rather than dropping it into the residual.
  if (pending > 0 && endMs > toolStart) tool.push({ start: toolStart, end: endMs });
  else if (endMs > cursor) model.push({ start: cursor, end: endMs });

  return { model: union(model), tool: union(tool) };
}

function countToolUses(e: AgentEvent): number {
  const msg = (e.raw as { message?: { content?: unknown } } | undefined)?.message;
  const content = msg?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((c) => (c as { type?: string })?.type === 'tool_use').length;
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

export interface DecomposeInput {
  wallMs: number;
  phases: PhaseEvent[];
  stream: StreamAttribution;
  /** First moment the dev server answered an HTTP request. */
  serverReadyMs: number | null;
  /** Time of the first frame showing anything. */
  firstPaintMs: number | null;
  reportedApiMs: number | null;
  /**
   * Whether the adapter exposed an event stream. Without one, model and tool
   * time are structurally unknowable and a large residual is expected rather
   * than a symptom of anything being wrong.
   */
  hasStream?: boolean;
}

/**
 * Assign every millisecond of wall clock to exactly one bucket.
 *
 * Buckets are resolved by priority, highest first, because the real intervals
 * genuinely nest: `npm install` runs inside a Bash tool call, which runs inside
 * the agent's turn. Priority order decides who gets charged for the overlap.
 *
 * The ordering that matters is first_paint last. The window between "server
 * answers" and "something renders" is usually time the agent spends writing the
 * app, and charging that to the toolchain would manufacture exactly the result
 * this harness exists to test. So first_paint only collects time that nothing
 * else claims: the server was up, the agent was idle, and the screen was still
 * empty. That is genuine toolchain-and-browser latency and nothing else.
 */
export function decompose(input: DecomposeInput): Decomposition {
  const notes: string[] = [];
  const end = input.wallMs;
  const clip = (iv: Interval[]): Interval[] =>
    union(iv.map((i) => ({ start: Math.max(0, i.start), end: Math.min(end, i.end === null ? end : i.end) })));

  const spanOf = (kinds: PhaseKind[]): Interval[] =>
    clip(
      input.phases
        .filter((p) => kinds.includes(p.kind))
        .map((p) => ({ start: p.startMs, end: p.endMs ?? end })),
    );

  const install = spanOf(['install', 'scaffold']);
  const build = spanOf(['build']);

  // A dev server's boot cost is the wait until it answers, not its lifetime.
  const devBoot: Interval[] = [];
  for (const p of input.phases.filter((x) => x.kind === 'devserver')) {
    if (input.serverReadyMs !== null && input.serverReadyMs > p.startMs) {
      devBoot.push({ start: p.startMs, end: Math.min(input.serverReadyMs, p.endMs ?? end) });
    }
  }

  const firstPaint: Interval[] =
    input.serverReadyMs !== null && input.firstPaintMs !== null && input.firstPaintMs > input.serverReadyMs
      ? [{ start: input.serverReadyMs, end: input.firstPaintMs }]
      : [];

  // Highest priority first. Each bucket keeps only what no higher bucket took.
  const ordered: Array<[Bucket, Interval[]]> = [
    ['install', install],
    ['build', build],
    ['devserver_boot', clip(devBoot)],
    ['model', clip(input.stream.model)],
    ['tool_overhead', clip(input.stream.tool)],
    ['first_paint', clip(firstPaint)],
  ];

  const buckets = {
    model: 0, tool_overhead: 0, install: 0, build: 0,
    devserver_boot: 0, first_paint: 0, residual: 0,
  } as Record<Bucket, number>;

  const taken: Interval[] = [];
  for (const [name, iv] of ordered) {
    const mine = subtract(iv, taken);
    buckets[name] = total(mine);
    taken.push(...mine);
  }
  const accounted = total(taken);
  buckets.residual = Math.max(0, end - accounted);

  const coverage = end > 0 ? accounted / end : 0;
  const hasStream = input.hasStream ?? input.stream.model.length + input.stream.tool.length > 0;
  if (coverage < 0.85) {
    notes.push(
      hasStream
        ? `Only ${(coverage * 100).toFixed(0)}% of wall clock is accounted for. The split below is not trustworthy; check whether the agent shelled out through a command the shims do not wrap.`
        : `Only ${(coverage * 100).toFixed(0)}% of wall clock is accounted for, because this adapter exposes no event stream: model and tool time cannot be separated and land in the residual. The toolchain phases below still come from the shims and are sound.`,
    );
  }
  if (input.serverReadyMs === null) notes.push('Dev server never answered; first_paint and devserver_boot are unmeasured.');
  if (!input.phases.some((p) => p.kind === 'install')) notes.push('No install phase observed (warm cache, vendored deps, or an unshimmed package manager).');

  const attributedModelMs = buckets.model;
  return {
    wallMs: end,
    buckets,
    coverage,
    crossCheck: {
      reportedApiMs: input.reportedApiMs,
      attributedModelMs,
      deltaMs: input.reportedApiMs === null ? null : attributedModelMs - input.reportedApiMs,
    },
    notes,
  };
}
