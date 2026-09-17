import { writeFile, rename } from 'node:fs/promises';

/**
 * Write JSON so a reader never sees a half-written file.
 *
 * `writeFile` truncates the target before it writes, so for a stretch there is
 * a `result.json` that parses as nothing. That is normally invisible; here it
 * is the exact thing being guarded against. A run writes its result twice --
 * once with the timeline and provisional scores, once with real ones -- and the
 * whole point of the first write is that an interrupted judge still leaves a
 * complete run on disk. Truncating that file to replace it would hand back the
 * failure it exists to prevent, with a partial file that is worse than either
 * version because nothing can read it.
 *
 * The temporary file is a sibling, so the rename stays within one filesystem
 * and is atomic rather than a copy.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
