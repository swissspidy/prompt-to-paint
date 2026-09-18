# The metric, precisely

Everything here is a choice that changes rankings. None of it is obvious, so all
of it is written down.

## The curve

A run produces a correctness function `c(t)` over `[0, H]`, where `H` is the
brief's horizon. `c(t)` is a **step function** built from polled observations:

- `c(0) = 0`. Nothing is rendering at the start, and a run that has not begun is
  worth exactly what a blank page is worth.
- Each observation holds until the next one. We know the state at sample times
  only; holding forward is the assumption that nothing changed in between, which
  is also what a person watching the tab would experience.
- After the run ends, the final value holds to `H`. The app keeps serving after
  the agent stops, so finishing early is rewarded by the integral without
  punishing the agent for having stopped.

**The headline number is the normalised area under that curve:**

```
AUC = (1/H) ∫₀ᴴ c(t) dt        ∈ [0, 1]
```

An agent that renders something crude at 20s and refines it beats one that shows
a blank page for four minutes and then nails it, even when their final scores
tie. That is the entire point, and `test/curve.test.ts` pins it with the worked
example: 0.787 versus 0.540 on a 600s horizon.

### AUC is only comparable at equal horizon

`H` is in the denominator. A run scored against a 300s horizon cannot be
compared to one scored against 600s — halve the horizon and every AUC moves.
`p2p compare` refuses to rank runs whose horizons differ.

## Scoring a frame

`c(t)` at a judged frame is the **weighted fraction of rubric criteria met**:

```
score = Σ weightᵢ · met(criterionᵢ) / Σ weightᵢ
```

Criteria are binary and written to be answerable from a screenshot alone. This
is deliberate. Asking a judge to "rate this 0-10" produces a number that drifts
between calls and cannot be audited; asking "are three columns visible, yes or
no" produces one that can be checked by looking at the frame. Partial progress
is expressed by meeting fewer criteria, never by hedging on one.

Frames classified `blank`, `error`, or `unreachable` score 0 without a model
call — both correct and a large cost saving.

### Which frames get judged

Polling at 1Hz for ten minutes yields hundreds of frames, but a build passes
through a few dozen distinct visual states. A frame is judged when it differs
from the last judged frame either **structurally** — 64-bit difference hash
more than `distinctThreshold` (default 6) bits apart — or **in colour**, by
worst-cell distance over a 16x16 RGB grid (default 14/255).

Colour is checked separately because the difference hash is computed on
luminance and is therefore blind to recolouring. Measured on a real page whose
heading was restyled from black to blue: **the difference hash moved 0 bits.**
Not a few, none. Structural hashing alone would have called those two frames
identical.

Everything in between inherits its score by forward-fill, labelled
`scoreSource: "forward-fill"`, so the provenance of every point on the curve is
visible in the result JSON.

The final rendering frame is always judged, so a run that drifts slowly into a
broken state cannot escape by never tripping the threshold.

**Judging runs strictly after the run finishes.** This is not an implementation
convenience: scoring during the run would put model latency and CPU load inside
the window being measured.

## The two derived numbers

**Time to first non-blank render (TTFNBR)** — the first frame classified
`render`. Classification is mechanical, never a model call, because both derived
numbers key off it and they have to be reproducible.

A frame is `blank` only when text, pixels, and media all agree it is empty: body
text under 8 characters, ink ratio under 0.004, and no image/svg/canvas/video
with a box bigger than 8×8. Any single signal alone produces false blanks — an
image-only hero has no text, a text-only page has almost no ink.

A pure loading placeholder (`Loading…`, `Please wait`) counts as **blank**, not
as a render. Otherwise an SSR shell that ships a spinner would win this metric
without showing anyone anything. Set `loadingIsBlank: false` to disagree.

A frame is `error` on a 4xx/5xx, on a known dev-server overlay
(`vite-error-overlay`, `#nextjs__container_errors`, the webpack overlay, …), or
on error text that dominates an otherwise empty page. Error *text* is only
trusted under 600 characters, so an app that legitimately renders the word
"error" in a form is not mistaken for a crash.

**Time to first reviewable render (TTFRR)** — the first `render` frame whose
weighted entity coverage reaches `reviewableThreshold`. Entities are the things
the brief named; coverage is a word-boundary text match over the rendered DOM.
Mechanical on purpose: "could a human give useful feedback on this" becomes
"are enough of the named things on screen", which is reproducible across runs
and judges.

