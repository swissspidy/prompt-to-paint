import type { Brief } from './types.js';

/**
 * Toolchain-floor controls: the same measurement with no model in the loop.
 *
 * This is the control the "is the model even the bottleneck?" question needs.
 * Without it, a fast agent and a slow one are only comparable to each other,
 * and there is no way to tell whether either is anywhere near the floor set by
 * scaffolding, installing, and booting a dev server. Whatever an agent scores
 * on time-to-first-render, the honest question is how much of it was ever
 * available to win back.
 */
export interface FloorTemplate {
  id: string;
  description: string;
  /** Shell script, with {{PORT}} substituted. Must end up serving on that port. */
  script: string;
}

export const FLOOR_TEMPLATES: Record<string, FloorTemplate> = {
  'vite-react': {
    id: 'vite-react',
    description: 'npm create vite (react) + install + dev server',
    script: [
      'set -e',
      'npm create vite@latest app -- --template react --yes >/dev/null 2>&1',
      'cd app',
      'npm install >/dev/null 2>&1',
      'npm run dev -- --port {{PORT}} --strictPort --host 127.0.0.1',
    ].join('\n'),
  },
  'vite-vanilla': {
    id: 'vite-vanilla',
    description: 'npm create vite (vanilla) + install + dev server',
    script: [
      'set -e',
      'npm create vite@latest app -- --template vanilla --yes >/dev/null 2>&1',
      'cd app',
      'npm install >/dev/null 2>&1',
      'npm run dev -- --port {{PORT}} --strictPort --host 127.0.0.1',
    ].join('\n'),
  },
  static: {
    id: 'static',
    description: 'write one HTML file, serve it -- the no-toolchain floor',
    script: [
      'set -e',
      "printf '%s' '<!doctype html><meta charset=utf-8><title>Floor</title><h1>Floor control</h1><p>Static page, no build step.</p>' > index.html",
      'exec python3 -m http.server {{PORT}} --bind 127.0.0.1',
    ].join('\n'),
  },
};

/** A brief whose only job is to hold the port and keep validation happy. */
export function floorBrief(template: FloorTemplate, port: number, horizonSec: number): Brief {
  return {
    id: `floor-${template.id}`,
    title: `Toolchain floor: ${template.description}`,
    prompt: '(control run: no agent)',
    horizonSec,
    reviewableThreshold: 1,
    entities: [{ id: 'anything', aliases: ['floor', 'vite', 'react', 'hello'] }],
    rubric: [{ id: 'renders', description: 'The page shows something.', weight: 1 }],
    target: { port },
  };
}
