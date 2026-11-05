/**
 * Polish-wave live-replay harness (NOT a test; run manually with the REAL
 * planner against a fresh copy of the committed CRM template — never the
 * user's dev server). Drives the 4 named validation replays from the
 * round-2 TRIAGE and verifies each in the DB/events. Prints a scorecard +
 * total OpenRouter spend. Clock pinned to 2026-11-04T10:00:00Z (VirtualClock
 * default), matching the human-test "now".
 */
import '../src/env.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetCrm } from '../src/store/reset.js';
import { openCrm } from '../src/store/db.js';
import { openSessions } from '../src/store/sessions-db.js';
import { openEventLog } from '../src/events/log.js';
import { createRefStore } from '../src/agent/refs.js';
import { registry } from '../src/catalog/registry.js';
import { runTurn } from '../src/agent/pipeline.js';
import type { ConfirmBroker } from '../src/agent/executor.js';
import type { Event } from '../src/events/types.js';

const PROFILE = `polishwave-replay-${process.pid}`;
const TEMPLATE = resolve(import.meta.dirname, '../data/crm-standard.template.db');
const approve: ConfirmBroker = { request: async () => true };

let totalCost = 0;

async function drive(deps: Parameters<typeof runTurn>[0]['sessionDeps'], sessionId: string, userText: string) {
  const events: Event[] = [];
  for await (const ev of runTurn({ sessionId, turnId: `t_${randomUUID()}`, userText, sessionDeps: deps })) events.push(ev);
  const answer = events.filter((e) => e.t === 'answer.final').map((e) => (e as Extract<Event, { t: 'answer.final' }>).text).join(' ');
  const comp = events.find((e) => e.t === 'turn.completed') as Extract<Event, { t: 'turn.completed' }> | undefined;
  totalCost += comp?.metrics.costUsd ?? 0;
  return { events, answer, status: comp?.status ?? '?' };
}
const steps = (e: Event[]) => e.filter((x) => x.t === 'step.started').map((x) => (x as Extract<Event, { t: 'step.started' }>).action);
const fails = (e: Event[]) => e.filter((x) => x.t === 'step.failed').map((x) => `${(x as { stepId?: string }).stepId}:${(x as { error?: { code?: string } }).error?.code}`);

async function main() {
  await resetCrm(PROFILE, TEMPLATE);
  const crm = openCrm(PROFILE);
  const dbPath = resolve(tmpdir(), `polishwave-sessions-${randomUUID()}.db`);
  const eventLog = openEventLog(dbPath);
  const sessionsDb = openSessions(dbPath);
  const q = (sql: string, ...p: unknown[]) => crm.tx((db) => db.all(sql, p));
  const mk = (sid: string) => ({ registry, crm, refs: createRefStore(sessionsDb, sid), eventLog, confirm: approve, playbooks: [] });
  const card: { name: string; pass: boolean; note: string }[] = [];

  // --- 1. support: "the oldest one" must resolve to the true oldest ticket ---
  {
    const sid = 'rep_oldest';
    await drive(mk(sid), sid, 'search tickets where assignee is user_38 and status is open');
    const r = await drive(mk(sid), sid, 'reassign the oldest one to Nora Haddad');
    const oldest = (q("SELECT assignee_id FROM support_tickets WHERE id='ticket_362'")[0] as { assignee_id: string }).assignee_id;
    const newest = (q("SELECT assignee_id FROM support_tickets WHERE id='ticket_113'")[0] as { assignee_id: string }).assignee_id;
    const correct = oldest === 'user_2' && newest === 'user_38'; // oldest reassigned, newest untouched
    card.push({ name: 'P1 support "oldest one" → ticket_362 (not ticket_113)', pass: correct, note: `ticket_362.assignee=${oldest} (want user_2), ticket_113.assignee=${newest} (want user_38) status=${r.status} steps=[${steps(r.events).join(',')}] ans="${r.answer.slice(0, 120)}"` });
  }

  // --- 2. billing: "total amount owed" must be formula-honest ----------------
  {
    const sid = 'rep_owed';
    const r = await drive(mk(sid), sid, 'what is the total amount owed on all overdue invoices?');
    const net = r.answer.includes('415863') || r.answer.includes('415,863');
    const grossLabeled = (r.answer.includes('483595') || r.answer.includes('483,595')) && /summing|total of|sum of|total\b/i.test(r.answer);
    card.push({ name: 'P3 billing "amount owed" formula-honest (net $415,863.49 or labeled basis)', pass: net || grossLabeled, note: `net=${net} grossLabeled=${grossLabeled} status=${r.status} steps=[${steps(r.events).join(',')}] ans="${r.answer.slice(0, 160)}"` });
  }

  // --- 3. marketing: launch "campaign 16" by name (no fabricated id) ---------
  {
    const sid = 'rep_launch';
    const before = (q("SELECT status FROM structures WHERE id='struct_86'")[0] as { status: string }).status;
    const r = await drive(mk(sid), sid, 'launch the campaign named campaign 16');
    const after = (q("SELECT status FROM structures WHERE id='struct_86'")[0] as { status: string }).status;
    const fabricatedNotFound = fails(r.events).some((f) => /NOT_FOUND/.test(f));
    const didLookup = steps(r.events).some((a) => /search|list/.test(a));
    const honest = r.status === 'clarify' || r.status === 'refused';
    // Pass: no NOT_FOUND on a guessed id, AND either it resolved via a lookup
    // (touching the real struct_86) or it asked/refused honestly.
    const pass = !fabricatedNotFound && (didLookup || honest);
    card.push({ name: 'P4 marketing launch-by-name (provenance forces lookup, no fabricated id)', pass, note: `struct_86 ${before}->${after} status=${r.status} fabricatedNOT_FOUND=${fabricatedNotFound} didLookup=${didLookup} steps=[${steps(r.events).join(',')}] ans="${r.answer.slice(0, 120)}"` });
  }

  // --- 4. sales: lead-score update echo names the changed field --------------
  {
    const sid = 'rep_score';
    const r = await drive(mk(sid), sid, 'update lead_1 score to 99');
    const score = (q("SELECT score FROM leads WHERE id='lead_1'")[0] as { score: number }).score;
    const echoesScore = /score/i.test(r.answer) && r.answer.includes('99');
    const pass = score === 99 && echoesScore;
    card.push({ name: 'P2 sales lead-score echo (names "score"=99, no fabricated fields)', pass, note: `lead_1.score=${score} (want 99) echoesScore=${echoesScore} status=${r.status} ans="${r.answer.slice(0, 140)}"` });
  }

  console.log('\n=== Polish-wave live-replay scorecard ===');
  for (const c of card) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.note}`);
  console.log(`\n${card.filter((c) => c.pass).length}/${card.length} passed · total OpenRouter spend ≈ $${totalCost.toFixed(4)}`);
  eventLog.close();
  sessionsDb.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