### The tab, which is not one of them

**Time to first tab signal** — the first frame where `document.title` was
something other than the address Chromium falls back to, or the page declared a
`<link rel="icon">`. Recorded per frame as `tabSignal`, surfaced once as
`curve.firstTabSignalMs`.

It sits outside `classify()` on purpose, and nothing downstream of it moves:

- A titled blank page is still a blank page. Someone waiting for something to
  react to cannot react to a tab, so counting it as a render would move TTFNBR,
  the curve and every AUC ever recorded — including the ones in this repository's
  own calibration fixtures.
- The judge cannot see it either way. Browser chrome is outside the viewport, so
  it is absent from the screenshot by construction; a frame scored 0 for being
  empty is scored 0 whatever its tab says.

What it is good for is the gap. `firstTabSignalMs` well before `ttfnbrMs` is a
dev server that booted and served an `index.html` whose app has not mounted yet
— the difference between "nothing is happening" and "the bundle is still
building", which are indistinguishable in the screenshot and very different to
the person watching.

A title the browser derived from the URL (`127.0.0.1:5173`, which is what a
document with no `<title>` gets) is not a signal. Counting it would fire on
every blank page ever served, including the error page shown before anything is
listening.

### On screen means in the viewport

One rule, applied to both halves of the metric.

The judge scores a **viewport screenshot** — 1280×800 by default, no scrolling —
and its prompt says to credit only what is visible. Entity coverage used to read
`document.body.innerText`, the entire document, fold or no fold. So the two
halves disagreed: a page whose content sat below 800px could be called
*reviewable* by one and empty by the other, and TTFRR could fire on text nobody
could see without scrolling.

Now the text a frame records is the text inside the viewport. A text node that
wraps is measured **word by word**, not as a whole: a paragraph can begin inside
the viewport and run past the fold, and crediting all of it because its first
line is visible would put an entity nobody can see back into `ttfrrMs` — the same
confusion between "in the DOM" and "on screen", one node lower down. `classify` and `entityCoverage` both read
it, so the judge, the render classification and the reviewability threshold all
mean the same thing by "on screen".

`offscreenTextChars` records what was left out, and a run says so when it
matters. When *nothing* is in frame the warning is emphatic, because that case
is invisible otherwise: every frame is blank, coverage is 0, the judge gets an
empty screenshot, and the run reads as an agent that built nothing when it built
something nobody was shown.

**A brief sets how much page is in scope** with `target.viewport`. That is not a
thumb on the scale, it is the brief saying what it means to score. The bundled
`landing-page` brief asks for a pricing section and a footer; on a normally
proportioned marketing page those sit well below 800px, so through a
laptop-sized window three of its ten rubric points were unwinnable however good
the page was — a cap on the achievable AUC indistinguishable from an agent doing
badly. It runs at 1280×2400.

## Latency decomposition

Wall clock is partitioned so every millisecond lands in exactly one bucket.
The intervals genuinely nest — `npm install` runs inside a Bash tool call, which
runs inside the agent's turn — so **priority decides who is charged for the
overlap**:

```
install > build > devserver_boot > model > tool_overhead > first_paint
```

- `install`, `build`, `scaffold` come from PATH shims that record start and end
  timestamps around package managers and bundlers.
- `devserver_boot` is the wait from launching a dev server until it first
  answers an HTTP request — not the server's lifetime, which is not blocking.
- `model` and `tool_overhead` come from the agent's event stream, stamped on
  arrival at the harness. `model` spans the wait until an assistant message
  lands (inference + generation + network); `tool_overhead` spans until every
  tool that message requested has reported back. Parallel tool calls close as a
  batch, since the agent is blocked until the slowest returns.
- `first_paint` is **last on purpose.** The window between "server answers" and
  "something renders" is usually the agent still writing the app. If
  `first_paint` outranked `model`, that work would be charged to the toolchain
  and the harness would manufacture the very result it exists to test. Ranked
  last, `first_paint` collects only time nothing else claims: server up, agent
  idle, screen still empty — genuine toolchain and browser latency.
- `residual` is whatever is left. **It is always reported.** Below 85% coverage
  the report says outright that the split is not trustworthy, which is what
  happens when an agent shells out through a command the shims do not wrap.

