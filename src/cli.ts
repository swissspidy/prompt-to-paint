import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrief } from './brief.ts';
import { runBenchmark } from './run.ts';
import { ClaudeCodeAdapter, ExecAdapter, ScriptedAdapter, PiAdapter, AntigravityAdapter } from './adapters/index.ts';
import { pickBackend, NullBackend } from './judge/backends.ts';
import { judgeRun } from './judge/judge.ts';
import { computeMetrics } from './metrics/curve.ts';
import { renderHtml } from './report/html.ts';
import { renderText } from './report/text.ts';
import { renderCompareText, renderCompareHtml } from './report/compare.ts';
import { aggregate, renderAggregate } from './report/aggregate.ts';
import { FLOOR_TEMPLATES, floorBrief } from './floor.ts';
import type { Adapter, RunResult } from './types.ts';

/**
 * Bundled briefs live with the package, not in whatever directory the command
 * was run from, so `p2p briefs` works outside the repository too.
 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUNDLED_BRIEFS = ['todo-app', 'landing-page', 'static-page'];
const bundledBrief = (id: string): string => join(PKG_ROOT, 'briefs', `${id}.json`);

/**
 * Labels end up in path names, and a label is whatever the user typed --
 * `claude-code:claude-opus-5` by default. One definition so a run directory and
 * the aggregate file beside it can never disagree about the spelling.
 */
const slug = (label: string): string => label.replace(/[^\w.-]/g, '_');

const USAGE = `
prompt-to-paint -- how long until an agent renders something you can react to

  p2p run      --brief <file> [options]     measure one agent on one brief
  p2p floor    --template <id> [options]    measure the toolchain with no agent
  p2p compare  <result.json...>             rank runs by trajectory and by final score
  p2p rescore  <runDir> [--judge <backend>] [--brief <file>]
                                            re-score saved frames without re-running
  p2p briefs                                list bundled briefs
  p2p floors                                list toolchain-floor templates

Options for run:
  --adapter    claude-code | pi | antigravity | exec | scripted  (default claude-code)
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
  --unsafe     pass --dangerously-skip-permissions to claude-code (non-root sandboxes only)
  --permission-mode <mode>  permission mode for claude-code (default acceptEdits)
  --provider   provider for pi (pi defaults to google)
  --tools      comma-separated tool allowlist for pi
  --effort     low | medium | high, for antigravity
  --print-timeout  agy print timeout (default 30m; agy's own default is 5m)
  --bin        override the agent binary name/path
  --repeat N   run N times and report a median with its full range
`;

