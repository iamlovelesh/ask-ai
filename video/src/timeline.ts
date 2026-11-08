import manifestJson from './manifest.json';

export interface Clip {
  id: string;
  chip: string;
  title: string;
  subtitle?: string;
  narration: string;
  video: string;
  audio: string;
  videoDur?: number; // seconds — written by the capture step
  audioDur?: number; // seconds — written by the narrate step
}

export interface Card {
  title: string;
  subtitle: string;
  narration: string;
  audioDur?: number;
}

export interface Manifest {
  fps: number;
  intro: Card;
  outro: Card;
  clips: Clip[];
}

export const manifest = manifestJson as Manifest;
export const FPS = manifest.fps || 30;
export const TRANSITION = 12; // frames of cross-fade between sequences

const sec = (s: number) => Math.round(s * FPS);

/** Seconds of the clip's tail (the final answer / payoff) that always play at
 * 1× so they're readable — only the "thinking" before it is sped up. */
export const ANSWER_TAIL = 5;

/** Playback rate for a clip's "thinking" portion. Short clips stay 1×; long
 * clips with lots of dead-air relative to their narration are sped up. */
export function clipSpeed(c: Clip): number {
  if (c.videoDur == null || c.audioDur == null) return 1;
  if (c.videoDur <= c.audioDur + 8) return 1; // not enough slack to bother
  return Math.min(2.6, Math.max(1, +(c.videoDur / (c.audioDur + 4)).toFixed(2)));
}

export interface ClipLayout {
  speed: number;
  part1: number; // frames: sped-up "thinking" portion
  thinkRawFrames: number; // source frame where the 1× answer tail begins
  total: number; // frames: whole segment
}

/** Two-part layout: fast "thinking" then the final answer at 1×. */
export function clipLayout(c: Clip): ClipLayout {
  const v = c.videoDur ?? 8;
  const speed = clipSpeed(c);
  const tail = Math.min(ANSWER_TAIL, v);
  const thinkRaw = Math.max(0, v - tail);
  const part1 = Math.round((thinkRaw / speed) * FPS);
  const thinkRawFrames = Math.round(thinkRaw * FPS);
  const natural = part1 + Math.round(tail * FPS);
  const total = Math.max(natural, sec((c.audioDur ?? 0) + 0.6));
  return { speed, part1, thinkRawFrames, total };
}

export function clipFrames(c: Clip): number {
  return clipLayout(c).total;
}

// Intro/outro cards hold at least a base length, and long enough for their
// own narration plus a short tail.
export const introFrames = sec(Math.max(4.5, (manifest.intro.audioDur ?? 0) + 1.0));
export const outroFrames = sec(Math.max(6, (manifest.outro.audioDur ?? 0) + 1.2));

export interface Segment {
  kind: 'intro' | 'clip' | 'outro';
  frames: number;
  clip?: Clip;
}

export function segments(): Segment[] {
  return [
    { kind: 'intro', frames: introFrames },
    ...manifest.clips.map((clip) => ({ kind: 'clip' as const, frames: clipFrames(clip), clip })),
    { kind: 'outro', frames: outroFrames },
  ];
}

/** Total composition length with TransitionSeries overlaps subtracted. */
export function totalFrames(): number {
  const segs = segments();
  const sum = segs.reduce((n, s) => n + s.frames, 0);
  return sum - TRANSITION * (segs.length - 1);
}
