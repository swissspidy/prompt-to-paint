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

### What a frame is scored on

A frame is a **viewport screenshot** — 1280×800 by default, no scrolling — and
the text inside that same rectangle. The judge is told to credit only what it
can see, and entity coverage counts only what it could have seen, so "on screen"
means one thing across the whole metric. `target.viewport` is how a brief says
how much of the page it means to score.

### Two numbers fall out of the curve

- **Time to first render** — the first frame that is not an error page, an empty
  body, or a loading spinner.
- **Time to first *reviewable* render** — the first frame a human could give
  useful feedback on. Operationalised as "enough of the things the brief named
  are on screen", so it is judgeable rather than vibes.

### And one that deliberately does not

- **Time to tab title/icon** — the first frame where the browser chrome
  identified the app, however empty the viewport still was. An app whose
  `index.html` sets `<title>` and a favicon says "Orbit" in the tab while the
  page is still a grey rectangle, and that is real evidence to the person
  waiting that the right thing is starting.

  It is reported beside the render times and **never folded into them**. A
  titled blank page is still a blank page to someone waiting to react to it, so
  letting this move a frame's class would change every AUC ever recorded. It is
  also invisible to the judge by construction: browser chrome is not in the
  screenshot. A title Chromium derived from the address — what a document with
  no `<title>` gets — does not count, or every blank page would trip it.

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

**Wall clock alone would misattribute this.** One tool call behind an
eleven-second Vite rebuild and nine tool calls of flailing produce the same
"correct change" number, so ranking on it charges the model for a slow dev
server. Each edit therefore also records what the agent did — tool calls, their
names, thinking time, and the toolchain phases that ran inside the window — plus
**`afterAgentMs`**, the gap between the agent finishing and the change reaching
the screen. That gap is the part the agent is not accountable for:

```
  Iteration (prompt -> visible change)   [live-session]
    header-blue      first change    7.2s   correct    7.2s
                     1 tool call  ·  thinking 7.0s  ·  0.2s waiting on the toolchain after the agent finished
```

Tool calls read `--` rather than `0` when the adapter's stream cannot show them:
"it made none" and "we could not see" are opposite claims about an agent.

