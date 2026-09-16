import { readFile } from 'node:fs/promises';
import type { Brief } from './types.js';

class BriefError extends Error {}

function need<T>(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new BriefError(msg);
}

/**
 * Loads and validates a brief.
 *
 * Validation is strict and loud because a malformed rubric fails silently in
 * the worst way: the run completes, produces a plausible number, and that
 * number means nothing. An empty rubric would score every frame 1.0.
 */
export function parseBrief(raw: unknown, source: string): Brief {
  const b = raw as Partial<Brief>;
  need(b && typeof b === 'object', `${source}: not an object`);
  need(typeof b.id === 'string' && b.id, `${source}: missing "id"`);
  need(typeof b.prompt === 'string' && b.prompt.trim(), `${source}: missing "prompt"`);
  need(typeof b.horizonSec === 'number' && b.horizonSec > 0, `${source}: "horizonSec" must be a positive number`);
  need(Array.isArray(b.entities) && b.entities.length > 0, `${source}: "entities" must be a non-empty array`);
  need(Array.isArray(b.rubric) && b.rubric.length > 0, `${source}: "rubric" must be a non-empty array`);
  need(
    typeof b.reviewableThreshold === 'number' && b.reviewableThreshold > 0 && b.reviewableThreshold <= 1,
    `${source}: "reviewableThreshold" must be in (0, 1]`,
  );

  for (const e of b.entities!) {
    need(typeof e.id === 'string' && e.id, `${source}: entity without an id`);
    need(Array.isArray(e.aliases) && e.aliases.length > 0, `${source}: entity "${e.id}" has no aliases`);
  }
  const ids = new Set<string>();
  for (const c of b.rubric!) {
    need(typeof c.id === 'string' && c.id, `${source}: rubric criterion without an id`);
    need(!ids.has(c.id), `${source}: duplicate rubric id "${c.id}"`);
    ids.add(c.id);
    need(typeof c.description === 'string' && c.description.trim(), `${source}: criterion "${c.id}" has no description`);
    need(typeof c.weight === 'number' && c.weight > 0, `${source}: criterion "${c.id}" needs a positive weight`);
  }
  for (const it of b.iterations ?? []) {
    need(typeof it.id === 'string' && it.id, `${source}: iteration without an id`);
    need(typeof it.prompt === 'string' && it.prompt.trim(), `${source}: iteration "${it.id}" has no prompt`);
    need(
      typeof it.check === 'string' && it.check.trim(),
      `${source}: iteration "${it.id}" has no check expression -- iteration success must be mechanical`,
    );
  }
  return {
    title: b.title ?? b.id!,
    ...b,
  } as Brief;
}

export async function loadBrief(path: string): Promise<Brief> {
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BriefError(`${path}: invalid JSON (${String(e)})`);
  }
  return parseBrief(parsed, path);
}
