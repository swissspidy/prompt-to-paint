import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  ['chrome-linux', 'chrome'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-win', 'chrome.exe'],
];

/**
 * Find a Chromium that Playwright can drive.
 *
 * CI images often ship a browser whose build number does not match the
 * Playwright version in package.json, and Playwright then refuses to launch
 * even though a perfectly good binary is sitting on disk. Rather than pin the
 * two together forever, look for the newest build in the browsers directory and
 * hand Playwright an explicit path.
 *
 * Returns undefined when nothing is found, so Playwright falls back to its own
 * resolution and reports its own (clearer) error.
 */
export function findChromium(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.P2P_CHROMIUM) return process.env.P2P_CHROMIUM;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;

  let best: { build: number; path: string } | undefined;
  for (const entry of readdirSync(root)) {
    const m = /^chromium-(\d+)$/.exec(entry);
    if (!m) continue;
    const build = Number(m[1]);
    for (const parts of CANDIDATES) {
      const p = join(root, entry, ...parts);
      if (existsSync(p) && (!best || build > best.build)) best = { build, path: p };
    }
  }
  return best?.path;
}
