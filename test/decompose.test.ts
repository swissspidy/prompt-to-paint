import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  union, subtract, total, classifyPhase, parsePhaseLog, attributeAgentStream, decompose,
} from '../src/decompose/attribute.ts';
import { iterationWork } from '../src/run.ts';
import type { AgentEvent, PhaseEvent, PhaseKind } from '../src/types.ts';

test('union merges overlapping and touching intervals', () => {
  assert.deepEqual(union([{ start: 0, end: 10 }, { start: 5, end: 20 }]), [{ start: 0, end: 20 }]);
  assert.deepEqual(union([{ start: 0, end: 10 }, { start: 10, end: 20 }]), [{ start: 0, end: 20 }]);
  assert.deepEqual(union([{ start: 0, end: 5 }, { start: 9, end: 20 }]).length, 2);
});

test('subtract punches holes, including a hole in the middle', () => {
  assert.deepEqual(
    subtract([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]),
    [{ start: 0, end: 40 }, { start: 60, end: 100 }],
  );
  assert.deepEqual(subtract([{ start: 0, end: 100 }], [{ start: 0, end: 100 }]), []);
  assert.equal(total(subtract([{ start: 0, end: 100 }], [{ start: 90, end: 200 }])), 90);
});

test('classifyPhase separates install, build, dev server and scaffold', () => {
  assert.equal(classifyPhase('npm', ['install']), 'install');
  assert.equal(classifyPhase('npm', ['ci']), 'install');
  assert.equal(classifyPhase('npm', ['install', '--save-dev', 'vite']), 'install');
  assert.equal(classifyPhase('pnpm', ['add', 'react']), 'install');
  assert.equal(classifyPhase('yarn', []), 'install');
  assert.equal(classifyPhase('npm', ['run', 'build']), 'build');
  assert.equal(classifyPhase('vite', ['build']), 'build');
  assert.equal(classifyPhase('tsc', ['-p', '.']), 'build');
  assert.equal(classifyPhase('tsc', ['--watch']), 'devserver');
  assert.equal(classifyPhase('npm', ['run', 'dev']), 'devserver');
  assert.equal(classifyPhase('vite', []), 'devserver');
  assert.equal(classifyPhase('next', ['dev']), 'devserver');
  assert.equal(classifyPhase('npm', ['create', 'vite@latest', 'app']), 'scaffold');
  assert.equal(classifyPhase('npx', ['create-react-app', 'app']), 'scaffold');
  assert.equal(classifyPhase('npm', ['run', 'test']), 'test');
});

test('parsePhaseLog pairs start and end records and tolerates torn lines', () => {
  const t0 = 1000;
  const log = [
    JSON.stringify({ ev: 'start', id: 'a', cmd: 'npm', argv: ['install'], startEpoch: 2000 }),
    '{ this line is garbage',
    JSON.stringify({ ev: 'end', id: 'a', endEpoch: 5000, exit: 0 }),
    JSON.stringify({ ev: 'start', id: 'b', cmd: 'vite', argv: [], startEpoch: 6000 }),
  ].join('\n');
  const phases = parsePhaseLog(log, t0);
  assert.equal(phases.length, 2);
  assert.deepEqual(
    phases.map((p) => [p.kind, p.startMs, p.endMs]),
    [['install', 1000, 4000], ['devserver', 5000, null]],
  );
});

function assistant(tMs: number, toolUses = 0): AgentEvent {
  return {
    tMs, type: 'assistant',
    raw: { message: { content: Array.from({ length: toolUses }, () => ({ type: 'tool_use' })) } },
  };
}

test('stream attribution splits thinking from tool execution', () => {
  const events: AgentEvent[] = [
    { tMs: 0, type: 'system', subtype: 'init' },
    assistant(2000, 1),            // thought for 2s, then called a tool
    { tMs: 9000, type: 'tool_result' }, // tool took 7s
    assistant(11000, 0),           // thought for 2s, no tool
    { tMs: 11500, type: 'result' },
  ];
  const { model, tool } = attributeAgentStream(events, 11500);
  assert.equal(total(model), 2000 + 2000 + 500);
  assert.equal(total(tool), 7000);
});

