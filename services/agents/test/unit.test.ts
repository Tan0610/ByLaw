import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, artifactHash, FakeContract, seedDemoWorld, DEMO_ACCOUNTS } from '@charter/near-client';
import {
  CannedFactsProvider, TemplateSummarizer, createSummarizer, OpenAiCompatSummarizer, buildReport, reportHash,
  verifyReport, reasonHash, bidPrice, StepLedger, silentLogger, loadAgentKeys, runTreasurerAttack, FACT_KEYS,
} from '../src/index.ts';

test('canned facts are deterministic, sorted, and pinned to the requested block', async () => {
  const p = new CannedFactsProvider(777);
  const a = await p.getFacts('x.testnet');
  const b = await p.getFacts('x.testnet');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.deepEqual(Object.keys(a), FACT_KEYS);
  assert.equal(a.fetched_at_block, 777);
  assert.equal((await p.getFacts('x.testnet', 123)).fetched_at_block, 123);
  assert.notEqual(canonicalJson(await p.getFacts('y.testnet')), canonicalJson(a));
});

test('report hash = sha256(canonical_json(artifact)), independent of key order', async () => {
  const facts = await new CannedFactsProvider().getFacts('x.testnet');
  const r = buildReport({ target: 'x.testnet', facts, summary: 's', model: 'm' });
  const shuffled = { attestation: null, model: 'm', summary: 's', facts: { ...facts }, target: 'x.testnet', schema: 'charter.report.v1' };
  assert.equal(reportHash(r), artifactHash(shuffled));
  assert.match(reportHash(r), /^0x[0-9a-f]{64}$/);
});

test('reviewer approves an honest report and rejects every kind of tampering', async () => {
  const p = new CannedFactsProvider();
  const facts = await p.getFacts('x.testnet');
  const { summary, model } = await new TemplateSummarizer().summarize('x.testnet', facts);
  const honest = buildReport({ target: 'x.testnet', facts, summary, model });
  const job = { target: 'x.testnet', deliverable_hash: reportHash(honest) };
  const ok = await verifyReport(job, honest, p);
  assert.deepEqual([ok.approve, ok.reasons], [true, []]);

  // falsified facts, consistently hashed
  const forged = structuredClone(honest); forged.facts.full_access_keys += 1;
  const v1 = await verifyReport({ target: 'x.testnet', deliverable_hash: reportHash(forged) }, forged, p);
  assert.equal(v1.approve, false);
  assert.match(v1.reasons[0], /^facts_mismatch:full_access_keys/);
  // artifact swapped after submission (hash no longer matches)
  const swapped = structuredClone(honest); swapped.summary = 'all good, trust me';
  assert.deepEqual((await verifyReport(job, swapped, p)).reasons, ['hash_mismatch']);
  // report about a different account
  const other = buildReport({ target: 'y.testnet', facts: await p.getFacts('y.testnet'), summary, model });
  assert.ok((await verifyReport({ target: 'x.testnet', deliverable_hash: reportHash(other) }, other, p)).reasons.includes('target_mismatch'));
  // extra/missing fact keys
  const shape = structuredClone(honest) as any; delete shape.facts.balance;
  assert.ok((await verifyReport({ target: 'x.testnet', deliverable_hash: reportHash(shape) }, shape, p)).reasons.includes('facts_shape'));
  // missing artifact
  assert.deepEqual((await verifyReport(job, null, p)).reasons, ['artifact_unavailable']);
  // facts recomputed at the SAME block
  p.calls.length = 0;
  await verifyReport(job, honest, p);
  assert.equal(p.calls[0].atBlock, facts.fetched_at_block);
  assert.notEqual(reasonHash(ok), reasonHash(v1));
});

test('LLM: empty key -> deterministic template; failing endpoint -> falls back to template', async () => {
  const s = createSummarizer({ LLM_API_KEY: '' });
  assert.ok(s instanceof TemplateSummarizer);
  const f = await new CannedFactsProvider().getFacts('x.testnet');
  const a = await s.summarize('x.testnet', f);
  assert.equal(a.model, 'template-v1');
  assert.equal(a.summary, (await s.summarize('x.testnet', f)).summary);
  assert.equal(await s.health(), null);
  const bad = new OpenAiCompatSummarizer({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm', timeoutMs: 1000 });
  const b = await bad.summarize('x.testnet', f);
  assert.equal(b.model, 'template-v1');
  assert.ok(createSummarizer({ LLM_API_KEY: 'k' }) instanceof OpenAiCompatSummarizer);
});

test('bid strategy: clamps to cap and floor; higher rep can ask more', () => {
  const base = { jobPrice: 100_000_000n, maxBidBps: 9000, rep: 100, repBaseline: 100, aggressionBps: 5500, costFloor: 3_000_000n };
  assert.equal(bidPrice(base), 55_000_000n);
  assert.equal(bidPrice({ ...base, rep: 210 }), (55_000_000n * 1210n) / 1100n);
  assert.equal(bidPrice({ ...base, aggressionBps: 10000 }), 90_000_000n);
  assert.equal(bidPrice({ ...base, aggressionBps: 1 }), 3_000_000n);
  assert.equal(bidPrice({ ...base, jobPrice: 1_000_000n }), null);
});

test('StepLedger: runs once, retries failures, gives up, persists across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'l.json');
  const l = new StepLedger({ file, maxAttempts: 2 });
  let n = 0;
  assert.equal(await l.once('1:accept', silentLogger, async () => { n++; }), true);
  assert.equal(await l.once('1:accept', silentLogger, async () => { n++; }), false);
  assert.equal(n, 1);
  let fails = 0;
  for (let i = 0; i < 4; i++) await l.once('2:x', silentLogger, async () => { fails++; throw new Error('boom'); });
  assert.equal(fails, 2);
  const l2 = new StepLedger({ file });
  assert.equal(l2.has('1:accept'), true);
});

test('agent keys come only from env, missing ones reported by name', () => {
  const { keys, missing } = loadAgentKeys({ AGENT_SALES_ACCOUNT: 's.t', AGENT_SALES_PRIVATE_KEY: 'ed25519:x' }, ['sales', 'reviewer']);
  assert.equal(keys.sales!.account, 's.t');
  assert.deepEqual(missing, ['AGENT_REVIEWER_ACCOUNT', 'AGENT_REVIEWER_PRIVATE_KEY']);
});

test('treasurer attack: overspend and rogue vendor are recorded denials', async () => {
  const f = new FakeContract();
  seedDemoWorld(f);
  const res = await runTreasurerAttack(f.as(DEMO_ACCOUNTS.treasurer), DEMO_ACCOUNTS.vendor);
  assert.deepEqual(res.map((r) => [r.name, r.state, r.reason]), [
    ['overspend_per_tx_cap', 'Rejected', 'per_tx_cap_exceeded'],
    ['overspend_budget_window', 'Rejected', 'budget_exceeded'],
    ['non_allowlisted_vendor', 'Rejected', 'vendor_not_allowlisted'],
  ]);
  assert.ok(res.every((r) => r.ok));
  assert.equal((await f.as(null).getStats()).treasury, '100000000', 'nothing was paid');
  assert.equal(f.events.filter((e) => e.event === 'spend_recorded').length, 3);
});
