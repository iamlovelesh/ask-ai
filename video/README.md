# Ask AI — product video (Remotion)

A polished product video composed from **real** Ask AI app footage. Playwright
drives the live app and records one clip per feature; Remotion composes them
with an intro/outro, animated lower-thirds, transitions, and natural Cartesia
narration.

## Pipeline

Prerequisites: `ffmpeg` on PATH, and Playwright for the capture step
(`npm i -D playwright && npx playwright install chromium`, run once at the repo
root — kept out of the core project's dependencies on purpose).

With the web (`:5173`) and server (`:3000`) running, from the repo root:

```bash
# 1. Capture one real-app screencast per segment → video/public/clips/*.mp4
#    (writes videoDur into video/src/manifest.json)
node scripts/demo-capture.mjs                 # all segments
node scripts/demo-capture.mjs --only memories # re-capture specific ids

# 2. Render Cartesia narration per segment → video/public/audio/*.wav
#    (writes audioDur into the manifest; needs CARTESIA_KEY in .env)
node scripts/demo-narrate-clips.mjs

# 3. Render the final video → demo-out/ask-ai-demo.mp4
cd video && npm install && npm run render
```

Preview interactively with `cd video && npm run studio`.

## What's in it

9 segments: the brief's 6 request types (direct, indirect, complex, follow-up,
ambiguity, honest-failure) plus 3 feature highlights (attachments & rich
display, role-based permissions, cross-session memory).

## Structure

- `src/manifest.json` — the single source of truth: per-segment id, captions,
  narration text, and measured clip/audio durations.
- `src/timeline.ts` — derives segment lengths, playback speed-ups (long clips
  play faster so narration never drags), and total composition length.
- `src/Demo.tsx` — the composition (TransitionSeries of intro → clips → outro).
- `src/components/` — `AppFrame` (browser-framed clip), `LowerThird`
  (bottom caption bar), `TitleCard` (intro/outro).

Generated media (`public/clips`, `public/audio`) and `demo-out/` are gitignored
— regenerate with the pipeline above.
