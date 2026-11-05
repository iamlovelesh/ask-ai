/**
 * E1 bulk-hydration follow-up — live replay against a REAL, locally spawned
 * server process (NOT a test, NOT the in-process `enginewave-replay.ts`
 * harness, NOT the user's dev server). Spawns `src/index.ts` as a child
 * process pointed at a FRESH profile DB copied from the committed template
 * (`resetCrm`, never `crm-standard.template.db` or `crm-standard.db`
 * itself), drives the exact scenario from the task — "find new leads with
 * score over 95 and assign them all to user_6" — over the real HTTP/SSE
 * API with the REAL planner, approves the confirmation gate, and verifies
 * row counts directly against the profile DB file before/after.
 *
 * Usage: tsx scripts/hydration-live-replay.ts
 */
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resetCrm } from '../src/store/reset.js';
import { openCrm, closeRegistered } from '../src/store/db.js';

const PROFILE = `hydration-replay-${process.pid}`;
const PORT = 3100 + (process.pid % 1000);
const TEMPLATE = resolve(import.meta.dirname, '../data/crm-standard.template.db');
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy in time');
}

interface ParsedEvent {
  seq: number;
  t: string;
  [k: string]: unknown;
}

/** Drive one turn over the real SSE channel, auto-approving any
 * confirmation gate, returning every parsed event. */
async function driveTurn(sessionId: string, text: string): Promise<ParsedEvent[]> {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.body) throw new Error('no SSE body');
  const events: ParsedEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue; // heartbeat comment or similar
      const ev = JSON.parse(dataLine.slice('data: '.length)) as ParsedEvent;
      events.push(ev);
      if (ev['t'] === 'confirmation.required') {
        const confirmId = ev['confirmId'] as string;
        // Fire-and-forget: the server resumes execution synchronously once
        // resolved, continuing to write SSE frames to the same stream we're
        // still reading.
        void fetch(`${BASE}/api/sessions/${sessionId}/confirm/${confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        });
      }
      if (ev['t'] === 'memory.snapshot') {
        done = true;
        break;
      }
    }
  }
  return events;
}

async function main(): Promise<void> {
  console.log(`[hydration-replay] profile=${PROFILE} port=${PORT}`);
  await resetCrm(PROFILE, TEMPLATE);

  const q = (sql: string, ...p: unknown[]) => {
    const crm = openCrm(PROFILE);
    const rows = crm.tx((db) => db.all(sql, p));
    crm.close();
    return rows;
  };

  const beforeMatching = (q('SELECT COUNT(*) n FROM leads WHERE score > 95 AND archived = 0')[0] as { n: number }).n;
  const beforeAssigned = (q("SELECT COUNT(*) n FROM leads WHERE owner_id = 'user_6'")[0] as { n: number }).n;
  console.log(`[hydration-replay] before: matching(score>95)=${beforeMatching} already-assigned-to-user_6=${beforeAssigned}`);
  closeRegistered(PROFILE);

  const child: ChildProcess = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../node_modules/.bin/tsx'), resolve(import.meta.dirname, '../src/index.ts')],
    {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, PORT: String(PORT), PROFILE, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  child.stdout?.on('data', (d) => {
    serverLog += String(d);
  });
  child.stderr?.on('data', (d) => {
    serverLog += String(d);
  });

  let exitCode: number | null = null;
  try {
    await waitForHealth();
    console.log('[hydration-replay] server healthy, driving turn...');

    const sessionId = (
      (await (await fetch(`${BASE}/api/sessions`, { method: 'POST' })).json()) as { id: string }
    ).id;

    const scenario = 'find new leads with score over 95 and assign them all to user_6';
    const events = await driveTurn(sessionId, scenario);

    const gate = events.find((e) => e.t === 'confirmation.required');
    const completed = events.find((e) => e.t === 'turn.completed');
    const failed = events.filter((e) => e.t === 'step.failed');
    const answer = events.filter((e) => e.t === 'answer.final').map((e) => e['text'] as string).join(' ');

    const afterMatching = (q('SELECT COUNT(*) n FROM leads WHERE score > 95 AND archived = 0')[0] as { n: number }).n;
    const afterAssigned = (q("SELECT COUNT(*) n FROM leads WHERE owner_id = 'user_6'")[0] as { n: number }).n;
    const newlyAssigned = afterAssigned - beforeAssigned;

    console.log('');
    console.log('=== REPLAY RESULT ===');
    console.log(`scenario: "${scenario}"`);
    console.log(`turn status: ${completed ? (completed['status'] as string) : '(no turn.completed event seen)'}`);
    console.log(`gate seen: ${gate !== undefined}${gate ? ` (affectedCount=${JSON.stringify((gate['scope'] as { affectedCount?: number } | undefined)?.affectedCount)})` : ''}`);
    console.log(`step failures: ${JSON.stringify(failed.map((f) => ({ stepId: f['stepId'], code: (f['error'] as { code?: string } | undefined)?.code })))}`);
    console.log(`answer: ${answer.slice(0, 200)}`);
    console.log('');
    console.log(`BEFORE — matching(score>95, non-archived): ${beforeMatching}; already owner_id=user_6: ${beforeAssigned}`);
    console.log(`AFTER  — matching(score>95, non-archived): ${afterMatching}; owner_id=user_6: ${afterAssigned} (newly assigned: ${newlyAssigned})`);
    console.log('');

    const gatedWithTrueCount =
      gate !== undefined && (gate['scope'] as { affectedCount?: number } | undefined)?.affectedCount === beforeMatching;
    const allMatchingAssigned = newlyAssigned === beforeMatching;

    if (gatedWithTrueCount && allMatchingAssigned) {
      console.log(`PASS — gated with the TRUE full count (${beforeMatching}) and wrote ALL matching rows (${newlyAssigned}).`);
      exitCode = 0;
    } else {
      console.log('FAIL — see details above.');
      console.log('--- server log tail ---');
      console.log(serverLog.slice(-4000));
      exitCode = 1;
    }
  } catch (err) {
    console.error('[hydration-replay] error:', err);
    console.log('--- server log tail ---');
    console.log(serverLog.slice(-4000));
    exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
  }
  process.exit(exitCode ?? 1);
}

main();
