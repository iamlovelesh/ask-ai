// Adds a TTS voiceover to the recorded demo. Reads demo-out/manifest.json
// (segment start times + narration lines), renders each line with macOS `say`,
// and muxes them onto demo-out/ask-ai-demo.webm at the right offsets →
// demo-out/ask-ai-demo-narrated.mp4.
//
//   node scripts/demo-narrate.mjs [voice]     # default voice: Samantha
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'demo-out';
const VOICE = process.argv[2] || 'Samantha';
const RATE = 188; // words/min — snappy but clear
const VIDEO = `${OUT}/ask-ai-demo.webm`;
const FINAL = `${OUT}/ask-ai-demo-narrated.mp4`;
const CLIPS = `${OUT}/narration`;

if (!existsSync(VIDEO)) throw new Error(`missing ${VIDEO} — run scripts/demo-video.mjs first`);
mkdirSync(CLIPS, { recursive: true });

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const probeDur = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

const videoDur = probeDur(VIDEO);
const { segments } = JSON.parse(readFileSync(`${OUT}/manifest.json`, 'utf8'));
console.log(`video ${videoDur.toFixed(1)}s · ${segments.length} narration segments · voice ${VOICE}`);

// 1) render each narration line to aiff
const clips = segments.map((s, i) => {
  const f = `${CLIPS}/n${String(i).padStart(2, '0')}.aiff`;
  sh('say', ['-v', VOICE, '-r', String(RATE), '-o', f, s.narration]);
  const d = probeDur(f);
  console.log(`  [${s.t.toFixed(1)}s +${d.toFixed(1)}s] ${s.narration.slice(0, 56)}…`);
  return { file: f, at: s.t, dur: d };
});

// 2) build ffmpeg: video + silent base (video length) + each clip delayed to its offset
const inputs = ['-i', VIDEO, '-f', 'lavfi', '-t', String(videoDur.toFixed(2)), '-i', 'anullsrc=r=44100:cl=stereo'];
clips.forEach((c) => inputs.push('-i', c.file));
// input indices: 0=video, 1=silent base, 2..=clips
const delays = clips
  .map((c, i) => `[${i + 2}]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[c${i}]`)
  .join(';');
const mixIns = ['[1]', ...clips.map((_, i) => `[c${i}]`)].join('');
const filter = `${delays};${mixIns}amix=inputs=${clips.length + 1}:normalize=0:duration=first[aout]`;

const args = [
  '-y', ...inputs,
  '-filter_complex', filter,
  '-map', '0:v', '-map', '[aout]',
  '-vf', 'scale=1360:-2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium',
  '-c:a', 'aac', '-b:a', '160k',
  '-t', String(videoDur.toFixed(2)),
  '-movflags', '+faststart',
  FINAL,
];
console.log('muxing…');
sh('ffmpeg', args);
console.log(`\nDONE → ${FINAL}`);