Adapters declare a **stream fidelity**, and only `full` earns a model/tool
split. `turns-only` means the agent's activity is visible but its tool
boundaries are not — the Antigravity adapter reports this when it cannot
identify tool events in a step payload — and that time goes to the residual
with a note. Guessing would be worse: an unidentified tool span silently
becomes "thinking", which is the exact distortion the priority ordering above
is designed to prevent.

An adapter that exposes no event stream (the `exec` wrapper, and the floor
control, which has no model at all) gets **nothing** attributed to `model` or
`tool_overhead`. That time goes to `residual`, and the report says the gap is
structural rather than a sign the shims missed something. Charging it to "model
thinking" would invent the very result this harness exists to test — an earlier
version did exactly that and reported 245s of model time for a control run with
no model in it.

### What the denominator excludes

Attribution is computed over **active** wall clock: the settle window, and the
wait after a control run first renders, are subtracted. The harness knows
exactly what was happening then — nothing — so charging its own deliberate
idling to `residual` would make a fast control run warn that its own split is
untrustworthy. The curve still covers that time; only the attribution
denominator excludes it, and the report states how much was excluded.

### Cross-check

When the adapter can supply the agent's self-reported API time, the report
prints it next to the attributed `model` time and their delta. Large
disagreement means the attribution is wrong and should be distrusted.

### The control

`p2p floor` runs the same measurement with **no model in the loop** — scaffold,
install, boot, paint. Without it, agents are only comparable to each other and
there is no way to tell whether any of them is near the floor set by the
toolchain. The question "is the model even the bottleneck?" needs this
denominator to be answerable at all.

## Iteration

Measured separately from cold start, and excluded from the cold-start curve —
turning the header blue is a different experiment, and scoring those frames
against the original brief would blend two measurements into one number.

How the follow-up is delivered depends on the adapter, and it changes what the
number means, so every iteration result records its `mode`.

- **`live-session`** (`claude-code` via stream-json on stdin, `pi` via RPC mode,
  `antigravity` via `--input-format stream-json`): the prompt goes into the
  running session, so what is measured is the edit loop a person sits in.
- **`restart`** (the `exec` adapter by default): the command is re-run. The
  timings then also contain process startup and however long the agent spends
  re-reading the project before it can act. That is a real cost of using that
  agent, but it is a different quantity, and the report says so rather than
  printing it next to a live-session number as though they were the same thing.

If a CLI can resume a session, put its resume flag in `iterationCommand` and
declare `iterationMode: 'live-session'`; the harness takes that claim at face
value, so only make it when it is true.

Three numbers, because they answer different questions:

- **Time to first change** — first frame visually different from the pre-prompt
  baseline, by structure *or* colour. This is what makes an edit feel
  responsive.

  The colour test uses the **worst cell**, not the average. On a real heading
  recolour the mean cell difference across the frame was 0.19/255 — a local
  change averaged over a whole page vanishes — while the worst cell moved 18.7.
  Thresholding the mean would miss essentially every small edit, including
  "make the header blue", which is the canonical one.
- **Time to correct change** — first frame where the iteration's in-page
  predicate passes, and keeps passing for `confirmFrames` frames. Mechanical, so
  "did the header actually turn blue" does not depend on a judge's mood. The
  confirmation window exists because HMR can flash a half-applied state.
- **Broken for** — time the app spent blank or erroring between prompt and
  correct change. White-screening the app for eight seconds mid-edit is a real
  cost that neither timestamp captures.

### Whose time was it?

Time to correct change is wall clock, and wall clock cannot tell two very
different runs apart. One tool call followed by an eleven-second Vite rebuild
and nine tool calls of flailing produce the same number, and ranking on that
number alone charges the model for a slow dev server.

So every edit also records, in `work`:

- **`toolCalls`** and **`toolNames`** — what the agent actually did. `null`,
  never `0`, when the adapter's stream does not expose tool boundaries: "it made
  none" and "we could not see" are opposite claims about an agent.
- **`modelMs`** / **`toolMs`** — thinking and tool execution inside the window,
  from the same attribution the cold-start decomposition uses.
- **`phases`** — toolchain commands the shims saw run inside the window, so a
  rebuild that straddles the end of an edit is visible as the cost it was.

and, beside it, **`afterAgentMs`** — the gap between the agent finishing its
turn and the change reaching the screen. This is the part of an edit's latency
the agent is not accountable for. It is signed: negative means the page updated
while the agent was still working, which is what a fast loop looks like.

