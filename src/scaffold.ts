import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, writeFile, rename, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sleep } from './sleep.ts';

const run = promisify(execFile);

/**
 * A project the harness prepares and serves, so the agent only edits files.
 *
 * Without one, a toolchain brief needs an agent with a shell: it has to
 * scaffold, install and start a dev server before anything can render. That
 * measures something real -- whether the agent sets up the toolchain, and how
 * long that takes -- but it is not the only question. With the toolchain
 * already running, every file the agent saves hot-reloads on its own, so an
 * agent that builds an app across several files renders in stages whether it
 * means to or not. That is the behaviour a single-file static brief can never
 * show, and it needs no shell to observe.
 */
export interface Scaffold {
  id: string;
  description: string;
  /** Files written before `npm install`, relative to the project root. */
  files: Record<string, string>;
  /** Argv for the dev server, run with node from the project root. */
  devServer: (port: number) => string[];
  /**
   * What the agent is told about the project, appended to the protocol. It is
   * the only way the agent learns there is a dev server it must not replace and
   * dependencies it cannot add.
   */
  protocol: string;
}

/**
 * The starting page is deliberately empty: no title, no favicon, an App that
 * renders nothing. Anything the template showed by itself would be a "first
 * render" at 0s for every agent, and a title or icon would trip the tab signal
 * before the agent had written a line.
 */
export const SCAFFOLDS: Record<string, Scaffold> = {
  'vite-react': {
    id: 'vite-react',
    description: 'Vite + React, dependencies installed, dev server running with hot reload',
    files: {
      'package.json': `${JSON.stringify(
        {
          name: 'app',
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: { dev: 'vite' },
          // Exact versions: two runs a week apart must start from the same project.
          dependencies: { react: '19.2.8', 'react-dom': '19.2.8' },
          devDependencies: { '@vitejs/plugin-react': '6.1.1', vite: '8.3.0' },
        },
        null,
        2,
      )}\n`,
      'vite.config.js': [
        "import { defineConfig } from 'vite'",
        "import react from '@vitejs/plugin-react'",
        '',
        'export default defineConfig({ plugins: [react()] })',
        '',
      ].join('\n'),
      'index.html': [
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        '    <title></title>',
        '  </head>',
        '  <body>',
        '    <div id="root"></div>',
        '    <script type="module" src="/src/main.jsx"></script>',
        '  </body>',
        '</html>',
        '',
      ].join('\n'),
      'src/main.jsx': [
        "import { StrictMode } from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import './index.css'",
        "import App from './App.jsx'",
        '',
        "createRoot(document.getElementById('root')).render(",
        '  <StrictMode>',
        '    <App />',
        '  </StrictMode>,',
        ')',
        '',
      ].join('\n'),
      'src/App.jsx': 'export default function App() {\n  return null\n}\n',
      'src/index.css': '',
    },
    devServer: (port) => ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    protocol:
      '- This directory is already a Vite + React project with its dependencies\n' +
      '  installed, and the harness is running its dev server at that URL with hot\n' +
      '  reload: every file you save under `src/` is on screen at the next\n' +
      '  screenshot. Start from `src/App.jsx`, which currently renders nothing. Do\n' +
      '  not start a server or install packages: `react` and `react-dom` are the\n' +
      '  only dependencies, and nothing else can be added.',
  },
};

function cacheRoot(): string {
  return resolve(process.env.P2P_CACHE_DIR ?? '.p2p-cache', 'scaffold');
}

/**
 * Copy a prepared project into the workdir, preparing it once if needed.
 *
 * Installed once per machine and copied per run, rather than installed per
 * run: an `npm install` before every run would cost tens of seconds of nothing
 * and make each run's starting state depend on the registry that minute. The
 * copy happens before the clock starts, because the agent is not being
 * measured on it.
 */
export async function prepareScaffold(s: Scaffold, workdir: string, log: (m: string) => void = () => {}): Promise<void> {
  const ready = join(cacheRoot(), s.id);
  if (!existsSync(join(ready, 'node_modules'))) {
    log(`preparing the ${s.id} scaffold (once per machine)`);
    const tmp = `${ready}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    for (const [path, body] of Object.entries(s.files)) {
      await mkdir(join(tmp, path, '..'), { recursive: true });
      await writeFile(join(tmp, path), body);
    }
    await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp, timeout: 300_000 });
    await rm(ready, { recursive: true, force: true });
    // Renamed into place only once complete, so an interrupted install is
    // never mistaken for a prepared scaffold.
    await rename(tmp, ready);
  }
  // verbatimSymlinks: node_modules/.bin is relative symlinks, and rewriting
  // them to absolute paths into the cache would let a run modify the cache.
  await cp(ready, workdir, { recursive: true, verbatimSymlinks: true });
}

export interface DevServer {
  stop(): Promise<void>;
}

/**
 * Start the scaffold's dev server and wait until it answers.
 *
 * Ready before the clock starts: the agent did not start it and is not charged
 * for it. A server that never answers fails the run rather than letting the
 * agent be measured against a dead port.
 */
export async function startDevServer(s: Scaffold, workdir: string, port: number, logPath: string): Promise<DevServer> {
  const out = await open(logPath, 'a');
  const child: ChildProcess = spawn(process.execPath, s.devServer(port), {
    cwd: workdir,
    stdio: ['ignore', out.fd, out.fd],
    detached: true,
  });
  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited !== null) {
      await out.close();
      throw new Error(`the ${s.id} dev server exited with code ${exited} before serving; see ${logPath}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await out.close();
      throw new Error(`the ${s.id} dev server did not answer on ${url} within 30s; see ${logPath}`);
    }
    await sleep(200);
  }

  return {
    async stop() {
      if (exited === null && child.pid) {
        // The whole group: vite may have children of its own.
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch { /* already gone */ }
        for (let i = 0; i < 25 && exited === null; i++) await sleep(100);
        if (exited === null) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch { /* already gone */ }
        }
      }
      await out.close().catch(() => undefined);
    },
  };
}
