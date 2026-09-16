import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadBrief } from './brief.js';
import { runBenchmark } from './run.js';
import { ClaudeCodeAdapter, ExecAdapter, ScriptedAdapter } from './adapters/index.js';
import { pickBackend, NullBackend } from './judge/backends.js';
import { judgeRun } from './judge/judge.js';
import { computeMetrics } from './metrics/curve.js';
import { renderHtml } from './report/html.js';
import { renderText } from './report/text.js';
import { renderCompareText, renderCompareHtml } from './report/compare.js';
import { FLOOR_TEMPLATES, floorBrief } from './floor.js';
import type { Adapter, RunResult } from './types.js';

const USAGE = `
prompt-to-paint -- how long until an agent renders something you can react to

  p2p run      --brief <file> [options]     measure one agent on one brief
  p2p floor    --template <id> [options]    measure the toolchain with no agent
  p2p compare  <result.json...>             rank runs by trajectory and by final score
  p2p rescore  <runDir> [--judge <backend>] re-score saved frames without re-running
  p2p briefs                                list bundled briefs
  p2p floors                                list toolchain-floor templates

Options for run:
  --adapter    claude-code | exec | scripted     (default claude-code)
  --model      model passed to the agent
  --label      name for this run in reports      (default: adapter[+model])
  --judge      api | cli | none | auto           (default auto)
  --judge-model                                  (default claude-sonnet-5)
  --out        output directory                  (default runs/)
  --poll       cold-start poll interval in ms    (default 1000)
  --iter-poll  iteration poll interval in ms     (default 250)
  --settle     extra observation after the agent stops, ms (default 15000)
  --command    shell command for --adapter exec; {{PROMPT}} and {{WORKDIR}} are substituted
  --script     JSON timeline file for --adapter scripted
  --no-iterate skip the iteration phase
  --kill-port  free the target port first instead of refusing to run
  --keep-server leave the agent's dev server running after the run
  --unsafe     pass --dangerously-skip-permissions to claude-code (sandboxes only)
`;

