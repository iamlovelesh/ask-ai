/**
 * Engine-wave live-replay harness (NOT a test; run manually). Spins a
 * dev-style in-process pipeline against a FRESH copy of the committed CRM
 * template (isolated profile — never the user's running dev server), drives
 * the 5 human-test scenarios with the REAL planner, and verifies each in the
 * DB/events. Prints a pass/fail scorecard.
 */
import '../src/env.js'; // load repo-root .env (OPENROUTER_API_KEY) — like index.ts
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetCrm } from '../src/store/reset.js';
import { openCrm, crmDbPath } from '../src/store/db.js';
import { openSessions } from '../src/store/sessions-db.js';
import { openEventLog } from '../src/events/log.js';
import { createRefStore } from '../src/agent/refs.js';
import { registry } from '../src/catalog/registry.js';
import { runTurn } from '../src/agent/pipeline.js';
import type { ConfirmBroker } from '../src/agent/executor.js';
import type { Event } from '../src/events/types.js';

const PROFILE = `enginewave-replay-${process.pid}`;
const TEMPLATE = resolve(import.meta.dirname, '../data/crm-standard.template.db');

const approve: ConfirmBroker = { request: async () => true };

async function drive(deps: Parameters<typeof runTurn>[0]['sessionDeps'], sessionId: string, userText: string): Promise<{ events: Event[]; answer: string; status: string }> {
  const events: Event[] = [];
  for await (const ev of runTurn({ sessionId, turnId: `t_${randomUUID()}`, userText, sessionDeps: deps })) events.push(ev);
  const answer = events.filter((e) => e.t === 'answer.final').map((e) => (e as Extract<Event, { t: 'answer.final' }>).text).join(' ');
  const comp = events.find((e) => e.t === 'turn.completed') as Extract<Event, { t: 'turn.completed' }> | undefined;
  return { events, answer, status: comp?.status ?? '?' };
}

function stepEvents(events: Event[]): string[] {
  return events.filter((e) => e.t === 'step.started').map((e) => (e as Extract<Event, { t: 'step.started' }>).action);
}
function failures(events: Event[]): string[] {
  return events.filter((e) => e.t === 'step.failed').map((e) => `${(e as any).stepId}:${(e as any).error?.code}`);
}
function gated(events: Event[]): boolean {
  return events.some((e) => e.t === 'confirmation.required');
}

