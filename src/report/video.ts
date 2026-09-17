import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PNG } from 'pngjs';
import type { ScoredFrame } from '../types.ts';

/** One stretch of the timeline showing one image. */
export interface VideoSegment {
  /** Image to show, or null for the synthesised blank. */
  src: string | null;
  startMs: number;
  endMs: number;
}

export interface SegmentOptions {
  /** How long the final observation is held for, absent anything later. */
  tailMs: number;
  /** Hold the final observation until here instead, e.g. the brief's horizon. */
  holdToMs?: number | null;
}

/**
 * Turn the frame timeline into timed segments.
 *
 * `frames/` is not the timeline and cannot be used as one. Consecutive
 * identical screenshots share a file, so a run with forty observations can have
 * four PNGs on disk; stitching the directory listing produces a four-frame
 * video in which a blank minute and a finished app get equal screen time. The
 * timeline lives in `result.json`, where every observation carries its own
 * `tMs`, and this rebuilds it: each image is held until the next observation,
 * exactly the hold-forward convention the curve is integrated with.
 *
 * Three cases are easy to get wrong:
 *
 * 1. Nothing covers t0 to the first observation. The prober's first tick fires
 *    one interval after the browser opens, so a video that starts at the first
 *    frame silently omits the opening second or two. That gap is blank -- not
 *    the first frame held backwards, which would claim the app was already on
 *    screen before anything had been looked at.
 * 2. A frame whose screenshot failed holds whatever was showing. No change was
 *    observed, so inventing a transition would be a lie about the run.
 * 3. The last observation is a sample, not an ending. It is held for one poll
 *    interval, or to the horizon when the caller asks, which is what makes two
 *    runs' videos the same length and therefore comparable side by side.
 */
export function buildSegments(frames: ScoredFrame[], opts: SegmentOptions): VideoSegment[] {
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  const first = sorted[0];
  if (!first) return [];

  const segments: VideoSegment[] = [];
  if (first.tMs > 0) segments.push({ src: null, startMs: 0, endMs: first.tMs });

  let showing: string | null = null;
  for (const [i, f] of sorted.entries()) {
    const next = sorted[i + 1];
    const end = next ? next.tMs : Math.max(f.tMs + opts.tailMs, opts.holdToMs ?? 0);
    if (end <= f.tMs) continue;
    showing = f.screenshotPath ?? showing;
    segments.push({ src: showing, startMs: f.tMs, endMs: end });
  }

  // Adjacent stretches of the same image are one shot of one duration. This is
  // the common case, since the prober already de-duplicates identical captures.
  const merged: VideoSegment[] = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && last.src === s.src && last.endMs === s.startMs) last.endMs = s.endMs;
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * The poll interval this run was captured at, read back off its own frames.
 *
 * It is not recorded in the result, and the median gap is a better answer than
 * a hardcoded second: a run captured at 250ms would otherwise hold its last
 * frame four times too long.
 */
export function inferIntervalMs(frames: ScoredFrame[], fallback = 1000): number {
  const sorted = [...frames].sort((a, b) => a.tMs - b.tMs);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]!.tMs - sorted[i - 1]!.tMs);
  if (!gaps.length) return fallback;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? fallback;
}

/**
 * An ffmpeg concat script for these segments.
 *
 * Paths are absolute: the concat demuxer's resolution of relative entries
 * depends on how it was invoked, and this file is a build artefact rather than
 * something to move around.
 */
export function renderConcat(segments: VideoSegment[], blankPath: string): string {
  const quote = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`;
  const pathOf = (s: VideoSegment): string => quote(s.src ?? blankPath);

  const lines = ['ffconcat version 1.0'];
  for (const s of segments) {
    lines.push(`file ${pathOf(s)}`);
    lines.push(`duration ${((s.endMs - s.startMs) / 1000).toFixed(3)}`);
  }
  // The demuxer ignores the last entry's duration, so the final image is listed
  // once more. Without it the video ends a whole segment early -- which is the
  // finished app, the part anyone watching is waiting for.
  const last = segments.at(-1);
  if (last) lines.push(`file ${pathOf(last)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * ffmpeg arguments for a concat script, with the codec chosen by extension.
 *
 * The input is variable-rate by construction -- one entry may last a frame and
 * the next a minute -- so it is resampled to a constant rate, which is what
 * makes the result play the same in every player. Odd dimensions are rounded
 * because H.264 cannot encode them, and a viewport is not always even.
 */
export function ffmpegArgs(concatPath: string, outPath: string, fps: number): string[] {
  const webm = outPath.toLowerCase().endsWith('.webm');
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vf', `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    ...(webm
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']),
    outPath,
  ];
}

/**
 * Point a recorded screenshot path at a file that exists.
 *
 * Paths in `result.json` are absolute, so copying `runs/` somewhere else breaks
 * every one of them. The frames are still sitting beside the result, so look
 * there before giving up; ffmpeg's error for a missing input says nothing about
 * why.
 */
export function resolveShot(runDir: string, src: string): string | null {
  if (existsSync(src)) return src;
  const beside = join(runDir, 'frames', basename(src));
  return existsSync(beside) ? beside : null;
}

/**
 * The colour-type byte out of a PNG's IHDR.
 *
 * Byte 25: an 8-byte signature, a 4-byte chunk length, "IHDR", width, height,
 * and the bit depth come first. Anything pngjs cannot write is reported as
 * truecolour, which is what a screenshot is.
 */
export function pngColorType(buf: Buffer): 0 | 2 | 4 | 6 {
  const ct = buf[25];
  return ct === 0 || ct === 2 || ct === 4 || ct === 6 ? ct : 2;
}

/**
 * A white frame for the stretch before the first observation, built to match a
 * real one.
 *
 * Size and colour type both come from an actual screenshot rather than being
 * chosen here, because ffmpeg's concat demuxer requires every input to share
 * one set of stream parameters and **silently drops** the ones that differ. A
 * hand-built RGBA blank next to Playwright's RGB screenshots encoded without
 * complaint and without the blank: the video simply began on the first real
 * frame, 1.6s early, with every later timestamp wrong by that much. That is the
 * exact defect this whole command exists to avoid, and it is invisible unless
 * the output duration is checked against the timeline.
 */
export async function writeBlankFrame(path: string, likePath: string): Promise<void> {
  const source = await readFile(likePath);
  const png = PNG.sync.read(source);
  png.data.fill(0xff);
  await writeFile(path, PNG.sync.write(png, { colorType: pngColorType(source) }));
}

/** How long the finished video has to be, if no segment was dropped. */
export const timelineSpanMs = (segments: VideoSegment[]): number => segments.at(-1)?.endMs ?? 0;
