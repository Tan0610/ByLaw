// Checks that NearContractClient's view calls match contracts/bylaw/ABI.md (argument names and
// JSON encodings), with fetch stubbed so no network is used. Change calls (signed) are not covered here.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NearContractClient, parseEvents } from '../src/index.ts';

type Call = { method: string; args: any };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stub RPC: `handler(method, args)` returns the JSON the contract view would return. */
function stub(handler: (method: string, args: any) => unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    const p = body.params;
    const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
    calls.push({ method: p.method_name, args });
    const result = [...Buffer.from(JSON.stringify(handler(p.method_name, args)))];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'bylaw', result: { result } }));
  }) as typeof fetch;
  return calls;
}

const client = () => new NearContractClient({ rpcUrl: 'http://rpc.invalid', contractId: 'bylaw.x.testnet', tokenId: 'tusd.x.testnet' });
const job = (id: number, state = 'Open') => ({
  id: String(id), customer: 'c.testnet', target: 't.testnet', price: '100000000', state, created_ns: '1',
  sales: '1', bids: [{ agent: '2', price: '80000000', ts_ns: '5', score: '72727272' }], winner: null, reviewer: null,
  deliverable_hash: null, uri: null, attestation: null, attempts: 0, deadline_ns: '9', escalated: false, escrow: '100000000',
});

test('list_jobs: `from` is a U64 string id starting at "1", pages of 100 until a short page', async () => {
  const calls = stub((m, a) => {
    assert.equal(m, 'list_jobs');
    assert.equal(typeof a.from, 'string', 'from must be a string (near-sdk U64)');
    const start = Number(a.from);
    const ids = Array.from({ length: Math.max(0, Math.min(a.limit, 150 - start + 1)) }, (_, i) => start + i);
    return ids.map((i) => job(i));
  });
  const all = await client().listJobs({ from: 0, limit: 1000 });
  assert.equal(all.length, 150);
  assert.deepEqual(calls.map((c) => c.args.from), ['1', '101']);
  assert.ok(calls.every((c) => c.args.limit === 100));
});

test('list_jobs: state filter is sent by name; offset/limit applied like the fake', async () => {
  const calls = stub((_m, a) => (a.from === '1' ? [job(3, 'Settled'), job(7, 'Settled'), job(9, 'Settled')] : []));
  const page = await client().listJobs({ state: 'Settled', from: 1, limit: 1 });
  assert.equal(calls[0].args.state, 'Settled');
  assert.deepEqual(page.map((j) => j.id), ['7']);
});

test('list_spends pages by id beyond the 50 default', async () => {
  const calls = stub((_m, a) => {
    const start = Number(a.from);
    const n = start === 1 ? 100 : 20;
    return Array.from({ length: n }, (_, i) => ({ id: String(start + i), agent: '5', vendor: 'v.testnet', amount: '1', job: null, state: 'Paid', reason: '', memo: '', ts_ns: '1' }));
  });
  const spends = await client().listSpends();
  assert.equal(spends.length, 120);
  assert.deepEqual(calls.map((c) => c.args.from), ['1', '101']);
});

test('budget_of returns an object in the ABI; client returns its `budget` field', async () => {
  const calls = stub(() => ({ token_id: '5', budget: '30000000', win_spent: '10000000', remaining: '20000000', window_ns: '3600000000000', log_len: 1 }));
  assert.equal(await client().budgetOf('5'), '30000000');
  assert.deepEqual(calls[0], { method: 'budget_of', args: { token_id: '5' } });
});

test('agent, job, seat and stats views decode the ABI shapes', async () => {
  stub((m) => {
    if (m === 'get_agent') return { token_id: '7', account: 'analyst-1.bylaw.x.testnet', kind: 'Analyst', state: 'Active', owner: 'bob.testnet', rep: 110, delivered: 1, rejected: 0, win_start_ns: '0', win_spent: '0', budget: '31000000', method_names: 'place_bid,submit_work' };
    if (m === 'get_job') return { ...job(1, 'Settled'), deliverable_hash: '0x' + 'ab'.repeat(32) };
    if (m === 'list_seats') return [{ token_id: '12', owner: 'carol.testnet', weight: 100, last_acc: '0', pending: '1500000' }];
    if (m === 'get_stats') return { treasury: '1', escrow_total: '2', claimable_total: '3', pools_total: '0', seat_pool: '4', total_in: '10', total_out: '0', jobs_total: '3', jobs_settled: '1', agents_total: 5, seats_total: 1, total_seat_weight: '100', solvent: true };
    throw new Error('unexpected ' + m);
  });
  const c = client();
  const a = await c.getAgent('7');
  assert.equal(a?.owner, 'bob.testnet');
  assert.equal(a?.rep, 110);
  const j = await c.getJob('1');
  assert.equal(j?.deliverable_hash, '0x' + 'ab'.repeat(32));
  assert.equal(j?.bids[0].price, '80000000');
  const seats = await c.listSeats();
  assert.equal(seats[0].weight, 100);
  const st = await c.getStats();
  assert.equal(st.escrow_total, '2');
  assert.equal(st.jobs_total, 3);
});

test('parseEvents reads bylaw NEP-297 logs and ignores others', () => {
  const evs = parseEvents([
    'plain log',
    'EVENT_JSON:{"standard":"nep171","version":"1.2.0","event":"nft_mint","data":[]}',
    'EVENT_JSON:{"standard":"bylaw","version":"1.0.0","event":"job_posted","data":[{"job_id":"4","customer":"c","target":"t","price":"1"}]}',
    'EVENT_JSON:{not json',
  ]);
  assert.deepEqual(evs.map((e) => e.event), ['job_posted']);
  assert.equal(evs[0].data[0].job_id, '4');
});
