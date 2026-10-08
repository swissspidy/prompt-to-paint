# prompt-to-paint

Measures how long a coding agent takes to put something on screen that a human
can react to, and how good it gets over time.

Most agent benchmarks score a run once, at the end: did it build a working app?
This one asks a different question: **first meaningful paint for agent output.**
How long until there is something to look at, and how does it improve while
you wait? That is a different metric, and it can produce a different ranking.

**[Results, with every run replayed side by side →](https://swissspidy.github.io/prompt-to-paint/)**

## How it works

A headless browser screenshots the page every second while the agent works. A
judge model scores each screenshot against the brief, using yes/no criteria
that can be answered from a screenshot alone. The result is a
**correctness-over-time curve**. The headline number is the area under it.

```
score
 1.0 |                       ╭──────────────────────────  agent A
     |                  ╭────╯
 0.5 |      ╭───────────╯                ╭──────────────  agent B
     |      │                            │
 0.0 |──────╯────────────────────────────╯
     +──────────────────────────────────────────────────  time
        20s                             240s
```

Both agents finish at 0.9. A renders something rough at 20s and refines it. B
shows a blank page for four minutes and then nails it. On final score they tie.
On area under the curve A wins, **0.787 to 0.540**, because it gave a person
something to react to three and a half minutes earlier. That comparison is
pinned as a test in `test/curve.test.ts`.

Alongside the curve, every run reports:

- **Time to first render**: the first frame that isn't an error page, an empty
  body or a spinner.
- **Time to first reviewable render**: the first frame showing enough of what
  the brief asked for that a person could give useful feedback.
- **Where the time went**: wall clock split into model thinking, tool calls,
  dependency install, build, dev-server boot and first paint. Time it can't
  attribute is reported as unaccounted rather than hidden. `p2p floor` runs the
  same measurement with no model at all, as a control.
- **Follow-up edits**: after the first render the harness sends a follow-up
  ("make the header blue") into the same session and times how long the change
  takes to appear. An in-page check decides whether it landed, not a judge.

The precise definitions are in [docs/METRIC.md](docs/METRIC.md).

## What it has found so far

Fifty-four runs on two briefs, across Claude Code and Pi
driving Claude, GPT and Gemini models. Full write-ups are in
[docs/FINDINGS.md](docs/FINDINGS.md).

- **Agents don't render progressively, even when told to.** Every agent is
  told that a browser is watching and that a rough early page counts for more
  than a perfect late one. In 29 of the 30 published runs the page still went
  from blank to finished in one step. The agent event logs show why: the model
  composes the whole page and saves it in a single file write, so the browser
  only ever sees "nothing" and "done".
- **Telling them that does nothing measurable.** Dropping the instruction
  changed AUC by less than ±0.01, well inside run-to-run noise.
- **Telling them *how* does.** SKELETON_FIRST_SUMMARY
- **Model generation is the whole wait.** With the toolchain taken out of the
  agent's hands, model time was over 99% of every run.
- **Follow-up edits are an order of magnitude faster than the first render.**
  Most landed in 2–3s with a single tool call.
- **The rubric saturates.** Every run on both published briefs scored 1.00. Once
  each criterion is met, the score can't tell a better page from a worse one.
  `p2p pairwise` compares consecutive states directly. On the dashboard, none
  of the eight changes agents made after their first render was judged an
  improvement.

## Quickstart

Requires **Node 24 or newer**. `.nvmrc` pins `lts/*`. Node strips the
TypeScript types itself, so there is no build step: the CLI runs directly as
`node src/cli.ts`.

```bash
nvm use                             # optional; reads .nvmrc
npm install
npx playwright install chromium     # or set P2P_CHROMIUM to an existing binary

# see what's bundled
npm run p2p -- briefs
npm run p2p -- floors

# measure the toolchain with no agent in the loop -- run this first
npm run p2p -- floor --template vite-react

# measure an agent
npm run p2p -- run --brief briefs/todo-app.json --adapter claude-code --unsafe

# any other agent that is a command line
npm run p2p -- run --brief briefs/todo-app.json --adapter exec \
  --command 'my-agent --prompt {{PROMPT}} --cwd {{WORKDIR}}'

# one run is not a measurement -- report a median and its range
npm run p2p -- run --brief briefs/todo-app.json --adapter claude-code --unsafe --repeat 5

# rank runs, and replay them side by side on one clock
npm run p2p -- compare runs/*/result.json
npm run p2p -- leaderboard runs/*/result.json

# every run as one bar on a shared clock, shaded by how much of the brief was on screen
npm run p2p -- race runs/*/result.json

# is the curve doing any work, or is every run a step?
npm run p2p -- trajectory runs/*/result.json
```

`--unsafe` passes `--dangerously-skip-permissions` to Claude Code, which
refuses it when running as root. For briefs that only need file writes,
`--permission-mode acceptEdits` works as root. **Sandboxes only.**

Each run writes `result.json` (every frame, phase and event), a self-contained
`report.html`, the screenshots, and the exact prompt the agent was given. See
[what a run writes](docs/USAGE.md#what-a-run-writes).

## Agents it can drive

| adapter | follow-up edits | model vs tool time | verified |
|---|---|---|---|
| `claude-code` | live session | inferred from messages | full run |
| `pi` | live session | exact tool spans | full run |
| `antigravity` | live session | best effort | docs only |
| `exec` (any CLI) | restarts the process | not available | full run |

Anything that can be started from a command line and handed a prompt works
through `exec`. An IDE-only agent with no headless mode can't be driven at all.
Details are in [docs/USAGE.md](docs/USAGE.md#which-agents-this-works-with).

## Documentation

- [docs/FINDINGS.md](docs/FINDINGS.md): every experiment run so far, with the
  numbers and what they do and don't show.
- [docs/USAGE.md](docs/USAGE.md): the leaderboard, judging, the protocol every
  agent is told, recovering interrupted runs, writing briefs, and running your
  own comparison.
- [docs/METRIC.md](docs/METRIC.md): exact definitions, conventions and edge
  cases, and where the metric comes from.

## Caveats before you quote a number

- **One run is not a measurement.** The same agent on the same brief has varied
  by 0.17 AUC and by 45s of first render across three repeats. Report a median
  and its range.
- **Check the shape before trusting an AUC.** When every curve is a step, AUC
  is just final score and first render in disguise. `p2p trajectory` says
  whether that is the case.
- **Judges differ at the margin**, and a stricter one can turn a step into a
  curve. Runs scored by different judges are refused in one ranking.
- **The protocol is part of the measurement.** Every agent gets the same
  instructions appended to the brief, saved as `prompt.txt`. Runs given
  different instructions are ranked separately.
- **AUC only compares at equal horizon**, and **the poll interval is the
  resolution floor** (±1s on cold start).

The full list is in [docs/METRIC.md](docs/METRIC.md#known-limits).

## Tests

```bash
npm run typecheck
npm test             # unit tests, no browser needed
npm run test:e2e     # real browser, real runs, real CLI invocations
```

## License

Apache-2.0
