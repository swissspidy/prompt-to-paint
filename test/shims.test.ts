import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupShims, withShimPath } from '../src/decompose/shims.js';
import { parsePhaseLog } from '../src/decompose/attribute.js';

test('shims record a real command and stay transparent to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-shim-'));
  try {
    const shims = await setupShims(dir);
    const t0 = Date.now();

    // `npm --version` is cheap, real, and its output must survive the shim.
    const res = spawnSync('/bin/bash', ['-lc', withShimPath('npm --version')], {
      env: { ...process.env, ...shims.env },
      encoding: 'utf8',
    });

    assert.equal(res.status, 0, `shimmed npm failed: ${res.stderr}`);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/, 'stdout must pass through untouched');

    const phases = parsePhaseLog(await readFile(shims.phaseLog, 'utf8'), t0);
    assert.equal(phases.length, 1, 'exactly one invocation recorded');
    assert.equal(phases[0]!.cmd, 'npm');
    assert.deepEqual(phases[0]!.argv, ['--version']);
    assert.equal(phases[0]!.exitCode, 0);
    assert.ok(phases[0]!.endMs !== null && phases[0]!.endMs >= phases[0]!.startMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a login shell cannot strip the shims off PATH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-shim-'));
  try {
    const shims = await setupShims(dir);
    // Simulate a profile that rebuilds PATH without the shim directory -- node
    // and npm are still reachable, the shims are not. This is what made an
    // earlier version of this harness silently record zero phases while every
    // command still worked.
    const clobber = `export PATH=${JSON.stringify(process.env.PATH ?? '')}`;
    const hostile = withShimPath(`${clobber}\n${withShimPath('npm --version')}`);
    const res = spawnSync('/bin/bash', ['-lc', hostile], {
      env: { ...process.env, ...shims.env },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    const phases = parsePhaseLog(await readFile(shims.phaseLog, 'utf8'), Date.now());
    assert.equal(phases.length, 1, 'the shim must still have been used');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shim forwards a non-zero exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p2p-shim-'));
  try {
    const shims = await setupShims(dir);
    const res = spawnSync('/bin/bash', ['-lc', withShimPath('npm run definitely-not-a-script')], {
      env: { ...process.env, ...shims.env },
      encoding: 'utf8',
    });
    assert.notEqual(res.status, 0, 'failure must not be swallowed');
    const phases = parsePhaseLog(await readFile(shims.phaseLog, 'utf8'), Date.now());
    assert.ok(phases.length >= 1);
    assert.notEqual(phases[0]!.exitCode, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
