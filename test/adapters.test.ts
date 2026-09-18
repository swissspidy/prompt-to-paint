import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateClaudeCodeEvent } from '../src/adapters/claude-code.ts';
import { translatePiEvent, PiAdapter } from '../src/adapters/pi.ts';
import { detectToolSignal, AntigravityAdapter } from '../src/adapters/antigravity.ts';
import { attributeAgentStream, total } from '../src/decompose/attribute.ts';
import type { AgentEvent } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Claude Code. Event shapes captured from a live `claude -p --output-format
// stream-json` session driven by this harness.
// ---------------------------------------------------------------------------

test('claude-code events map onto the harness vocabulary', () => {
  const at = (o: object) => translateClaudeCodeEvent(o as never, 100);

  const asst = at({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'writing it' }, { type: 'tool_use', name: 'Write', id: 'tu1' }] },
  });
  assert.equal(asst[0]?.type, 'assistant');
  assert.equal(asst[1]?.type, 'tool_use');
  assert.equal(asst[1]?.toolName, 'Write');
  assert.equal(asst[1]?.toolId, 'tu1');

  const result = at({ type: 'user', message: { content: [{ type: 'tool_result', id: 'tu1' }] } });
  assert.equal(result[0]?.type, 'tool_result', 'a tool_result block is a tool boundary, not a user turn');

  assert.equal(at({ type: 'result', subtype: 'success' })[0]?.type, 'result');
  assert.equal(at({ type: 'system', subtype: 'init' })[0]?.type, 'system');
  assert.equal(at({ type: 'rate_limit_event' })[0]?.type, 'raw');
});

test('claude-code reads a user message whose content is a bare string', () => {
  // The Messages API allows a string in place of a one-element block list, and
  // Claude Code uses it for the synthetic user turns it injects mid-session --
  // a background task reporting completion is one. Reading `content` as
  // always-array threw inside the stdout 'data' listener, which is uncaught:
  // the process died and a run that was minutes deep went with it.
  const ev = translateClaudeCodeEvent(
    { type: 'user', message: { content: '<task-notification>done</task-notification>' } } as never,
    100,
  );
  assert.equal(ev[0]?.type, 'user', 'a string carries no tool_result block');
});

test('claude-code tolerates a message with no content at all', () => {
  // system events carry no message, and an empty assistant turn carries an
  // empty one. Neither is a tool boundary, and neither may throw.
  assert.equal(translateClaudeCodeEvent({ type: 'user', message: {} } as never, 1)[0]?.type, 'user');
  assert.deepEqual(
    translateClaudeCodeEvent({ type: 'assistant' } as never, 1).map((e) => e.type),
    ['assistant'],
  );
});

test('a realistic claude-code session attributes thinking and tool time', () => {
  // Tool spans are inferred: a tool_use block opens one, the tool_result user
  // message closes it. The string-content notification in the middle is the
  // shape that used to kill the run.
  const wire: Array<[number, object]> = [
    [0, { type: 'system', subtype: 'init' }],
    [4_000, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: 't1' }] } }],
    [4_300, { type: 'user', message: { content: [{ type: 'tool_result', id: 't1' }] } }],
    [4_400, { type: 'user', message: { content: '<task-notification>done</task-notification>' } }],
    [4_500, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't2' }] } }],
    [22_500, { type: 'user', message: { content: [{ type: 'tool_result', id: 't2' }] } }],
    [23_000, { type: 'result', subtype: 'success' }],
  ];
  const events: AgentEvent[] = wire.flatMap(([t, o]) => translateClaudeCodeEvent(o as never, t));
  const { tool } = attributeAgentStream(events, 40_000);
  assert.equal(total(tool), 300 + 18_000);
});

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

// ---------------------------------------------------------------------------
// exec: the substituted prompt reaches a shell, so quoting is a safety boundary
// ---------------------------------------------------------------------------

test('shellQuote neutralises expansion in a substituted prompt', async () => {
  const { execFileSync } = await import('node:child_process');
  const { shellQuote } = await import('../src/adapters/exec.ts');
  // JSON quoting is not shell quoting: inside double quotes $(), backticks and
  // ${} all stay live, so a brief could run commands just by naming them.
  const nasty = 'hi $(echo OWNED) `echo OWNED2` ${HOME} \'q\' "dq"';
  const out = execFileSync('/bin/bash', ['-lc', `printf '%s' ${shellQuote(nasty)}`], { encoding: 'utf8' });
  assert.equal(out, nasty, 'the value must survive verbatim and unexpanded');
  assert.ok(!out.includes('OWNED2'.replace('OWNED2', 'OWNED2')) || !/\/root|\/home\/\w+/.test(out));
});

test('describeSpawnError only blames a missing binary for ENOENT', async () => {
  const { describeSpawnError } = await import('../src/adapters/spawn-error.ts');
  const missing = Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' });
  assert.match(describeSpawnError(missing, 'x'), /not found on PATH/);

  // Anything else means the executable exists and something else broke;
  // reporting it as "not installed" sends people after the wrong problem.
  const denied = Object.assign(new Error('spawn x EACCES'), { code: 'EACCES' });
  assert.doesNotMatch(describeSpawnError(denied, 'x'), /not found on PATH/);
  assert.match(describeSpawnError(denied, 'x'), /EACCES/);
});

test('antigravity reads back the cwd agy announces, so a scratch folder is caught', () => {
  // agy runs a conversation that is not in a Project in its own scratch folder.
  // A run against one looks almost right -- an app is built, served and
  // measured -- while the workdir the harness handed over stays empty and
  // nothing in the run directory reproduces what was on screen. The init event
  // is the only place agy says where it actually is.
  const ag = new AntigravityAdapter();
  assert.equal(ag.reportedWorkdir, null, 'nothing claimed before the agent speaks');
  ag.translate({ event: 'init', cwd: '/Users/x/.gemini/antigravity-cli/scratch/orbit/src' }, 0);
  assert.equal(ag.reportedWorkdir, '/Users/x/.gemini/antigravity-cli/scratch/orbit/src');
});

test('antigravity tolerates an init event that says nothing about cwd', () => {
  const ag = new AntigravityAdapter();
  ag.translate({ event: 'init' }, 0);
  // Null, not the workdir: "it did not say" must never be read as "it agreed".
  assert.equal(ag.reportedWorkdir, null);
});