function fail(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const argv = process.argv.slice(3);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'briefs') {
    for (const id of ['todo-app', 'landing-page', 'static-page']) {
      const b = await loadBrief(join('briefs', `${id}.json`));
      console.log(`  ${id.padEnd(16)} ${b.title}  (horizon ${b.horizonSec}s, ${b.rubric.length} criteria)`);
    }
    return;
  }
  if (cmd === 'floors') {
    for (const t of Object.values(FLOOR_TEMPLATES)) console.log(`  ${t.id.padEnd(14)} ${t.description}`);
    return;
  }

  if (cmd === 'compare') {
    const files = argv.filter((a) => !a.startsWith('-'));
    if (!files.length) fail('compare needs at least one result.json');
    const runs: RunResult[] = [];
    for (const f of files) runs.push(JSON.parse(await readFile(f, 'utf8')) as RunResult);
    console.log(renderCompareText(runs));
    const out = resolve('runs', 'compare.html');
    await mkdir(resolve('runs'), { recursive: true });
    await writeFile(out, renderCompareHtml(runs));
    console.log(`  comparison page: ${out}\n`);
    return;
  }

  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      brief: { type: 'string' }, adapter: { type: 'string' }, model: { type: 'string' },
      label: { type: 'string' }, judge: { type: 'string' }, 'judge-model': { type: 'string' },
      out: { type: 'string' }, poll: { type: 'string' }, 'iter-poll': { type: 'string' },
      settle: { type: 'string' }, command: { type: 'string' }, script: { type: 'string' },
      template: { type: 'string' }, port: { type: 'string' }, horizon: { type: 'string' },
      'no-iterate': { type: 'boolean' }, unsafe: { type: 'boolean' },
      'kill-port': { type: 'boolean' }, 'keep-server': { type: 'boolean' },
    },
  });

  if (cmd === 'rescore') {
    const dir = argv.find((a) => !a.startsWith('-'));
    if (!dir) fail('rescore needs a run directory');
    const prev = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as RunResult;
    const brief = await loadBrief(join('briefs', `${prev.brief}.json`));
    const backend = pickBackend({ backend: (values.judge as 'api' | 'cli' | 'none' | 'auto') ?? 'auto', model: values['judge-model'] });
    const judged = await judgeRun(prev.frames, brief, { backend });
    const next: RunResult = {
      ...prev,
      frames: judged.frames,
      judge: { backend: backend.name, model: backend.model, framesJudged: judged.framesJudged, degraded: judged.degraded },
      curve: computeMetrics(judged.frames, {
        horizonMs: brief.horizonSec * 1000,
        runEndMs: prev.curve.runEndMs,
        reviewableThreshold: brief.reviewableThreshold,
      }),
    };
    await writeFile(join(dir, 'result.json'), JSON.stringify(next, null, 2));
    await writeFile(join(dir, 'report.html'), renderHtml(next, dir));
    console.log(renderText(next));
    return;
  }

  let brief;
  let adapter: Adapter;
  let label = values.label ?? '';

  if (cmd === 'floor') {
    const t = FLOOR_TEMPLATES[values.template ?? 'vite-react'];
    if (!t) fail(`unknown floor template "${values.template}". Try: ${Object.keys(FLOOR_TEMPLATES).join(', ')}`);
    const port = Number(values.port ?? 5173);
    brief = floorBrief(t, port, Number(values.horizon ?? 300));
    adapter = new ExecAdapter({ command: t.script.replaceAll('{{PORT}}', String(port)) });
    label ||= `floor:${t.id}`;
  } else if (cmd === 'run') {
    if (!values.brief) fail('run needs --brief <file>');
    brief = await loadBrief(values.brief);
    const kind = values.adapter ?? 'claude-code';
    if (kind === 'claude-code') {
      adapter = new ClaudeCodeAdapter({ model: values.model, skipPermissions: values.unsafe });
      label ||= values.model ? `claude-code:${values.model}` : 'claude-code';
      if (!values.unsafe)
        console.log('  note: running with --permission-mode acceptEdits. An agent that needs to run\n' +
                    '        commands will stall on approval. Use --unsafe in a sandbox.');
    } else if (kind === 'exec') {
      if (!values.command) fail('--adapter exec needs --command');
      adapter = new ExecAdapter({ command: values.command });
      label ||= 'exec';
    } else if (kind === 'scripted') {
      if (!values.script) fail('--adapter scripted needs --script <timeline.json>');
      const spec = JSON.parse(await readFile(values.script, 'utf8'));
      adapter = new ScriptedAdapter(spec);
      label ||= 'scripted';
    } else {
      fail(`unknown adapter "${kind}"`);
    }
  } else {
    fail(`unknown command "${cmd}". Run "p2p help".`);
  }

  const judgeBackend = cmd === 'floor'
    ? new NullBackend()
    : pickBackend({ backend: (values.judge as 'api' | 'cli' | 'none' | 'auto') ?? 'auto', model: values['judge-model'] });

  const outRoot = values.out ?? 'runs';
  const runDir = resolve(outRoot, `${brief.id}-${label.replace(/[^\w.-]/g, '_')}-${Date.now().toString(36)}`);
  await mkdir(runDir, { recursive: true });
  console.log(`  run dir: ${runDir}`);

  const result = await runBenchmark({
    brief,
    adapter,
    runDir,
    label,
    judgeBackend,
    pollMs: values.poll ? Number(values.poll) : undefined,
    iterationPollMs: values['iter-poll'] ? Number(values['iter-poll']) : undefined,
    settleMs: values.settle ? Number(values.settle) : undefined,
    skipIterations: values['no-iterate'] || cmd === 'floor',
    killPort: values['kill-port'],
    keepServer: values['keep-server'],
    onLog: (m) => console.log(`  · ${m}`),
  });

  await writeFile(join(runDir, 'report.html'), renderHtml(result, runDir));
  console.log(renderText(result));
  console.log(`  report: ${join(runDir, 'report.html')}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
