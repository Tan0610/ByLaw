import type { ContractClient } from './client.ts';
import type { Agent, ByLawParams, Job, JobListOpts, Seat, SpendRequest, Stats } from './types.ts';

/** Minimal JSON-RPC helper (no dependency). Used for views, facts and block info. */
export async function nearRpc<T = unknown>(rpcUrl: string, method: string, params: unknown, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'bylaw', method, params }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`rpc http ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown } };
      if (body.error) throw new Error(`rpc error ${body.error.cause?.name ?? body.error.name ?? ''}: ${JSON.stringify(body.error.data ?? body.error.message)}`);
      return body.result as T;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw lastErr;
}

export interface NearClientOptions {
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  /** Signer; omit for read-only (indexer). */
  accountId?: string;
  /** `ed25519:...` secret key, read from env by the caller; never logged. */
  privateKey?: string;
  gas?: bigint;
  /** How [u8;32] args are sent. Reconcile with contracts/bylaw/ABI.md. */
  hashEncoding?: 'hex' | 'bytes';
}

const s = (x: unknown): string => String(x);
const sn = (x: unknown): string | null => (x === null || x === undefined ? null : String(x));

const normAgent = (a: any): Agent => ({
  token_id: s(a.token_id), account: s(a.account), owner: s(a.owner ?? ''), kind: a.kind, state: a.state,
  rep: Number(a.rep), delivered: Number(a.delivered), rejected: Number(a.rejected),
  win_start_ns: s(a.win_start_ns ?? '0'), win_spent: s(a.win_spent ?? '0'),
});
const hex32 = (h: unknown): string | null => {
  if (h === null || h === undefined) return null;
  if (Array.isArray(h)) return '0x' + Buffer.from(h as number[]).toString('hex');
  const x = String(h);
  return x.startsWith('0x') ? x : '0x' + x;
};
const normJob = (j: any): Job => ({
  id: s(j.id), customer: s(j.customer), target: s(j.target), price: s(j.price), state: j.state,
  created_ns: s(j.created_ns), sales: sn(j.sales), winner: sn(j.winner), reviewer: sn(j.reviewer),
  bids: (j.bids ?? []).map((b: any) => ({ agent: s(b.agent), price: s(b.price), ts_ns: s(b.ts_ns) })),
  deliverable_hash: hex32(j.deliverable_hash), uri: j.uri ?? null, attestation: j.attestation ?? null,
  attempts: Number(j.attempts ?? 0), deadline_ns: s(j.deadline_ns ?? '0'),
});
const normSpend = (x: any): SpendRequest => ({
  id: s(x.id), agent: s(x.agent), vendor: s(x.vendor), amount: s(x.amount), job: sn(x.job),
  state: x.state, reason: x.reason ?? '', memo: x.memo, ts_ns: x.ts_ns === undefined ? undefined : s(x.ts_ns),
});
const normByLaw = (c: any): ByLawParams => ({ ...c, text_hash: hex32(c.text_hash) as string });

/**
 * Real implementation over NEAR RPC. Views are plain JSON-RPC `call_function` (no key needed);
 * change calls are signed with near-api-js (loaded lazily). NOT exercised against a live network in
 * this repo's tests: see services/NOTES.md. View/arg names follow CONTRACT_SPEC 4.12 and must be
 * reconciled with contracts/bylaw/ABI.md.
 */
export class NearContractClient implements ContractClient {
  readonly accountId: string | null;
  private o: NearClientOptions;
  private account: any | null = null;

  constructor(o: NearClientOptions) {
    this.o = o;
    this.accountId = o.accountId ?? null;
  }

  private async view<T = any>(method: string, args: Record<string, unknown> = {}, contractId = this.o.contractId): Promise<T> {
    const r = await nearRpc<{ result: number[] }>(this.o.rpcUrl, 'query', {
      request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
  }

  private async signer(): Promise<any> {
    if (this.account) return this.account;
    if (!this.o.accountId || !this.o.privateKey) throw new Error('NearContractClient: signer account/key not configured');
    const { Account } = (await import('near-api-js')) as any;
    this.account = new Account(this.o.accountId, this.o.rpcUrl, this.o.privateKey);
    return this.account;
  }

  private async call<T = any>(method: string, args: Record<string, unknown>, contractId = this.o.contractId, deposit = 0n, gas?: bigint): Promise<T> {
    const acc = await this.signer();
    return (await acc.callFunction({ contractId, methodName: method, args, gas: gas ?? this.o.gas ?? 100_000_000_000_000n, deposit })) as T;
  }

  /** Like call() but returns every receipt log, so we can read NEP-297 events (e.g. the new job id). */
  private async callLogs(method: string, args: Record<string, unknown>, contractId: string, deposit: bigint, gas: bigint): Promise<string[]> {
    const acc = await this.signer();
    const r: any = await acc.callFunctionRaw({ contractId, methodName: method, args, gas, deposit });
    const failure = r?.status?.Failure;
    if (failure) throw new Error(`transaction failed: ${JSON.stringify(failure)}`);
    const outcomes = [r?.transaction_outcome, ...(r?.receipts_outcome ?? [])];
    return outcomes.flatMap((o: any) => (o?.outcome?.logs ?? []) as string[]);
  }

  /** Contract list views page by id (`from` = first id as a U64 string, ids start at 1, limit <= 100). */
  private async viewAllById(method: string, extra: Record<string, unknown> = {}): Promise<any[]> {
    const out: any[] = [];
    let from = 1n;
    for (;;) {
      const batch = await this.view<any[]>(method, { ...extra, from: from.toString(), limit: 100 });
      out.push(...batch);
      if (batch.length < 100) return out;
      from = BigInt(batch[batch.length - 1].id) + 1n;
    }
  }

  private h(h: string): unknown {
    const raw = h.startsWith('0x') ? h.slice(2) : h;
    return this.o.hashEncoding === 'bytes' ? [...Buffer.from(raw, 'hex')] : raw;
  }

  private async block(): Promise<{ height: number; ns: bigint }> {
    const b = await nearRpc<{ header: { height: number; timestamp_nanosec: string } }>(this.o.rpcUrl, 'block', { finality: 'final' });
    return { height: b.header.height, ns: BigInt(b.header.timestamp_nanosec) };
  }
  async nowNs() { return (await this.block()).ns; }
  async blockHeight() { return (await this.block()).height; }

  async getByLaw() { return normByLaw(await this.view('get_bylaw')); }
  async getGuardians() { return (await this.view<string[]>('get_guardians')).map(s); }
  async getAgent(id: string) { const a = await this.view('get_agent', { token_id: id }); return a ? normAgent(a) : null; }
  async listAgents() { return (await this.view<any[]>('list_agents')).map(normAgent); }
  async getJob(id: string) { const j = await this.view('get_job', { id }); return j ? normJob(j) : null; }
  /** Same semantics as FakeContract: optional state filter, then `from` is a 0-based OFFSET into that list. */
  async listJobs(o: JobListOpts = {}) {
    const all = (await this.viewAllById('list_jobs', o.state ? { state: o.state } : {})).map(normJob);
    const from = o.from ?? 0;
    return all.slice(from, from + (o.limit ?? 50));
  }
  async getSpend(id: string) { const x = await this.view('get_spend', { id }); return x ? normSpend(x) : null; }
  async listSpends() { return (await this.viewAllById('list_spends')).map(normSpend); }
  /** ABI-dependent: assumes `list_seats` returning Seat[]; see INTERFACES.md section 7 request. */
  async listSeats(): Promise<Seat[]> {
    const r = await this.view<any[]>('list_seats').catch(() => []);
    return r.map((x) => ({ token_id: s(x.token_id), owner: s(x.owner), weight: Number(x.weight), last_acc: s(x.last_acc ?? '0') }));
  }
  async claimableOf(account: string) { return s(await this.view('claimable_of', { account })); }
  /** Total budget for the current window (ABI returns {budget, win_spent, remaining, ...}). */
  async budgetOf(id: string) { return s((await this.view<any>('budget_of', { token_id: id })).budget); }
  async seatPending(id: string) { return s(await this.view('seat_pending', { token_id: id })); }
  async getStats(): Promise<Stats> {
    const x = await this.view<any>('get_stats');
    const f = (k: string): string => s(x[k] ?? '0');
    return {
      treasury: f('treasury'), escrow_total: f('escrow_total'), claimable_total: f('claimable_total'),
      pools_total: f('pools_total'), seat_pool: f('seat_pool'), total_in: f('total_in'), total_out: f('total_out'),
      jobs_total: Number(x.jobs_total ?? 0), jobs_settled: Number(x.jobs_settled ?? 0),
      agents_total: Number(x.agents_total ?? 0), seats_total: Number(x.seats_total ?? 0),
      total_seat_weight: f('total_seat_weight'),
    };
  }

  /** ft_transfer_call(post_job) on the token; the new job id comes from the `job_posted` event. null = refunded. */
  async postJob(target: string, amount: string): Promise<string | null> {
    const logs = await this.callLogs('ft_transfer_call', {
      receiver_id: this.o.contractId, amount, msg: JSON.stringify({ action: 'post_job', target }),
    }, this.o.tokenId, 1n, 150_000_000_000_000n);
    for (const ev of parseEvents(logs)) {
      if (ev.event === 'job_posted' && ev.data?.[0]?.job_id !== undefined) return s(ev.data[0].job_id);
    }
    return null;
  }
  async acceptJob(id: string) { await this.call('accept_job', { job: id }); }
  async awardJob(id: string) { await this.call('award_job', { job: id }); }
  async placeBid(id: string, price: string) { await this.call('place_bid', { job: id, price }); }
  async submitWork(id: string, hash: string, uri: string, attestation: string | null = null) {
    await this.call('submit_work', { job: id, hash: this.h(hash), uri, attestation });
  }
  async reviewWork(id: string, approve: boolean, reasonHash: string) {
    await this.call('review_work', { job: id, approve, reason_hash: this.h(reasonHash) });
  }
  async requestSpend(vendor: string, amount: string, job: string | null, memo: string) {
    return s(await this.call('request_spend', { vendor, amount, job, memo }));
  }
  async expireJob(id: string) { await this.call('expire_job', { job: id }); }
  /** Returns the amount claimed (same as the fake). The contract returns a bool; the amount comes from the `claimed` event (emitted only on success). */
  async claim() {
    const logs = await this.callLogs('claim', { token: this.o.tokenId }, this.o.contractId, 0n, 100_000_000_000_000n);
    let amount = 0n;
    for (const ev of parseEvents(logs)) if (ev.event === 'claimed') amount += BigInt(ev.data?.[0]?.amount ?? 0);
    return amount.toString();
  }
  async checkpointSeat(id: string) { await this.call('checkpoint_seat', { token_id: id }); }
  async freezeAgent(id: string, reason: string) { await this.call('freeze_agent', { token_id: id, reason }); }
}

/** Parse NEP-297 `EVENT_JSON:` logs of the `bylaw` standard. */
export function parseEvents(logs: string[]): { event: string; data: any[] }[] {
  const out: { event: string; data: any[] }[] = [];
  for (const l of logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(l.slice('EVENT_JSON:'.length));
      if (e?.standard === 'bylaw') out.push({ event: e.event, data: e.data ?? [] });
    } catch { /* ignore malformed logs */ }
  }
  return out;
}