test('parallel tool calls close as one batch, not one interval each', () => {
  const events: AgentEvent[] = [
    assistant(1000, 3),
    { tMs: 2000, type: 'tool_result' },
    { tMs: 3000, type: 'tool_result' },
    { tMs: 8000, type: 'tool_result' }, // agent is blocked until the slowest
    { tMs: 8000, type: 'result' },
  ];
  const { tool } = attributeAgentStream(events, 8000);
  assert.equal(total(tool), 7000, 'one 7s batch, not 1+1+5 counted separately');
});

const phase = (kind: string, startMs: number, endMs: number | null): PhaseEvent => ({
  kind: kind as PhaseEvent['kind'], cmd: kind, argv: [], startMs, endMs, exitCode: 0, source: 'shim',
});

test('install nested inside a tool call is charged to install, not tool overhead', () => {
  const d = decompose({
    wallMs: 100_000,
    phases: [phase('install', 10_000, 40_000)],
    // The Bash tool call wrapping that install ran slightly longer.
    stream: { model: [{ start: 0, end: 9_000 }], tool: [{ start: 9_000, end: 41_000 }] },
    serverReadyMs: null,
    firstPaintMs: null,
    reportedApiMs: null,
  });
  assert.equal(d.buckets.install, 30_000);
  assert.equal(d.buckets.tool_overhead, 2_000, 'only the non-install part of the tool call');
  assert.equal(d.buckets.model, 9_000);
  assert.equal(d.buckets.residual, 59_000);
});

test('agent work between server-up and first paint is model time, not toolchain', () => {
  // This is the ordering that protects the headline finding: if first_paint
  // outranked model here it would swallow 30s of the agent writing code and
  // report it as toolchain latency.
  const d = decompose({
    wallMs: 60_000,
    phases: [],
    stream: { model: [{ start: 10_000, end: 40_000 }], tool: [] },
    serverReadyMs: 10_000,
    firstPaintMs: 50_000,
    reportedApiMs: null,
  });
  assert.equal(d.buckets.model, 30_000);
  assert.equal(d.buckets.first_paint, 10_000, 'only the genuinely idle window [40s,50s]');
});

test('coverage collapses and says so when the agent shells out unshimmed', () => {
  const d = decompose({
    wallMs: 100_000,
    phases: [],
    stream: { model: [{ start: 0, end: 5_000 }], tool: [] },
    serverReadyMs: null, firstPaintMs: null, reportedApiMs: null,
  });
  assert.equal(d.buckets.residual, 95_000);
  assert.ok(d.coverage < 0.1);
  assert.ok(d.notes.some((n) => n.includes('not trustworthy')));
});

test('cross-check surfaces disagreement with the agent self-reported API time', () => {
  const d = decompose({
    wallMs: 20_000,
    phases: [],
    stream: { model: [{ start: 0, end: 12_000 }], tool: [] },
    serverReadyMs: null, firstPaintMs: null,
    reportedApiMs: 9_000,
  });
  assert.equal(d.crossCheck.deltaMs, 3_000);
});

test('an adapter with no event stream attributes nothing to the model', () => {
  // The floor control has no model at all, and a bare command wrapper exposes
  // no stream. Charging their wall clock to "model thinking" would invent the
  // exact finding this harness is built to test.
  const { model, tool } = attributeAgentStream([{ tMs: 245_000, type: 'result' }], 245_000);
  assert.equal(total(model), 0);
  assert.equal(total(tool), 0);

  const d = decompose({
    wallMs: 245_000,
    phases: [],
    stream: { model, tool },
    serverReadyMs: null, firstPaintMs: null, reportedApiMs: null,
  });
  assert.equal(d.buckets.model, 0);
  assert.equal(d.buckets.residual, 245_000, 'unknown time is unaccounted, not attributed');
});

test('a missing event stream is explained, not blamed on the shims', () => {
  const noStream = decompose({
    wallMs: 100_000, phases: [phase('install', 0, 50_000)],
    stream: { model: [], tool: [] }, hasStream: false,
    serverReadyMs: null, firstPaintMs: null, reportedApiMs: null,
  });
  assert.ok(noStream.notes.some((n) => n.includes('exposes no event stream')));
  assert.ok(noStream.notes.some((n) => n.includes('still come from the shims')));

  const withStream = decompose({
    wallMs: 100_000, phases: [],
    stream: { model: [{ start: 0, end: 5_000 }], tool: [] }, hasStream: true,
    serverReadyMs: null, firstPaintMs: null, reportedApiMs: null,
  });
  assert.ok(withStream.notes.some((n) => n.includes('shims do not wrap')));
});

