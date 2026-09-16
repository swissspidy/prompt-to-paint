import type { Entity } from '../types.js';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Word-boundary match for alphanumeric aliases, substring for the rest. */
function aliasPresent(haystack: string, alias: string): boolean {
  const a = norm(alias);
  if (!a) return false;
  if (/^[a-z0-9 ]+$/.test(a)) {
    const re = new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    return re.test(haystack);
  }
  return haystack.includes(a);
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
