#!/usr/bin/env node
// Chat with the live Ask-AI server like a real user, over HTTP.
// Usage:
//   node persona-chat.mjs --session new --text "..." [--role viewer|member|admin] [--model auto] [--confirm approve|deny|edit:value_cents=15000000]
// Prints a JSON summary: { sessionId, status, answer, steps, gated, confirmReason, memoryOps, scheduled }
const BASE = process.env.BASE || 'http://localhost:3000';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]); return a;
}, []));

async function createSession() {
  const r = await fetch(`${BASE}/api/sessions`, { method: 'POST' });
  return (await r.json()).id;
}
async function getEvents(sid) {
  const r = await fetch(`${BASE}/api/sessions/${sid}/events`);
  return (await r.json()).events || [];
}
async function sendConfirm(sid, confirmId, policy) {
  const body = { approved: policy.startsWith('deny') ? false : true };
  if (policy.startsWith('edit:')) {
    const [k, v] = policy.slice(5).split('=');
    body.editedParams = { [k]: isNaN(Number(v)) ? v : Number(v) };
  }
  await fetch(`${BASE}/api/sessions/${sid}/confirm/${confirmId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function main() {
  const sid = args.session === 'new' || !args.session ? await createSession() : args.session;
  const body = { text: args.text };
  if (args.model) body.model = args.model;
  if (args.role) body.role = args.role;
  const confirmPolicy = args.confirm || 'approve';
  let confirmed = false;

  const res = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const live = [];
  const deadline = Date.now() + 120000;
  outer: while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      live.push(ev);
      if (ev.t === 'confirmation.required' && !confirmed) {
        confirmed = true;
        await sendConfirm(sid, ev.confirmId, confirmPolicy);
      }
      if (ev.t === 'turn.completed') break outer;
    }
  }
  try { await reader.cancel(); } catch {}

  // Authoritative record (incl. memory.op appended post-turn)
  await new Promise((r) => setTimeout(r, 1500));
  const all = await getEvents(sid);
  const mine = all.length ? all : live;
  const answer = [...mine].reverse().find((e) => e.t === 'answer.final')?.text || '';
  const steps = mine.filter((e) => e.t === 'step.started').map((e) => e.action);
  const stepDetail = mine.filter((e) => e.t === 'step.started').map((e) => ({ action: e.action, params: e.resolvedParams?.[0] }));
  const completed = [...mine].reverse().find((e) => e.t === 'turn.completed');
  const m = completed?.metrics || {};
  const confReq = mine.find((e) => e.t === 'confirmation.required');
  const memoryOps = mine.filter((e) => e.t === 'memory.op').map((e) => ({ op: e.op, cat: e.category, body: e.body }));
  const sched = await (await fetch(`${BASE}/api/sessions/${sid}/scheduled`)).json();

  console.log(JSON.stringify({
    sessionId: sid,
    status: completed?.status,
    answer,
    chips: (answer.match(/\[\[record:(\w+):/g) || []).map((m) => m.split(':')[1]),
    steps,
    stepDetail,
    gated: !!confReq,
    confirmDescription: confReq?.scope?.description,
    confirmHasParams: !!confReq?.scope?.params,
    memoryOps,
    scheduled: (sched.tasks || []).map((t) => ({ due: new Date(t.dueAt).toISOString().slice(0, 10), what: t.instruction, role: t.role })),
    metrics: { ttfurMs: Math.round(m.ttfurMs || 0), totalMs: Math.round(m.totalMs || 0), llmCalls: m.llmCalls, tokensIn: m.tokensIn, tokensOut: m.tokensOut, costUsd: m.costUsd, stepsOk: m.stepsOk, stepsFailed: m.stepsFailed },
  }, null, 2));
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
