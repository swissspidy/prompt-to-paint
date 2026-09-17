import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
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
import { renderLeaderboard, renderLeaderboardText } from './report/leaderboard.ts';
import {
  buildSegments, inferIntervalMs, renderConcat, ffmpegArgs, resolveShot, writeBlankFrame, timelineSpanMs,
} from './report/video.ts';
import { aggregate, renderAggregate } from './report/aggregate.ts';
import { Progress } from './progress.ts';
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
  p2p leaderboard <result.json...>          ranking + every run replayed side by side
  p2p video    <runDir> [--out <file>]      replay one run's frames as a real video
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
  --quiet-for  end the window after N seconds with nothing changing (default 120, 0 off)
  --stop-after-render  end the window N ms after the app first renders
  --no-render-early    drop the "render something early" clause from the protocol

Options for video:
  --out        output file; .mp4 or .webm picks the codec (default <runDir>/timeline.mp4)
  --fps        output frame rate                 (default 30)
  --to-horizon hold the last frame to the brief's horizon, so two runs' videos
               are the same length and can be played side by side
  --headed     show the prober's browser window while the agent works
  --video      record the session to video.webm (Playwright screencast)
  --no-progress  no live status line
  --unsafe     pass --dangerously-skip-permissions to claude-code (non-root sandboxes only)
  --permission-mode <mode>  permission mode for claude-code (default acceptEdits)
  --provider   provider for pi (pi defaults to google)
  --tools      comma-separated tool allowlist for pi
  --effort     low | medium | high, for antigravity
  --print-timeout  agy print timeout (default 30m; agy's own default is 5m)
  --bin        override the agent binary name/path
  --repeat N   run N times and report a median with its full range

Options for leaderboard:
  --out        page to write   (default runs/leaderboard.html)
  --title      heading for the page
`;

/** Quote an argument for a command line a person is meant to paste and run. */
const shellQuote = (a: string): string =>
  /^[\w.,:=/-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;

/**
 * Check the encoded video is as long as the timeline it was built from.
 *
 * A dropped segment does not make ffmpeg fail. The concat demuxer skips inputs
 * whose stream parameters do not match the first one and says nothing, so the
 * video comes out short and every timestamp after the gap is wrong -- which is
 * unnoticeable in a file nobody has measured. The timeline span is known
 * exactly, so this compares against it rather than trusting the encode.
 */
async function assertVideoSpan(
  sh: (f: string, a: string[]) => Promise<{ stdout: string }>,
  out: string,
  spanMs: number,
  fps: number,
): Promise<void> {
  let seconds: number;
  try {
    const { stdout } = await sh('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out,
    ]);
    seconds = Number(stdout.trim());
  } catch {
    // ffprobe usually ships with ffmpeg, but the check is a safety net rather
    // than the job; not having it is not a reason to withhold the video.
    console.log('  note: ffprobe not available, so the video length was not verified.');
    return;
  }
  if (!Number.isFinite(seconds)) return;
  // Rounding to whole output frames is expected; a missing segment is not.
  const slackMs = (2000 / fps) + 250;
  const driftMs = Math.abs(seconds * 1000 - spanMs);
  if (driftMs > slackMs)
    fail(
      `the encoded video is ${seconds.toFixed(2)}s but the timeline is ${(spanMs / 1000).toFixed(2)}s.\n` +
        `  ffmpeg dropped ${(driftMs / 1000).toFixed(2)}s, so every timestamp after the gap is wrong.\n` +
        `  This is usually a frame whose pixel format differs from the rest; compare them with\n` +
        `  ffprobe -show_entries stream=pix_fmt,width,height on the files in the concat script.`,
    );
}

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

  if (cmd === 'leaderboard') {
    // Positionals, not "every argument that does not start with a dash": the
    // latter also collects option *values*, so `--title "Two agents"` was read
    // as three more result files.
    const { values: flags, positionals: files } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: 'string' }, title: { type: 'string' } },
    });
    if (!files.length) fail('leaderboard needs at least one result.json');
    const runs: RunResult[] = [];
    const runDirs: string[] = [];
    for (const f of files) {
      runs.push(JSON.parse(await readFile(f, 'utf8')) as RunResult);
      // Frames and report.html sit beside the result they belong to, and the
      // page links to both relatively, so it keeps working when the whole
      // runs/ directory is copied somewhere else.
      runDirs.push(dirname(resolve(f)));
    }
    console.log(renderLeaderboardText(runs));
    const out = resolve(flags.out ?? join('runs', 'leaderboard.html'));
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, renderLeaderboard(runs, out, { title: flags.title, runDirs }));
    console.log(`  leaderboard: ${out}\n`);
    return;
  }

  if (cmd === 'video') {
    const { values: flags, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { out: { type: 'string' }, fps: { type: 'string' }, 'to-horizon': { type: 'boolean' } },
    });
    const dir = positionals[0];
    if (!dir) fail('video needs a run directory');
    const runDir = resolve(dir);
    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as RunResult;

    const fps = Number(flags.fps ?? 30);
    if (!Number.isFinite(fps) || fps <= 0) fail(`--fps must be a positive number, got "${flags.fps}"`);

    // A screenshot that is not where the result says it is becomes a blank
    // frame, which is indistinguishable from a deliberately blank one, so it is
    // counted rather than quietly substituted.
    let missing = 0;
    const segments = buildSegments(result.frames, {
      tailMs: inferIntervalMs(result.frames),
      holdToMs: flags['to-horizon'] ? result.curve.horizonMs : null,
    }).map((seg) => {
      if (!seg.src) return seg;
      const found = resolveShot(runDir, seg.src);
      if (!found) missing++;
      return { ...seg, src: found };
    });

    if (!segments.length) fail(`no frames recorded in ${join(runDir, 'result.json')}`);
    const anyShot = segments.find((seg) => seg.src)?.src;
    if (!anyShot)
      fail(
        `none of this run's screenshots are on disk. result.json records absolute paths, so\n` +
          `  moving runs/ breaks them; frames/ must sit beside result.json.`,
      );
    if (missing)
      console.log(`  ! ${missing} of ${segments.length} segments have no screenshot on disk; they show blank.`);

    const blankPath = join(runDir, 'timeline-blank.png');
    if (segments.some((seg) => !seg.src)) await writeBlankFrame(blankPath, anyShot);
    const concatPath = join(runDir, 'timeline.concat');
    await writeFile(concatPath, renderConcat(segments, blankPath));

    const out = resolve(flags.out ?? join(runDir, 'timeline.mp4'));
    await mkdir(dirname(out), { recursive: true });
    const args = ffmpegArgs(concatPath, out, fps);
    const spanMs = timelineSpanMs(segments);
    console.log(
      `  ${result.frames.length} observations over ${(spanMs / 1000).toFixed(1)}s -> ${segments.length} segments`,
    );

    const sh = promisify(execFile);
    try {
      await sh('ffmpeg', ['-version']);
    } catch {
      // The timeline is the hard part and it is already written, so say exactly
      // how to finish rather than throwing the work away.
      console.error(
        `\n  error: ffmpeg is not on PATH, so nothing was encoded.\n` +
          `  The timeline is written; finish it with:\n\n` +
          `    ffmpeg ${args.map(shellQuote).join(' ')}\n`,
      );
      process.exit(1);
    }
    try {
      await sh('ffmpeg', args, { maxBuffer: 1 << 24 });
    } catch (e) {
      const err = e as { stderr?: string };
      fail(`ffmpeg failed:\n${(err.stderr ?? String(e)).trim().split('\n').slice(-8).join('\n')}`);
    }
    await assertVideoSpan(sh, out, spanMs, fps);
    console.log(`  video: ${out}\n`);
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
      'quiet-for': { type: 'string' }, 'stop-after-render': { type: 'string' },
      'no-render-early': { type: 'boolean' }, headed: { type: 'boolean' },
      video: { type: 'boolean' }, 'no-progress': { type: 'boolean' },
      title: { type: 'string' },
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

    // A run is minutes of an agent working somewhere else. Without this the CLI
    // printed nothing until it was over, and the only way to tell a run in
    // progress from a hung one was to tail agent.log in another terminal.
    const progress = values['no-progress'] ? null : new Progress(brief.horizonSec * 1000);
    progress?.start();

    let result: RunResult;
    try {
      result = await runBenchmark({
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
        stopAfterRenderMs:
          values['stop-after-render'] !== undefined
            ? Number(values['stop-after-render'])
            : cmd === 'floor' ? Number(values.settle ?? 8000) : undefined,
        // A floor script exits on its own and has no agent to fall silent, so
        // quiescence could only ever cut it short.
        quietForMs:
          cmd === 'floor' ? 0
            : values['quiet-for'] !== undefined ? Number(values['quiet-for']) * 1000
            : undefined,
        noRenderEarly: values['no-render-early'],
        headed: values.headed,
        videoPath: values.video ? join(runDir, 'video.webm') : undefined,
        keepServer: values['keep-server'],
        onLog: (m) => (progress ? progress.log(m) : console.log(`  · ${m}`)),
        onFrame: (f) => progress?.onFrame(f),
        onAgentEvent: (e) => progress?.onAgentEvent(e),
      });
    } finally {
      // The status line owns the last terminal row; the report must not be
      // printed over the top of it.
      progress?.stop();
    }

    await writeFile(join(runDir, 'report.html'), renderHtml(result, runDir));
    console.log(renderText(result));
    console.log(`  report: ${join(runDir, 'report.html')}`);
    if (result.artifacts?.videoPath) console.log(`  video:  ${result.artifacts.videoPath}`);
    console.log('');
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
