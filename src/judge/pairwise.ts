import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Brief, PairwiseResult, PairwiseStep, RunResult, ScoredFrame, StepVerdict } from '../types.ts';
import { downscalePngColor } from '../probe/pixels.ts';
import { writeJsonAtomic } from '../atomic.ts';
import { coldFrames } from '../phase.ts';
import type { JudgeBackend } from './backends.ts';
import { DEFAULT_IMAGE_WIDTH, keyOf } from './judge.ts';

/**
 * Was each visible change an improvement?
 *
 * The rubric asks yes/no questions of one screenshot at a time, and once a page
 * meets every criterion it scores 1.00 whatever happens next. Observed on
 * `ops-dashboard`: Gemini put a finished dashboard on screen, then replaced it
 * with a different design up to three times, and every judge scored every
 * version 1.00. The curve drew a flat line over a minute of visible change.
 *
 * Comparing each state with the one it replaced asks the question a rubric
 * cannot: did this change help? It is reported beside the scores, never folded
 * into them, so no AUC changes because of it.
 */

/** One comparison: which of two screenshots better satisfies the brief. */
export type Choice = 'first' | 'second' | 'tie';

export function buildPairwisePrompt(brief: Brief): string {
  const criteria = brief.rubric.map((c) => `- ${c.description}`).join('\n');
  return `Screenshots 1 and 2 show the same web app at two moments while an agent was building it, from this brief:

${brief.title}
${brief.prompt}

What the brief asks for:
${criteria}

Which screenshot better satisfies the brief, as a person reviewing the app would see it? Count everything visible: how much of the brief is done, whether the content is correct, and how well it is laid out and designed. Judge only what is visible. Answer "tie" when the difference is negligible or neither is clearly better.

Respond with JSON and nothing else:
{"better": "first" | "second" | "tie", "note": "<=15 words naming the main visible difference"}`;
}

/**
 * The verdict, given both orderings.
 *
 * A model shown two pictures has a measurable preference for one position, so
 * each pair is asked twice, swapped. Only a preference that survives the swap
 * counts; one that flips with the order is position bias and is recorded as
 * `same`, flagged, rather than as a change in the page.
 */
export function combine(forward: Choice, swapped: Choice): { verdict: StepVerdict; inconsistent: boolean } {
  // Forward: first = earlier state. Swapped: first = later state.
  const laterF = forward === 'second' ? 1 : forward === 'first' ? -1 : 0;
  const laterS = swapped === 'first' ? 1 : swapped === 'second' ? -1 : 0;
  if (laterF === laterS) return { verdict: laterF > 0 ? 'better' : laterF < 0 ? 'worse' : 'same', inconsistent: false };
  // One said tie and the other had a preference: a weak preference, kept.
  if (laterF === 0 || laterS === 0) {
    const v = laterF + laterS;
    return { verdict: v > 0 ? 'better' : 'worse', inconsistent: false };
  }
  return { verdict: 'same', inconsistent: true };
}

/**
 * The transitions worth asking about: consecutive distinct rendered states in
 * the cold-start window.
 *
 * Frames that look the same share a screenshot file, so a new path is a new
 * picture. Only render-to-render pairs: blank to rendered is the first render,
 * which the curve already prices, and a frame with no page in it has nothing
 * to compare.
 */
export function transitions(frames: ScoredFrame[]): Array<{ from: ScoredFrame; to: ScoredFrame }> {
  const out: Array<{ from: ScoredFrame; to: ScoredFrame }> = [];
  let prev: ScoredFrame | null = null;
  for (const f of [...frames].sort((a, b) => a.tMs - b.tMs)) {
    if (f.class !== 'render' || !f.screenshotPath) continue;
    if (prev && prev.screenshotPath !== f.screenshotPath) out.push({ from: prev, to: f });
    if (!prev || prev.screenshotPath !== f.screenshotPath) prev = f;
  }
  return out;
}

/** Read the choice out of a reply, tolerating prose or fences around the JSON. */
export function parseChoice(raw: string): { better: Choice; note: string } | null {
  const m = raw.match(/"better"\s*:\s*"(first|second|tie)"/i);
  if (!m) return null;
  const note = raw.match(/"note"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? '';
  return { better: m[1]!.toLowerCase() as Choice, note: note.replace(/\\"/g, '"') };
}

/**
 * The forward question shows the earlier state first, so its note's "first"
 * and "second" are "before" and "after". Said that way, because a note reading
 * "First has more polish" under a replay means nothing to anyone watching it.
 */
export function beforeAfter(note: string): string {
  const out = note
    .replace(/\b(screenshot 1|the first|first)\b/gi, 'before')
    .replace(/\b(screenshot 2|the second|second)\b/gi, 'after');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export interface PairwiseOptions {
  backend: JudgeBackend;
  cacheDir?: string;
  maxImageWidth?: number;
  /** Cap on transitions compared per run; the rest are reported as skipped. */
  maxSteps?: number;
}

export async function judgePairwise(r: RunResult, brief: Brief, opts: PairwiseOptions): Promise<PairwiseResult> {
  const warnings: string[] = [];
  const judge = opts.backend.model ?? opts.backend.name;
  let pairs = transitions(coldFrames(r));
  const maxSteps = opts.maxSteps ?? 30;
  if (pairs.length > maxSteps) {
    warnings.push(`pairwise: ${pairs.length} changes, compared the first ${maxSteps}`);
    pairs = pairs.slice(0, maxSteps);
  }

  const cacheDir = opts.cacheDir || process.env.P2P_CACHE_DIR || join(process.cwd(), '.p2p-cache');
  await mkdir(cacheDir, { recursive: true });
  const prompt = buildPairwisePrompt(brief);
  const promptHash = createHash('sha256')
    .update(JSON.stringify({ prompt, judge, width: opts.maxImageWidth ?? DEFAULT_IMAGE_WIDTH }))
    .digest('hex')
    .slice(0, 12);
  const cachePath = join(cacheDir, `pairwise-v1-${promptHash}.json`);
  let cache: Record<string, { better: Choice; note: string }> = {};
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(await readFile(cachePath, 'utf8')) as typeof cache;
    } catch { /* a corrupt cache is a cold one */ }
  }

  const width = opts.maxImageWidth ?? DEFAULT_IMAGE_WIDTH;
  const ask = async (a: Buffer, b: Buffer): Promise<{ better: Choice; note: string }> => {
    const key = `${keyOf(a)}:${keyOf(b)}`;
    const hit = cache[key];
    if (hit) return hit;
    const raw = await opts.backend.ask({
      before: [downscalePngColor(a, width)],
      png: downscalePngColor(b, width),
      prompt,
    });
    const c = parseChoice(raw);
    if (!c) throw new Error(`unparseable pairwise answer: ${raw.slice(0, 120)}`);
    cache[key] = c;
    return c;
  };

  const steps: PairwiseStep[] = [];
  for (const { from, to } of pairs) {
    try {
      const [a, b] = await Promise.all([readFile(from.screenshotPath!), readFile(to.screenshotPath!)]);
      const [fwd, swp] = await Promise.all([ask(a, b), ask(b, a)]);
      const { verdict, inconsistent } = combine(fwd.better, swp.better);
      steps.push({ tMs: to.tMs, fromTMs: from.tMs, verdict, inconsistent, note: beforeAfter(fwd.note) });
    } catch (e) {
      warnings.push(`pairwise: change at ${(to.tMs / 1000).toFixed(1)}s failed (${String(e).slice(0, 160)})`);
    }
  }
  await writeJsonAtomic(cachePath, cache).catch(() => undefined);
  return { judge, steps, warnings };
}
