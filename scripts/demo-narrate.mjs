// Adds a natural voiceover to the recorded demo. Reads demo-out/manifest.json
// (segment start times + narration lines), renders each line with Cartesia
// Sonic (natural neural TTS) — or macOS `say` as a fallback — and muxes them
// onto demo-out/ask-ai-demo.webm at the right offsets →
// demo-out/ask-ai-demo-narrated.mp4.
//
//   node scripts/demo-narrate.mjs            # Cartesia if CARTESIA_KEY set, else say
//   CARTESIA_VOICE_ID=<id> node scripts/...  # pick a different Cartesia voice
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'demo-out';
const VIDEO = `${OUT}/ask-ai-demo.webm`;
const FINAL = `${OUT}/ask-ai-demo-narrated.mp4`;
const CLIPS = `${OUT}/narration`;

const CARTESIA_KEY = process.env.CARTESIA_KEY || process.env.CARTESIA_API_KEY;
const VOICE_ID = process.env.CARTESIA_VOICE_ID || 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1'; // Clive — Measured Expert
const MODEL_ID = process.env.CARTESIA_MODEL || 'sonic-2';

if (!existsSync(VIDEO)) throw new Error(`missing ${VIDEO} — run scripts/demo-video.mjs first`);
mkdirSync(CLIPS, { recursive: true });

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const probeDur = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

async function cartesiaTTS(text, outFile) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': CARTESIA_KEY,
      'Cartesia-Version': '2024-11-13',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: MODEL_ID,
      transcript: text,
      voice: { mode: 'id', id: VOICE_ID },
      language: 'en',
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia ${res.status}: ${(await res.text()).slice(0, 200)}`);
  writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
}

const videoDur = probeDur(VIDEO);
const { segments } = JSON.parse(readFileSync(`${OUT}/manifest.json`, 'utf8'));
const engine = CARTESIA_KEY ? `Cartesia (${MODEL_ID}, voice ${VOICE_ID.slice(0, 8)}…)` : 'macOS say (fallback)';
console.log(`video ${videoDur.toFixed(1)}s · ${segments.length} segments · ${engine}`);

// 1) render each narration line
const clips = [];
for (let i = 0; i < segments.length; i++) {
  const s = segments[i];
  const ext = CARTESIA_KEY ? 'wav' : 'aiff';
  const f = `${CLIPS}/n${String(i).padStart(2, '0')}.${ext}`;
  if (CARTESIA_KEY) await cartesiaTTS(s.narration, f);
  else sh('say', ['-v', 'Samantha', '-r', '188', '-o', f, s.narration]);
  const d = probeDur(f);
  console.log(`  [${s.t.toFixed(1)}s +${d.toFixed(1)}s] ${s.narration.slice(0, 54)}…`);
  clips.push({ file: f, at: s.t, dur: d });
}

// 2) mux: video + silent base (video length) + each clip delayed to its offset
const inputs = ['-i', VIDEO, '-f', 'lavfi', '-t', videoDur.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo'];
clips.forEach((c) => inputs.push('-i', c.file));
const delays = clips.map((c, i) => `[${i + 2}]adelay=${Math.round(c.at * 1000)}|${Math.round(c.at * 1000)}[c${i}]`).join(';');
const mixIns = ['[1]', ...clips.map((_, i) => `[c${i}]`)].join('');
const filter = `${delays};${mixIns}amix=inputs=${clips.length + 1}:normalize=0:duration=first[aout]`;

const args = [
  '-y', ...inputs,
  '-filter_complex', filter,
  '-map', '0:v', '-map', '[aout]',
  '-vf', 'scale=1360:-2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'medium',
  '-c:a', 'aac', '-b:a', '160k',
  '-t', videoDur.toFixed(2),
  '-movflags', '+faststart',
  FINAL,
];
console.log('muxing…');
sh('ffmpeg', args);
console.log(`\nDONE → ${FINAL}`);
