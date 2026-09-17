import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { classify } from '../src/probe/classify.ts';
import { entityCoverage } from '../src/probe/entities.ts';
import { decodeGray, dhash, hamming, inkRatio, colorSignature, colorDelta } from '../src/probe/pixels.ts';
import { captureWithRetry } from '../src/probe/prober.ts';

const base = { reachable: true, httpStatus: 200, overlayHit: null, mediaBoxes: 0, inkRatio: 0.3 };

test('classify: an unreachable server is not an error page', () => {
  assert.equal(classify({ ...base, reachable: false, text: '' }).class, 'unreachable');
});

test('classify: status codes and dev-server overlays are errors', () => {
  assert.equal(classify({ ...base, httpStatus: 500, text: 'x' }).class, 'error');
  assert.equal(classify({ ...base, httpStatus: 404, text: 'x' }).class, 'error');
  assert.equal(classify({ ...base, overlayHit: 'vite-error-overlay', text: 'app' }).class, 'error');
});

test('classify: error text only counts when it dominates the page', () => {
  assert.equal(classify({ ...base, text: 'Failed to resolve import "./App"' }).class, 'error');
  // A real app that happens to display the word error is not a crash.
  const longPage = 'Dashboard. '.repeat(80) + ' Error rate: 0.2% ' + 'More content. '.repeat(40);
  assert.equal(classify({ ...base, text: longPage }).class, 'render');
});

test('classify: a loading placeholder is blank, not a render', () => {
  // Otherwise an SSR shell that ships a spinner wins time-to-first-render
  // without showing anyone anything.
  assert.equal(classify({ ...base, text: 'Loading...', inkRatio: 0.001 }).class, 'blank');
  assert.equal(classify({ ...base, text: 'Loading...', inkRatio: 0.001, loadingIsBlank: false }).class, 'render');
});

test('classify: blankness needs text, pixels and media to agree', () => {
  assert.equal(classify({ ...base, text: '', inkRatio: 0.0001 }).class, 'blank');
  // An image-only hero has no text but is plainly a render.
  assert.equal(classify({ ...base, text: '', inkRatio: 0.0001, mediaBoxes: 1 }).class, 'render');
  // A text-only page has almost no ink but is plainly a render.
  assert.equal(classify({ ...base, text: 'A real heading and a paragraph of copy', inkRatio: 0.001 }).class, 'render');
});

test('entityCoverage weights entities and respects word boundaries', () => {
  const entities = [
    { id: 'orbit', aliases: ['Orbit'], weight: 2 },
    { id: 'done', aliases: ['Done'] },
    { id: 'missing', aliases: ['Nowhere'] },
  ];
  const c = entityCoverage('Orbit board -- Done', entities);
  assert.equal(c.coverage, 3 / 4);
  assert.deepEqual(c.found.sort(), ['done', 'orbit']);

  // "cart" must not match "cartography".
  const strict = entityCoverage('cartography notes', [{ id: 'cart', aliases: ['cart'] }]);
  assert.equal(strict.coverage, 0);
});

test('entityCoverage matches any alias and ignores case and spacing', () => {
  const e = [{ id: 'progress', aliases: ['In Progress', 'Doing'] }];
  assert.equal(entityCoverage('doing', e).coverage, 1);
  assert.equal(entityCoverage('IN   PROGRESS', e).coverage, 1);
});

function png(fill: (x: number, y: number) => [number, number, number], w = 64, h = 64): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) << 2;
      const [r, g, b] = fill(x, y);
      img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

test('inkRatio is near zero for a uniform page and rises with content', () => {
  const blank = decodeGray(png(() => [255, 255, 255]));
  assert.ok(inkRatio(blank) < 0.001, `blank page ink ${inkRatio(blank)}`);
  const halved = decodeGray(png((_, y) => (y < 32 ? [255, 255, 255] : [0, 0, 0])));
  assert.ok(inkRatio(halved) > 0.4);
});

test('dhash is stable for identical images and moves for different layouts', () => {
  const a = dhash(decodeGray(png((x) => (x < 32 ? [255, 255, 255] : [0, 0, 0]))));
  const b = dhash(decodeGray(png((x) => (x < 32 ? [255, 255, 255] : [0, 0, 0]))));
  const c = dhash(decodeGray(png((_, y) => (y < 32 ? [255, 255, 255] : [0, 0, 0]))));
  assert.equal(hamming(a, b), 0);
  assert.ok(hamming(a, c) > 6, `different layouts should differ, got ${hamming(a, c)}`);
});