Two bounds hold by construction, because breaking either produces a number that
is not merely wrong but impossible, which is how a split stops being believed:
attribution is clipped to the edit's window, and it stops at the agent's **last
event** rather than at the end of the window. Everything after that last event
is the page catching up, and it belongs to `afterAgentMs`.

### A check that was already true

If the iteration's predicate passes *before* the prompt is sent, the edit cannot
be measured: the first frame after the prompt would report a near-instant
success for a change the agent never made. That is a broken check, not a fast
agent, so the result is marked `baselineAlreadyPassing`, `ok` is false, and the
run warns.

An agent that happens to build a blue header during the cold start makes
`header-blue` void this way, which is a property of the brief rather than a
bug — write checks against a state the app is unlikely to already be in.

The baseline is sampled **twice**, and *any* sample passing marks the edit void.
The check is arbitrary JavaScript evaluated in a live page: it throws mid-reload
and reads styles that have not applied yet, so a single unlucky sample reports
an already-blue header as not-blue and the edit then scores a flattering
near-zero. The two errors are not symmetrical — a false "void" costs one
measurement and says why, a false "correct at 0.2s" is a wrong number that looks
like a very good one. Samples that disagree set `baselineUnstable` and warn
separately: a flapping predicate invalidates the verdict too, not just the
timing.

Iteration polls at 250ms by default; cold start polls at 1000ms. Edits are fast
and deserve finer resolution. Once the agent's turn ends, the harness waits a
grace period (20s) rather than the full timeout: an agent that has stopped
talking is not about to change the page.

### Writing a check expression

The check decides whether an edit landed, so a wrong check reports a working
agent as a failure. Two traps, both hit while building this:

**A selector list matches in document order, not in the order you wrote it.**
`document.querySelector('h1,h2,header')` on a page with `<header><h1>…</h1></header>`
returns the `<header>`, not the `<h1>`. A real run had the agent correctly
recolour the heading to `rgb(56,189,248)` in 4.7 seconds; the check read the
wrapper's colour instead and reported the edit as never landing. Target the
element the prompt names.

**Check the property the prompt is about.** "Make the header blue" is a
`backgroundColor` question for a banner and a `color` question for a heading.
Where the element is uncertain, scan candidates by geometry -- a wide, short box
near the top -- rather than betting on one selector, and accept a range of
blues rather than one hex value, since agents pick their own shade.

## The protocol suffix

Every brief is handed to the agent with the same block appended, verbatim, for
every agent. It is part of the measurement, not a hint given to one of them.
The exact text sent is saved as `prompt.txt` in the run directory.

It says four things:

1. **Where to serve, and to leave the server running.** So a run is never lost
   to a port mismatch.
2. **That a browser is already watching, and to render something early.** The
   first version of this suffix said "when the app is ready to look at, serve
   it" — which asks for exactly the behaviour the metric exists to catch: a
   blank page for the whole run and a first frame that is already the finished
   app. Telling every agent that the clock is running is the fair version of
   that instruction. `--no-render-early` drops this clause, which measures
   unprompted behaviour instead. That is a different experiment, and runs from
   the two may not be ranked in one table. They can still be compared, but only
   pairwise: `p2p leaderboard` ranks each condition on its own and reports the
   per-agent difference between them, which is what "how much was the
   instruction worth" actually means.
3. **To start the dev server in the background.** A server in the foreground
   never returns, so the agent's turn can never complete.
4. **To create `.p2p-done` when finished.** See below.

## How the observation window ends

The cold-start window closes on whichever of these comes first. The reason is
recorded as `endReason` in the result and printed by `p2p leaderboard`, because
a run the agent finished and a run that was cut off are not the same
measurement and nothing else in the numbers distinguishes them.

| `endReason` | what happened |
|---|---|
| `turn` | the adapter saw the agent complete its first turn |
| `signal` | the agent created `.p2p-done` in its workdir |
| `quiet` | page, agent stream and toolchain were all idle for `--quiet-for` |
| `rendered` | `--stop-after-render` was set and the app rendered |
| `horizon` | the brief's horizon ran out first |

