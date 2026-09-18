import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { analyzeShot } from './pixels.ts';
import { classify, ERROR_SELECTORS } from './classify.ts';
import { findChromium } from './browser.ts';
import { sleep } from '../sleep.ts';
import type { Frame } from '../types.ts';

export interface ProberOptions {
  url: string;
  framesDir: string;
  t0Epoch: number;
  intervalMs?: number;
  /**
   * The window every number in the run is measured through.
   *
   * It decides what the judge is shown and, since text is read from the same
   * rectangle, what entity coverage counts. A brief whose rubric asks about a
   * pricing table and a footer needs a window tall enough to contain them, or
   * those criteria are unwinnable however good the page is.
   */
  viewport?: { width: number; height: number };
  /** Consecutive failed server probes before we call a live page stale. */
  serverDownGrace?: number;
  /** Explicit Chromium binary. Defaults to P2P_CHROMIUM, then autodetection. */
  executablePath?: string;
  /**
   * Show the browser window. Costs nothing measurable and is the only way to
   * watch a run happen, but needs a display, so it is off by default.
   */
  headed?: boolean;
  /**
   * Record the whole session to this path as WebM. Chromium screencasts the
   * page continuously, which is more browser work than the poll alone, so this
   * is opt-in and the report says when it was on.
   */
  videoPath?: string;
  /**
   * Consecutive non-rendering frames tolerated before the prober reloads a
   * live page. Gives a booting app time to paint before we refresh it.
   */
  renavigateAfter?: number;
  onFrame?: (f: Frame) => void;
  /** Brief-specific enrichment, supplied by the orchestrator. */
  analyze?: (text: string) => { entityCoverage: number; entitiesFound: string[] };
}

interface PageObservation {
  /** Text inside the viewport. What the judge can see, so what counts. */
  text: string;
  /** Characters of text outside it -- present in the DOM, below the fold. */
  offscreenChars: number;
  title: string;
  /** Absolute href of the page's declared icon, or null if it declares none. */
  favicon: string | null;
  overlayHit: string | null;
  mediaBoxes: number;
  domSignature: string;
}

export const OBSERVE = `(() => {
  const sels = ${JSON.stringify(ERROR_SELECTORS)};
  let overlayHit = null;
  for (const s of sels) { try { if (document.querySelector(s)) { overlayHit = s; break; } } catch {} }
  let mediaBoxes = 0;
  for (const el of document.querySelectorAll('img,svg,canvas,video')) {
    const r = el.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) mediaBoxes++;
  }
  // Text the viewport actually shows, not the whole document.
  //
  // The judge scores a viewport screenshot and is told to credit only what it
  // can see. Entity coverage -- which decides time to first *reviewable*
  // render -- used to read document.body.innerText, the entire page, fold or no
  // fold. So the two halves of one metric disagreed about what "on screen"
  // meant, and a page whose content sat below 800px could be called reviewable
  // by one and empty by the other. One rule, applied to both: on screen means
  // in the viewport. A brief that wants more of the page in scope says so with
  // a taller target.viewport.
  let text = '';
  let offscreenChars = 0;
  if (document.body) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const parts = [];
    let seen = 0;
    for (let n = walker.nextNode(); n && seen < 4000; n = walker.nextNode()) {
      const raw = n.nodeValue;
      if (!raw || !raw.trim()) continue;
      const parent = n.parentElement;
      if (!parent || parent.closest('script,style,noscript,template')) continue;
      seen++;
      let onScreen = false;
      try {
        range.selectNodeContents(n);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) { onScreen = true; break; }
        }
      } catch {}
      if (onScreen) parts.push(raw.trim());
      else offscreenChars += raw.trim().length;
    }
    text = parts.join('\\n');
  }
  // The last declared icon wins, the way the browser resolves it. .href is the
  // resolved absolute URL; the attribute would be whatever relative string the
  // page happened to write.
  let favicon = null;
  const icons = document.querySelectorAll('link[rel~="icon" i],link[rel="shortcut icon" i],link[rel="apple-touch-icon" i]');
  const lastIcon = icons[icons.length - 1];
  if (lastIcon && lastIcon.href) favicon = String(lastIcon.href);
  const tags = {};
  for (const el of document.querySelectorAll('*')) {
    tags[el.tagName] = (tags[el.tagName] || 0) + 1;
  }
  const domSignature = Object.keys(tags).sort().map(k => k + k[0] + tags[k]).join('|');
  return {
    text: text.slice(0, 20000),
    offscreenChars,
    title: document.title || '',
    favicon,
    overlayHit,
    mediaBoxes,
    domSignature,
  };
})()`;