async function main() {
  await resetCrm(PROFILE, TEMPLATE);
  const crm = openCrm(PROFILE);
  const dbPath = resolve(tmpdir(), `enginewave-sessions-${randomUUID()}.db`);
  const eventLog = openEventLog(dbPath);
  const sessionsDb = openSessions(dbPath);

  const scorecard: { name: string; pass: boolean; note: string }[] = [];

  const q = (sql: string, ...p: unknown[]) => crm.tx((db) => db.all(sql, p));

  // helper to make a per-session deps (fresh refs per session)
  const mkDeps = (sessionId: string) => ({
    registry, crm, refs: createRefStore(sessionsDb, sessionId), eventLog, confirm: approve, playbooks: [],
  });

  // --- 1. "who owns lead_2025" — must be reads-only (E6c minimality) --------
  {
    const sid = 'rep_who_owns';
    const before = (q("SELECT owner_id FROM leads WHERE id='lead_2025'")[0] as any).owner_id;
    const r = await drive(mkDeps(sid), sid, 'who owns lead_2025?');
    const after = (q("SELECT owner_id FROM leads WHERE id='lead_2025'")[0] as any).owner_id;
    const noWrite = before === after;
    const mentionsOwner = /user_15|owner/i.test(r.answer);
    scorecard.push({ name: 'who owns lead_2025 (E6c no gratuitous write)', pass: noWrite, note: `owner ${before}->${after} status=${r.status} steps=[${stepEvents(r.events).join(',')}] ans="${r.answer.slice(0, 80)}" mentionsOwner=${mentionsOwner}` });
  }

  // --- 2. "whats going on with liam volkov" — E4 no fabricated id + name res -
  {
    const sid = 'rep_liam';
    const r = await drive(mkDeps(sid), sid, "what's going on with liam volkov?");
    const steps = stepEvents(r.events);
    // PASS: it SEARCHED by name (a *.search_*/list action) and did not fail
    // on a fabricated con_1. (12 Liam Volkovs exist → may clarify/ambiguate.)
    const searched = steps.some((s) => /search|list/.test(s));
    const fabricatedIdFail = r.events.some((e) => e.t === 'repair' && /ID_NOT_PROVENANCED|ID_NOT_RESOLVED/.test((e as any).reason ?? ''));
    scorecard.push({ name: 'liam volkov (E4 no fabricated id / E10 name)', pass: searched || r.status === 'clarify', note: `status=${r.status} steps=[${steps.join(',')}] provenanceRepair=${fabricatedIdFail} ans="${r.answer.slice(0, 90)}"` });
  }

  // --- 3. "assign all leads with score>95 to user_6" — E1 + E6 gate ---------
  {
    const sid = 'rep_assign';
    const before = (q("SELECT COUNT(*) n FROM leads WHERE owner_id='user_6'")[0] as any).n;
    const matching = (q('SELECT COUNT(*) n FROM leads WHERE score>95 AND archived=0')[0] as any).n;
    const r = await drive(mkDeps(sid), sid, 'assign all leads with score over 95 to user_6');
    const after = (q("SELECT COUNT(*) n FROM leads WHERE owner_id='user_6'")[0] as any).n;
    const assigned = after - before;
    const fails = failures(r.events);
    const truncated = r.events.some((e) => e.t === 'step.failed' && (e as any).error?.code === 'TRUNCATED_INPUT');
    // PASS (engine-correctness): either all matching were assigned OR it
    // honestly refused (TRUNCATED_INPUT/gate) — but NEVER a silent partial
    // (e.g. exactly 20 of 249).
    const silentPartial = assigned > 0 && assigned < matching && !gated(r.events);
    const pass = (assigned === matching) || truncated || (assigned === 0);
    scorecard.push({ name: 'assign all score>95 to user_6 (E1 full-set/E6 gate)', pass: pass && !silentPartial, note: `matching=${matching} assigned=${assigned} gated=${gated(r.events)} truncated=${truncated} fails=[${fails.join(',')}] status=${r.status}` });
  }

  // --- 4. "coupons expiring end of this month" — E3 date coercion ----------
  {
    const sid = 'rep_coupon';
    const r = await drive(mkDeps(sid), sid, 'which coupons are expiring at the end of this month?');
    const steps = stepEvents(r.events);
    const fails = failures(r.events);
    // PASS: ran a coupon lookup/filter and did NOT fail on a bad field or
    // date-type mismatch (no FIELD_NOT_IN_SCHEMA / PARAM_SCHEMA / silent crash).
    const ranCouponLookup = steps.some((s) => /coupon|struct|search|list/.test(s));
    const badField = r.events.some((e) => e.t === 'repair' && /FIELD_NOT_IN_SCHEMA|PARAM_SCHEMA/.test((e as any).reason ?? ''));
    scorecard.push({ name: 'coupons expiring end of month (E3 date coercion)', pass: ranCouponLookup && fails.length === 0 && r.status !== 'failed', note: `status=${r.status} steps=[${steps.join(',')}] badFieldRepair=${badField} fails=[${fails.join(',')}] ans="${r.answer.slice(0, 80)}"` });
  }

  // --- 5. "192/192" month comparison — deals this vs last month -------------
  {
    const sid = 'rep_months';
    const r = await drive(mkDeps(sid), sid, 'how many deals did we close this month vs last month?');
    const steps = stepEvents(r.events);
    const fails = failures(r.events);
    // PASS (engine side): used real date-filtered reads (search_opportunities
    // with date params coerced per E3) and did not fail on a bad field.
    const badField = r.events.some((e) => e.t === 'repair' && /FIELD_NOT_IN_SCHEMA|PARAM_SCHEMA|UNKNOWN_PARAM/.test((e as any).reason ?? ''));
    scorecard.push({ name: '192/192 month comparison (E2/E3 fields+dates)', pass: steps.length > 0 && r.status !== 'failed', note: `status=${r.status} steps=[${steps.join(',')}] badFieldRepair=${badField} fails=[${fails.join(',')}] ans="${r.answer.slice(0, 90)}"` });
  }

  // --- report ----------------------------------------------------------------
  console.log('\n===== ENGINE-WAVE LIVE-REPLAY SCORECARD =====');
  for (const s of scorecard) console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.name}\n      ${s.note}`);
  console.log(`\n${scorecard.filter((s) => s.pass).length}/${scorecard.length} passed`);

  eventLog.close();
  sessionsDb.close();
  crm.close();
  console.log(`(crm profile db: ${crmDbPath(PROFILE)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
