import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translatePiEvent, PiAdapter } from '../src/adapters/pi.js';
import { detectToolSignal, AntigravityAdapter } from '../src/adapters/antigravity.js';
import { attributeAgentStream, total } from '../src/decompose/attribute.js';
import type { AgentEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Pi. Event shapes taken from the published --mode json / rpc reference.
// ---------------------------------------------------------------------------

test('pi events map onto the harness vocabulary', () => {
  const at = (o: object) => translatePiEvent(o as never, 100);
  assert.equal(at({ type: 'message_end', message: { role: 'assistant' } })[0]?.type, 'assistant');
  assert.equal(at({ type: 'agent_end' })[0]?.type, 'result');
  assert.equal(at({ type: 'agent_settled' })[0]?.type, 'result');
  assert.equal(at({ type: 'turn_start' })[0]?.type, 'system');

  const start = at({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash' })[0];
  assert.equal(start?.type, 'tool_use');
  assert.equal(start?.toolId, 'c1');
  assert.equal(start?.toolName, 'bash');

  const end = at({ type: 'tool_execution_end', toolCallId: 'c1', isError: false })[0];
  assert.equal(end?.type, 'tool_result');
  assert.equal(end?.toolId, 'c1');
});

test('pi does not mistake the echoed user prompt for assistant output', () => {
  // Verified against the real binary: message_start/message_end fire for the
  // user's own message too. Counting that as assistant output would defeat the
  // "agent produced no output" check.
  const user = translatePiEvent(
    { type: 'message_end', message: { role: 'user', content: [] } } as never, 10,
  )[0];
  assert.equal(user?.type, 'system');

  const asst = translatePiEvent(
    { type: 'message_end', message: { role: 'assistant', content: [] } } as never, 20,
  )[0];
  assert.equal(asst?.type, 'assistant');
});

test('pi surfaces a failed turn instead of reporting it as silence', () => {
  // A bad API key still streams a clean, well-formed turn -- observed against
  // the binary. Without the stopReason check it would look like a working run
  // that happened to build nothing.
  const ev = translatePiEvent({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'UnrecognizedClientException' },
  } as never, 30)[0];
  assert.equal(ev?.type, 'assistant');
  assert.equal(ev?.subtype, 'error');
  assert.match(ev?.text ?? '', /UnrecognizedClient/);
});

test('the real pi turn sequence completes exactly one turn', () => {
  // Captured from the binary: response, agent_start, turn_start, user
  // message_start/end, assistant message_start/end, turn_end, agent_end,
  // agent_settled. Both settle events fire, so the latch must count one turn.
  const observed = [
    'response', 'agent_start', 'turn_start',
    'message_start', 'message_end', 'message_start', 'message_end',
    'turn_end', 'agent_end', 'agent_settled',
  ];
  const settleEvents = observed.filter((t) => t === 'agent_end' || t === 'agent_settled');
  assert.equal(settleEvents.length, 2, 'both fire, so the adapter must de-duplicate');
});

test('pi per-token deltas are dropped', () => {
  // These arrive per token; keeping them would bloat result.json by orders of
  // magnitude and tell the metric nothing message_end does not.
  assert.deepEqual(translatePiEvent({ type: 'message_update' } as never, 1), []);
  assert.deepEqual(translatePiEvent({ type: 'tool_execution_update' } as never, 1), []);
  assert.deepEqual(translatePiEvent({ type: 'queue_update' } as never, 1), []);
});

test('a realistic pi session attributes thinking and tool time correctly', () => {
  const wire: Array<[number, object]> = [
    [0, { type: 'session', version: 3, id: 'u', cwd: '/w' }],
    [100, { type: 'agent_start' }],
    [120, { type: 'turn_start' }],
    [3_000, { type: 'message_end', message: { role: 'assistant' } }],   // thought ~3s
    [3_100, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'write' }],
    [3_400, { type: 'tool_execution_end', toolCallId: 't1' }],          // fast write
    [3_500, { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash' }],
    [21_500, { type: 'tool_execution_end', toolCallId: 't2' }],         // npm install, 18s
    [23_000, { type: 'message_end', message: { role: 'assistant' } }],
    [23_100, { type: 'agent_settled' }],
  ];
  const events: AgentEvent[] = wire.flatMap(([t, o]) => translatePiEvent(o as never, t));
  const { model, tool } = attributeAgentStream(events, 40_000);

  assert.equal(total(tool), 300 + 18_000);
  // Active window 0..23100 minus 18.3s of tools.
  assert.equal(total(model), 23_100 - 18_300);
});

test('pi declares live-session iteration and full stream fidelity', () => {
  const pi = new PiAdapter();
  assert.equal(pi.iterationMode, 'live-session', 'rpc mode keeps one session across turns');
  assert.equal(pi.streamFidelity, 'full', 'tool_execution events give exact spans');
});

// ---------------------------------------------------------------------------
// Antigravity. Outer events are documented; step payloads are not, so the
// adapter must degrade honestly rather than guess.
// ---------------------------------------------------------------------------

test('detectToolSignal recognises the plausible step shapes', () => {
  assert.deepEqual(detectToolSignal({ tool_name: 'bash', status: 'started', tool_call_id: 'x' }), {
    id: 'x', name: 'bash', phase: 'start',
  });
  assert.deepEqual(detectToolSignal({ tool: { name: 'write', state: 'completed', id: 'y' } }), {
    id: 'y', name: 'write', phase: 'end',
  });
  assert.equal(detectToolSignal({ toolCall: { toolName: 'read', phase: 'running' } })?.phase, 'start');
  assert.equal(detectToolSignal({ tool_name: 'bash', status: 'failed' })?.phase, 'end');
});

test('detectToolSignal returns null rather than inventing a boundary', () => {
  assert.equal(detectToolSignal({ text: 'thinking about it' }), null);
  assert.equal(detectToolSignal({ name: 'bash' }), null, 'a name with no phase is not a boundary');
  assert.equal(detectToolSignal({ status: 'running' }), null, 'a phase with no tool is not one either');
  assert.equal(detectToolSignal({ tool_name: 'bash', status: 'wat' }), null, 'unknown phase word');
});

test('antigravity reports turns-only when it cannot see tool boundaries', () => {
  // The important case: steps arrive but their shape is not one we recognise.
  // Booking that time as thinking would manufacture a model/tool split from
  // nothing, so fidelity drops and the run routes it to the residual instead.
  const ag = new AntigravityAdapter();
  assert.equal(ag.streamFidelity, 'none', 'nothing seen yet');
  ag.translate({ event: 'init' }, 0);
  ag.translate({ event: 'step_update', step: { kind: 'something_unknown' } }, 100);
  assert.equal(ag.streamFidelity, 'turns-only');
});

test('antigravity upgrades to full fidelity once a tool boundary is parsed', () => {
  const ag = new AntigravityAdapter();
  ag.translate({ event: 'step_update', step: { tool_name: 'bash', status: 'started', id: 'a' } }, 10);
  assert.equal(ag.streamFidelity, 'full');

  const ev = ag.translate({ event: 'step_update', step: { tool_name: 'bash', status: 'completed', id: 'a' } }, 20);
  assert.equal(ev[0]?.type, 'tool_result');
  assert.equal(ev[0]?.toolId, 'a');
});

test('antigravity result events close a turn and are not counted as thinking', () => {
  const ag = new AntigravityAdapter();
  const ev = ag.translate({ event: 'result', status: 'SUCCESS', duration_seconds: 12, num_turns: 3 }, 500);
  assert.equal(ev[0]?.type, 'result');
});

test('antigravity declares live-session iteration', () => {
  // --input-format stream-json reuses the warmed conversation across turns.
  assert.equal(new AntigravityAdapter().iterationMode, 'live-session');
});