test('colour signature catches a recolour that luminance hashing misses', () => {
  // This is the "make the header blue" case. The two fills are chosen to have
  // near-identical luma, which is exactly when dhash goes blind.
  const before = png((_, y) => (y < 16 ? [128, 128, 128] : [255, 255, 255]));
  const after = png((_, y) => (y < 16 ? [40, 90, 220] : [255, 255, 255]));

  const dh = hamming(dhash(decodeGray(before)), dhash(decodeGray(after)));
  const cd = colorDelta(colorSignature(before), colorSignature(after));

  assert.equal(dh, 0, 'luminance hashing is blind to an equal-luma recolour');
  assert.ok(cd.max > 8, `worst-cell colour delta ${cd.max} should register the recolour`);
});

test('a localised recolour shows up in max but is diluted away in mean', () => {
  // Measured on a real page: one recoloured heading moved the mean 0.19 and the
  // worst cell 18.7. Thresholding the mean would miss every small edit.
  const before = png(() => [255, 255, 255], 128, 128);
  const after = png((x, y) => (x < 16 && y < 16 ? [40, 90, 220] : [255, 255, 255]), 128, 128);
  const d = colorDelta(colorSignature(before), colorSignature(after));
  assert.ok(d.max > 8, `max ${d.max}`);
  assert.ok(d.mean < d.max / 4, `mean ${d.mean} should be far smaller than max ${d.max}`);
});

test('colorDelta is zero for identical frames and ignores missing signatures', () => {
  const sig = colorSignature(png(() => [10, 20, 30]));
  assert.deepEqual(colorDelta(sig, sig), { mean: 0, max: 0 });
  assert.deepEqual(colorDelta(sig, null), { mean: 0, max: 0 });
});

// ---------------------------------------------------------------------------
// Screenshot retries: the browser's refusals are not all answers.
// ---------------------------------------------------------------------------

const shot = Buffer.from('png');
const noWait = async (): Promise<void> => undefined;

test('a screenshot that succeeds first time is not retried', async () => {
  let calls = 0;
  const r = await captureWithRetry(async () => { calls++; return shot; }, { budgetMs: 3000, wait: noWait });
  assert.equal(r.buf, shot);
  assert.equal(r.error, null);
  assert.equal(calls, 1);
});

test('a transient refusal is retried rather than recorded as a missing frame', async () => {
  // Chromium answers "Unable to capture screenshot" when its compositor has
  // nothing to hand over yet, which is most likely in the moments after a
  // navigation fails -- exactly the frames before anything is serving.
  let calls = 0;
  const r = await captureWithRetry(
    async () => {
      if (++calls < 3) throw new Error('Protocol error (Page.captureScreenshot): Unable to capture screenshot');
      return shot;
    },
    { budgetMs: 3000, wait: noWait },
  );
  assert.equal(r.buf, shot);
  assert.equal(r.attempts, 3);
});

test('a refusal that never clears is reported, not swallowed', async () => {
  const r = await captureWithRetry(
    async () => { throw new Error('still broken'); },
    { budgetMs: 3000, wait: noWait },
  );
  assert.equal(r.buf, null);
  assert.match(r.error ?? '', /still broken/);
  assert.equal(r.attempts, 3);
});

test('the attempts share one budget instead of each getting it', async () => {
  // Otherwise a page that is genuinely slow to paint turns one overrunning
  // capture into three, and the poll interval is blown by 3x rather than 1x.
  const budgets: number[] = [];
  await captureWithRetry(
    async (timeoutMs) => { budgets.push(timeoutMs); throw new Error('nope'); },
    { budgetMs: 3000, attempts: 3, wait: noWait },
  );
  assert.deepEqual(budgets, [1000, 1000, 1000]);
  assert.ok(budgets.reduce((a, b) => a + b, 0) <= 3000);
});

test('a tiny budget still leaves each attempt enough time to answer', async () => {
  const budgets: number[] = [];
  await captureWithRetry(
    async (timeoutMs) => { budgets.push(timeoutMs); throw new Error('nope'); },
    { budgetMs: 100, attempts: 3, wait: noWait },
  );
  assert.deepEqual(budgets, [500, 500, 500]);
});
