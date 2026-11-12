import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeContract, ManualClock, seedDemoWorld, DEMO_ACCOUNTS as D, sha256Hex, artifactHash } from '@charter/near-client';
import { createIndexerApp, Indexer, Db } from '../src/index.ts';

const H = sha256Hex('deliverable');

async function setup() {
  const clock = new ManualClock();
  const fake = new FakeContract({ clock: clock.now });
  seedDemoWorld(fake);
  const cfg = { contract_id: fake.contractId, dao_id: fake.ownerId, token_id: fake.tokenId };
  const r = await createIndexerApp({ client: fake.as(null), cfg });
  // job 1: settled; job 2: posted; job 3: rejected once then open for re-submit
  const id = (await fake.as(D.customer).postJob('x.testnet', '100000000'))!;
  await fake.as(D.sales).acceptJob(id);
  await fake.as(D.analyst1).placeBid(id, '60000000');
  await fake.as(D.analyst2).placeBid(id, '70000000');
  await r.indexer.poll(); // observe bids at their time (scores use rep at first sight)
  clock.advanceSec(61);
  await fake.as(D.sales).awardJob(id);
  await fake.as(D.analyst1).submitWork(id, H, 'artifact://h');
  await fake.as(D.reviewer).reviewWork(id, true, H);
  await fake.as(D.treasurer).requestSpend(D.vendor, '1000000', id, 'rpc credits');
  await fake.as(D.treasurer).requestSpend('evil.testnet', '1000000', null, 'attack');
  await fake.as(D.customer).postJob('y.testnet', '20000000');
  await r.indexer.poll();
  fake.setCharter({ text: 'Charter v2\nsecond line' });
  await r.indexer.poll();
  return { clock, fake, ...r, jobId: id };
}

const get = async (app: any, url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};

test('GET /health', async () => {
  const { app, indexer } = await setup();
  indexer.heartbeats.set('sales', { at: Date.now(), llm_ok: true });
  const r = await get(app, '/health');
  assert.equal(r.status, 200);
  assert.ok(r.body.near_height > 0);
  assert.equal(typeof r.body.indexer_lag_s, 'number');
  assert.deepEqual(r.body.agents_alive, ['sales']);
  assert.equal(r.body.llm_ok, true);
});

test('GET /config and /charter and /charter/history (with diff)', async () => {
  const { app, fake } = await setup();
  const c = await get(app, '/config');
  assert.equal(c.body.contract_id, fake.contractId);
  assert.deepEqual(c.body.guardians, ['guardian.fake.testnet']);
  assert.equal(c.body.charter.version, 2);
  assert.match(c.body.charter.text_hash, /^0x[0-9a-f]{64}$/);
  const ch = await get(app, '/charter');
  assert.equal(ch.body.version, 2);
  assert.equal(ch.body.split.producer, 5500);
  const h = await get(app, '/charter/history');
  assert.equal(h.body.length, 2);
  assert.equal(h.body[0].diff.length, 0);
  assert.ok(h.body[1].diff.some((d: any) => d.op === '+' && d.line === 'second line'));
  assert.ok(h.body[1].diff.some((d: any) => d.op === '-'));
  assert.equal(h.body[1].text, 'Charter v2\nsecond line');
});

test('GET /agents and /agents/:id', async () => {
  const { app } = await setup();
  const l = await get(app, '/agents');
  assert.equal(l.body.length, 5);
  const a = await get(app, '/agents/2');
  assert.equal(a.body.kind, 'Analyst');
  assert.equal(a.body.owner, 'bob.fake.testnet');
  assert.equal(a.body.rep, 110);
  assert.equal(a.body.budget, '6100000'.replace('6100000', String(5_000_000 + (1_000_000 * 110) / 100)));
  assert.equal(a.body.earnings.by_role.producer, '55000000');
  assert.equal(a.body.state, 'Active');
  assert.equal(a.body.win_spent, '0');
  const t = await get(app, '/agents/5');
  assert.equal(t.body.win_spent, '1000000');
  const nf = await get(app, '/agents/99');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'not_found');
  assert.equal((await get(app, '/agents/abc')).status, 400);
});

