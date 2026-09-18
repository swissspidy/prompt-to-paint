import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { killPort, listenersOn } from '../src/port.ts';
import { sleep } from '../src/sleep.ts';

/** A port high enough that nothing else in CI is plausibly on it. */
const PORT = 5391;

const listener = (port: number): ReturnType<typeof spawn> =>
  spawn(
    process.execPath,
    ['-e', `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('up'))`],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

/** Nothing here can be asserted where no tool can see a listening socket. */
async function noLookupTool(): Promise<boolean> {
  return !(await listenersOn(PORT)).probed;
}

test('killPort kills the listener and spares this process, which is only a client', async (t) => {
  if (await noLookupTool()) return t.skip('no lsof, ss or fuser here');
  const child = listener(PORT);
  await once(child.stdout!, 'data');

  // This is the whole bug. `lsof -i tcp:PORT` matches sockets with that number
  // at either end, so the harness -- which polls the app under test once a
  // second and therefore always has a client socket open to it -- appeared in
  // its own kill list and SIGKILLed itself during teardown. The run died after
  // its last measured frame, losing result.json, the judging pass and the
  // report, leaving a frames/ directory nothing could read.
  await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.arrayBuffer());

  const found = await listenersOn(PORT);
  assert.deepEqual(found.pids, [child.pid], 'only the listening process is a target');
  assert.ok(!found.pids.includes(process.pid), 'a client of the port is never a target');

  const res = await killPort(PORT);
  assert.deepEqual(res.killed, [child.pid]);
  assert.deepEqual(res.survivors, []);
  // Reaching this line at all is the other half of the assertion: the process
  // running it had a live socket to the port that was just cleared.
  assert.equal(typeof process.pid, 'number');
  // killPort does not return until its targets are gone, so this is settled by
  // now; waiting on 'exit' here would wait for an event already fired.
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'the listener is gone');
});

test('killPort on an empty port does nothing and says it looked', async (t) => {
  if (await noLookupTool()) return t.skip('no lsof, ss or fuser here');
  const res = await killPort(PORT + 1);
  assert.deepEqual(res.killed, []);
  assert.deepEqual(res.survivors, []);
  assert.deepEqual(res.skippedSelf, []);
  assert.equal(res.probed, true, 'an empty answer from a tool that ran is still an answer');
});

test('a port is free again once its listener has been killed', async (t) => {
  if (await noLookupTool()) return t.skip('no lsof, ss or fuser here');
  const child = listener(PORT + 2);
  await once(child.stdout!, 'data');
  await killPort(PORT + 2);
  await sleep(200);
  let stillServing = true;
  try {
    await fetch(`http://127.0.0.1:${PORT + 2}/`, { signal: AbortSignal.timeout(800) });
  } catch {
    stillServing = false;
  }
  assert.equal(stillServing, false);
});
