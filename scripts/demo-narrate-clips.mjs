// Renders one natural-voice narration clip per demo segment (intro, outro, and
// every clip) with Cartesia Sonic → video/public/audio/<id>.wav, and writes the
// measured audio duration back into video/src/manifest.json so the Remotion
// composition sizes each segment to never cut the voiceover short.
//
//   node scripts/demo-narrate-clips.mjs
//   CARTESIA_VOICE_ID=<id> node scripts/demo-narrate-clips.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'video', 'src', 'manifest.json');
const AUDIO = join(ROOT, 'video', 'public', 'audio');

const CARTESIA_KEY = process.env.CARTESIA_KEY || process.env.CARTESIA_API_KEY;
const VOICE_ID = process.env.CARTESIA_VOICE_ID || 'b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1'; // Clive — Measured Expert
const MODEL_ID = process.env.CARTESIA_MODEL || 'sonic-2';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const probeDur = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

async function cartesiaTTS(text, outFile) {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': CARTESIA_KEY, 'Cartesia-Version': '2024-11-13', 'Content-Type': 'application/json' },
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

async function render(id, text) {
  const f = join(AUDIO, `${id}.wav`);
  if (CARTESIA_KEY) await cartesiaTTS(text, f);
  else sh('say', ['-v', 'Samantha', '-r', '186', '-o', f.replace('.wav', '.aiff'), text]);
  const file = CARTESIA_KEY ? f : f.replace('.wav', '.aiff');
  const dur = probeDur(file);
  console.log(`  [${id}] ${dur.toFixed(1)}s — ${text.slice(0, 56)}…`);
  return +dur.toFixed(2);
}

async function main() {
  mkdirSync(AUDIO, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  console.log(`narrating ${manifest.clips.length + 2} segments · ${CARTESIA_KEY ? `Cartesia ${MODEL_ID}` : 'macOS say (fallback)'}`);

  manifest.intro.audioDur = await render('intro', manifest.intro.narration);
  manifest.outro.audioDur = await render('outro', manifest.outro.narration);
  for (const clip of manifest.clips) {
    clip.audioDur = await render(clip.id, clip.narration);
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log(`\nDONE — manifest updated: ${MANIFEST}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