/**
 * Does the browser chrome identify the app yet?
 *
 * Asked because the two halves of the tab move before the page does: an app
 * that sets `<title>` and an icon in its index.html says "Orbit" in the tab
 * while the viewport is still an empty grey rectangle. That is a real signal to
 * the person waiting -- it is the first evidence the right thing is starting --
 * and a screenshot of the viewport cannot contain it.
 *
 * A title Chromium derived from the address is not a signal: a document with no
 * `<title>` is titled after its own URL, so counting that would fire on every
 * blank page ever served.
 */
export function tabSignalFrom(title: string, favicon: string | null, url: string): boolean {
  if (favicon) return true;
  const t = title.trim();
  if (!t) return false;
  let derived: string[] = [];
  try {
    const u = new URL(url);
    const hostPath = `${u.host}${u.pathname}`.replace(/\/$/, '');
    derived = [u.href, u.href.replace(/\/$/, ''), u.host, hostPath, `${hostPath}/`];
  } catch {
    derived = [url];
  }
  return !derived.includes(t);
}

export interface CaptureAttempt {
  buf: Buffer | null;
  /** The last error, when every attempt failed. Null on success. */
  error: string | null;
  attempts: number;
}

/**
 * Take a screenshot, retrying the refusals that are not answers.
 *
 * Chromium answers `Page.captureScreenshot` with "Unable to capture screenshot"
 * when its compositor has no frame to hand over yet. That is most likely in the
 * moments right after a navigation fails -- which is to say, over the whole
 * stretch before anything is serving, the part of a run this harness exists to
 * measure. It is transient: the next attempt milliseconds later succeeds. It is
 * also not a timeout, so waiting longer does not help and retrying does.
 *
 * The attempts share the original budget rather than each getting it, so a page
 * that is genuinely slow to paint cannot turn one overrunning capture into
 * three.
 */
export async function captureWithRetry(
  take: (timeoutMs: number) => Promise<Buffer>,
  opts: { budgetMs: number; attempts?: number; wait?: (ms: number) => Promise<void> },
): Promise<CaptureAttempt> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const perAttempt = Math.max(500, Math.floor(opts.budgetMs / attempts));
  const wait = opts.wait ?? sleep;
  let error: string | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return { buf: await take(perAttempt), error: null, attempts: i + 1 };
    } catch (e) {
      error = String(e).slice(0, 200);
      if (i < attempts - 1) await wait(50 * (i + 1));
    }
  }
  return { buf: null, error, attempts };
}

/**
 * Polls a URL and turns it into a timeline of frames.
 *
 * Two rules shape the design. First, the prober must not perturb what it
 * measures: it navigates once and then stays put, so HMR updates land the way
 * they would for a human with the tab open, and no screenshot work blocks the
 * agent. Second, every frame carries the evidence behind its classification,
 * so a surprising curve can be audited frame by frame instead of re-run.
 */
export class Prober {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private capturing = false;
  private index = 0;
  private live = false;
  private consoleErrors: string[] = [];
  private serverFails = 0;
  private skipped = 0;
  private check: string | null = null;
  private staleTicks = 0;
  private everRendered = false;
  private lastDocHash: string | null = null;
  private reloads = 0;
  private lastShot: { dhash: string; colorSig: string; screenshotPath: string } | null = null;
  private distinct = 0;
  private duplicates = 0;
  private failedShots: string[] = [];
  private video: string | null = null;

  readonly frames: Frame[] = [];

  private opts: ProberOptions;

  constructor(opts: ProberOptions) {
    this.opts = opts;
  }

  /**
   * Current poll interval; iteration runs finer than cold start.
   */
  get intervalMs(): number {
    return this.opts.intervalMs ?? 1000;
  }

  /** Frames are stamped at capture start, so all times carry this quantization. */
  get resolutionMs(): number {
    return this.intervalMs;
  }

  /**
   * Ticks dropped because a capture overran the interval.
   */
  get skippedTicks(): number {
    return this.skipped;
  }

