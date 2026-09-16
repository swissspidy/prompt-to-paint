import type { FrameClass } from '../types.js';

/** Dev-server and framework error overlays. Unambiguous when present. */
export const ERROR_SELECTORS = [
  'vite-error-overlay',
  '#nextjs__container_errors',
  '[data-nextjs-dialog]',
  '#webpack-dev-server-client-overlay',
  'iframe#react-error-overlay',
  '.parcel-error-overlay',
  '#svelte-announcer + .error',
];

/** Strong signals, only trusted when they dominate an otherwise empty page. */
const ERROR_TEXT = [
  /^cannot get \//i,
  /failed to resolve import/i,
  /module not found/i,
  /internal server error/i,
  /this site can'?t be reached/i,
  /err_connection_refused/i,
  /^\s*\d{3}\s*[:|-]?\s*(not found|forbidden|bad gateway)/i,
  /unexpected token|syntaxerror/i,
  /econnrefused|enoent/i,
];

const LOADING_TEXT = /^(loading|loading\.{1,3}|please wait|initializing|starting)[\s.!…]*$/i;

export interface ClassifyInput {
  reachable: boolean;
  httpStatus: number | null;
  text: string;
  overlayHit: string | null;
  mediaBoxes: number;
  inkRatio: number;
  /** Treat pure loading placeholders as blank. Defaults on; see METRIC.md. */
  loadingIsBlank?: boolean;
  minChars?: number;
  minInk?: number;
}

export interface ClassifyOutput {
  class: FrameClass;
  reason: string;
}

/**
 * Mechanical frame classification. No model involved: "is anything there" must
 * be reproducible, because both derived latency numbers key off it.
 */
export function classify(i: ClassifyInput): ClassifyOutput {
  const minChars = i.minChars ?? 8;
  const minInk = i.minInk ?? 0.004;
  const text = i.text.trim();

  if (!i.reachable) return { class: 'unreachable', reason: 'navigation-failed' };
  if (i.httpStatus !== null && i.httpStatus >= 400)
    return { class: 'error', reason: `http-${i.httpStatus}` };
  if (i.overlayHit) return { class: 'error', reason: `overlay:${i.overlayHit}` };

  // Only trust error text on a page that is mostly *just* the error. A real app
  // may legitimately render the word "error" in a form or a log viewer.
  if (text.length < 600) {
    for (const re of ERROR_TEXT) {
      if (re.test(text)) return { class: 'error', reason: `error-text:${re.source.slice(0, 24)}` };
    }
  }

  if ((i.loadingIsBlank ?? true) && LOADING_TEXT.test(text) && i.mediaBoxes === 0)
    return { class: 'blank', reason: 'loading-placeholder' };

  // Blankness needs agreement from text, pixels, and media. Any one of them
  // alone produces false blanks: an image-only hero has no text, a text-only
  // page has almost no ink.
  if (text.length < minChars && i.inkRatio < minInk && i.mediaBoxes === 0)
    return { class: 'blank', reason: `empty(text=${text.length},ink=${i.inkRatio.toFixed(4)})` };

  return { class: 'render', reason: `text=${text.length},ink=${i.inkRatio.toFixed(3)}` };
}
