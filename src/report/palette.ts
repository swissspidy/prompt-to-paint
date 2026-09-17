import type { Bucket } from '../types.ts';

/**
 * Categorical slots in fixed order, from the validated reference palette.
 * Never cycled, never reordered: a bucket keeps its colour across every run so
 * two reports can be compared side by side.
 *
 * Validated with the skill's checker in both modes. Light mode returns a
 * contrast WARN on three slots, so every chart here ships the required relief:
 * direct labels on the segments and a table view of the same numbers.
 */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

export const BUCKET_ORDER: Bucket[] = [
  'model', 'tool_overhead', 'install', 'build', 'devserver_boot', 'first_paint', 'residual',
];

export const BUCKET_LABEL: Record<Bucket, string> = {
  model: 'Model thinking',
  tool_overhead: 'Tool round trips',
  install: 'Dependency install',
  build: 'Build',
  devserver_boot: 'Dev server boot',
  first_paint: 'First paint',
  residual: 'Unaccounted',
};

/** Which side of the agent/toolchain question each bucket belongs to. */
export const BUCKET_SIDE: Record<Bucket, 'agent' | 'toolchain' | 'unknown'> = {
  model: 'agent',
  tool_overhead: 'agent',
  install: 'toolchain',
  build: 'toolchain',
  devserver_boot: 'toolchain',
  first_paint: 'toolchain',
  residual: 'unknown',
};

export const bucketVar = (b: Bucket): string =>
  b === 'residual' ? 'var(--muted-fill)' : `var(--series-${BUCKET_ORDER.indexOf(b) + 1})`;
