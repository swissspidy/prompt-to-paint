# prompt-to-paint

Measures how long an agent takes to put something on screen that a human can
react to — and where that time actually goes.

This is not "can it build a working app". Plenty of benchmarks answer that, and
they all answer it with a single number scored at the end. The question here is
**first-meaningful-paint for agent output**: how long until there is something to
look at, and how good it gets, over time.

That is a different metric, and it produces a different ranking.

## The idea

Don't score the run once at the end. Poll a headless browser every second
during the run, screenshot every frame, and score each frame against the brief.
What comes out is a **correctness-over-time curve**, and the area under it is the
headline number.

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

Both agents finish at 0.9. Agent A renders something crude at 20s and refines
it; agent B shows a blank page for four minutes and then nails it. On final
score they tie. On area under the curve it is **0.787 vs 0.540**, and A wins by
a lot — because A gave a human something to react to three and a half minutes
earlier.

That comparison is pinned as a test, not a claim: `test/curve.test.ts`.

### Two numbers fall out of the curve

- **Time to first render** — the first frame that is not an error page, an empty
  body, or a loading spinner.
- **Time to first *reviewable* render** — the first frame a human could give
  useful feedback on. Operationalised as "enough of the things the brief named
  are on screen", so it is judgeable rather than vibes.

## Where the time actually goes

Wall clock is decomposed into model thinking, tool round trips, dependency
install, build, dev-server boot, and first paint. Every millisecond lands in
exactly one bucket, and whatever cannot be attributed is reported as
**unaccounted** rather than quietly absorbed.

The buckets come from two sources: PATH shims that wrap package managers and
bundlers, and the agent's own event stream stamped on arrival. Where those
overlap — `npm install` runs inside a tool call, which runs inside a turn — a
documented priority order decides who is charged.

The ordering that matters most is that **first paint is charged last**. The gap
between "server answers" and "something renders" is usually the agent still
writing the app; charging that to the toolchain would manufacture the exact
result this harness exists to test. Ranked last, it collects only genuinely idle
time.

**There is a control.** `p2p floor` runs the same measurement with no model in
the loop — scaffold, install, boot, paint. Without that denominator, "the
toolchain dominates and model differences are noise" is not a finding, it is a
vibe. With it, you can say how much of the latency was ever available to win.

## Iteration is measured separately

Cold start and the edit loop are different metrics and rank differently. Once
something renders, the harness injects a follow-up prompt — "make the header
blue" — into the **same live session** and times it:

- **first change** — any visible movement, which is what makes an edit feel live
- **correct change** — the edit actually landed, decided by an in-page predicate
  shipped with the brief, not by a judge
- **broken for** — how long the app was white-screened in between

## Quickstart

```bash
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

# rank runs by trajectory and by final score, side by side
npm run p2p -- compare runs/*/result.json

# one run is not a measurement -- report a median and its range
npm run p2p -- run --brief briefs/todo-app.json --adapter claude-code --unsafe --repeat 5
```

Each run writes a directory containing `result.json` (every frame, phase and
event), `report.html` (curve, decomposition, filmstrip), `frames/` (every
screenshot), `phases.jsonl` and `agent.log`.

`--unsafe` passes `--dangerously-skip-permissions` to Claude Code. Without it an
agent that needs to run commands will stall waiting for approval. **Sandboxes
only.**

The CLI refuses to bypass permissions when running as **root**, so a
containerised harness should run as a non-root user. For briefs that only need
file writes (`static-page`), `--permission-mode acceptEdits` works as root. If
an agent dies on startup the report says so in a banner rather than quietly
reporting a 0.000 — a failed launch and an agent that built nothing produce
identical numbers otherwise.

### Judging

Frames are scored against per-brief rubrics of binary, screenshot-answerable
criteria — "are three columns visible", not "rate this 0-10" — so scores are
auditable and reasonably stable. Three backends:

| backend | when |
|---|---|
| `api` | `ANTHROPIC_API_KEY` is set. Parallel and cheap; the default when available. |
| `cli` | falls back to a signed-in local `claude`. No key needed. |
| `none` | no model. Scores degrade to entity coverage, and every report says so. |

