import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  union, subtract, total, classifyPhase, parsePhaseLog, attributeAgentStream, decompose,
} from '../src/decompose/attribute.js';
import type { AgentEvent, PhaseEvent } from '../src/types.js';

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
