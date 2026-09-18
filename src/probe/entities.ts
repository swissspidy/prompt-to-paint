import type { Entity } from '../types.ts';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Compiled matchers, keyed by the alias they came from.
 *
 * `entityCoverage` runs inside every capture -- four times a second during an
 * iteration -- and a brief's aliases do not change between frames, so compiling
 * the same handful of patterns over and over was spending time in the one place
 * the harness cannot afford it: a capture that overruns its tick drops the
 * frame, and the dropped frame is the resolution the metric is quoted at.
 *
 * A `null` entry is an alias that normalises to nothing and can never match.
 */
const MATCHERS = new Map<string, RegExp | string | null>();

/**
 * Bound on the matcher cache.
 *
 * A run uses a handful of aliases, so this is never reached in practice; it
 * exists because the map is module-global and would otherwise grow without
 * limit in anything long-lived that scores many briefs. Cleared rather than
 * evicted one at a time: the cost of a cold rebuild is a few regex compiles.
 */
const MAX_MATCHERS = 2000;

/** Word-boundary match for alphanumeric aliases, substring for the rest. */
function matcherFor(alias: string): RegExp | string | null {
  const a = norm(alias);
  if (!a) return null;
  if (/^[a-z0-9 ]+$/.test(a)) {
    // No `g` flag: a stateful regex would carry lastIndex between frames.
    return new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  }
  return a;
}

function aliasPresent(haystack: string, alias: string): boolean {
  let m = MATCHERS.get(alias);
  if (m === undefined) {
    if (MATCHERS.size >= MAX_MATCHERS) MATCHERS.clear();
    m = matcherFor(alias);
    MATCHERS.set(alias, m);
  }
  if (m === null) return false;
  return typeof m === 'string' ? haystack.includes(m) : m.test(haystack);
}

export interface Coverage {
  coverage: number;
  found: string[];
  missing: string[];
}

/**
 * Weighted fraction of the brief's named entities visible in rendered text.
 *
 * This is the mechanical half of "reviewable": it asks whether the things the
 * brief named are on screen, not whether they look good. Deliberately dumb so
 * the reviewability threshold stays reproducible across runs and judges.
 */
export function entityCoverage(text: string, entities: Entity[]): Coverage {
  const hay = norm(text);
  const found: string[] = [];
  const missing: string[] = [];
  let got = 0;
  let total = 0;
  for (const e of entities) {
    const w = e.weight ?? 1;
    total += w;
    if (e.aliases.some((a) => aliasPresent(hay, a))) {
      got += w;
      found.push(e.id);
    } else {
      missing.push(e.id);
    }
  }
  return { coverage: total ? got / total : 0, found, missing };
}
