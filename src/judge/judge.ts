import { readFile, mkdir } from 'node:fs/promises';
import { writeJsonAtomic } from '../atomic.ts';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Brief, Frame, ScoredFrame } from '../types.ts';
import { hamming, colorDelta, downscalePngColor } from '../probe/pixels.ts';
import { JUDGE_TEMPERATURE, type JudgeBackend } from './backends.ts';

export interface JudgeOptions {
  backend: JudgeBackend;
  /** dhash distance above which two frames count as visually different. */
  distinctThreshold?: number;
  /** Hard cap on model calls per run. Frames beyond it are sampled evenly. */
  maxJudged?: number;
  cacheDir?: string;
  maxImageWidth?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Width screenshots are downscaled to before they are sent to a judge. */
export const DEFAULT_IMAGE_WIDTH = 1024;

export interface JudgeSummary {
  frames: ScoredFrame[];
  framesJudged: number;
  degraded: boolean;
  warnings: string[];
}

/**
 * Build the rubric prompt sent with each judged frame.
 */
export function buildJudgePrompt(brief: Brief): string {
  const criteria = brief.rubric
    .map((c) => `- ${c.id}: ${c.description}`)
    .join('\n');
  return `You are scoring a single screenshot taken while an agent was building a web app. This is a snapshot mid-build, so a partially finished page is expected and normal.

THE BRIEF THE AGENT WAS GIVEN
${brief.title}
${brief.prompt}

CRITERIA
${criteria}

RULES
- Judge only what is visible in this screenshot. Do not credit anything you cannot see, however likely it is to exist in the code.
- Each criterion is a yes/no question. Partial progress is expressed by meeting fewer criteria, never by hedging on one.
- A loading spinner, an error overlay, or an empty page meets no criteria.
- Placeholder or lorem-ipsum content does not meet a criterion that asks for real content, but a criterion about layout or structure can still be met by placeholder content.

Respond with JSON and nothing else:
{"criteria": {"<criterion id>": {"met": true, "note": "<=12 words of visual evidence"}}, "overall": "<=20 words"}`;
}

interface JudgeVerdict {
  criteria: Record<string, { met: boolean; note?: string }>;
  overall?: string;
}

/** Models sometimes wrap JSON in prose or fences; take the first balanced object. */
export function parseVerdict(raw: string): JudgeVerdict | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];
  for (const text of candidates) {
    const start = text.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as JudgeVerdict;
          if (obj && typeof obj === 'object' && obj.criteria) return obj;
        } catch { /* try the next candidate */ }
        break;
      }
    }
  }
  return null;
}

/**
 * Weighted fraction of rubric criteria met.
 *
 * A criterion the judge omitted counts as unmet rather than dropping out of
 * the denominator, so forgetting one cannot inflate the score.
 */
export function scoreFromVerdict(brief: Brief, v: JudgeVerdict): number {
  let got = 0;
  let total = 0;
  for (const c of brief.rubric) {
    total += c.weight;
    if (v.criteria[c.id]?.met) got += c.weight;
  }
  return total ? got / total : 0;
}

/**
 * Choose which frames are worth a model call.
 *
 * Polling at 1Hz for ten minutes yields hundreds of frames, but a build passes
 * through only a few dozen distinct visual states. Judging a frame that is
 * pixel-identical to the last judged one buys nothing, so we judge visual
 * transitions and hold the score across the flat stretches between them.
 */
export function selectFramesToJudge(
  frames: Frame[],
  opts: { distinctThreshold: number; maxJudged: number; colorThreshold?: number },
): number[] {
  const colorThreshold = opts.colorThreshold ?? 14;
  const renders = frames.filter((f) => f.class === 'render' && f.dhash);
  const picked: number[] = [];
  let last: string | null = null;
  let lastSig: string | null = null;
  for (const f of renders) {
    // A restyle can leave the luminance hash flat while changing the page a
    // judge would score differently, so colour movement also makes a frame
    // worth a fresh look.
    const structural = last === null || hamming(f.dhash!, last) > opts.distinctThreshold;
    const colour = lastSig !== null && colorDelta(f.colorSig, lastSig).max > colorThreshold;
    if (structural || colour) {
      picked.push(f.index);
      last = f.dhash;
      lastSig = f.colorSig;
    }
  }
  // The end state gets judged even when it never tripped the threshold, because
  // a run can drift slowly into a broken state one sub-threshold step at a
  // time. If it is genuinely identical to the last judged frame there is
  // nothing new to see and forward-fill is already correct.
  const lastRender = renders.at(-1);
  if (
    lastRender &&
    !picked.includes(lastRender.index) &&
    (last === null ||
      hamming(lastRender.dhash!, last) > 0 ||
      colorDelta(lastRender.colorSig, lastSig).max > 0)
  ) {
    picked.push(lastRender.index);
  }

  if (picked.length <= opts.maxJudged) return picked;
  // Too many transitions: keep the first and last, sample the middle evenly.
  const keep = new Set<number>([picked[0]!, picked.at(-1)!]);
  const step = (picked.length - 1) / (opts.maxJudged - 1);
  for (let i = 0; i < opts.maxJudged; i++) keep.add(picked[Math.round(i * step)]!);
  return [...keep].sort((a, b) => a - b);
}

