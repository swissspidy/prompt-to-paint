import { chromium, type Browser, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
  viewport?: { width: number; height: number };
  /** Consecutive failed server probes before we call a live page stale. */
  serverDownGrace?: number;
  /** Explicit Chromium binary. Defaults to P2P_CHROMIUM, then autodetection. */
  executablePath?: string;
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
  text: string;
  title: string;
  overlayHit: string | null;
  mediaBoxes: number;
  domSignature: string;
}

const OBSERVE = `(() => {
  const sels = ${JSON.stringify(ERROR_SELECTORS)};
  let overlayHit = null;
  for (const s of sels) { try { if (document.querySelector(s)) { overlayHit = s; break; } } catch {} }
  let mediaBoxes = 0;
  for (const el of document.querySelectorAll('img,svg,canvas,video')) {
    const r = el.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) mediaBoxes++;
  }
  const text = (document.body && document.body.innerText) ? document.body.innerText : '';
  const tags = {};
  for (const el of document.querySelectorAll('*')) {
    tags[el.tagName] = (tags[el.tagName] || 0) + 1;
  }
  const domSignature = Object.keys(tags).sort().map(k => k + k[0] + tags[k]).join('|');
  return {
    text: text.slice(0, 20000),
    title: document.title || '',
    overlayHit,
    mediaBoxes,
    domSignature,
  };
})()`;

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

  /**
   * Launch the browser and begin polling.
   */
  async start(): Promise<void> {
    await mkdir(this.opts.framesDir, { recursive: true });
    this.browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(this.opts.executablePath),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await this.browser.newContext({
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
    });
    this.page = await context.newPage();
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
  private errorFrame(tMs: number, reason: string, captureMs: number): Frame {
    return {
      index: this.index++,
      tMs,
      class: 'unreachable',
      reason: `capture-failed:${reason.slice(0, 120)}`,
      screenshotPath: null,
      dhash: null,
      colorSig: null,
      inkRatio: 0,
      text: '',
      title: '',
      httpStatus: null,
      consoleErrors: [],
      entityCoverage: 0,
      entitiesFound: [],
      domSignature: '',
      captureMs,
    };
  }

  /**
   * Take one observation: navigate if needed, screenshot, read the DOM, and
   * classify what a person would be looking at.
   */
  private async capture(tMs: number): Promise<Frame> {
    const page = this.page!;
    const startedAt = Date.now();

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
            ...this.errorFrame(tMs, `http-${res!.status()}`, Date.now() - startedAt),
            class: 'error',
            reason: `http-${res!.status()}`,
            httpStatus: res!.status(),
          };
        }
      } catch {
        return {
          ...this.errorFrame(tMs, 'not-listening', Date.now() - startedAt),
          reason: 'unreachable:not-listening',
          httpStatus: status,
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
        return this.errorFrame(tMs, `evaluate:${e}`, Date.now() - startedAt);
      }
    }

    let shot: Buffer | null = null;
    try {
      shot = await page.screenshot({ type: 'png', timeout: Math.max(3000, this.intervalMs * 2) });
    } catch {
      shot = null;
    }

    let ink = 0;
    let hash: string | null = null;
    let sig: string | null = null;
    let screenshotPath: string | null = null;
    if (shot) {
      const a = analyzeShot(shot);
      ink = a.inkRatio;
      hash = a.dhash;
      sig = a.colorSig;
      screenshotPath = join(this.opts.framesDir, `f${String(this.index).padStart(5, '0')}.png`);
      await writeFile(screenshotPath, shot);
    }

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
      index: this.index++,
      tMs,
      class: cls.class,
      reason: cls.reason,
      screenshotPath,
      dhash: hash,
      colorSig: sig,
      inkRatio: ink,
      text: obs.text,
      title: obs.title,
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
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    // Let an in-flight capture finish so the last frame is not truncated.
    for (let i = 0; i < 50 && this.capturing; i++) await sleep(50);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }
}
