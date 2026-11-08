// Captures the REAL Ask AI web app, one short screencast per demo segment, by
// driving it with Playwright. Each segment is recorded in its own browser
// context (→ one webm), converted to a normalized mp4 in video/public/clips/,
// and its duration written back into video/src/manifest.json so the Remotion
// composition (video/) can lay the clips end-to-end with synced narration.
//
//   node scripts/demo-capture.mjs                 # all segments
//   node scripts/demo-capture.mjs --only memories # re-capture specific ids
//
// Requires the web (:5173) + server (:3000) running.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = 'http://localhost:5173';
const RAW = join(ROOT, 'demo-out', 'raw');
const CLIPS = join(ROOT, 'video', 'public', 'clips');
const MANIFEST = join(ROOT, 'video', 'src', 'manifest.json');
const ASSET_NOTES = join(ROOT, 'scripts', 'demo-assets', 'acme-call-notes.txt');
const VIEW = { width: 1440, height: 900 };

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const probeDur = (f) => parseFloat(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim());

// --- app-driving primitives --------------------------------------------------
const TA = 'textarea[placeholder="Message Ask AI…"]';
const composerBack = (page) => page.evaluate((sel) => !document.querySelector('.btn-cancel') && !!document.querySelector(sel), TA);

async function newChat(page) {
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await sleep(700);
}

/** Type + submit a prompt, handle a confirm gate inline, return when the turn
 * finishes (composer returns). Polls — no fixed long timeouts. */
async function ask(page, text, opts = {}) {
  const t0 = Date.now();
  const ta = page.locator(TA).first();
  await ta.waitFor({ state: 'visible', timeout: 30000 });
  await ta.click();
  await ta.pressSequentially(text, { delay: 12 });
  await sleep(300);
  await page.locator('button.btn-send').first().click();
  // phase 1: wait for the turn to actually START
  const startBy = Date.now() + 12000;
  while (Date.now() < startBy) {
    if (await page.evaluate(() => !!document.querySelector('.btn-cancel') || !!document.querySelector('.confirm-card')).catch(() => false)) break;
    await sleep(150);
  }
  // phase 2: wait for finish, approving/denying EVERY gate that appears inline
  // (a single turn can raise more than one confirmation).
  const deadline = Date.now() + 120000;
  let gates = 0;
  while (Date.now() < deadline) {
    if (await page.locator('.confirm-card .btn-approve, .confirm-card .btn-deny').count()) {
      if (opts.confirm === undefined) break; // leave the gate on screen (we want to show it)
      await sleep(gates === 0 ? 2000 : 900); // let the first gate read
      const sel = opts.confirm === 'deny' ? '.confirm-card .btn-deny' : '.confirm-card .btn-approve';
      await page.locator(sel).first().click().catch(() => {});
      gates += 1;
      await sleep(900); // let the card resolve before re-checking
      if (gates > 6) break; // safety
      continue;
    }
    if (await composerBack(page)) break;
    await sleep(400);
  }
  // make sure the latest answer is actually in view (a long prior turn can
  // push a short follow-up answer below the fold).
  await page.evaluate(() => {
    const nodes = document.querySelectorAll('.said-agent');
    nodes[nodes.length - 1]?.scrollIntoView({ block: 'end' });
  }).catch(() => {});
  await sleep(500);
  console.log(`    [ask ${((Date.now() - t0) / 1000).toFixed(0)}s${gates ? ` +${gates}gate` : ''}] ${text.slice(0, 50)}…`);
  await sleep(opts.hold ?? 3500); // hold the final answer on screen
}

async function setRole(page, label) {
  const btn = page.locator('button.role-seg-btn', { hasText: label }).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  await btn.click();
  await sleep(700);
}

async function uploadFile(page, path) {
  await page.locator('input[type=file]').first().setInputFiles(path);
  await sleep(1200); // let the attachment chip render
}

async function clickFirstRecordChip(page) {
  const chip = page.locator('.record-chip[data-record]').first();
  if (await chip.count()) {
    await chip.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(500);
    await chip.click().catch(() => {});
    await sleep(2600); // show the record popover
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }
}