/**
 * The cache key for one screenshot: the bytes of the screenshot.
 *
 * This used to be the frame's `dhash`, which is wrong in a way that is easy to
 * miss and impossible to notice afterwards. A dhash is a 64-bit perceptual hash
 * of a 9x8 downscale -- built to answer "are these nearly the same picture",
 * with a distance threshold, and it collides readily on pages that differ only
 * in their text. Two 1280x800 screenshots with entirely different copy hash
 * identically (there is a test).
 *
 * As an exact cache key inside a file shared by every run of one brief, that
 * means a verdict earned by one agent's page can be served for another agent's
 * different page, silently, with the collision rate rising as the cache fills.
 * The rubric hash above is careful to stop two judges answering for each other;
 * this stops two screenshots doing the same thing.
 *
 * Perceptual similarity still has a job here -- it is how `selectFramesToJudge`
 * decides a frame is not worth a fresh call -- but that is a threshold applied
 * within one run, not an identity claim across all of them.
 */
export const keyOf = (png: Buffer): string => createHash('sha256').update(png).digest('hex');

/**
 * Read the verdict cache, treating any corruption as a cold cache.
 */
async function loadCache(path: string): Promise<Record<string, JudgeVerdict>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, JudgeVerdict>;
  } catch {
    return {};
  }
}

/**
 * Score frames without a model, from entity coverage alone.
 *
 * The honest fallback whenever no judge looked at a frame -- no backend, a
 * scoring pass that has not run yet, or one that failed. `scoreSource` says so
 * per frame, so a report can never present these as rubric scores.
 */
export function mechanicalScores(frames: Frame[]): ScoredFrame[] {
  return frames.map((f) => ({
    ...f,
    score: f.class === 'render' ? f.entityCoverage : 0,
    scoreSource: f.class === 'render' ? ('mechanical' as const) : ('non-render' as const),
  }));
}

/**
 * Scores every frame, running strictly after the run has finished.
 *
 * Post-hoc is not an implementation convenience: judging during the run would
 * put model latency and CPU load inside the window being measured.
 */