test('GET /jobs (filters) and /jobs/:id with bids, scores, winner, waterfall', async () => {
  const { app, jobId } = await setup();
  const all = await get(app, '/jobs');
  assert.equal(all.body.length, 2);
  assert.equal((await get(app, '/jobs?state=Settled')).body.length, 1);
  assert.equal((await get(app, '/jobs?state=Posted')).body.length, 1);
  assert.equal((await get(app, `/jobs?customer=${D.customer}`)).body.length, 2);
  assert.equal((await get(app, '/jobs?customer=nobody.testnet')).body.length, 0);
  assert.equal((await get(app, '/jobs?state=Bogus')).status, 400);
  const j = await get(app, `/jobs/${jobId}`);
  assert.equal(j.body.state, 'Settled');
  assert.equal(j.body.winner, '2');
  assert.equal(j.body.reviewer, '4');
  assert.equal(j.body.bids.length, 2);
  assert.equal(j.body.bids[0].score, String((60_000_000n * 1000n) / 1100n));
  assert.equal(j.body.bids.filter((b: any) => b.is_winner).length, 1);
  assert.equal(j.body.deliverable.hash, H);
  assert.equal(j.body.waterfall.producer, '55000000');
  assert.equal(j.body.waterfall.seats, '15000000');
  assert.ok(j.body.created_iso.endsWith('Z'));
  assert.equal((await get(app, '/jobs/999')).status, 404);
});

test('GET /jobs/:id/timeline is ordered and complete', async () => {
  const { app, jobId } = await setup();
  const t = await get(app, `/jobs/${jobId}/timeline`);
  const types = t.body.map((e: any) => e.type);
  assert.deepEqual(types, ['job_posted', 'job_opened', 'bid_placed', 'bid_placed', 'job_awarded', 'work_submitted', 'work_reviewed', 'job_settled', 'spend_recorded', 'spend_paid']);
  assert.deepEqual(t.body.map((e: any) => e.seq), [...t.body.map((e: any) => e.seq)].sort((a, b) => a - b));
  const settled = t.body[7].data;
  assert.equal(settled.credits.producer, '55000000');
  assert.equal((await get(app, '/jobs/999/timeline')).status, 404);
});

test('GET /spends includes rejected attempts; /pools is empty', async () => {
  const { app } = await setup();
  const s = await get(app, '/spends');
  assert.equal(s.body.length, 2);
  const rej = s.body.find((x: any) => x.state === 'Rejected');
  assert.equal(rej.outcome, 'Rejected:vendor_not_allowlisted');
  assert.equal(s.body.find((x: any) => x.state === 'Paid').amount, '1000000');
  assert.deepEqual((await get(app, '/pools')).body, []);
});

test('GET /seats, /seats/:id with pending dividends', async () => {
  const { app } = await setup();
  const s = await get(app, '/seats');
  assert.equal(s.body.length, 2);
  assert.equal(s.body[0].pending, '9000000');
  assert.equal(s.body[1].pending, '6000000');
  assert.equal((await get(app, '/seats/6')).body.weight, 60);
  assert.equal((await get(app, '/seats/1')).status, 404);
});

test('GET /claimable/:account', async () => {
  const { app } = await setup();
  assert.deepEqual((await get(app, '/claimable/bob.fake.testnet')).body, { account: 'bob.fake.testnet', claimable: '55000000' });
  assert.equal((await get(app, '/claimable/nobody.testnet')).body.claimable, '0');
  assert.equal((await get(app, '/claimable/BAD!')).status, 400);
});