test('iteration mode defaults to restart, so a cold re-run is never read as a live edit', async () => {
  // Claiming live-session timings for a cold restart would understate an
  // agent's real edit latency by however long it takes to boot and re-read the
  // project, with nothing in the output to reveal it.
  const { ExecAdapter } = await import('../src/adapters/exec.ts');
  const { ClaudeCodeAdapter } = await import('../src/adapters/claude-code.ts');
  const { ScriptedAdapter } = await import('../src/adapters/scripted.ts');

  assert.equal(new ExecAdapter({ command: 'x' }).iterationMode, 'restart');
  assert.equal(new ClaudeCodeAdapter().iterationMode, 'live-session');
  assert.equal(new ScriptedAdapter({ steps: [] }).iterationMode, 'live-session');

  // Opt in only when the command genuinely resumes.
  assert.equal(
    new ExecAdapter({ command: 'x', iterationCommand: 'x --resume', iterationMode: 'live-session' })
      .iterationMode,
    'live-session',
  );
});

test('explicit tool spans are used when an agent reports them', () => {
  // Pi reports tool_execution_start/end keyed by id, which beats inferring
  // spans from message boundaries: overlapping tools need no guessing.
  const events: AgentEvent[] = [
    { tMs: 1_000, type: 'assistant' },
    { tMs: 2_000, type: 'tool_use', toolId: 'a', toolName: 'bash' },
    { tMs: 2_500, type: 'tool_use', toolId: 'b', toolName: 'read' },
    { tMs: 4_000, type: 'tool_result', toolId: 'b' },
    { tMs: 9_000, type: 'tool_result', toolId: 'a' },
    { tMs: 10_000, type: 'assistant' },
  ];
  const { model, tool } = attributeAgentStream(events, 20_000);
  // Overlapping spans [2s,9s] and [2.5s,4s] union to 7s, not 8.5s.
  assert.equal(total(tool), 7_000);
  // Active window is 1s..10s; the rest of it is thinking.
  assert.equal(total(model), 2_000);
});

test('explicit attribution ignores time outside the agent active window', () => {
  // Startup before the first event and harness idle after the last must not be
  // charged to the model.
  const events: AgentEvent[] = [
    { tMs: 30_000, type: 'assistant' },
    { tMs: 31_000, type: 'tool_use', toolId: 'x' },
    { tMs: 33_000, type: 'tool_result', toolId: 'x' },
  ];
  const { model, tool } = attributeAgentStream(events, 120_000);
  assert.equal(total(tool), 2_000);
  assert.equal(total(model), 1_000, 'not 30s of startup, not 87s of trailing idle');
});

test('an unclosed tool span runs to the end of the run', () => {
  const events: AgentEvent[] = [
    { tMs: 1_000, type: 'tool_use', toolId: 'a' },
    { tMs: 2_000, type: 'tool_result', toolId: 'a' },
    { tMs: 3_000, type: 'tool_use', toolId: 'b' }, // killed mid-flight
  ];
  const { tool } = attributeAgentStream(events, 10_000);
  assert.equal(total(tool), 1_000 + 7_000);
});

// ---------------------------------------------------------------------------
// Iteration attribution: whose time was an edit's latency?
// ---------------------------------------------------------------------------

const ev = (tMs: number, type: AgentEvent['type'], over: Partial<AgentEvent> = {}): AgentEvent =>
  ({ tMs, type, ...over });

const shimPhase = (kind: PhaseKind, startMs: number, endMs: number | null, cmd = 'npm'): PhaseEvent =>
  ({ kind, cmd, argv: ['run', 'build'], startMs, endMs, exitCode: 0, source: 'shim' });

test('an edit reports the tool calls it took, scoped to its own window', () => {
  const events = [
    ev(1000, 'tool_use', { toolId: 'a', toolName: 'Read' }),   // before the prompt
    ev(1500, 'tool_result', { toolId: 'a', toolName: 'Read' }),
    ev(5200, 'tool_use', { toolId: 'b', toolName: 'Edit' }),
    ev(5900, 'tool_result', { toolId: 'b', toolName: 'Edit' }),
    ev(6100, 'tool_use', { toolId: 'c', toolName: 'Bash' }),
    ev(6400, 'tool_result', { toolId: 'c', toolName: 'Bash' }),
    ev(99_000, 'tool_use', { toolId: 'd', toolName: 'Write' }), // after the window
  ];
  const w = iterationWork(events, [], { from: 5000, to: 9000, fidelity: 'full' });
  assert.equal(w.toolCalls, 2, 'only the calls inside this edit');
  assert.deepEqual(w.toolNames, ['Edit', 'Bash']);
});

