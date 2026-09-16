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

Follow-up prompts are injected into the **same live session** (via stream-json
on stdin), so what is measured is the edit loop rather than process startup and
context re-read.

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

## Port hygiene

A run **refuses to start** if anything is already answering on the target port,
and kills whatever it started when it finishes.

This is not tidiness. Agents launch dev servers as children of a shell inside a
tool call, so terminating the agent does not reliably take the server with it. A
leaked server would make the next run report a time-to-first-render near zero,
for an application the agent under test never built — a wrong number that looks
entirely plausible. Pass `--kill-port` to clear the port instead of aborting,
and `--keep-server` to leave a finished run's server up for debugging.

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
  serve, verbatim and identically, so a run is never lost to a port mismatch.
  It is part of the measurement, not a hint to one agent.
- **The prober reloads a non-rendering page** after 4 stale polls, and stops
  reloading once anything has rendered. A page that would have painted at 10s
  can be refreshed at ~4s and restart its boot; this is visible in the frame log.