**If the check was already true before the prompt**, the edit is void, not fast
— an agent that happened to build a blue header during cold start makes
`header-blue` unmeasurable, and the run says so instead of reporting a
near-instant success for a change nobody made. See
[docs/METRIC.md](docs/METRIC.md#a-check-that-was-already-true).

## Quickstart

Requires **Node 24 or newer**. `.nvmrc` pins `lts/*`, so `nvm use` picks up a
supported release without this file having to be edited every six months.

Node strips the TypeScript types itself, so there is no build step, no bundler
and no loader: the CLI is run directly with `node src/cli.ts`, and
`tsconfig.json` sets `erasableSyntaxOnly` so syntax Node cannot strip fails
typechecking rather than only failing at runtime.

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

# rank runs by trajectory and by final score, side by side
npm run p2p -- compare runs/*/result.json

# the same ranking, with every run replayed side by side on one clock
npm run p2p -- leaderboard runs/*/result.json

# one run is not a measurement -- report a median and its range
npm run p2p -- run --brief briefs/todo-app.json --adapter claude-code --unsafe --repeat 5
```

Each run writes a directory containing `result.json` (every frame, phase and
event), `report.html` (curve, decomposition, filmstrip), `frames/` (one
screenshot per distinct visual state), `prompt.txt` (the exact text the agent
was given), `run.json` and `frames.ndjson` (the timeline as it happens — see
[Recovering an interrupted run](#recovering-an-interrupted-run)), `phases.jsonl`
and `agent.log`. With `--video`, also `video.webm`.

`result.json` holds the whole run: cold-start frames and, when the brief has
iterations, the frames captured while those edits landed. Each carries a
`phase`. **Only `cold` frames are judged, charted or ranked** — an edit like
"make the header blue" answers a different question from the brief, and scoring
it against the brief's rubric would blend two measurements into one number. The
iteration frames are kept so the run can be replayed in full.

**`frames/` is not the timeline and cannot be replayed as one.** Consecutive
identical screenshots share a file, so a forty-observation run can hold four
PNGs; stitching the directory listing gives a four-frame video in which a blank
minute and a finished app get equal screen time. A long run whose page barely
moved is the extreme case — 1300 observations of a page that changed three times
is three PNGs, and that is deduplication working, not captures going missing.
The timeline is in `result.json`, where every observation carries its own `tMs`:

```bash
npm run p2p -- video runs/todo-app-claude-code-abc123
```

`p2p video` rebuilds it — each image held until the next observation, and the
stretch before the first one left blank rather than back-filled with the first
frame, which would claim the app was on screen before anything had been looked
at. It shells out to `ffmpeg`, and prints the command to run by hand if there
isn't one. `--to-horizon` pads every video to the brief's horizon so two runs
come out the same length and can be played side by side.

`--unsafe` passes `--dangerously-skip-permissions` to Claude Code. Without it an
agent that needs to run commands will stall waiting for approval. **Sandboxes
only.**

The CLI refuses to bypass permissions when running as **root**, so a
containerised harness should run as a non-root user. For briefs that only need
file writes (`static-page`), `--permission-mode acceptEdits` works as root. If
an agent dies on startup the report says so in a banner rather than quietly
reporting a 0.000 — a failed launch and an agent that built nothing produce
identical numbers otherwise.

## Watching a run happen

A run is several minutes of an agent working somewhere else, so the CLI shows a
live status line: elapsed time against the horizon, what is on screen right now,
how much of the brief is visible, how many frames have been captured, and what
the agent last did — with how long ago, which is the number that separates
"working" from "wedged".

```
  02:14/08:00  ·  ● rendering  ·   71% of brief on screen  ·  134 frames / 19 distinct  ·  tool: Write (00:08 ago)
```

`--headed` shows the prober's browser window so you can watch the page being
built. `--video` records the whole session to `video.webm` through Chromium's
screencast — real video, no ffmpeg — at the cost of a little more browser work
during the run, which is why it is opt-in.

## The leaderboard

```bash
npm run p2p -- leaderboard runs/*/result.json --out runs/leaderboard.html \
  --title "Greenfield task board, five agents"
```

One page with the ranking table, the overlaid curves, and **every run replayed
side by side on a single shared clock** — play, pause, scrub, 1x to 30x. At any
instant you see what each agent had on screen at that moment, its score, and
whether it was still serving an error page.

The players are driven by the same frames the scores were computed from, so the
table and the pictures cannot disagree: a run that wins on area under the curve
is visibly ahead at the four-minute mark, and if it is not, the number is wrong
and this is where you notice.

Runs must share a brief and a horizon; the command refuses to rank runs that do
not, because AUC has the horizon in its denominator.

### Told versus not told

A run measured with `--no-render-early` answers a different question from one
measured without it: whether the agent renders early *unprompted*, rather than
how fast it does so *when asked*. Feed both to `p2p leaderboard` and it ranks
each condition separately — never as one table, which would be a ranking of two
different experiments — and adds a paired row per agent showing what the
instruction was worth:

```
  What the instruction was worth  (same agent, same brief, told vs not told)
  run                       AUC told  not told    delta  first render
  ----------------------------------------------------------------------------
  demo-agent                   0.937     0.691   +0.247  9.9s sooner
```

A large delta says the agent can render early but does not think to. A delta
near zero is the more interesting result: the ranking would look the same
without the instruction, so the headline number is measuring the agent rather
than its instruction-following.

## What every agent is told, and how a run ends

Every brief is handed to the agent with the same block appended, identically,
for every agent. It is part of the measurement rather than a hint to one of
them, and the exact text sent is saved as `prompt.txt` beside the result. It
says: a browser is already watching this URL and screenshots it every second;
get something on screen early and refine it in place; start the dev server in
the background; and create an empty `.p2p-done` when you consider it finished.

Each of those exists because leaving it out broke a run:

- **"Render early"** replaced "when the app is ready to look at, serve it",
  which asked for precisely the behaviour this metric is built to catch — a
  blank page for the whole run, and a first frame that is already the finished
  app. Telling every agent the clock is running is the fair version of that
  instruction. `--no-render-early` drops the clause and measures unprompted
  behaviour, which is a different experiment; the two are not comparable as one
  ranking, but they are worth measuring together — see below.
- **"Background the server"** because a dev server in the foreground never
  returns, so the agent's turn never completes.
- **`.p2p-done`** because a turn that never completes left the horizon as the
  only way for a run to end. The sentinel works for every adapter, including
  the ones whose event stream this harness can only partly read.

The window closes on whichever comes first: the agent's turn completing
(`turn`), the sentinel appearing (`signal`), **quiescence** (`quiet`), or the
horizon (`horizon`). The reason is recorded with the result and printed by
`p2p leaderboard`, because a run the agent finished and a run that was cut off
are not the same measurement.

Quiescence is the backstop for an agent that ignores the sentinel: no visible
change, no agent output, and no shimmed command running, all at once, for
`--quiet-for` seconds (default 120, `0` to disable), with something already on
screen. All three signals are required because each one alone has a false
positive that would cut a working run short. Ending early cannot change the AUC
— the curve holds its last value to the horizon regardless — but it can miss a
late improvement, so a `quiet` run says so in its caveats.

## Judging

Frames are scored against per-brief rubrics of binary, screenshot-answerable
criteria — "are three columns visible", not "rate this 0-10" — so scores are
auditable and reasonably stable.

Every judge reaches the model through the [AI SDK](https://ai-sdk.dev), so the
provider is just part of the model name:

```bash
# the default judge
npm run p2p -- run --brief briefs/todo-app.json

# judge with Gemini instead -- needs GOOGLE_GENERATIVE_AI_API_KEY
npm run p2p -- run --brief briefs/todo-app.json --judge google:gemini-2.5-flash
```

| provider | key |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` (also honours `ANTHROPIC_BASE_URL`) |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

`--judge` is the whole judging surface: a `<provider>:<model>` pair, defaulting
to `anthropic:claude-sonnet-5`, or `none` to turn scoring off — scores then
degrade to entity coverage, and every report says so. There is no backend to
choose, because one transport for every provider is what makes two judges
comparable: they differ in that one string and nowhere else in this code.

A judge must name its provider. A bare `claude-sonnet-5` is an error rather
than a guess, and a provider whose key is missing fails before the run starts
rather than once per frame, after the minutes it takes to measure one. Adding a
provider is a line in `AI_SDK_PROVIDERS`. `result.json` records the judge as
`google:gemini-2.5-flash` rather than a bare model name — **different judges
disagree at the margin, so a leaderboard should not mix them.** Two judges also
get separate verdict caches, so re-scoring one run with a second judge measures
their disagreement instead of replaying the first one's answers.

This replaced an earlier pair of flags:

| before | now |
|---|---|
| `--judge-model google:gemini-2.5-flash` | `--judge google:gemini-2.5-flash` |
| `--judge-model claude-sonnet-5` | `--judge anthropic:claude-sonnet-5` |
| `--judge api`, `--judge cli`, `--judge auto` | omit `--judge` |
| `--judge none` | unchanged |

Judging runs **after** the run finishes, from saved screenshots — scoring during
the run would put model latency inside the window being measured. Only visually
distinct frames cost a call; the rest inherit by forward-fill. `p2p rescore`
re-scores a finished run without re-running any agent, which is also how you
measure judge variance, and how you score a run whose judging was interrupted.

Because judging happens after teardown, the browser closes minutes before the
scores land. `result.json` is therefore written **twice**: once with the
complete timeline and provisional scores (`judge.pending: true`), and again with
the real scores when the judge returns. An interrupted or failed scoring pass
leaves a run that still replays and still rescores, rather than no run at all.

A judge is also checked **before** the run rather than after it. `--judge` names
a provider and a model, and only the provider knows whether that model exists,
so the harness sends it one 1×1 pixel and quotes whatever comes back:

```
error: the judge "google:gemini-3.5-flash-low" did not answer a test request.

  models/gemini-3.5-flash-low is not found for API version v1beta

  The provider was sent that model id exactly as written, so a typo, a model that has
  been renamed, and one your key cannot reach all look like this.
```

Without that check a misspelled model is discovered at the end of a fifteen
minute run, as one failure per frame. The scoring pass itself gives up after
three failures with no successful call, for the same reason.

Calls are made at **temperature 0**, and verdicts are cached in `.p2p-cache/`
(override with `P2P_CACHE_DIR`) keyed by the brief, the rubric, the judge, and a
SHA-256 of the screenshot's bytes. `--max-judged` caps model calls per run
(default 60) and `--judge-width` sets the width screenshots are downscaled to
before sending. See [docs/METRIC.md](docs/METRIC.md#the-verdict-cache) for why
the key is the bytes and not a perceptual hash.

Runs that are not on one scale refuse to be ranked together — different
horizons, briefs, judges, judge temperatures, viewports, judged-vs-unjudged,
prompted-vs-unprompted, or a run whose judging never finished. See
[what may be ranked together](docs/METRIC.md#what-may-be-ranked-together).

## Recovering an interrupted run

`result.json` is assembled once, after the browser and the agent are torn down.
Until then the timeline lives only in the harness's memory, so anything that
kills the process — a Ctrl-C, an OOM, the harness [killing its own
port](#freeing-a-port) — used to leave a `frames/` directory full of screenshots
with no record of when any of them were taken.

Two files are now written *while* the run happens: `run.json` (which brief,
which agent, which clock) and `frames.ndjson` (one line per observation, plus a
marker for the end of the cold-start window and one per completed iteration).
They cost one append per frame and they are on disk the moment each frame is:

```bash
npm run p2p -- salvage runs/todo-app-antigravity-abc123
```

That rebuilds `result.json` and `report.html` from the frame log, after which
`p2p video` and `p2p rescore` work normally. A salvaged run is explicitly not a
complete one and says so in its warnings: the agent's event stream and the
toolchain phases were never on disk, so it has a timeline and no latency
decomposition, and its scores are entity coverage until you follow up with
`p2p rescore`.

## Freeing a port

A dev server the agent started is not reliably killed by killing the agent, and
a survivor would corrupt the next run: the harness would find something already
serving and report a near-zero first render for an app the agent never built. So
the port is cleared at teardown, and `--kill-port` clears it at startup too.

Clearing it means **listening sockets only**. `lsof -i tcp:5173` matches every
socket with that number at either end, which includes every *client* of the port
— and the harness polls the app under test once a second, so it is always one.
Piping that list into `kill -9` made the harness SIGKILL itself during teardown:
the run died immediately after its last measured frame, losing `result.json`,
the judging pass and the report, and printing `Killed: 9` with no explanation.
It only reproduced on macOS, which has no `fuser` and fell through to the `lsof`
line; Linux has `fuser`, which matches local ports only, so CI never saw it.
The lookup now filters to `LISTEN` state and refuses to signal this process or
any of its parents, whatever a tool reports.

## Antigravity and the scratch folder

`agy` runs a conversation that is not in a **Project** in "an isolated local
scratch folder", and a child-process cwd alone does not bind one. An unbound run
looks almost right — the agent builds an app, its dev server serves it, the page
renders and the curve is a curve — while the workdir the harness handed over
stays empty and nothing in the run directory reproduces what was measured. It
turns up as `~/.gemini/antigravity-cli/scratch/<name>/`.

The adapter passes `--add-dir <workdir>` by default. That is the narrower of the
two plausible mechanisms — it names a directory rather than creating persistent
state — but Antigravity's published headless documentation describes neither it
nor the Project flags, so it is a default, not a certainty. To try the other:

```bash
npm run p2p -- run --brief briefs/todo-app.json --adapter antigravity   --no-add-dir --agent-arg --new-project
```

**The run checks the outcome either way.** `agy` reports a `cwd` in its `init`
event; the harness compares it to the directory it handed over and fails the run
loudly when they differ, rather than leaving it to be discovered from an empty
workdir afterwards:

```
! AGENT WORKED SOMEWHERE ELSE: it reported its working directory as
  /Users/you/.gemini/antigravity-cli/scratch/orbit, not the runs/…/workdir it was
  given. Whatever this run measured was built outside the run directory, so
  nothing here reproduces it.
```

## Which agents this works with

The harness talks to agents through adapters. The curve, both latency numbers,
and every toolchain phase the shims catch are valid for any agent that can be
started from a command line. What varies is how much of the agent's internals
its event stream exposes, and whether a follow-up prompt continues a session or
restarts the process.

| adapter | curve + TTFR | toolchain phases | model vs tool split | iteration | verified |
|---|---|---|---|---|---|
| `claude-code` | yes | yes | inferred from messages | live session | full run |
| `pi` | yes | yes | **exact** tool spans | live session | wire format + harness run |
| `antigravity` | yes | yes | best-effort, self-reported | live session | docs only |
| `exec` (any CLI) | yes | yes | none → residual | restart | full run |
| `scripted` | yes | yes | synthetic | live session | full run |

```bash
npm run p2p -- run --brief briefs/todo-app.json --adapter pi \
  --provider anthropic --model claude-sonnet-5

npm run p2p -- run --brief briefs/todo-app.json --adapter antigravity \
  --model gemini-3.8-flash-high --unsafe

npm run p2p -- run --brief briefs/todo-app.json --adapter exec \
  --command 'some-agent exec --cd {{WORKDIR}} {{PROMPT}}'
```

**Pi** runs through `--mode rpc`, which is bidirectional, so follow-up prompts
go into the live session. Its `tool_execution_start`/`_end` events are keyed by
call id, giving *exact* tool spans rather than the boundaries this harness has
to infer for agents that only emit messages — the best decomposition of any
adapter here. Note Pi defaults to the `google` provider; pass `--provider` and
`--model` for a reproducible run.

**Antigravity** runs through `agy --input-format stream-json --output-format
stream-json`, so follow-ups reuse the warmed conversation. Its outer events
(`init`, `step_update`, `result`) are documented but the contents of a step are
not, so the adapter probes for tool boundaries and **reports what it actually
found**: if it cannot identify them it declares `turns-only` fidelity and that
time goes to the residual rather than being booked as thinking. The harness also
raises `--print-timeout` to 30m, since `agy` defaults to 5m — well under a
realistic greenfield build.

### What "verified" means above

Being specific, because this matters more than the table:

- `claude-code`, `exec`, `scripted` — run end to end against real binaries.
- `pi` — flags checked against `@earendil-works/pi-coding-agent@0.85.1`, the RPC
  wire format captured from the running binary, and a full harness run
  completed. That run had no provider credentials, so the model never did any
  work; everything around it (spawn, prompt submission, turn completion,
  error reporting) is exercised.
- `antigravity` — written from the published headless docs. **Not run against a
  binary**, because Antigravity ships through Google's installer rather than
  npm. Treat the first run as a smoke test and read `agent.log` if the stream
  looks empty.

Capturing the Pi wire format immediately found two bugs that the docs alone
would not have: `message_end` fires for the user's own prompt as well as the
assistant's reply, and a failed turn still streams cleanly with
`stopReason: "error"` — which without a check would have reported an auth
failure as an agent that simply built nothing. Expect the Antigravity adapter
to need the same treatment on first contact with a real binary.

**An IDE-only agent with no headless mode cannot be driven by this harness at
all.** That is a hard limit: the design assumes something startable from a
command line and handed a prompt.

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

**An iteration check reads text the way the browser renders it.**
`document.body.innerText` is the *rendered* text, so CSS decides its case: a
column header styled `text-transform: uppercase` reads `BLOCKED`, and
`.includes('Blocked')` is then false on a page that plainly shows the column.
That is not a hypothetical — it is how the bundled `add-column` check reported
`NEVER LANDED` for an edit visible in the screenshot beside it. Match
case-insensitively (`/\bblocked\b/i.test(...)`), which is what entity coverage
has always done, or read `textContent` if you mean the source text rather than
what is on screen. A check that decides a headline number should fail only when
the edit did.

## Tests

```bash
npm run typecheck    # also enforces that Node can strip every construct used
npm test             # unit tests, no browser needed
npm run test:e2e     # real browser, real runs, real CLI invocations
npm run test:all     # all of the above, the same order CI uses
```

The end-to-end suite is the one that matters. It drives a real Chromium against
real runs and asserts on the metric itself: the calibration recovers a curve
whose AUC was integrated by hand, a stand-in third-party CLI agent is measured
through `exec`, and the failure modes are checked for being *loud* — a crashed
agent, a missing binary, and an iteration whose check was already satisfied all
have to report themselves rather than return a tidy zero. It also runs the CLI
the way a person does, as a subprocess.

CI runs all of it on the version in `.nvmrc`, which is the same file `nvm use`
reads — so it tests what a contributor is actually running, and the next LTS
cutover needs no edit to the workflow. A second job audits the workflows
themselves with [zizmor](https://docs.zizmor.sh), so the hash-pinned actions and
least-privilege permissions stay that way rather than decaying at the next hand
edit; Dependabot proposes the bumps weekly, grouped so a package and its type
definitions arrive in one pull request.

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
- **On screen means in the viewport.** The judge scores a 1280×800 screenshot
  with no scrolling, and entity coverage counts only text inside that same
  rectangle, so both halves of the metric agree. A brief that means to score
  more of the page says so with `target.viewport`; `landing-page` runs at
  1280×2400 because its rubric asks for a pricing section and a footer.
- **Judges are scored at temperature 0 and cached by screenshot bytes.** Runs
  scored by different judges refuse to be ranked together.
- **The protocol suffix is part of the measurement.** These numbers describe
  agents that were told a browser is watching and asked to render early. That
  is a fair instruction because every agent gets it verbatim, but it is not the
  same as measuring what an agent does unprompted.
- **A run ended by quiescence could have missed a late improvement.** It never
  changes the AUC, since the curve holds forward either way, and the report
  names the runs it happened to.
- **Ctrl-C tears down properly.** The browser, the agent and its dev server are
  stopped on `SIGINT`/`SIGTERM`/`SIGHUP`, because a leaked dev server on the
  target port is what gives the *next* run a near-zero first render for an app
  nobody built. Playwright's own signal handlers are disabled so they cannot
  pre-empt that; see [docs/METRIC.md](docs/METRIC.md#interrupting-a-run).

Full definitions, conventions and edge cases: [`docs/METRIC.md`](docs/METRIC.md).

## License

Apache-2.0
