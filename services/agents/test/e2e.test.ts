import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ACCOUNTS as D, artifactHash } from '@bylaw/near-client';
import { CannedFactsProvider, createFakeStack, createLogger } from '../src/index.ts';

const logs: string[] = [];
const log = createLogger({}, (l) => logs.push(l));

async function json(base: string, path: string) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() as any };
}

test('e2e: indexer + 5 agents + FakeContract: post -> accept -> bids -> award -> submit -> review -> settle -> purchase -> claims', async () => {
  const s = await createFakeStack({ facts: new CannedFactsProvider(), manualClock: true, log });
  try {
    const id = (await s.fake.as(D.customer).postJob('guest-book.testnet', '100000000'))!;
    await s.step(); // sales accepts, both analysts bid
    let job = (await json(s.base, `/jobs/${id}`)).body;
    assert.equal(job.state, 'Open');
    assert.equal(job.bids.length, 2);
    s.clock!.advanceSec(61);
    await s.step(); // award, winner submits report, reviewer recomputes and approves, treasurer buys
    job = (await json(s.base, `/jobs/${id}`)).body;
    assert.equal(job.state, 'Settled');
    assert.equal(job.winner_account, D.analyst1, 'analyst1 bids 55% vs 65% and wins');
    // the deliverable is served by the indexer and its hash matches
    const art = await json(s.base, `/artifacts/${job.deliverable.hash}`);
    assert.equal(art.status, 200);
    assert.equal(art.body.schema, 'bylaw.report.v1');
    assert.equal(artifactHash(art.body), job.deliverable.hash);
    assert.equal(art.body.model, 'template-v1');
    const tl = (await json(s.base, `/jobs/${id}/timeline`)).body.map((e: any) => e.type);
    for (const t of ['job_posted', 'job_opened', 'bid_placed', 'job_awarded', 'work_submitted', 'work_reviewed', 'job_settled', 'spend_recorded']) assert.ok(tl.includes(t), t);
    const spends = (await json(s.base, '/spends')).body;
    assert.equal(spends.length, 1);
    assert.equal(spends[0].state, 'Paid');
    // claims: producer owner, reviewer owner, sales owner
    assert.equal((await json(s.base, '/claimable/bob.fake.testnet')).body.claimable, '55000000');
    assert.equal(await s.fake.as('bob.fake.testnet').claim(), '55000000');
    assert.equal(await s.fake.as('dave.fake.testnet').claim(), '8000000');
    assert.equal(await s.fake.as('alice.fake.testnet').claim(), '7000000');
    await s.fake.as('erin.fake.testnet').checkpointSeat('7');
    assert.equal(await s.fake.as('erin.fake.testnet').claim(), '6000000');
    await s.indexer.poll();
    const stats = (await json(s.base, '/stats')).body;
    assert.equal(stats.solvency.ok, true);
    assert.equal(stats.jobs_settled, 1);
    assert.equal((await json(s.base, '/agents/2')).body.rep, 110);
    // idempotency: extra rounds do nothing new
    const before = s.fake.events.length;
    await s.step(); await s.step();
    assert.equal(s.fake.events.length, before);
    // structured logs
    const parsed = logs.map((l) => JSON.parse(l));
    assert.ok(parsed.some((l) => l.msg === 'review_work' && l.approve === true && l.job_id === id && l.agent === 'reviewer'));
  } finally {
    await s.close();
  }
});

test('e2e: tampered report is rejected, job re-opens to the honest analyst and settles', async () => {
  const s = await createFakeStack({ facts: new CannedFactsProvider(), manualClock: true, log, tamper: { analyst1: true } });
  try {
    const id = (await s.fake.as(D.customer).postJob('wrap.testnet', '100000000'))!;
    await s.step();
    s.clock!.advanceSec(61);
    await s.step(); // analyst1 wins, submits forged facts, reviewer rejects -> re-award to analyst2
    let job = (await json(s.base, `/jobs/${id}`)).body;
    assert.equal(job.attempts, 1);
    assert.equal(job.winner_account, D.analyst2);
    const reviewer = s.agents.find((a) => a.name === 'reviewer') as any;
    assert.equal(reviewer.verdicts[0].approve, false);
    assert.match(reviewer.verdicts[0].reasons[0], /^facts_mismatch:/);
    const a1 = (await json(s.base, '/agents/2')).body;
    assert.equal(a1.rep, 80);
    assert.equal(a1.rejected, 1);
    // if the honest analyst already submitted in the same round, the job may be settled; otherwise one more round
    if (job.state !== 'Settled') await s.step();
    job = (await json(s.base, `/jobs/${id}`)).body;
    assert.equal(job.state, 'Settled');
    assert.equal(reviewer.verdicts.at(-1).approve, true);
    assert.equal((await json(s.base, '/claimable/carol.fake.testnet')).body.claimable, '55000000');
    assert.equal((await json(s.base, '/claimable/bob.fake.testnet')).body.claimable, '0');
    const tl = (await json(s.base, `/jobs/${id}/timeline`)).body;
    assert.ok(tl.some((e: any) => e.type === 'work_reviewed' && e.data.approve === false));
    assert.equal((await json(s.base, '/stats')).body.solvency.ok, true);
  } finally {
    await s.close();
  }
});