Judging runs **after** the run finishes, from saved screenshots — scoring during
the run would put model latency inside the window being measured. Only visually
distinct frames cost a call; the rest inherit by forward-fill. `p2p rescore`
re-scores a finished run without re-running any agent, which is also how you
measure judge variance.

## Running the actual experiment

The interesting hypothesis is that on greenfield tasks the toolchain dominates
and model differences are noise. Here is how to settle it rather than assert it.

**1. Establish the floor.** Nothing here is an agent; this is what the toolchain
costs on its own.

```bash
npm run p2p -- floor --template vite-react --port 5242 --kill-port
npm run p2p -- floor --template static      --port 5242 --kill-port
```

On the machine this was developed on, `vite-react` first paints at **13.5s on a
cold npm cache and 6.8s on a warm one** — scaffold, install, dev-server boot and
first request, with no model involved at all. That is the budget no agent
choosing that stack can beat.

That 2x spread from cache state alone is worth noticing before ranking
anything: if it exceeds the gap between two agents, you are measuring the
machine, not the model. Run the floor on the same box, in the same cache state,
in the same session as the agents you are comparing.

**2. Measure agents on the same brief, repeatedly.**

```bash
for m in opus sonnet haiku; do
  npm run p2p -- run --brief briefs/todo-app.json --adapter claude-code     --model "$m" --label "$m" --unsafe --repeat 5 --kill-port
done
```

**3. Read the answer off three places.**

- **Time to first render vs the floor.** If every agent lands within a second or
  two of the floor, the toolchain set the pace and the model choice did not.
- **The agent/toolchain split** in each report. If `install + build +
  devserver_boot + first_paint` dwarfs `model + tool_overhead`, same conclusion —
  provided attribution coverage is high enough to trust, which the report states.
- **The range across repeats.** If the spread within one model overlaps the gap
  between two models, there is no ranking yet, only noise. The aggregate output
  says so explicitly when the AUC range exceeds 0.15.

A null result here is worth as much as a positive one: "the thing everyone is
optimising is not the bottleneck" is only credible with the floor to compare
against, which is why the control ships with the harness rather than as an
afterthought.

## Writing a brief

```jsonc
{
  "id": "todo-app",
  "prompt": "Build a task board called \"Orbit\"...",
  "horizonSec": 480,
  "reviewableThreshold": 0.5,
  "entities": [                     // mechanical: is it on screen?
    { "id": "app-name", "aliases": ["Orbit"], "weight": 2 }
  ],
  "rubric": [                       // judged: binary, from a screenshot alone
    { "id": "three-columns",
      "description": "Three distinct columns labelled Todo, In Progress and Done.",
      "weight": 2 }
  ],
  "iterations": [
    { "id": "header-blue",
      "prompt": "Make the header background blue.",
      "check": "/* JS evaluated in the page; truthy once it landed */" }
  ]
}
```

Briefs are validated strictly on load. A malformed rubric fails in the worst
possible way — the run completes and produces a plausible number that means
nothing — so an empty rubric is an error, not a default.

## Caveats worth knowing before you quote a number

- **The poll interval is the resolution floor.** Every latency figure carries
  ±1 interval of quantisation (1s cold start, 250ms iteration).
- **One run is not a measurement.** Agent runs vary a lot. Repeat and report a
  distribution; this harness gives you one run per invocation and does not
  pretend otherwise.
- **AUC only compares at equal horizon.** The horizon is in the denominator.
  `compare` refuses runs that disagree on it.
- **Low attribution coverage invalidates the split, not the curve.** If an agent
  shells out through something the shims do not wrap, the report says the
  decomposition is untrustworthy. The curve and wall clock stay valid.
- **Entity coverage is text-only** — it cannot see text baked into images,
  canvas, or shadow DOM.

Full definitions, conventions and edge cases: [`docs/METRIC.md`](docs/METRIC.md).

## License

Apache-2.0