  /** Reloads the prober performed. High counts mean a volatile document. */
  get reloadCount(): number {
    return this.reloads;
  }

  /** Screenshots actually written. Frames that repeat one share its file. */
  get distinctShots(): number {
    return this.distinct;
  }

  /** Frames whose screenshot was identical to the one before it. */
  get repeatedShots(): number {
    return this.duplicates;
  }

  /**
   * Captures the browser refused outright, one message each.
   *
   * A frame with no picture used to be indistinguishable from one the prober
   * never tried to take, because the failure was caught and dropped. It is the
   * kind of thing that only shows up much later, as a hole in a filmstrip or a
   * blank stretch in a video, with nothing anywhere saying why.
   */
  get shotFailures(): string[] {
    return this.failedShots;
  }

  /** Where the session recording landed, once the run has stopped. */
  get videoPath(): string | null {
    return this.video;
  }

  /**
   * Launch the browser and begin polling.
   */
  async start(): Promise<void> {
    await mkdir(this.opts.framesDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      executablePath: findChromium(this.opts.executablePath),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      // Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers by default.
      // They kill the browser and then exit the process -- which pre-empts the
      // harness's own teardown mid-flight. The visible result of a Ctrl-C was a
      // browser that closed tidily, an agent still running, and its dev server
      // still holding the target port: precisely the leak the harness's handler
      // exists to prevent, defeated by the one step that ran before it. The
      // browser is closed in `stop()`, which the harness calls on those signals
      // itself, so nothing is lost by owning them.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const viewport = this.opts.viewport ?? { width: 1280, height: 800 };
    // Playwright names the recording itself and only finalises it when the
    // context closes, so it is written to a scratch directory here and moved
    // to the requested path in stop().
    const videoDir = this.opts.videoPath ? join(this.opts.framesDir, '..', '.video') : undefined;
    this.context = await this.browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
      ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
    });
    this.page = await this.context.newPage();
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300));
    });
    this.page.on('pageerror', (e) => this.consoleErrors.push(String(e).slice(0, 300)));
    this.running = true;
    this.schedule();
  }

  /**
   * Queue the next tick after the current one settles, never on a fixed timer,
   * so captures cannot pile up.
   */
  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.intervalMs);
  }

  /**
   * One observation. Overlapping ticks are dropped rather than queued: a
   * backlog would report stale states at fresh timestamps, which is worse than
   * a gap in the curve.
   */
  private async tick(): Promise<void> {
    if (!this.running || this.capturing) {
      if (this.capturing) this.skipped++;
      return;
    }
    this.capturing = true;
    const startEpoch = Date.now();
    const tMs = startEpoch - this.opts.t0Epoch;
    try {
      const frame = await this.capture(tMs);
      this.frames.push(frame);
      this.opts.onFrame?.(frame);
    } catch (err) {
      this.frames.push(this.errorFrame(tMs, String(err), Date.now() - startEpoch));
    } finally {
      this.capturing = false;
    }
  }

  /**
   * A frame recording that the capture itself failed.
   */
  private errorFrame(tMs: number, reason: string, captureMs: number, index = this.index++): Frame {
    return {
      index,
      tMs,
      class: 'unreachable',
      reason: `capture-failed:${reason.slice(0, 120)}`,
      screenshotPath: null,
      dhash: null,
      colorSig: null,
      inkRatio: 0,
      text: '',
      offscreenTextChars: 0,
      title: '',
      favicon: null,
      tabSignal: false,
      httpStatus: null,
      consoleErrors: [],
      entityCoverage: 0,
      entitiesFound: [],
      domSignature: '',
      captureMs,
    };
  }

  /**
   * Screenshot the page, analyse it, and put it on disk.
   *
   * Consecutive frames that look identical share one file. An agent that
   * finishes early and leaves its dev server up produces hundreds of identical
   * PNGs otherwise -- most of a run directory's size, and a filmstrip nobody
   * can read. The test is exact equality of both the luminance hash and the
   * colour grid, which is stricter than the near-miss threshold the judge uses
   * to decide a frame does not need re-scoring.
   */
  private async shoot(index: number): Promise<{
    inkRatio: number;
    dhash: string | null;
    colorSig: string | null;
    screenshotPath: string | null;
  }> {
    const shot = await captureWithRetry(
      (timeout) => this.page!.screenshot({ type: 'png', timeout }),
      { budgetMs: Math.max(3000, this.intervalMs * 2) },
    );
    if (!shot.buf) {
      // Recorded rather than dropped: the frame still belongs on the timeline,
      // but the run has to be able to say why it has no picture.
      this.failedShots.push(shot.error ?? 'unknown');
      return { inkRatio: 0, dhash: null, colorSig: null, screenshotPath: null };
    }
    const buf = shot.buf;
    const a = analyzeShot(buf);
    const prev = this.lastShot;
    if (prev && prev.dhash === a.dhash && prev.colorSig === a.colorSig) {
      this.duplicates++;
      return { ...a, screenshotPath: prev.screenshotPath };
    }
    const screenshotPath = join(this.opts.framesDir, `f${String(index).padStart(5, '0')}.png`);
    await writeFile(screenshotPath, buf);
    this.distinct++;
    this.lastShot = { dhash: a.dhash, colorSig: a.colorSig, screenshotPath };
    return { ...a, screenshotPath };
  }

  /**
   * Take one observation: navigate if needed, screenshot, read the DOM, and
   * classify what a person would be looking at.
   *
   * Every frame carries a screenshot, including the ones taken before anything
   * is listening. Those frames are the first minutes of a run -- exactly the
   * window this harness exists to measure -- and skipping them meant the
   * filmstrip opened on the finished app, as if it had appeared instantly.
   */
  private async capture(tMs: number): Promise<Frame> {
    const page = this.page!;
    const startedAt = Date.now();
    const index = this.index++;

    // Server liveness is probed out-of-band so we never have to re-navigate
    // just to learn the server's status -- re-navigating would destroy HMR
    // state and change the very latency we are trying to measure.
    const probe = await this.probeServer();
    const status = probe.status;

    // Reload when the *served document* changed.
    //
    // A dev server pushes updates over its own channel and its index.html
    // usually stays byte-identical, so this does not fire and HMR timing is
    // preserved. A plain static page has no such channel: the only way anyone
    // sees an edit is a refresh, which is exactly what a human would do. Keying
    // on the served bytes gets both cases right without special-casing either.
    const docChanged =
      probe.hash !== null && this.lastDocHash !== null && probe.hash !== this.lastDocHash;
    if (probe.hash !== null) this.lastDocHash = probe.hash;

    // Re-navigate when the live page is stale. A page that went live on an
    // early 404 would otherwise show that 404 forever, because the prober
    // deliberately does not reload once it is live. The counter means a booting
    // app gets a few seconds to paint on its own before we refresh it, and once
    // anything has rendered we stop reloading entirely so HMR is preserved.
    const needsReload =
      this.live &&
      (docChanged || (!this.everRendered && this.staleTicks >= (this.opts.renavigateAfter ?? 4)));

    if (!this.live || needsReload) {
      try {
        if (this.live) this.reloads++;
        const res = await page.goto(this.opts.url, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(2000, this.intervalMs * 2),
        });
        this.staleTicks = 0;
        // An error response is not "live": keep retrying navigation until the
        // server actually serves the app.
        this.live = res === null || res.status() < 400;
        if (!this.live) {
          return {
            ...this.errorFrame(tMs, `http-${res!.status()}`, 0, index),
            ...(await this.shoot(index)),
            class: 'error',
            reason: `http-${res!.status()}`,
            httpStatus: res!.status(),
            captureMs: Date.now() - startedAt,
          };
        }
      } catch {
        // Chromium paints its own "site can't be reached" page here, which is
        // an honest picture of what a person would see: nothing yet.
        return {
          ...this.errorFrame(tMs, 'not-listening', 0, index),
          ...(await this.shoot(index)),
          reason: 'unreachable:not-listening',
          httpStatus: status,
          captureMs: Date.now() - startedAt,
        };
      }
    }

    let obs: PageObservation;
    try {
      obs = (await page.evaluate(OBSERVE)) as PageObservation;
    } catch {
      // Usually a navigation landed mid-evaluate. One retry; the page is
      // reloading, which is itself a legitimate thing to observe.
      await page.waitForTimeout(120);
      try {
        obs = (await page.evaluate(OBSERVE)) as PageObservation;
      } catch (e) {
        return {
          ...this.errorFrame(tMs, `evaluate:${e}`, 0, index),
          ...(await this.shoot(index)),
          captureMs: Date.now() - startedAt,
        };
      }
    }

    const { inkRatio: ink, dhash: hash, colorSig: sig, screenshotPath } = await this.shoot(index);

    if (status === null) this.serverFails++;
    else this.serverFails = 0;
    const serverDown = this.serverFails >= (this.opts.serverDownGrace ?? 3);

    let cls = classify({
      reachable: true,
      httpStatus: status,
      text: obs.text,
      overlayHit: obs.overlayHit,
      mediaBoxes: obs.mediaBoxes,
      inkRatio: ink,
    });

    // A stale-but-pretty page after the server has gone is not a working app:
    // the human's next click would fail. Brief restarts are tolerated by the
    // grace window above.
    if (serverDown) cls = { class: 'error', reason: 'server-down' };

    if (cls.class === 'render') {
      this.everRendered = true;
      this.staleTicks = 0;
    } else {
      this.staleTicks++;
    }

    let checkPassed: boolean | null = null;
    if (this.check) {
      try {
        checkPassed = Boolean(await page.evaluate(`Boolean(${this.check})`));
      } catch {
        // A check that throws (missing element, mid-reload) has not passed.
        checkPassed = false;
      }
    }

    const errs = this.consoleErrors.splice(0);
    const an = this.opts.analyze?.(obs.text) ?? { entityCoverage: 0, entitiesFound: [] };

    return {
      index,
      tMs,
      class: cls.class,
      reason: cls.reason,
      screenshotPath,
      dhash: hash,
      colorSig: sig,
      inkRatio: ink,
      text: obs.text,
      offscreenTextChars: obs.offscreenChars,
      title: obs.title,
      favicon: obs.favicon,
      tabSignal: tabSignalFrom(obs.title, obs.favicon, this.opts.url),
      httpStatus: status,
      consoleErrors: errs,
      entityCoverage: an.entityCoverage,
      entitiesFound: an.entitiesFound,
      domSignature: obs.domSignature,
      captureMs: Date.now() - startedAt,
      checkPassed,
    };
  }

  private async probeServer(): Promise<{ status: number | null; hash: string | null }> {
    try {
      const ctl = AbortSignal.timeout(Math.max(1500, this.intervalMs));
      const res = await fetch(this.opts.url, { signal: ctl, redirect: 'manual' });
      const buf = await res.arrayBuffer().catch(() => null);
      const hash = buf
        ? createHash('sha1').update(Buffer.from(buf).subarray(0, 262_144)).digest('hex')
        : null;
      return { status: res.status, hash };
    } catch {
      return { status: null, hash: null };
    }
  }

  /** Change poll rate mid-run. Iteration needs finer resolution than cold start. */
  setInterval(ms: number): void {
    this.opts.intervalMs = ms;
  }

  /**
   * Arm a per-frame predicate, evaluated in the page.
   *
   * Iteration success is decided mechanically by this expression rather than by
   * a judge, so "did the header actually turn blue" is reproducible.
   */
  setCheck(expr: string | null): void {
    this.check = expr;
  }

  /**
   * Run one capture immediately, outside the poll schedule.
   *
   * Waits for any in-flight capture rather than skipping, so an iteration
   * baseline is the current state and not a frame up to one interval stale.
   */
  async sample(): Promise<Frame | null> {
    for (let i = 0; i < 40 && this.capturing; i++) await sleep(25);
    await this.tick();
    return this.frames.at(-1) ?? null;
  }

  /**
   * Stop polling and close the browser, letting an in-flight capture finish so
   * the last frame is not truncated.
   *
   * The context is closed before the browser because that is what finalises a
   * video recording; closing the browser out from under it leaves a truncated
   * file. A recording that cannot be saved is reported as absent, never as a
   * failed run.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    // Let an in-flight capture finish so the last frame is not truncated.
    for (let i = 0; i < 50 && this.capturing; i++) await sleep(50);
    const recording = this.opts.videoPath ? this.page?.video() ?? null : null;
    await this.context?.close().catch(() => undefined);
    if (recording && this.opts.videoPath) {
      try {
        const src = await recording.path();
        await rename(src, this.opts.videoPath);
        this.video = this.opts.videoPath;
        await rm(dirname(src), { recursive: true, force: true }).catch(() => undefined);
      } catch {
        this.video = null;
      }
    }
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
