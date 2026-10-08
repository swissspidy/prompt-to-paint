# Findings

Every experiment this harness has been used for, newest first. Each section
says which agents, models, brief and judge it used, because numbers from
different setups are not comparable: a different judge or a different protocol
is a different measurement.

The published runs, with their screenshots, reports and the page each agent
built, are under [`site/`](../site/) and replayed at
<https://swissspidy.github.io/prompt-to-paint/>.

## Skeleton first turns the step into a curve

**[Leaderboard →](https://swissspidy.github.io/prompt-to-paint/2026-10-08-skeleton-first/)** ·
**[Race chart →](https://swissspidy.github.io/prompt-to-paint/2026-10-08-skeleton-first/race.html)**

Every published run so far went from a blank page to the finished one in a
single step, even when told to render early. The agent event streams suggested
why: the model composed the whole page and saved it in one file write, so the
browser only ever saw "nothing" and "done". If that's right, asking for an
outcome ("render early") can't change the shape, but asking for the mechanism
should.

`--skeleton-first` tests that. It replaces the render-early clause with:

> Build the page in stages, and save after each one. First save a bare skeleton
> on its own: the heading and an empty placeholder for every section the brief
> names, before writing any of their content. Then fill in the sections one at
> a time, each as a separate edit, so every save puts a little more on screen.
> Do not write the finished page in a single write.

**Setup.** `ops-dashboard`, four agent/model pairs, both conditions, three
repeats each: 24 runs, interleaved so a slow or fast patch at the provider hit
both conditions alike. Claude Code ran in `acceptEdits` mode with the plugin
configuration of the account it ran under, Pi with file tools only, so neither
had a shell or a toolchain. All 24 runs were judged by **`openai:gpt-5.5`**, not
by the Claude judge used in the sections below, so their scores and AUCs don't
share a table with those. First render doesn't depend on the judge, and the
"told" runs reproduce the earlier medians within seven seconds.

| agent / model | stages, told → skeleton | first render | first reviewable | whole brief on screen | AUC |
|---|---|---|---|---|---|
| Claude Code / `claude-sonnet-5-5` | 1 → 4–5 | 19.9s → **7.5s** | 19.9s → 32.7s | 19.9s → 50.9s | 0.953 → 0.931 |
| Claude Code / `claude-opus-5-5` | 1 → 4–5 | 33.0s → **13.7s** | 33.0s → 29.3s | 33.0s → 57.7s | 0.921 → **0.930** |
| Pi / `gpt-5.5` | 1 → 4–5 | 28.4s → **20.9s** | 28.4s → 29.3s | 28.4s → 54.1s, 72.0s, never | 0.932 → 0.907 |
| Pi / `gemini-3.8-flash` | 1 → 4–5 | 45.1s → **19.9s** | 45.1s → 57.1s | 45.1s → 89.7s | 0.893 → 0.881 |

Medians of three. "First reviewable" is the first frame scoring 0.5 or more;
"whole brief" is the first frame scoring 1.00.

What it showed:

- **The instruction works, completely.** 12 of 12 skeleton-first runs built the
  page in four or five visible stages. 0 of 12 told runs did. `p2p trajectory`
  agrees: AUC matched `finalScore x (1 - ttfr/horizon)` on none of the twelve,
  so for the first time the curve is carrying information the endpoints don't.
  A typical run, Sonnet 5.5: heading and subtitle at 7.5s (0.14), KPI tiles at
  19.7s (0.43), the depot table at 26.9s (0.79), bars and footer at 37.8s
  (1.00).
- **First render came 1.4–2.6x sooner for every agent.** Sonnet 5.5 in Claude
  Code got under Nielsen's ten-second limit, the first runs on this brief to do
  so.
- **The finished page came about twice as late.** Every extra save is another
  model turn: model time roughly doubled for Sonnet 5.5 and GPT-5.5. One GPT-5.5
  run never got to 1.00; it ended at 0.86.
- **So AUC mostly went down.** Only Opus 5.5 gained (+0.008), because its
  skeleton runs reached a reviewable page sooner than its single write did. For
  the other three, the early stages score too little to pay for the later
  finish. A skeleton with a heading in it is something on screen, but it is
  not much to react to.

The headline for this harness: **the blank-then-finished step is a habit, not a
limit.** The agents can build progressively when told how. Whether they
should is a trade-off: something on screen two to three times sooner, a
finished page about twice as late. AUC, as currently weighted, prefers the
finished page sooner. A person waiting to give feedback might not.

**What this doesn't cover.** One brief, three repeats, one judge. A single-file
static page is the case where staging costs most, since every stage rewrites
part of one file. A multi-file app on a running dev server
(`todo-app-scaffolded`) is the obvious next test.

## Three vendors, one dense brief

**[Replay every run side by side →](https://swissspidy.github.io/prompt-to-paint/2026-10-07-ops-dashboard/)**

The [earlier runs](#earlier-runs-three-claude-models-on-two-static-briefs) were all Claude models in Claude Code. Fifteen more, on
[`ops-dashboard`](USAGE.md#write-briefs-that-are-not-saturated): five agent/model pairs
across three vendors, three repeats each, all told to render early, all judged
by `anthropic:claude-sonnet-5`. Two agents drive the models — Claude Code, and
[Pi](USAGE.md#which-agents-this-works-with), which runs any provider's model — so the
same model can be measured in two harnesses.

| agent / model | first render, median [range] | AUC median | edit landed: heading blue / add a row |
|---|---|---|---|
| Claude Code / `claude-sonnet-5-5` | **18.9s** [18.0 – 20.0] | 0.955 | 2.3s / 2.4s |
| Pi / `claude-sonnet-5-5` | 23.3s [16.1 – 29.6] | 0.945 | 3.0s / 3.0s |
| Pi / `gpt-5.5` | 30.9s [30.0 – 35.7] | 0.926 | 2.8s / 2.6s |
| Claude Code / `claude-opus-5-5` | 34.7s [33.4 – 36.1] | 0.917 | 3.1s / 3.0s |
| Pi / `gemini-3.8-flash` | 38.6s [38.2 – 45.1] | 0.908 | 6.6s / 15.0s |

These agents could edit files and nothing else: Claude Code in `acceptEdits`
mode, Pi with `--tools read,write,edit`. No shell, so no toolchain, and over 99%
of every wall clock was the model. The stored runs, their reports and the page
each agent actually built are in
[`site/2026-10-07-ops-dashboard/`](site/2026-10-07-ops-dashboard/).

What they showed:

- **Fifteen of fifteen curves were steps.** `p2p trajectory`: AUC equals
  `finalScore x (1 - ttfr/horizon)` on every run, with a residual of zero. Over
  the 42 runs recorded up to then, **one** had rendered progressively. With
  other vendors in the table, that stops looking like a Claude habit.
- **Every run scored 1.00, so the ranking is first render and nothing else.**
  The ranges sort into three tiers that do not overlap: Sonnet 5.5 in either
  harness, then GPT-5.5 and Opus 5.5, then Gemini 3.8 Flash. Within a tier the
  ranges overlap, so the order inside one is unresolved.
- **The harness moves the number, not only the model.** The same Sonnet 5.5 had
  a 2.0s spread across repeats in Claude Code and 13.5s in Pi.
- **Bigger was slower, for the same score.** Opus 5.5 took nearly twice as long
  as Sonnet 5.5 to an identical 1.00.
- **The edit loop is fast for almost everyone.** Follow-up edits landed in 2–3s
  with a single tool call, an order of magnitude faster than cold start. Gemini
  was the exception, at up to 19s and four tool calls. The leaderboard replays
  every edit side by side from its prompt, which is the most visibly different
  thing about these agents.
- **A void edit showed up on a live run.** One GPT-5.5 run had already made the
  heading blue during cold start, so "make the heading blue" was reported as
  unmeasurable rather than as a 0s success.

**The judges agree, and the one dissent was a misread.** Re-scoring all fifteen
runs with `openai:gpt-5.5` and `google:gemini-3.8-flash` reproduced the
original AUC exactly in 29 of 30 re-scorings. The odd one out: GPT-5.5 docked a Gemini page's
cost tile for showing "−$0.60" where the brief asks for "+$0.60". The page shows
**+$0.60**, styled red because a rising cost is bad news; the judge read the
colour as the sign. Judges disagree at the margin — here, in one re-scoring in
thirty — which is why runs scored by different judges never share a table.

**The scores cannot see work that a person would.** Gemini rendered a finished
dashboard at about 40s in all three runs, then kept working and replaced it one
to three more times. In the run checked frame by frame, it swapped a styled
layout with a status badge, trend arrows and side-by-side panels for a plainer
one. Every judge scored every version 1.00, so the curve is a flat line over
seventy seconds of visible change. Part of "every curve is a step" is the
agents. Part is a rubric that saturates: once each criterion is met, it cannot
tell a better page from a worse one.

[`p2p pairwise`](USAGE.md#did-each-change-help) puts a number on it. Across all fifteen
runs there were eight visible changes after a first render, six of them
Gemini's. **None was judged an improvement:** five were judged worse and three
about the same, two of those because the judge's preference flipped when the
order was swapped. On this brief, an agent that kept working after its first
render only ever made the page worse or left it as it was.

**What these runs do not cover:** a stack with a build step. An agent that has
to set one up needs a shell. The control alone is in: `p2p floor --template
vite-react` first paints at **18.0s on a cold npm cache and 7.4s on a warm one**
on the same machine. That is already as long as the fastest agent above took to
write the whole dashboard. The next section takes the toolchain off the agent
instead.

## The same agents on a running Vite + React project

**[Replay every run side by side →](https://swissspidy.github.io/prompt-to-paint/2026-10-07-todo-app-scaffolded/)**

A single-file static page can only appear in one step, so the runs above could
never show an agent building in stages. These fifteen use
[`todo-app-scaffolded`](USAGE.md#a-toolchain-the-agent-does-not-have-to-set-up): the
`todo-app` task board, on a Vite + React project the harness had already
installed and started. The agents still had file edits only, and every save
hot-reloaded. Same five agent/model pairs, three repeats each.

| agent / model | first render, median [range] | AUC median | edit landed: header blue / add a column |
|---|---|---|---|
| Claude Code / `claude-sonnet-5-5` | **13.8s** [12.9 – 26.4] | 0.971 | 3.3s / 1.5s |
| Pi / `gpt-5.5` | 21.5s [12.5 – 25.4] | 0.955 | 7.5s / 4.5s |
| Claude Code / `claude-opus-5-5` | 23.6s [21.2 – 26.9] | 0.951 | 5.9s / 5.5s |
| Pi / `claude-sonnet-5-5` | 28.9s [15.8 – 60.3] | 0.940 | 4.2s / 2.7s |
| Pi / `gemini-3.8-flash` | 67.4s [58.4 – 68.8] | 0.860 | 20.8s / 21.3s |

What they showed:

- **Hot reload made staged rendering possible, and almost nobody used it.** Both
  Claude Code models wrote the whole app into `src/App.jsx` in a single write, in
  all six runs. The Pi agents wrote `App.jsx` and then `index.css`, and the order
  of those two saves is the only thing that ever produced a partial page. One
  GPT-5.5 run put the unstyled app on screen at 12.5s (scored 0.56), the styled
  board at 23.5s (1.00), and moved "Sprint 14" into place at 27.1s. That is the
  first curve in these runs that is not a step: 2 of 15 runs scored at a partial
  state here, against 0 of 15 on `ops-dashboard`.
- **Later changes helped only when the page was being built, not rebuilt.**
  Pairwise found nine changes after a first render. Three were judged better: two
  are that GPT-5.5 run completing its page, and one is a Gemini run adding a
  task counter. Of Gemini's other three, two were judged worse and one the same,
  and all three of Opus's were judged nearly identical: spacing and icon size,
  in the judge's words.
- **The ranking holds across the two briefs.** Sonnet 5.5 in Claude Code was
  fastest on both; Gemini 3.8 Flash was slowest on both, by a wider margin here.
  Pi / Sonnet ranged from 15.8s to 60.3s across three identical runs, the widest
  spread in either table and a reminder that three repeats is a smoke test.

**Four of thirty edits were mis-scored by the brief, not the agent.** All four
were visibly on screen and the brief's check said NEVER LANDED:

- GPT-5.5 made the header blue with a `linear-gradient`, in all three runs. A
  gradient leaves `background-color` transparent, and the check read nothing
  else.
- One Pi / Sonnet run rendered its column header as
  `<h2>Blocked<span>0</span></h2>`. Its `innerText` is `BLOCKED0`, and `\b` sees
  no word boundary between a letter and a digit.

Both checks are fixed in `todo-app`, `todo-app-scaffolded` and the same gradient
blind spot in `landing-page`. Re-run against every run's final code, the fixed
checks pass exactly those four and agree with the old ones everywhere else; both
fail on the blank scaffold. In each of the four, the page changed once after the
prompt and then held that state to the end of the window. So their results were
corrected to land at that first change, and each says so in a `rechecked` field
and in the run's warnings. The replay marks them "re-checked".

**The pairwise notes are a judge's words, so check them before quoting.** One
note says a Gemini change "lacks subtitle text". The screenshots show "Sprint 14"
is still there; it went from a badge to plain text, and the line under it was
removed. The "worse" verdict is defensible. The note's reason is not.

## Earlier runs: three Claude models on two static briefs

The first runs used `claude-haiku-4-5`, `claude-sonnet-5` and `claude-opus-5`
in Claude Code, judged by `anthropic:claude-sonnet-5`. They are not
re-published under `site/`, but they are where the step-curve finding started.

### Does the curve earn its keep?

The headline number is the area under a curve, which is only worth integrating
if the curve has a shape. An agent that shows a blank page and then the finished
app draws a **step**, and the area under a step is fixed by two numbers already
printed beside it:

```
AUC = finalScore x (1 - timeToFirstRender / horizon)
```

When that identity holds, ranking on AUC is ranking on those two numbers in a
trenchcoat. `p2p trajectory` is the self-check:

```bash
npm run p2p -- trajectory runs/*/result.json
```

**On the first nine measured runs it held exactly on eight of them.** Three
Claude models (haiku-4.5, sonnet-5, opus-5), three repeats each, on
`briefs/static-page.json`, every one told to render early:

```
    AUC == finalScore x (1 - ttfr/horizon)     8 / 9 runs
    ever scored at a partial state            1 / 9 runs
    largest residual                          0.01144
```

The exception is the interesting one, and it is exactly what the protocol asks
for: **opus-5 rendered a complete but unstyled page at 6.8s (0.833), then
styled it in place at 27.4s (1.000).** That run is the only one whose curve has
a shape, and the metric priced it correctly — it beat a run that first painted
at 17.8s despite both finishing at 1.00.

So the metric works. Agents just rarely give it anything to work on. **Eight
times out of nine they went from nothing to finished in one step, having been
explicitly told not to.**

Two things follow, and they matter more than any ranking this harness has
produced so far:

- **Report `p2p trajectory` next to any AUC you publish.** A leaderboard whose
  runs are all steps is a leaderboard of first-render times with extra arithmetic,
  and should say so rather than let a reader assume otherwise.
- **The headline finding available here is a negative one.** Not "agent X renders
  sooner" but "agents do not render progressively, even when told to, and here is
  the instrument that measures how often." That is a more interesting claim than
  a ranking, and it is the one the data currently supports.

**What nine runs cannot tell you:** this is one deliberately easy brief where
eight of nine runs finished at a perfect score, so the ceiling is doing some of
the work. A harder brief, a shorter horizon, or a stack with a real build step
could all produce genuine trajectories. The check is cheap — run it on your own
runs before trusting an AUC ranking.

#### Dropping the instruction changes nothing

The same nine runs again with `--no-render-early`, paired by model:

```
  What the instruction was worth  (same agent, same brief, told vs not told)
  run                       AUC told  not told    delta  first render
  ----------------------------------------------------------------------------
  claude-code:claude-haik      0.963     0.955   +0.008  same
  claude-code:claude-sonn      0.955     0.952   +0.004  1.1s sooner
  claude-code:claude-opus      0.941     0.944   −0.003  same
```

Deltas of ±0.008 against a within-model noise range of up to 0.167. **The
instruction is worth nothing measurable** — which is the result this comparison
exists to be able to report, because it means the headline number is measuring
the agent rather than its instruction-following.

With one caveat that the averages hide: **not told, zero of nine runs rendered
progressively; told, one did.** The instruction almost never changes behaviour,
and when it does, it changes it completely.

#### Whether the curve has a shape depends on the judge

Re-scoring that one progressive run under a second judge:

| judge | AUC | score levels | its verdict on the 6.8s frame |
|---|---|---|---|
| `claude-sonnet-5` | 0.966 | 0, **0.833**, 1.0 | "content complete but page looks like unstyled raw HTML" |
| `claude-haiku-4-5` | 0.977 | 0, 1.0 | "all criteria met" |

Haiku did not dock the unstyled page for the rubric's `styled` criterion, and
scoring it 1.00 collapsed the only trajectory in eighteen runs back into a step.
**Judge strictness decides whether the metric has anything to measure at all** —
which is the strongest possible argument for the rule that runs scored by
different judges may not share a table.

Judge *self*-agreement, by contrast, was perfect. Pointing `P2P_CACHE_DIR` at a
fresh directory defeats the verdict cache and forces real calls, so the same
judge can be asked the same question twice:

```bash
P2P_CACHE_DIR=$(mktemp -d) npm run p2p -- rescore runs/some-run --judge anthropic:claude-sonnet-5
```

Three runs, asked twice each: **identical AUC to four decimal places every
time**, with only cosmetic rewording between the two verdicts. `claude-sonnet-5`
refuses a sampling temperature and the harness correctly warns that variance is
therefore inside the AUC — but on this evidence that variance is theoretical
rather than observed. The caveat is right to be there and should not be read as
a measured effect.

#### What three repeats already showed

Nine runs — three Claude models, three repeats each, `briefs/static-page.json`,
all told to render early:

| model | AUC median | AUC range | first render median | first render range |
|---|---|---|---|---|
| `claude-haiku-4-5` | 0.963 | **0.167** | 11.1s | 2.3s |
| `claude-sonnet-5` | 0.955 | 0.007 | 13.4s | 2.0s |
| `claude-opus-5` | 0.941 | 0.025 | 17.8s | **11.1s** |

Read the medians as a ranking and haiku beats opus by 0.022. **Haiku's own
spread across three identical runs is 0.167 — seven times that gap.** There is
no ranking here, only noise, and the aggregate said so itself without being
asked:

```
  ! AUC ranges over 0.167 across 3 runs. Treat any ranking against
    another agent as unresolved unless the gap exceeds that.
```

Opus is the other warning: its first render ranged from 6.8s to 17.9s across
three runs of the same prompt. A single run of either model would have
supported a confident and wrong conclusion.

Two practical consequences:

- **Three repeats is a smoke test, not a measurement.** It was enough to show
  the ranking is unresolved; it is nowhere near enough to resolve it. Budget
  repeats until the within-model range is smaller than the between-model gap,
  and report both numbers when you publish either.
- **Final score could not rank these at all** — eight of nine runs finished at
  1.00. `static-page` is saturated for current frontier models. A brief every
  agent aces measures nothing except how fast they ace it, which is a good
  reason to write harder ones before running a leaderboard on it.

### A denser brief only half worked

Nine runs of the same three models on the first version of `ops-dashboard`:

| | `static-page` | `ops-dashboard` |
|---|---|---|
| first render | 10.1s – 17.9s | **20.2s – 64.4s** |
| wall clock | 15s – 18s | **52s – 322s** |
| final score | 1.00 on 8 of 9 | **1.00 on every run that rendered** |
| curves with a shape | 1 of 9 | **0 of 9** |

Density bought a much wider spread in the thing the metric is actually about —
first render went from a 7.8s spread to a 44s one, which is real discrimination
between models. It did **not** break the score ceiling and it did **not**
produce trajectories. Every run that rendered still scored a perfect 1.00, and
every curve was still a step.

That leaves an open question this harness can now answer but has not: is the
ceiling the models, or the judge? A rubric asking whether numeric columns are
aligned and whether bar lengths are proportional to their figures, which never
docks anyone across nine dense dashboards, is either describing things that are
genuinely easy or being marked leniently. `p2p rate` and `p2p calibrate` exist
to settle exactly that — put those frames in front of a person and find out.