**`signal` exists because `turn` cannot be relied on.** An agent whose last act
is starting a dev server holds that tool call open forever and never completes a
turn, so the only end condition left was the horizon — which meant minutes of
screenshotting an app that had been finished the whole time. A sentinel file
works for every adapter, including the ones whose event stream this harness can
only partly read.

**`quiet` is the backstop for an agent that ignores the sentinel.** Three
signals have to idle together for the full window (default 120s, `--quiet-for 0`
to disable): no visible change on the page, no agent event, and no shimmed
command running. Any one alone has a false positive that would cut a working run
short — the page sits unchanged through a long install, the agent goes quiet
while a build runs — so all three are required, and something must already have
rendered.

Ending early does not change the AUC: the curve holds its last value to the
horizon either way (convention 3 above). What it can miss is a late improvement,
so a `quiet` run says so in its caveats. The quiescence window itself is
excluded from the latency denominator on the same grounds as the settle window:
it is defined as a stretch in which nothing happened.

## The verdict cache

Scoring is the expensive part of a run, so verdicts are cached on disk in
`.p2p-cache/` (override with `P2P_CACHE_DIR`; the default is relative to the
working directory). The file is keyed by the brief, its rubric **and the judge**,
so two judges can never answer for each other — that would defeat the one thing
`p2p rescore --judge` exists to do.

The file is also keyed by the width screenshots are downscaled to before they
are sent (`--judge-width`): the judge sees that image, not the one on disk, so it
is an input to the verdict as surely as the rubric is.

Inside the file, each verdict is keyed by a **SHA-256 of the screenshot's
bytes**. It was previously keyed by the frame's `dhash`, which is wrong in a way
that leaves no trace: a dhash is a 64-bit perceptual hash of a 9×8 downscale,
built to answer "are these nearly the same picture" with a distance threshold,
and it collides readily on pages differing only in their text. Two 1280×800
screenshots with entirely different copy hash identically — there is a test. As
an exact key in a file shared by every run of one brief, that let a verdict
earned by one agent's page be served for another agent's different page, with
the collision rate rising as the cache filled. Caches written under the old
scheme are ignored rather than migrated.

Verdicts are written as they arrive rather than once at the end, and written
atomically: a truncating write that stopped halfway would leave unparseable JSON,
and an unparseable cache is read as a cold one — discarding every verdict already
paid for. Writing incrementally is only an improvement if the increments cannot
destroy each other.

Perceptual similarity still has a job: it is how `selectFramesToJudge` decides a
frame is not worth a fresh call. That is a threshold applied within one run, not
an identity claim across all of them.

Judge calls are made at **temperature 0**, recorded in `result.json`. At a
provider's default the same screenshot can score differently on two runs, which
puts sampling noise in the headline number — and the cache then freezes whichever
sample landed first, so the noise becomes permanent and looks like a
measurement. It does not make a judge deterministic; no provider promises that.
It removes the variance that is ours to remove.

## What may be ranked together

`compare` and `leaderboard` refuse a set of runs that is not on one scale. Each
check guards a table that would otherwise look completely normal:

- **different horizons** — AUC is normalised by horizon.
- **different briefs** — different rubrics.
- **different judges** — they disagree at the margin, so a ranking across them is
  partly a ranking of the judges.
- **different judge temperatures** — the same model samples differently at each,
  so part of the gap would be the sampler. A run from before the temperature was
  recorded compares with its own kind and refuses to compare with one that
  pinned it.
- **different viewports** — the window decides what the judge was shown and what
  counted as on screen, so it moves the AUC as directly as the rubric does. It
  is recorded on every result, defaults included.
- **unfinished judging** — a `judge.pending` result carries provisional scores;
  ranking it presents entity coverage under a model's byline.
- **judged mixed with unjudged** — entity coverage and rubric correctness are
  different quantities that happen to share a 0..1 range.
- **prompted mixed with unprompted** — different questions. `compare` refuses
  this; `leaderboard` allows it *because* it ranks within each condition and
  never across, and reports the prompt effect between them.

`--repeat` aggregates carry the same information: the judge is named, a mixed
one is flagged, and bucket medians are shown in seconds with **no percentages**.
Each bucket's median is taken independently, so the median install and the median
build can come from different runs and their sum can exceed the median wall
clock. Rendering each as a share of that sum — which this did — produced a tidy
breakdown of a run that never happened.

## Port hygiene

A run **refuses to start** if anything is already answering on the target port,
and kills whatever it started when it finishes.

