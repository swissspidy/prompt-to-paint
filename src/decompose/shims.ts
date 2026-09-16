import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Commands worth intercepting. Anything not listed here lands in the residual
 * bucket, which the report prints, so a missing entry shows up as unexplained
 * time rather than silently vanishing.
 */
export const SHIMMED = [
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx',
  'vite', 'next', 'tsc', 'webpack', 'esbuild', 'rollup', 'parcel',
  'astro', 'nuxt', 'remix', 'ng', 'react-scripts',
];

/**
 * The shim records; it does not interpret.
 *
 * Every classification decision lives in the harness where it can be unit
 * tested. The shim's only jobs are to be fast, to be transparent to the
 * process it wraps (exit code, signals, stdio all pass through untouched), and
 * to log timestamps on a clock the harness shares.
 */
const SHIM_SOURCE = String.raw`#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const selfDir = __dirname;
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = process.env.P2P_PHASE_LOG;

function findReal() {
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const dir of parts) {
    if (!dir || path.resolve(dir) === path.resolve(selfDir)) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

const real = findReal();
if (!real) {
  process.stderr.write('p2p-shim: cannot find real ' + name + ' on PATH\n');
  process.exit(127);
}

const id = process.pid + '-' + Date.now().toString(36);
const depth = Number(process.env.P2P_PHASE_DEPTH || '0');

function record(rec) {
  if (!log) return;
  try { fs.appendFileSync(log, JSON.stringify(rec) + '\n'); } catch {}
}

const startEpoch = Date.now();
record({ ev: 'start', id, cmd: name, argv: args, startEpoch, depth, pid: process.pid, shimStartEpoch: Number(process.env.P2P_SHIM_T0) || startEpoch });

const child = spawn(real, args, {
  stdio: 'inherit',
  env: Object.assign({}, process.env, { P2P_PHASE_DEPTH: String(depth + 1) }),
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch {} });
}

child.on('error', (e) => {
  record({ ev: 'end', id, endEpoch: Date.now(), exit: 127, error: String(e) });
  process.exit(127);
});

child.on('close', (code, signal) => {
  record({ ev: 'end', id, endEpoch: Date.now(), exit: code, signal: signal || null });
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code === null ? 1 : code);
});
`;

export interface ShimSetup {
  dir: string;
  phaseLog: string;
  /** Merge into the agent's environment. */
  env: Record<string, string>;
}

/**
 * Prefix a shell command so the shims survive a login shell.
 *
 * Inheriting PATH through the environment is not enough. A login shell sources
 * the profile, which commonly rebuilds PATH from scratch and drops the shim
 * directory, and the run then records no phases at all while looking perfectly
 * healthy. Re-prepending inside the command runs after any profile has had its
 * say, and appends rather than replaces, so tools the profile added are kept.
 */
export function withShimPath(command: string): string {
  return `if [ -n "$P2P_SHIM_DIR" ]; then export PATH="$P2P_SHIM_DIR:$PATH"; fi
${command}`;
}

/**
 * Write the shim directory and return the env that activates it.
 *
 * Each shim costs one extra Node startup (~40ms). That overhead is inside the
 * measured window, so the shim stamps its own start time and the attribution
 * step subtracts it rather than quietly charging it to the build.
 */
export async function setupShims(runDir: string, extraPath = process.env.PATH ?? ''): Promise<ShimSetup> {
  const dir = join(runDir, 'shims');
  await mkdir(dir, { recursive: true });
  // Pin CommonJS so the shim resolves the same way regardless of what the
  // project under test declares.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  for (const name of SHIMMED) {
    const p = join(dir, name);
    await writeFile(p, SHIM_SOURCE);
    await chmod(p, 0o755);
  }
  const phaseLog = join(runDir, 'phases.jsonl');
  await writeFile(phaseLog, '');
  return {
    dir,
    phaseLog,
    env: {
      PATH: `${dir}:${extraPath}`,
      P2P_SHIM_DIR: dir,
      P2P_PHASE_LOG: phaseLog,
      P2P_PHASE_DEPTH: '0',
    },
  };
}
