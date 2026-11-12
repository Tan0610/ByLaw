import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeContract, ManualClock, ContractError, canonicalJson, sha256Hex, artifactHash, scoreBid, pickWinner,
  computeWaterfall, budgetFor, defaultParams, seedDemoWorld, DEMO_ACCOUNTS as D,
} from '../src/index.ts';

const H = sha256Hex('x');

function world() {
  const clock = new ManualClock();
  const f = new FakeContract({ clock: clock.now });
  seedDemoWorld(f);
  return { clock, f };
}
async function toAwarded(f: FakeContract, clock: ManualClock, target = 'x.testnet', price = '100000000') {
  const id = (await f.as(D.customer).postJob(target, price))!;
  await f.as(D.sales).acceptJob(id);
  await f.as(D.analyst1).placeBid(id, '60000000');
  await f.as(D.analyst2).placeBid(id, '70000000');
  clock.advanceSec(61);
  await f.as(D.sales).awardJob(id);
  return id;
}

test('canonicalJson sorts keys recursively and hash is stable', () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
  const b = { a: { c: 'x', d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(artifactHash(a), artifactHash(b));
  assert.match(artifactHash(a), /^0x[0-9a-f]{64}$/);
  assert.equal(sha256Hex('abc'), '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => canonicalJson({ a: undefined }));
});

test('scoring: lowest price*1000/(1000+rep) wins; tie -> earlier ts', () => {
  assert.equal(scoreBid('100', 0), 100n);
  assert.equal(scoreBid('110', 100), 100n);
  const bids = [
    { agent: '1', price: '100', ts_ns: '5' },
    { agent: '2', price: '110', ts_ns: '9' },
  ];
  // agent 2 has rep 100 -> score 100, ties with agent 1 (rep 0, score 100); earlier ts wins
  assert.equal(pickWinner(bids, (id) => (id === '2' ? 100 : 0))!.agent, '1');
  assert.equal(pickWinner(bids, (id) => (id === '2' ? 300 : 0))!.agent, '2');
  assert.equal(pickWinner(bids, () => 0, new Set(['1']))!.agent, '2');
  assert.equal(pickWinner([], () => 0), null);
});

test('waterfall conserves price, matches INTERFACES example, treasury takes rounding', () => {
  const p = defaultParams();
  const w = computeWaterfall(100_000_000n, p.split, 100n);
  assert.deepEqual([w.reviewer, w.producer, w.sales, w.seats, w.treasury].map(String),
    ['8000000', '55000000', '7000000', '15000000', '15000000']);
  for (const price of [10_000_001n, 33_333_333n, 999_999_999n]) {
    for (const weight of [0n, 3n, 100n]) {
      const x = computeWaterfall(price, p.split, weight);
      assert.equal(x.reviewer + x.producer + x.sales + x.seats + x.treasury, price);
    }
  }
  assert.equal(computeWaterfall(100n, p.split, 0n).seats, 0n);
});

test('budget formula: min(max, base + per_rep*rep/100)', () => {
  const p = defaultParams();
  assert.equal(budgetFor(p, 100), 6_000_000n);
  assert.equal(budgetFor(p, 100000), 50_000_000n);
});

test('full happy path: waterfall credits, rep, claims, solvency after each step', async () => {
  const { f, clock } = world();
  const id = await toAwarded(f, clock);
  assert.equal(f.checkSolvency().ok, true);
  let job = (await f.as(null).getJob(id))!;
  assert.equal(job.state, 'Awarded');
  assert.equal(job.winner, '2', 'analyst1 (token 2) bid lower and wins');
  assert.equal(job.reviewer, '4');
  await f.as(D.analyst1).submitWork(id, H, 'uri://x');
  await f.as(D.reviewer).reviewWork(id, true, H);
  assert.equal(f.checkSolvency().ok, true);
  job = (await f.as(null).getJob(id))!;
  assert.equal(job.state, 'Settled');
  const c = f.as(null);
  assert.equal(await c.claimableOf('bob.fake.testnet'), '55000000');
  assert.equal(await c.claimableOf('dave.fake.testnet'), '8000000');
  assert.equal(await c.claimableOf('alice.fake.testnet'), '7000000');
  assert.equal((await c.getAgent('2'))!.rep, 110);
  assert.equal((await c.getStats()).seat_pool, '15000000');
  assert.equal(await f.as('bob.fake.testnet').claim(), '55000000');
  assert.equal(f.checkSolvency().ok, true);
  assert.equal(await c.claimableOf('bob.fake.testnet'), '0');
  await assert.rejects(f.as('bob.fake.testnet').claim(), ContractError);
  // seats: weights 60/40 of 15,000,000
  await f.as('alice.fake.testnet').checkpointSeat('6');
  assert.equal(await c.claimableOf('alice.fake.testnet'), String(7_000_000 + 9_000_000));
  assert.equal(f.checkSolvency().ok, true);
});

test('price band: out-of-band payment is returned, no job created', async () => {
  const { f } = world();
  assert.equal(await f.as(D.customer).postJob('x.testnet', '1'), null);
  assert.equal(await f.as(D.customer).postJob('x.testnet', '99999999999'), null);
  assert.equal((await f.as(null).listJobs()).length, 0);
  assert.equal((await f.as(null).getStats()).total_in, '100000000');
});

test('bid rules: window, cap, one per agent; award only after window', async () => {
  const { f, clock } = world();
  const id = (await f.as(D.customer).postJob('x.testnet', '100000000'))!;
  await assert.rejects(f.as(D.analyst1).placeBid(id, '1'), /need Open/);
  await f.as(D.sales).acceptJob(id);
  await assert.rejects(f.as(D.analyst1).placeBid(id, '90000001'), /max_bid_bps/);
  await f.as(D.analyst1).placeBid(id, '90000000');
  await assert.rejects(f.as(D.analyst1).placeBid(id, '1'), /one bid/);
  await assert.rejects(f.as(D.sales).awardJob(id), /still open/);
  clock.advanceSec(61);
  await assert.rejects(f.as(D.analyst2).placeBid(id, '1'), /closed/);
});

test('role enforcement (C4) and wrong submitter', async () => {
  const { f, clock } = world();
  const id = (await f.as(D.customer).postJob('x.testnet', '100000000'))!;
  await assert.rejects(f.as(D.analyst1).acceptJob(id), /wrong kind/);
  await assert.rejects(f.as('nobody.testnet').acceptJob(id), /no agent/);
  await f.as(D.sales).acceptJob(id);
  await f.as(D.analyst1).placeBid(id, '50000000');
  clock.advanceSec(61);
  await f.as(D.sales).awardJob(id);
  await assert.rejects(f.as(D.analyst2).submitWork(id, H, 'u'), /only the winner/);
  await assert.rejects(f.as(D.reviewer).reviewWork(id, true, H), /need Submitted/);
});

test('no bids -> refund to customer claimable', async () => {
  const { f, clock } = world();
  const id = (await f.as(D.customer).postJob('x.testnet', '50000000'))!;
  await f.as(D.sales).acceptJob(id);
  clock.advanceSec(61);
  await f.as(D.sales).awardJob(id);
  assert.equal((await f.as(null).getJob(id))!.state, 'Refunded');
  assert.equal(await f.as(null).claimableOf(D.customer), '50000000');
  assert.equal(f.checkSolvency().ok, true);
});

test('reject: rep drops, job re-opens once to next-best bid, second reject refunds', async () => {
  const { f, clock } = world();
  const id = await toAwarded(f, clock);
  await f.as(D.analyst1).submitWork(id, H, 'u');
  await f.as(D.reviewer).reviewWork(id, false, H);
  let job = (await f.as(null).getJob(id))!;
  assert.equal(job.state, 'Awarded');
  assert.equal(job.winner, '3');
  assert.equal(job.attempts, 1);
  const a1 = (await f.as(null).getAgent('2'))!;
  assert.equal(a1.rep, 80); assert.equal(a1.rejected, 1);
  await f.as(D.analyst2).submitWork(id, H, 'u');
  await f.as(D.reviewer).reviewWork(id, false, H);
  job = (await f.as(null).getJob(id))!;
  assert.equal(job.state, 'Refunded');
  assert.equal(await f.as(null).claimableOf(D.customer), '100000000');
  assert.equal(f.checkSolvency().ok, true);
});

test('reviewer owner conflict: reviewer sharing an owner with the winner is skipped (C5)', async () => {
  const clock = new ManualClock();
  const f = new FakeContract({ clock: clock.now });
  f.registerAgent('Sales', 's', 'o1', 's.t');
  f.registerAgent('Analyst', 'a', 'o2', 'a.t');
  f.registerAgent('Reviewer', 'r1', 'o2', 'r1.t'); // same owner as analyst
  f.registerAgent('Reviewer', 'r2', 'o3', 'r2.t');
  for (let i = 0; i < 4; i++) {
    const id = (await f.as('c.t').postJob('x.t', '20000000'))!;
    await f.as('s.t').acceptJob(id);
    await f.as('a.t').placeBid(id, '10000000');
    clock.advanceSec(61);
    await f.as('s.t').awardJob(id);
    assert.equal((await f.as(null).getJob(id))!.reviewer, '4');
  }
});

test('expire: awarded deadline passes -> rep loss and re-open or refund; submitted -> escalated', async () => {
  const { f, clock } = world();
  const id = await toAwarded(f, clock);
  await assert.rejects(f.as(null).expireJob(id), /not expirable/);
  clock.advanceSec(601);
  await f.as(null).expireJob(id);
  const job = (await f.as(null).getJob(id))!;
  assert.equal(job.state, 'Awarded');
  assert.equal(job.winner, '3');
  assert.equal((await f.as(null).getAgent('2'))!.rep, 90);
  await f.as(D.analyst2).submitWork(id, H, 'u');
  clock.advanceSec(601);
  await f.as(null).expireJob(id);
  assert.equal((await f.as(null).getJob(id))!.state, 'Submitted');
  assert.ok(f.events.some((e) => e.event === 'job_expired'));
});

test('spends: allowed purchase paid; denials recorded not thrown; pending needs DAO', async () => {
  const { f, clock } = world();
  const t = f.as(D.treasurer);
  const ok = await t.requestSpend(D.vendor, '2000000', null, 'rpc');
  assert.equal((await t.getSpend(ok))!.state, 'Paid');
  const over = await t.requestSpend(D.vendor, '50000000', null, 'overspend');
  assert.deepEqual([(await t.getSpend(over))!.state, (await t.getSpend(over))!.reason], ['Rejected', 'per_tx_cap_exceeded']);
  const bad = await t.requestSpend('evil.testnet', '1000000', null, 'bad vendor');
  assert.equal((await t.getSpend(bad))!.reason, 'vendor_not_allowlisted');
  // budget window: 6,000,000 for rep 100; 2,000,000 spent; 4,500,000 would exceed? 2+4.5 > 6 -> rejected
  const b = await t.requestSpend(D.vendor, '4500000', null, 'x');
  assert.equal((await t.getSpend(b))!.reason, 'budget_exceeded');
  assert.equal(f.checkSolvency().ok, true);
  assert.ok(f.events.filter((e) => e.event === 'spend_recorded' && String(e.data[0].outcome).startsWith('Rejected:')).length >= 3);
  // window rolls after 24h
  clock.advanceSec(86401);
  const again = await t.requestSpend(D.vendor, '3000000', null, 'new window');
  assert.equal((await t.getSpend(again))!.state, 'Paid');
  clock.advanceSec(86401);
  const pend = await t.requestSpend(D.vendor, '5500000', null, 'big'); // >= approval_threshold, <= budget
  assert.equal((await t.getSpend(pend))!.state, 'Pending');
  f.approveSpend(pend);
  assert.equal((await t.getSpend(pend))!.state, 'Paid');
  assert.equal(f.checkSolvency().ok, true);
});

test('frozen agent cannot act; frozen treasurer spend is recorded as denial; guardians only freeze', async () => {
  const { f } = world();
  await assert.rejects(f.as('rando.testnet').freezeAgent('2', 'x'), /only guardians/);
  await f.as('guardian.fake.testnet').freezeAgent('5', 'suspicious');
  const id = await f.as(D.treasurer).requestSpend(D.vendor, '1000000', null, 'x');
  assert.equal((await f.as(null).getSpend(id))!.reason, 'agent_not_active');
  await f.as('guardian.fake.testnet').freezeAgent('2', 'x');
  const jid = (await f.as(D.customer).postJob('x.t', '20000000'))!;
  await f.as(D.sales).acceptJob(jid);
  await assert.rejects(f.as(D.analyst1).placeBid(jid, '1000000'), /Frozen/);
});

test('repeated rejections auto-freeze below rep_freeze_below (C10)', async () => {
  const clock = new ManualClock();
  const f = new FakeContract({ clock: clock.now, params: { rep_start: 60, rep_loss: 20 } });
  f.registerAgent('Sales', 's', 'o1', 's.t');
  f.registerAgent('Analyst', 'a', 'o2', 'a.t');
  f.registerAgent('Reviewer', 'r', 'o3', 'r.t');
  const id = (await f.as('c.t').postJob('x.t', '20000000'))!;
  await f.as('s.t').acceptJob(id);
  await f.as('a.t').placeBid(id, '10000000');
  clock.advanceSec(61);
  await f.as('s.t').awardJob(id);
  await f.as('a.t').submitWork(id, H, 'u');
  await f.as('r.t').reviewWork(id, false, H);
  const a = (await f.as(null).getAgent('2'))!;
  assert.equal(a.rep, 40);
  assert.equal(a.state, 'Frozen');
});

test('bylaw change: version increments, split validated, history kept', async () => {
  const { f } = world();
  const v = f.setByLaw({ text: 'ByLaw v2' });
  assert.equal(v.version, 2);
  assert.throws(() => f.setByLaw({ split: { reviewer: 1, producer: 1, sales: 1, seats: 1, treasury: 1 } }), /split/);
  assert.equal(f.bylawHistory().length, 2);
});