export async function judgeRun(
  frames: Frame[],
  brief: Brief,
  opts: JudgeOptions,
): Promise<JudgeSummary> {
  const warnings: string[] = [];
  const distinctThreshold = opts.distinctThreshold ?? 6;
  const maxJudged = opts.maxJudged ?? 60;
  const degraded = opts.backend.name === 'none';

  if (degraded) {
    warnings.push(
      'judge: no backend configured. Scores are entity coverage, not rubric correctness, and AUC is not comparable to judged runs.',
    );
    return { frames: mechanicalScores(frames), framesJudged: 0, degraded: true, warnings };
  }

  // P2P_CACHE_DIR because the default is relative to the working directory, so
  // running the same brief from a different shell silently started cold and
  // paid for every verdict again.
  const cacheDir = opts.cacheDir ?? process.env.P2P_CACHE_DIR ?? join(process.cwd(), '.p2p-cache');
  await mkdir(cacheDir, { recursive: true });
  // The judge is part of the cache identity, not just the rubric.
  //
  // Verdicts are keyed by screenshot hash inside this file, so two judges
  // sharing one would let whichever ran first answer for the other: a rescore
  // under a different --judge would return the original verdicts, and the
  // result would record them under the new judge's name. That is the one thing
  // `p2p rescore` with a second judge exists to do -- measure how far two
  // judges disagree -- so it would report perfect agreement by construction.
  const rubricHash = createHash('sha256')
    .update(JSON.stringify({
      id: brief.id,
      prompt: brief.prompt,
      rubric: brief.rubric,
      judge: { backend: opts.backend.name, model: opts.backend.model },
      // The image the judge sees is the screenshot downscaled to this width, so
      // it is an input to the verdict as surely as the rubric is. Without it a
      // rescore at a different --judge-width reads back verdicts formed from
      // pictures it never sent.
      imageWidth: opts.maxImageWidth ?? DEFAULT_IMAGE_WIDTH,
    }))
    .digest('hex')
    .slice(0, 12);
  // v2: caches written before this were keyed by perceptual hash and are not
  // safe to read. See the note on `keyOf` -- a v1 file can hold a verdict that
  // belongs to a different screenshot, so it is left on disk and ignored rather
  // than migrated.
  const cachePath = join(cacheDir, `judge-v2-${rubricHash}.json`);
  const cache = await loadCache(cachePath);
  // Written as verdicts arrive, not once at the end: the pass is the expensive
  // part of a run, and a process that died during it used to lose every call it
  // had already paid for.
  let unsaved = 0;
  let saving: Promise<void> = Promise.resolve();
  const persist = (force = false): void => {
    if (!force && ++unsaved < 5) return;
    unsaved = 0;
    // Atomic, because this runs every few verdicts: a plain write truncates the
    // file first, so a process that stopped inside that window would leave
    // unparseable JSON, and loadCache treats unparseable as cold -- discarding
    // every verdict already paid for. Writing incrementally is only an
    // improvement if the increments cannot destroy each other.
    saving = saving.then(() => writeJsonAtomic(cachePath, cache)).catch(() => undefined);
  };

  const prompt = buildJudgePrompt(brief);
  const targets = selectFramesToJudge(frames, { distinctThreshold, maxJudged });
  const byIndex = new Map(frames.map((f) => [f.index, f]));
  const verdicts = new Map<number, JudgeVerdict>();
  let done = 0;
  let calls = 0;
  let failures = 0;
  let aborted = false;

  // Stop after a few failures if nothing has ever worked.
  //
  // Every plausible cause of a first failure that is not transient -- a model
  // id that does not exist, a key without access to it -- fails identically for
  // every frame. Discovering that sixty times, each behind the SDK's four
  // retries, is minutes of backoff to reach a conclusion available after three.
  // A judge that has answered even once is a different situation: those
  // failures are rate limits and bad luck, and the pass runs to the end.
  const HOPELESS_AFTER = 3;

  // Workers pull by index rather than shifting a copy of the list: nothing
  // yields between the read and the increment, so each target is taken once.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      const idx = targets[next++];
      if (idx === undefined) return;
      const frame = byIndex.get(idx);
      if (!frame?.screenshotPath || !frame.dhash) continue;
      try {
        // The file is read before the cache is consulted, because the key is
        // the file. One read is nothing against the model call it may save.
        const full = await readFile(frame.screenshotPath);
        const key = keyOf(full);
        const cached = cache[key];
        if (cached) {
          verdicts.set(idx, cached);
          opts.onProgress?.(++done, targets.length);
          continue;
        }
        const png = downscalePngColor(full, opts.maxImageWidth ?? DEFAULT_IMAGE_WIDTH);
        const raw = await opts.backend.ask({ png, prompt });
        calls++;
        const v = parseVerdict(raw);
        if (!v) {
          warnings.push(`judge: frame ${idx} returned unparseable output`);
        } else {
          verdicts.set(idx, v);
          cache[key] = v;
          persist();
        }
      } catch (e) {
        failures++;
        warnings.push(`judge: frame ${idx} failed (${String(e).slice(0, 200)})`);
        if (calls === 0 && failures >= HOPELESS_AFTER && !aborted) {
          aborted = true;
          warnings.push(
            `judge: giving up after ${failures} failures with no successful call. The judge ` +
              `(${opts.backend.model ?? opts.backend.name}) is not answering, so the remaining ` +
              `${Math.max(0, targets.length - done - 1)} frame(s) were not sent. Scores here are entity ` +
              'coverage, not rubric correctness; fix the judge and run p2p rescore on this run directory.',
          );
        }
      }
      opts.onProgress?.(++done, targets.length);
    }
  };
  await Promise.all(Array.from({ length: opts.backend.concurrency }, worker));
  persist(true);
  await saving;

  // Asked after the pass, because that is when every provider warning has
  // arrived. The default judge is one of the models this applies to, so without
  // saying it here a run's headline number carries sampling variance and every
  // report about it claims otherwise.
  if (opts.backend.temperature?.() === null) {
    warnings.push(
      `judge: ${opts.backend.model ?? opts.backend.name} does not accept a sampling temperature, so ` +
        `these frames were scored at the provider's default rather than at ${JUDGE_TEMPERATURE}. The ` +
        'same screenshot can score differently on a rescore, and that variance is inside the AUC. ' +
        'result.json records the temperature as null rather than as the value that was asked for, so ' +
        'p2p compare will not pool this run with one that was scored at a fixed temperature.',
    );
  }

  // Walk forward, holding the last judged score across visually identical frames.
  let lastScore = 0;
  let lastCriteria: Record<string, { met: boolean; note?: string }> | undefined;
  let lastNote: string | undefined;
  let everJudged = false;
  const scored: ScoredFrame[] = frames.map((f) => {
    if (f.class !== 'render') {
      return { ...f, score: 0, scoreSource: 'non-render' as const };
    }
    const v = verdicts.get(f.index);
    if (v) {
      lastScore = scoreFromVerdict(brief, v);
      lastCriteria = v.criteria;
      lastNote = v.overall;
      everJudged = true;
      return { ...f, score: lastScore, scoreSource: 'judge' as const, criteria: v.criteria, judgeNote: v.overall };
    }
    if (!everJudged) {
      // Rendering, but nothing has been judged yet -- fall back to mechanical
      // rather than claiming a score we never measured.
      return { ...f, score: f.entityCoverage, scoreSource: 'mechanical' as const };
    }
    return { ...f, score: lastScore, scoreSource: 'forward-fill' as const, criteria: lastCriteria, judgeNote: lastNote };
  });

  return { frames: scored, framesJudged: calls, degraded: false, warnings };
}