test('an adapter that cannot see tool boundaries reports unknown, never zero', () => {
  // "It made no tool calls" and "we could not tell" are opposite claims about
  // an agent, and a report that renders both as 0 is worse than one that omits
  // the column.
  const events = [ev(5200, 'assistant', { text: 'ok' })];
  const w = iterationWork(events, [], { from: 5000, to: 9000, fidelity: 'turns-only' });
  assert.equal(w.toolCalls, null);
  assert.equal(w.modelMs, null);
  assert.equal(w.toolMs, null);
});

test('a rebuild straddling the end of an edit still counts against it', () => {
  // The case this exists for: one tool call, then eleven seconds of Vite. The
  // wall clock is the same as nine tool calls of flailing, and only this tells
  // them apart.
  const w = iterationWork([], [
    shimPhase('devserver', 0, null),       // started long before; not this edit's cost
    shimPhase('build', 6000, 17_000),      // straddles the window end: it is
  ], { from: 5000, to: 9000, fidelity: 'full' });
  assert.deepEqual(w.phases.map((p) => p.kind), ['devserver', 'build']);
  assert.equal(w.phases[1]?.ms, 11_000);
});

test('a phase that finished before the prompt is not charged to the edit', () => {
  const w = iterationWork([], [shimPhase('install', 0, 4000)], { from: 5000, to: 9000, fidelity: 'full' });
  assert.deepEqual(w.phases, []);
});

test('tool calls are counted whichever way an adapter expresses them', () => {
  // Some adapters emit a tool_use event per call; others put tool_use blocks
  // inside the assistant message. The count has to follow the same preference
  // order the attribution does, or the two halves of one row disagree.
  const inferred = [
    ev(5100, 'assistant', { raw: { message: { content: [{ type: 'tool_use' }, { type: 'tool_use' }] } } }),
    ev(5800, 'tool_result'),
  ];
  assert.equal(iterationWork(inferred, [], { from: 5000, to: 9000, fidelity: 'full' }).toolCalls, 2);

  // An agent that genuinely did nothing is 0, and stays distinct from null.
  const silent = [ev(5100, 'assistant', { text: 'already done' })];
  assert.equal(iterationWork(silent, [], { from: 5000, to: 9000, fidelity: 'full' }).toolCalls, 0);
  assert.equal(iterationWork(silent, [], { from: 5000, to: 9000, fidelity: 'none' }).toolCalls, null);
});

test('an edit can never be attributed more time than it lasted', () => {
  // attributeAgentStream measures a whole run: on its inference path the model
  // cursor starts at t0, so a slice of events came back with a thinking
  // interval that began when the run began. A seven-second edit reported
  // twelve seconds of thinking -- not merely wrong but impossible, which is how
  // a split stops being believed.
  const events = [
    ev(1000, 'assistant', { text: 'cold start work' }),
    ev(12_417, 'assistant', { raw: { message: { content: [{ type: 'tool_use' }] } } }),
    ev(12_418, 'tool_result'),
  ];
  const from = 5416;
  const to = 12_605;
  const w = iterationWork(events, [], { from, to, fidelity: 'full' });
  assert.ok(w.modelMs !== null && w.toolMs !== null);
  assert.ok(w.modelMs <= to - from, `thinking ${w.modelMs}ms must fit in a ${to - from}ms window`);
  assert.ok(w.modelMs + w.toolMs <= to - from, 'and so must the two together');
  // The honest answer: the prompt landed at `from` and the agent's first act in
  // this window was at 12417, so that gap is thinking nobody emitted an event
  // for. Charging it from t0 instead is what produced the impossible number.
  assert.equal(w.modelMs, 12_417 - from);
  // And the 187ms between the agent's last event and the end of the window is
  // the page catching up, not the agent thinking. afterAgentMs reports it.
  assert.equal(w.modelMs + w.toolMs, 12_418 - from);
});
