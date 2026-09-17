import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

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

  // A pre-provisioned browsers directory, which is what CI images and this
  // project's own container use.
  const fromDir = scanBrowsersDir(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (fromDir) return fromDir;

  // Ask Playwright where it installed its own browser. `npx playwright install`
  // with no PLAYWRIGHT_BROWSERS_PATH set -- the ordinary case on a CI runner or
  // a laptop -- lands in a per-user cache that the scan above never sees.
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    // Playwright throws when it has no browser registered; fall through.
  }

  return scanBrowsersDir(defaultCacheDir());
}

/** Playwright's per-user cache, by platform. */
function defaultCacheDir(): string | undefined {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : undefined;
  }
  return join(homedir(), '.cache', 'ms-playwright');
}

/**
 * Find the newest Chromium build under a browsers directory.
 */
function scanBrowsersDir(root: string | undefined): string | undefined {
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