/** Print a usage error and exit, without a stack trace the user cannot act on. */
function fail(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

/** Parse argv, dispatch the subcommand, and write whatever reports it produces. */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  const argv = process.argv.slice(3);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'briefs') {
    for (const id of BUNDLED_BRIEFS) {
      const b = await loadBrief(bundledBrief(id));
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
      repeat: { type: 'string' }, 'permission-mode': { type: 'string' },
      provider: { type: 'string' }, tools: { type: 'string' }, effort: { type: 'string' },
      'print-timeout': { type: 'string' }, bin: { type: 'string' },
    },
  });

  if (cmd === 'rescore') {
    const dir = argv.find((a) => !a.startsWith('-'));
    if (!dir) fail('rescore needs a run directory');
    const prev = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as RunResult;
    // Prefer an explicit --brief, then the path the run recorded, then the
    // bundled brief of that id.
    const briefPath = values.brief ?? prev.briefPath ?? bundledBrief(prev.brief);
    const brief = await loadBrief(briefPath);
    const backend = pickBackend({ backend: (values.judge as 'api' | 'cli' | 'none' | 'auto') ?? 'auto', model: values['judge-model'] });
    const judged = await judgeRun(prev.frames, brief, { backend });
    const next: RunResult = {
      ...prev,
      // Spreading prev would keep the old brief id and path, so the report
      // would name the wrong rubric and a later rescore would reload the brief
      // this one just replaced.
      brief: brief.id,
      briefPath,
      // Warnings from the previous scoring pass are stale; keep the ones about
      // the run itself. Without this a rescore silently inherits the old
      // judge's verdict about itself and hides fresh failures.
      warnings: [...prev.warnings.filter((w) => !w.startsWith('judge:')), ...judged.warnings],
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
  let makeAdapter: () => Adapter;
  let label = values.label ?? '';

  if (cmd === 'floor') {
    const t = FLOOR_TEMPLATES[values.template ?? 'vite-react'];
    if (!t) fail(`unknown floor template "${values.template}". Try: ${Object.keys(FLOOR_TEMPLATES).join(', ')}`);
    const port = Number(values.port ?? 5173);
    brief = floorBrief(t, port, Number(values.horizon ?? 300));
    makeAdapter = () => new ExecAdapter({ command: t.script.replaceAll('{{PORT}}', String(port)) });
    label ||= `floor:${t.id}`;
  } else if (cmd === 'run') {
    if (!values.brief) fail('run needs --brief <file>');
    brief = await loadBrief(values.brief);
    const kind = values.adapter ?? 'claude-code';
    if (kind === 'claude-code') {
      // The CLI refuses to bypass permissions when running as root, and the
      // resulting failure is opaque: the agent exits instantly and the run
      // looks like an agent that simply built nothing.
      if (values.unsafe && process.getuid?.() === 0) {
        fail(
          'the Claude Code CLI refuses --dangerously-skip-permissions as root.\n' +
            '  Run the harness as a non-root user in your sandbox, or pass\n' +
            '  --permission-mode acceptEdits for briefs that only need file writes\n' +
            '  (an agent that must run shell commands will stall on approval).',
        );
      }
      makeAdapter = () => new ClaudeCodeAdapter({
        model: values.model,
        skipPermissions: values.unsafe,
        permissionMode: values['permission-mode'],
      });
      label ||= values.model ? `claude-code:${values.model}` : 'claude-code';
      if (!values.unsafe && !values['permission-mode'])
        console.log('  note: running with --permission-mode acceptEdits. An agent that needs to run\n' +
                    '        commands will stall on approval. Use --unsafe in a non-root sandbox.');
    } else if (kind === 'pi') {
      makeAdapter = () => new PiAdapter({
        bin: values.bin,
        provider: values.provider,
        model: values.model,
        tools: values.tools,
      });
      label ||= values.model ? `pi:${values.model}` : 'pi';
      if (!values.model)
        console.log('  note: pi defaults to the google provider. Pass --provider and --model\n' +
                    '        for a reproducible run.');
    } else if (kind === 'antigravity') {
      makeAdapter = () => new AntigravityAdapter({
        bin: values.bin,
        model: values.model,
        effort: values.effort,
        skipPermissions: values.unsafe,
        printTimeout: values['print-timeout'],
      });
      label ||= values.model ? `antigravity:${values.model}` : 'antigravity';
      if (!values.unsafe)
        console.log('  note: agy soft-denies tools needing approval. Without --unsafe the agent\n' +
                    '        cannot write files or run commands.');
    } else if (kind === 'exec') {
      if (!values.command) fail('--adapter exec needs --command');
      // Captured outside the closure: the narrowing from fail() (which returns
      // never) does not survive into a deferred factory.
      const command = values.command;
      makeAdapter = () => new ExecAdapter({ command });
      label ||= 'exec';
    } else if (kind === 'scripted') {
      if (!values.script) fail('--adapter scripted needs --script <timeline.json>');
      const spec = JSON.parse(await readFile(values.script, 'utf8'));
      makeAdapter = () => new ScriptedAdapter(spec);
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
  const repeats = Math.max(1, Number(values.repeat ?? 1));
  const results: RunResult[] = [];

  for (let i = 0; i < repeats; i++) {
    const runDir = resolve(
      outRoot,
      `${brief.id}-${slug(label)}-${Date.now().toString(36)}${repeats > 1 ? `-r${i + 1}` : ''}`,
    );
    await mkdir(runDir, { recursive: true });
    if (repeats > 1) console.log(`\n  === run ${i + 1} of ${repeats} ===`);
    console.log(`  run dir: ${runDir}`);

    const result = await runBenchmark({
      brief,
      briefPath: cmd === 'run' ? values.brief : undefined,
      // A fresh instance per repeat: adapters accumulate per-run state (the
      // Antigravity one records what it learned about the stream), and reusing
      // one would let an earlier repeat decide a later repeat's fidelity.
      adapter: makeAdapter(),
      runDir,
      label,
      judgeBackend,
      pollMs: values.poll ? Number(values.poll) : undefined,
      iterationPollMs: values['iter-poll'] ? Number(values['iter-poll']) : undefined,
      settleMs: values.settle ? Number(values.settle) : undefined,
      skipIterations: values['no-iterate'] || cmd === 'floor',
      killPort: values['kill-port'],
      // A control run has no agent turn to wait for: its dev server runs forever.
      stopAfterRenderMs: cmd === 'floor' ? Number(values.settle ?? 8000) : undefined,
      keepServer: values['keep-server'],
      onLog: (m) => console.log(`  · ${m}`),
    });

    await writeFile(join(runDir, 'report.html'), renderHtml(result, runDir));
    console.log(renderText(result));
    console.log(`  report: ${join(runDir, 'report.html')}\n`);
    results.push(result);
  }

  if (results.length > 1) {
    const agg = aggregate(results);
    await mkdir(resolve(outRoot), { recursive: true });
    const aggPath = resolve(outRoot, `aggregate-${brief.id}-${slug(label)}.json`);
    await writeFile(aggPath, JSON.stringify(agg, null, 2));
    console.log(renderAggregate(agg));
    console.log(`  aggregate: ${aggPath}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