async function openTrace(page) {
  const btn = page.locator('button.foot-btn', { hasText: 'Trace' }).last();
  if (await btn.count()) {
    await btn.click().catch(() => {});
    await sleep(1400);
    // bring the "Memory updated from this message" section into view
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find((n) => /Memory updated/i.test(n.textContent || '') && n.children.length < 6);
      el?.scrollIntoView({ block: 'center' });
    }).catch(() => {});
    await sleep(3400); // show the trace drawer (incl. "Memory updated")
  }
}

// --- scenes (one per clip id) ------------------------------------------------
const SCENES = {
  direct: async (page) => {
    await newChat(page);
    await ask(page, 'How many open opportunities do we have, and what is their total value?', { hold: 4200 });
  },
  indirect: async (page) => {
    await newChat(page);
    await ask(page, 'Which of my open opportunities look most at risk, and why?', { hold: 5000 });
  },
  complex: async (page) => {
    await newChat(page);
    await ask(
      page,
      "For the contact sarah.chen@acme.com: create an opportunity called 'Acme Expansion' worth $25,000, add a task to follow up with her next week, and leave a note that she came in through the partner program.",
      { confirm: 'approve', hold: 4500 },
    );
  },
  followup: async (page) => {
    await newChat(page);
    await ask(page, 'Show me our biggest open opportunities.', { hold: 3600 });
    await ask(page, 'Who owns the top one, and when does it close?', { hold: 4200 });
  },
  ambiguity: async (page) => {
    await newChat(page);
    await ask(page, 'Change their email address', { hold: 3800 });
  },
  failure: async (page) => {
    await newChat(page);
    await ask(page, 'Pull up the details for invoice inv_999999.', { hold: 4200 });
  },
  attachments: async (page) => {
    await newChat(page);
    await uploadFile(page, ASSET_NOTES);
    await ask(page, 'Summarize these call notes and tell me the single most important next step.', { hold: 4200 });
    await ask(page, 'Break down our open opportunities by stage.', { hold: 4200 }); // table + bar chart
    await ask(page, 'Who owns the top 3 open opportunities?', { hold: 2200 });
    await clickFirstRecordChip(page); // clickable record → popover
    await sleep(1400);
  },
  permissions: async (page) => {
    await newChat(page);
    await setRole(page, 'Viewer');
    await ask(page, 'Delete lead lead_1.', { hold: 4500 });
  },
  memories: async (page) => {
    await newChat(page);
    await ask(page, 'Remember that my quarterly sales target is $50,000, and that I prefer short, bulleted answers.', { hold: 2800 });
    await openTrace(page); // "Memory updated from this message"
    await page.goto(`${WEB}/memories`, { waitUntil: 'networkidle' }); // the Memories page
    await sleep(4500);
    await newChat(page); // NEW session proves cross-session recall
    await ask(page, "What's my quarterly sales target? Give me a quick status on our open opportunities.", { hold: 5200 });
  },
};

// --- capture + encode --------------------------------------------------------
async function captureClip(browser, id, scene) {
  const rawDir = join(RAW, id);
  rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: rawDir, size: VIEW } });
  const page = await context.newPage();
  console.log(`\n▶ ${id}`);
  try {
    await scene(page);
  } finally {
    await context.close(); // flushes the webm
  }
  const webm = readdirSync(rawDir).filter((f) => f.endsWith('.webm')).sort().pop();
  if (!webm) throw new Error(`no webm recorded for ${id}`);
  const out = join(CLIPS, `${id}.mp4`);
  // trim ~0.6s lead-in (page load), normalize to 30fps h264, no audio.
  sh('ffmpeg', [
    '-y', '-ss', '0.6', '-i', join(rawDir, webm),
    '-vf', `scale=${VIEW.width}:${VIEW.height}:force_original_aspect_ratio=decrease,pad=${VIEW.width}:${VIEW.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-an', out,
  ]);
  const dur = probeDur(out);
  console.log(`  ✓ ${id}.mp4 — ${dur.toFixed(1)}s`);
  return dur;
}

async function main() {
  mkdirSync(CLIPS, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const clip of manifest.clips) {
      if (only && !only.has(clip.id)) continue;
      const scene = SCENES[clip.id];
      if (!scene) { console.log(`  (no scene for ${clip.id}, skipping)`); continue; }
      const dur = await captureClip(browser, clip.id, scene);
      clip.videoDur = +dur.toFixed(2);
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n'); // persist progress
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDONE — manifest updated: ${MANIFEST}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
