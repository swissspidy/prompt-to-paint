import type { RunResult, ScoredFrame } from './types.ts';

/**
 * The frames every headline number is computed from.
 *
 * `result.frames` carries the whole run, cold start and iterations both, so a
 * run can be replayed in full. Everything that scores, ranks or charts a run
 * wants only the cold-start window: the iteration frames are unjudged, they
 * answer a different question ("how fast does one edit land"), and letting them
 * into a curve would draw a line the AUC beside it does not describe.
 *
 * Results written before phases existed have nothing tagged, so fall back to
 * the window the curve itself recorded.
 */
export function coldFrames(r: RunResult): ScoredFrame[] {
  return r.frames.filter((f) => (f.phase ? f.phase === 'cold' : f.tMs <= r.curve.runEndMs));
}