This is not tidiness. Agents launch dev servers as children of a shell inside a
tool call, so terminating the agent does not reliably take the server with it. A
leaked server would make the next run report a time-to-first-render near zero,
for an application the agent under test never built — a wrong number that looks
entirely plausible. Pass `--kill-port` to clear the port instead of aborting,
and `--keep-server` to leave a finished run's server up for debugging.

Only **listening** sockets are ever killed, and never this process or one of its
parents. The distinction is not hypothetical: `lsof -i tcp:5173` matches sockets
with that number at either end, so it returns every client of the port as well
as the server. The harness polls the app under test once a second and is
therefore always a client of it, and the old teardown piped that list straight
into `kill -9`. The result was a run that died with `Killed: 9` immediately
after its last measured frame — no `result.json`, no scoring pass, no report,
and a `frames/` directory with nothing to read it by. macOS only: Linux has
`fuser`, which matches local ports, and it was tried first.

If no lookup tool is installed at all, the run says so in its warnings rather
than assuming the port is clear — an unexamined port is how a leaked server
survives into the next run.

Success is checked by asking the port again, not by asking whether the pid still
exists. `process.kill(pid, 0)` succeeds for a *zombie* — a killed child still in
the process table because nothing has reaped it — so a pid check reports a dead
server as a survivor indefinitely. It is also the wrong question: what the next
run needs to know is whether anything is still listening.

### Interrupting a run

`SIGINT`, `SIGTERM` and `SIGHUP` stop the browser, the agent and the agent's dev
server before exiting, bounded by a 20s deadline so a wedged teardown cannot
turn a Ctrl-C into a hang — and a hang into a second Ctrl-C, which would leave
everything running.

Chromium is launched with Playwright's `handleSIGINT` / `handleSIGTERM` /
`handleSIGHUP` set to **false**. They default to true, and they kill the browser
and then exit the process, pre-empting the harness's teardown after its first
step. The visible result was a Ctrl-C that looked tidy — the window vanished —
while the agent and its dev server ran on and poisoned the next run against that
port. An end-to-end test interrupts a real run and asserts the port is free
afterwards; it fails if those options are ever put back.

## Repeats

`--repeat N` runs the same brief N times and reports the median with its full
range, plus how many runs never rendered at all. When the range across repeats
is wider than the gap between two agents, there is no ranking yet, only noise,
and the output says so when the AUC range exceeds 0.15.

## Known limits

- **Poll interval is the resolution floor.** Every latency number carries ±1
  poll interval of quantisation. Frames are stamped at capture start.
- **Judge variance is reduced, not eliminated.** Binary criteria are far more
  stable than a 0-10 score, but two judges can still disagree on a borderline
  frame. Re-score saved frames with `p2p rescore` to measure that variance
  without re-running any agent.
- **One run is not a measurement.** Agent runs vary substantially. Repeat and
  report a distribution; the harness produces one run per invocation and makes
  no attempt to hide that.
- **Entity coverage is text-only.** It does not see text inside images, canvas,
  shadow DOM, or cross-origin iframes. A brief whose content is image-rendered
  will under-report coverage and therefore over-report TTFRR.
- **The protocol suffix modifies the prompt.** Every agent is told where to
  serve, to render early, to background its server and how to signal completion
  — verbatim and identically. It is part of the measurement, not a hint to one
  agent, and it is saved with the run as `prompt.txt`. It also means these
  numbers describe agents that were told the clock is running; `--no-render-early`
  measures the other thing. Which one a run answers is recorded in
  `result.json` as `protocol.renderEarly`, and the leaderboard keeps the two
  rankings apart rather than merging them.
- **Repeated screenshots share a file.** Every frame carries a screenshot,
  including the ones taken before anything was listening, but consecutive
  frames whose luminance hash and colour grid are both exactly equal point at
  one file in `frames/`. The timeline in `result.json` is complete; the
  directory holds one copy per distinct visual state. This means `frames/`
  cannot be replayed as a timeline: stitching the directory listing gives every
  distinct state equal screen time regardless of how long it was actually on
  screen. `p2p video` rebuilds the real one from `result.json`.
- **The prober reloads a non-rendering page** after 4 stale polls, and stops
  reloading once anything has rendered. A page that would have painted at 10s
  can be refreshed at ~4s and restart its boot; this is visible in the frame log.
