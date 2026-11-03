#!/usr/bin/env node
/**
 * Real-HTTP smoke test for the long-polling contract.
 * Requires a running server (see smoke-test.sh).
 *
 * Verifies:
 *   1. auth is enforced
 *   2. POST /api/tickets creates a ticket
 *   3. GET  /api/tickets/:id/wait blocks
 *   4. POST /api/tickets/:id/resolve wakes it in < 1s
 *   5. a short wait times out cleanly
 */

const BASE_URL = process.env.HUB_URL ?? 'http://127.0.0.1:8788';
const TOKEN = process.env.HUB_TOKEN ?? 'smoke-token';

const auth = { authorization: `Bearer ${TOKEN}` };

function ticketPayload(suffix = '') {
  return {
    env: 'smoke-test',
    projectName: `zhunzou-smoke${suffix}`,
    doneSummary: '完成了冒烟测试脚本',
    blockerQuestion: '长轮询能否在 resolve 后立即返回？',
    nextStepPlan: '验证通过后进入 Milestone 3',
    options: [
      { key: 'A', label: '立即返回', prosCons: '符合预期' },
      { key: 'B', label: '等超时', prosCons: '体验差' },
    ],
    recommendedOption: 'A',
  };
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...auth, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

async function main() {
  console.log(`zhunzou smoke test → ${BASE_URL}`);

  console.log('\n[1/5] auth');
  const unauthorized = await fetch(`${BASE_URL}/api/tickets`);
  assert(unauthorized.status === 401, 'unauthenticated request returns 401');

  console.log('\n[2/5] create ticket');
  const created = await api('/api/tickets', {
    method: 'POST',
    body: JSON.stringify(ticketPayload()),
  });
  assert(created.status === 201, 'ticket created (201)');
  const ticket = created.body.ticket;
  assert(/^\d+$/.test(ticket.id), `ticket id is numeric string (${ticket.id})`);
  console.log(`     ticket #${ticket.id} status=${ticket.status}`);

  console.log('\n[3/5] long poll + human resolve');
  const waitPromise = api(`/api/tickets/${ticket.id}/wait?timeout=40000`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const resolveStartedAt = Date.now();
  const resolved = await api(`/api/tickets/${ticket.id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ selectedOption: 'A', customInstruction: '冒烟测试通过' }),
  });
  assert(resolved.status === 200, 'resolve accepted (200)');

  const waited = await waitPromise;
  const wakeLatency = Date.now() - resolveStartedAt;
  assert(waited.status === 200, 'long poll returned 200');
  assert(waited.body.resolved === true, 'long poll reports resolved=true');
  assert(waited.body.timedOut === false, 'long poll reports timedOut=false');
  assert(waited.body.ticket.status === 'HUMAN_RESOLVED', 'status HUMAN_RESOLVED');
  assert(waited.body.ticket.selectedOption === 'A', 'selected option A');
  assert(
    waited.body.ticket.customInstruction === '冒烟测试通过',
    'custom instruction persisted',
  );
  console.log(`     wake latency: ${wakeLatency}ms`);
  assert(wakeLatency < 1_000, 'waiter woken in under 1 second');

  console.log('\n[4/5] timeout path');
  const second = await api('/api/tickets', {
    method: 'POST',
    body: JSON.stringify(ticketPayload('-timeout')),
  });
  const timeoutStartedAt = Date.now();
  const timedOut = await api(`/api/tickets/${second.body.ticket.id}/wait?timeout=300`);
  const elapsed = Date.now() - timeoutStartedAt;
  assert(timedOut.status === 200, 'timed-out poll returned 200');
  assert(timedOut.body.timedOut === true, 'timedOut=true');
  assert(timedOut.body.resolved === false, 'resolved=false');
  assert(elapsed >= 280, `waited ~300ms (${elapsed}ms)`);

  console.log('\n[5/5] already-resolved ticket returns immediately');
  const startedAt = Date.now();
  const immediate = await api(`/api/tickets/${ticket.id}/wait?timeout=40000`);
  const immediateLatency = Date.now() - startedAt;
  assert(immediate.body.resolved === true, 'resolved=true');
  assert(immediateLatency < 300, `returned immediately (${immediateLatency}ms)`);

  await api(`/api/tickets/${second.body.ticket.id}/cancel`, { method: 'POST' });

  console.log('\nSMOKE TEST PASSED\n');
}

main().catch((error) => {
  console.error(`\nSMOKE TEST FAILED: ${error.message}\n`);
  process.exit(1);
});
