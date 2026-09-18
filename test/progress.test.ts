import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, describeEvent, clock, Progress } from '../src/progress.ts';
import { protocolSuffix, DONE_SENTINEL } from '../src/run.ts';
import type { Frame } from '../src/types.ts';

const frame = (over: Partial<Frame> = {}): Frame => ({
  index: 0, tMs: 0, class: 'render', reason: '', screenshotPath: 'frames/f0.png',
  dhash: 'a', colorSig: 'b', inkRatio: 0.2, text: '', title: '', favicon: null, tabSignal: false,
  httpStatus: 200,
  consoleErrors: [], entityCoverage: 0.5, entitiesFound: [], domSignature: 'x', captureMs: 5,
  ...over,
});

const base = {
  elapsedMs: 65_000, frame: frame(), frames: 65, shots: 4,
  activity: 'tool: Write', silentForMs: null, horizonMs: 480_000,
};

test('clock renders mm:ss, because runs are minutes long', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(65_000), '01:05');
  assert.equal(clock(600_000), '10:00');
});

test('the status line carries state, progress and the horizon', () => {
  const l = statusLine(base, 120);
  assert.match(l, /01:05\/08:00/);
  assert.match(l, /rendering/);
  assert.match(l, /50% of brief on screen/);
  assert.match(l, /65 frames \/ 4 distinct/);
  assert.match(l, /tool: Write/);
});

test('the status line never exceeds the terminal width', () => {
  const wide = { ...base, activity: 'tool: Write '.repeat(40) };
  for (const w of [40, 60, 100, 200]) assert.ok(statusLine(wide, w).length <= w, `width ${w}`);
});

test('a silent agent is reported as silent, not as still working', () => {
  // "agent: working" from four minutes ago is the single most misleading thing
  // a progress line can say: it is exactly when someone needs to know the run
  // may be wedged.
  assert.doesNotMatch(statusLine({ ...base, silentForMs: 2000 }, 120), /ago/);
  assert.match(statusLine({ ...base, silentForMs: 240_000 }, 120), /\(04:00 ago\)/);
});

test('a run with nothing listening yet says so rather than showing nothing', () => {
  const l = statusLine({ ...base, frame: null }, 120);
  assert.match(l, /no server/);
  assert.match(l, /0% of brief on screen/);
});

test('describeEvent prefers the tool name, which says where a run is', () => {
  assert.equal(describeEvent({ tMs: 0, type: 'tool_use', toolName: 'Write' }), 'tool: Write');
  assert.equal(describeEvent({ tMs: 0, type: 'tool_result' }), null);
  assert.equal(describeEvent({ tMs: 0, type: 'assistant', text: 'ok' }), 'agent: ok');
  assert.match(String(describeEvent({ tMs: 0, type: 'assistant', subtype: 'error', text: 'boom' })), /error/);
});

test('off a TTY, progress degrades to periodic lines rather than carriage returns', () => {
  const out: string[] = [];
  let now = 0;
  const p = new Progress(60_000, { tty: false, quietLogMs: 10_000, write: (s) => out.push(s), now: () => now, columns: () => 100 });
  p.start();
  for (let i = 0; i < 30; i++) {
    now += 1000;
    p.onFrame(frame({ tMs: now }));
  }
  assert.ok(out.length >= 2 && out.length <= 4, `expected a handful of lines, got ${out.length}`);
  assert.ok(out.every((l) => l.endsWith('\n') && !l.includes('\r')), 'no carriage returns off a TTY');
});

test('distinct screenshots are counted by file, so repeats do not inflate the count', () => {
  const out: string[] = [];
  let now = 0;
  const p = new Progress(60_000, { tty: false, quietLogMs: 0, write: (s) => out.push(s), now: () => now, columns: () => 100 });
  for (const path of ['a.png', 'a.png', 'a.png', 'b.png', 'b.png']) {
    now += 1000;
    p.onFrame(frame({ screenshotPath: path }));
  }
  assert.match(out.at(-1)!, /5 frames \/ 2 distinct/);
});

test('the protocol tells every agent the clock is running and how to stop it', () => {
  const s = protocolSuffix('http://127.0.0.1:5173/');
  assert.match(s, /http:\/\/127\.0\.0\.1:5173\//);
  assert.match(s, /screenshots it every second/);
  assert.match(s, /as early as you can/);
  assert.match(s, /in the background/);
  assert.ok(s.includes(DONE_SENTINEL), 'names the done sentinel');
});

test('the early-render clause can be dropped without losing the mechanics', () => {
  // Measuring unprompted behaviour is a legitimate different experiment, but
  // an agent still has to know where to serve and how to end the run.
  const s = protocolSuffix('http://127.0.0.1:5173/', { renderEarly: false });
  assert.doesNotMatch(s, /as early as you can/);
  assert.match(s, /in the background/);
  assert.ok(s.includes(DONE_SENTINEL));
});