test('artifacts: POST stores by canonical hash, GET returns report JSON, bad input rejected', async () => {
  const { app } = await setup();
  const art = { schema: 'charter.report.v1', target: 'x.testnet', facts: { b: 1, a: 2 }, summary: 's', model: 'm', attestation: null };
  const post = await app.inject({ method: 'POST', url: '/artifacts', payload: art });
  assert.equal(post.statusCode, 201);
  const { hash } = JSON.parse(post.body);
  assert.equal(hash, artifactHash(art));
  const g = await get(app, `/artifacts/${hash}`);
  assert.equal(g.status, 200);
  assert.equal(artifactHash(g.body), hash);
  assert.equal((await get(app, `/artifacts/${sha256Hex('nope')}`)).status, 404);
  assert.equal((await get(app, '/artifacts/zzz')).status, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/artifacts', payload: { schema: 'other' } })).statusCode, 400);
});

test('write token protects POST endpoints when configured', async () => {
  const fake = new FakeContract();
  seedDemoWorld(fake);
  const { app } = await createIndexerApp({ client: fake.as(null), cfg: { contract_id: 'c', dao_id: 'd', token_id: 't' }, server: { writeToken: 'sekret' } });
  const art = { schema: 'charter.report.v1', target: 'x', facts: {}, summary: '', model: '', attestation: null };
  assert.equal((await app.inject({ method: 'POST', url: '/artifacts', payload: art })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/artifacts', payload: art, headers: { 'x-indexer-token': 'sekret' } })).statusCode, 201);
});

test('GET /attestations/:job_id', async () => {
  const { app, jobId } = await setup();
  const r = await get(app, `/attestations/${jobId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.verified, false);
  assert.equal((await get(app, '/attestations/999')).status, 404);
});

test('GET /stats includes solvency check', async () => {
  const { app } = await setup();
  const s = await get(app, '/stats');
  assert.equal(s.body.solvency.ok, true);
  assert.equal(s.body.jobs_total, 2);
  assert.equal(s.body.jobs_by_state.Settled, 1);
  assert.equal(s.body.spends.rejected, 1);
  assert.equal(s.body.treasury, String(100_000_000 + 15_000_000 - 1_000_000));
});

test('error shape and unknown route', async () => {
  const { app } = await setup();
  const r = await get(app, '/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message']);
});

test('CORS header present', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });
  assert.ok(res.headers['access-control-allow-origin']);
});

test('GET /stream (SSE) pushes pings on change', async () => {
  const { app, fake, indexer } = await setup();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/stream`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (re: RegExp) => {
    while (!re.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
  };
  await readUntil(/hello/);
  await fake.as(D.customer).postJob('z.testnet', '30000000');
  await indexer.poll();
  await readUntil(/"type":"job"/);
  assert.match(buf, /"type":"job","id":"3"/);
  ctrl.abort();
  await app.close();
});

test('reindex rebuilds identical state (incl. timeline) from an empty DB', async () => {
  const { app, indexer, jobId } = await setup();
  const before = {
    jobs: (await get(app, '/jobs')).body,
    tl: (await get(app, `/jobs/${jobId}/timeline`)).body.map((e: any) => e.type),
    agents: (await get(app, '/agents')).body,
    spends: (await get(app, '/spends')).body,
  };
  const art = { schema: 'charter.report.v1', target: 'x', facts: {}, summary: '', model: '', attestation: null };
  indexer.db.putArtifact(artifactHash(art), JSON.stringify(art));
  const r = await indexer.reindex();
  assert.ok(r.events > 0);
  const strip = (js: any[]) => js.map((j) => ({ ...j, bids: j.bids.map((b: any) => ({ ...b, score: null })) }));
  assert.deepEqual(strip((await get(app, '/jobs')).body), strip(before.jobs)); // scores use rep at first sight, not rebuildable
  assert.deepEqual((await get(app, `/jobs/${jobId}/timeline`)).body.map((e: any) => e.type), before.tl);
  assert.deepEqual((await get(app, '/agents')).body, before.agents);
  assert.deepEqual((await get(app, '/spends')).body, before.spends);
  assert.equal((await get(app, `/artifacts/${artifactHash(art)}`)).status, 200, 'artifacts survive reindex');
});

test('a new Indexer on an existing DB does not duplicate events (idempotent)', async () => {
  const { fake, db, indexer, jobId } = await setup();
  const n = db.events(jobId).length;
  const again = new Indexer(db, fake.as(null), indexer.cfg);
  await again.poll();
  assert.equal(db.events(jobId).length, n);
});

test('openapi.yaml documents every route', async () => {
  const yaml = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
  const paths = ['/health', '/config', '/charter', '/charter/history', '/agents', '/agents/{token_id}', '/jobs', '/jobs/{id}',
    '/jobs/{id}/timeline', '/spends', '/pools', '/seats', '/seats/{token_id}', '/claimable/{account}', '/artifacts/{hash}',
    '/attestations/{job_id}', '/stats', '/stream', '/heartbeat'];
  for (const p of paths) assert.ok(yaml.includes(`  ${p}:`), `openapi missing ${p}`);
  void Db;
});
