import { EventEmitter } from 'node:events';
import {
  computeWaterfall, scoreBid, listAllJobs,
} from '@bylaw/near-client';
import type { Agent, ByLawParams, ContractClient, Job, Seat, SpendRequest } from '@bylaw/near-client';
import { Db } from './db.ts';
import type { EventRow } from './db.ts';
import { lineDiff } from './textdiff.ts';

export interface IndexerConfig {
  contract_id: string;
  dao_id: string;
  token_id: string;
}

export interface Ping { type: string; id: string }

type AgentRow = Agent & { budget: string };
type SeatRow = Seat & { pending: string };
interface JobMeta { scores: Record<string, string> }

export const nsToIso = (ns: string | bigint | null | undefined): string | null => {
  if (ns === null || ns === undefined) return null;
  const n = BigInt(ns);
  if (n === 0n) return null;
  return new Date(Number(n / 1_000_000n)).toISOString();
};

/**
 * Poll-and-diff indexer. Reads contract views through a ContractClient, compares with the SQLite
 * snapshot, writes changes, derives events (idempotent via `ekey`) and emits pings for SSE.
 * Rebuildable: `reindex()` wipes chain-derived tables and re-polls (timeline is reconstructed from
 * job fields, so it survives a rebuild).
 */
export class Indexer {
  readonly db: Db;
  readonly client: ContractClient;
  readonly cfg: IndexerConfig;
  readonly bus = new EventEmitter();
  readonly heartbeats = new Map<string, { at: number; llm_ok: boolean | null }>();
  lastPollOkMs = 0;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(db: Db, client: ContractClient, cfg: IndexerConfig) {
    this.db = db; this.client = client; this.cfg = cfg;
    this.bus.setMaxListeners(200);
  }

  private ping(type: string, id: string): void { this.bus.emit('ping', { type, id } satisfies Ping); }
  private async nowNs(): Promise<string> { return (await this.client.nowNs()).toString(); }

  private event(type: string, id: string, jobId: string | null, ts: string, data: Record<string, unknown>, ekey: string | null): EventRow | null {
    const e = this.db.addEvent(type, id, jobId, ts, data, ekey);
    if (e) this.ping('event', jobId ?? id);
    return e;
  }

  /** One poll cycle. Safe to call concurrently (second call is skipped). */
  async poll(): Promise<{ changed: number }> {
    if (this.polling) return { changed: 0 };
    this.polling = true;
    let changed = 0;
    try {
      const now = await this.nowNs();
      const [height, bylaw, agents, jobs, spends, seats] = await Promise.all([
        this.client.blockHeight(), this.client.getByLaw(), this.client.listAgents(), listAllJobs(this.client),
        this.client.listSpends(), this.client.listSeats(),
      ]);
      const repById = new Map(agents.map((a) => [a.token_id, a.rep]));
      changed += this.diffByLaw(bylaw, now);
      changed += await this.diffAgents(agents, now);
      changed += this.diffJobs(jobs, repById, bylaw, seats, now);
      changed += this.diffSpends(spends, now);
      changed += await this.diffSeats(seats, now);
      this.db.setCursor('height', String(height));
      this.lastPollOkMs = Date.now();
      this.lastError = null;
      if (changed > 0) this.ping('stats', 'all');
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.polling = false;
    }
    return { changed };
  }

  private diffByLaw(c: ByLawParams, now: string): number {
    const known = this.db.bylaws();
    if (known.some((k) => k.version === c.version && JSON.parse(k.json).text_hash === c.text_hash)) return 0;
    const prev = known.length ? (JSON.parse(known[known.length - 1].json) as ByLawParams) : null;
    this.db.putByLaw(c.version, JSON.stringify(c), now);
    if (prev) this.event('bylaw_updated', String(c.version), null, now, { version: c.version, old_hash: prev.text_hash, new_hash: c.text_hash }, `bylaw:${c.version}`);
    this.ping('bylaw', String(c.version));
    return 1;
  }

  private async diffAgents(agents: Agent[], now: string): Promise<number> {
    let n = 0;
    for (const a of agents) {
      const budget = await this.client.budgetOf(a.token_id).catch(() => '0');
      const row: AgentRow = { ...a, budget };
      const json = JSON.stringify(row);
      const prevJson = this.db.rawJson('agents', a.token_id);
      if (prevJson === json) continue;
      n++;
      this.db.putJson('agents', a.token_id, json);
      this.ping('agent', a.token_id);
      const prev = prevJson ? (JSON.parse(prevJson) as AgentRow) : null;
      if (!prev) {
        this.event('agent_registered', a.token_id, null, now, { token_id: a.token_id, account: a.account, kind: a.kind, owner: a.owner }, `agent:${a.token_id}:registered`);
        continue;
      }
      if (prev.state !== a.state) {
        const t = a.state === 'Frozen' ? 'agent_frozen' : a.state === 'Retired' ? 'agent_retired' : 'agent_unfrozen';
        this.event(t, a.token_id, null, now, { token_id: a.token_id, from: prev.state, to: a.state }, null);
      }
      if (prev.rep !== a.rep) this.event('rep_changed', a.token_id, null, now, { token_id: a.token_id, old: prev.rep, new: a.rep }, null);
    }
    return n;
  }

  private diffJobs(jobs: Job[], repById: Map<string, number>, bylaw: ByLawParams, seats: Seat[], now: string): number {
    let n = 0;
    const totalWeight = seats.reduce((s, x) => s + BigInt(x.weight), 0n);
    for (const j of jobs) {
      const json = JSON.stringify(j);
      const prev = this.db.getJob(j.id);
      if (prev && prev.json === json) continue;
      n++;
      const meta: JobMeta = prev ? (JSON.parse(prev.meta) as JobMeta) : { scores: {} };
      for (const b of j.bids) {
        if (meta.scores[b.agent] === undefined) meta.scores[b.agent] = scoreBid(b.price, repById.get(b.agent) ?? 0).toString();
      }
      this.db.putJob(j.id, j.state, j.customer, json, JSON.stringify(meta));
      this.ping('job', j.id);
      this.jobMilestones(j, bylaw, totalWeight, now);
    }
    return n;
  }

  /** Idempotent, order-stable event derivation from a job snapshot. */
  private jobMilestones(j: Job, bylaw: ByLawParams, totalWeight: bigint, now: string): void {
    const k = (s: string) => `job:${j.id}:${s}`;
    const ev = (type: string, ts: string, data: Record<string, unknown>, key: string) =>
      this.event(type, j.id, j.id, ts, { job_id: j.id, ...data }, k(key));
    ev('job_posted', j.created_ns, { customer: j.customer, target: j.target, price: j.price }, 'posted');
    if (j.sales !== null) ev('job_opened', now, { sales_token_id: j.sales }, 'opened');
    for (const b of j.bids) ev('bid_placed', b.ts_ns, { agent: b.agent, price: b.price }, `bid:${b.agent}`);
    if (j.attempts >= 1) ev('work_reviewed', now, { approve: false, inferred: true, attempt: j.attempts }, `attempt_failed:${j.attempts}`);
    if (j.winner !== null && j.reviewer !== null) {
      ev('job_awarded', now, { winner: j.winner, reviewer: j.reviewer, deadline_ns: j.deadline_ns, attempt: j.attempts }, `awarded:${j.attempts}`);
    }
    if (j.deliverable_hash) ev('work_submitted', now, { deliverable_hash: j.deliverable_hash, uri: j.uri, attestation: j.attestation }, `submitted:${j.deliverable_hash}`);
    if (j.state === 'Settled' || j.state === 'Accepted') {
      ev('work_reviewed', now, { approve: true, reviewer: j.reviewer }, 'reviewed:approve');
      const w = computeWaterfall(BigInt(j.price), bylaw.split, totalWeight);
      ev('job_settled', now, {
        price: j.price,
        credits: { reviewer: String(w.reviewer), producer: String(w.producer), sales: String(w.sales), seats: String(w.seats), treasury: String(w.treasury) },
        credits_derived_from_bylaw_version: bylaw.version,
      }, 'settled');
    }
    if (j.state === 'Refunded') ev('job_refunded', now, {}, 'refunded');
    if (j.state === 'Expired') ev('job_expired', now, {}, 'expired');
  }

  private diffSpends(spends: SpendRequest[], now: string): number {
    let n = 0;
    for (const s of spends) {
      const json = JSON.stringify(s);
      const prevJson = this.db.rawJson('spends', s.id);
      if (prevJson === json) continue;
      n++;
      this.db.putJson('spends', s.id, json);
      this.ping('spend', s.id);
      const outcome = s.state === 'Rejected' ? `Rejected:${s.reason}` : s.state === 'Paid' ? 'Paid' : s.state;
      const ts = s.ts_ns ?? now;
      if (!prevJson) {
        // first sight: record the original attempt (a Pending that was later approved is seen as Paid; acceptable)
        this.event('spend_recorded', s.id, s.job, ts, { request_id: s.id, agent: s.agent, vendor: s.vendor, amount: s.amount, outcome }, `spend:${s.id}:recorded`);
        if (s.state === 'Paid') this.event('spend_paid', s.id, s.job, ts, { request_id: s.id }, `spend:${s.id}:paid`);
      } else {
        const prev = JSON.parse(prevJson) as SpendRequest;
        if (prev.state === 'Pending' && s.state === 'Paid') {
          this.event('spend_approved', s.id, s.job, now, { request_id: s.id }, `spend:${s.id}:approved`);
          this.event('spend_paid', s.id, s.job, now, { request_id: s.id }, `spend:${s.id}:paid`);
        }
      }
    }
    return n;
  }

  private async diffSeats(seats: Seat[], now: string): Promise<number> {
    let n = 0;
    for (const s of seats) {
      const pending = await this.client.seatPending(s.token_id).catch(() => '0');
      const row: SeatRow = { ...s, pending };
      const json = JSON.stringify(row);
      const prevJson = this.db.rawJson('seats', s.token_id);
      if (prevJson === json) continue;
      n++;
      this.db.putJson('seats', s.token_id, json);
      this.ping('seat', s.token_id);
      if (!prevJson) this.event('seat_minted', s.token_id, null, now, { token_id: s.token_id, owner: s.owner, weight: s.weight }, `seat:${s.token_id}:minted`);
    }
    return n;
  }

  /** Wipe chain-derived data and rebuild from the contract. Artifacts are kept (off-chain, hash-addressed). */
  async reindex(): Promise<{ jobs: number; agents: number; events: number }> {
    this.db.wipeChainData();
    await this.poll();
    return {
      jobs: this.db.listJobs().length,
      agents: this.db.allJson('agents').length,
      events: this.db.recentEvents(100000).length,
    };
  }

  start(intervalMs: number, onError: (e: unknown) => void): void {
    const run = () => { this.poll().catch(onError); };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ---------- read models ----------
  agentView(a: AgentRow) {
    const earnings = this.earningsFor(a);
    return {
      token_id: a.token_id, account: a.account, kind: a.kind, state: a.state, owner: a.owner,
      rep: a.rep, delivered: a.delivered, rejected: a.rejected,
      budget: a.budget, win_spent: a.win_spent, win_start_ns: a.win_start_ns, win_start_iso: nsToIso(a.win_start_ns),
      budget_remaining: (BigInt(a.budget) > BigInt(a.win_spent) ? BigInt(a.budget) - BigInt(a.win_spent) : 0n).toString(),
      earnings,
    };
  }

  private earningsFor(a: Agent): { total: string; by_role: Record<string, string>; settled_jobs: number } {
    const bylaw = this.currentByLaw();
    const totalWeight = this.db.allJson<SeatRow>('seats').reduce((s, x) => s + BigInt(x.weight), 0n);
    const by: Record<string, bigint> = { producer: 0n, reviewer: 0n, sales: 0n };
    let cnt = 0;
    if (bylaw) {
      for (const r of this.db.listJobs('Settled')) {
        const j = JSON.parse(r.json) as Job;
        const w = computeWaterfall(BigInt(j.price), bylaw.split, totalWeight);
        let hit = false;
        if (j.winner === a.token_id) { by.producer += w.producer; hit = true; }
        if (j.reviewer === a.token_id) { by.reviewer += w.reviewer; hit = true; }
        if (j.sales === a.token_id) { by.sales += w.sales; hit = true; }
        if (hit) cnt++;
      }
    }
    const total = by.producer + by.reviewer + by.sales;
    return {
      total: total.toString(),
      by_role: { producer: by.producer.toString(), reviewer: by.reviewer.toString(), sales: by.sales.toString() },
      settled_jobs: cnt,
    };
  }

  currentByLaw(): ByLawParams | null {
    const c = this.db.bylaws();
    return c.length ? (JSON.parse(c[c.length - 1].json) as ByLawParams) : null;
  }

  jobView(row: { json: string; meta: string }) {
    const j = JSON.parse(row.json) as Job;
    const meta = JSON.parse(row.meta) as JobMeta;
    const bylaw = this.currentByLaw();
    const agents = new Map(this.db.allJson<AgentRow>('agents').map((a) => [a.token_id, a]));
    const bids = j.bids.map((b) => ({
      agent: b.agent, agent_account: agents.get(b.agent)?.account ?? null, price: b.price, ts_ns: b.ts_ns, ts_iso: nsToIso(b.ts_ns),
      score: meta.scores[b.agent] ?? null, is_winner: j.winner === b.agent,
    }));
    const totalWeight = this.db.allJson<SeatRow>('seats').reduce((s, x) => s + BigInt(x.weight), 0n);
    let waterfall: Record<string, string> | null = null;
    if (bylaw && (j.state === 'Settled' || j.state === 'Accepted')) {
      const w = computeWaterfall(BigInt(j.price), bylaw.split, totalWeight);
      waterfall = { reviewer: String(w.reviewer), producer: String(w.producer), sales: String(w.sales), seats: String(w.seats), treasury: String(w.treasury) };
    }
    return {
      id: j.id, customer: j.customer, target: j.target, price: j.price, state: j.state,
      created_ns: j.created_ns, created_iso: nsToIso(j.created_ns),
      deadline_ns: j.deadline_ns, deadline_iso: nsToIso(j.deadline_ns),
      sales: j.sales, bids, winner: j.winner, winner_account: j.winner ? agents.get(j.winner)?.account ?? null : null,
      reviewer: j.reviewer, reviewer_account: j.reviewer ? agents.get(j.reviewer)?.account ?? null : null,
      attempts: j.attempts,
      deliverable: j.deliverable_hash ? { hash: j.deliverable_hash, uri: j.uri, attestation: j.attestation } : null,
      waterfall,
    };
  }

  timeline(jobId: string) {
    return this.db.events(jobId).map((e) => ({ seq: e.seq, type: e.type, ts_ns: e.ts_ns, ts_iso: nsToIso(e.ts_ns), data: e.data }));
  }

  bylawHistory() {
    const rows = this.db.bylaws().map((r) => ({ ...(JSON.parse(r.json) as ByLawParams), seen_ns: r.seen_ns }));
    return rows.map((c, i) => ({
      version: c.version, text_hash: c.text_hash, text: c.text, params: stripText(c), first_seen_iso: nsToIso(c.seen_ns),
      diff: i === 0 ? [] : lineDiff(rows[i - 1].text, c.text),
    }));
  }

  async stats() {
    const s = await this.client.getStats();
    const lhs = BigInt(s.treasury) + BigInt(s.escrow_total) + BigInt(s.claimable_total) + BigInt(s.pools_total) + BigInt(s.seat_pool);
    const rhs = BigInt(s.total_in) - BigInt(s.total_out);
    const jobs = this.db.listJobs().map((r) => (JSON.parse(r.json) as Job).state);
    const by_state: Record<string, number> = {};
    for (const st of jobs) by_state[st] = (by_state[st] ?? 0) + 1;
    const spends = this.db.allJson<SpendRequest>('spends');
    return {
      ...s,
      solvency: { ok: lhs === rhs, accounted: lhs.toString(), expected: rhs.toString() },
      jobs_by_state: by_state,
      spends: { total: spends.length, rejected: spends.filter((x) => x.state === 'Rejected').length, paid: spends.filter((x) => x.state === 'Paid').length },
    };
  }

  health(aliveTtlMs = 30_000) {
    const now = Date.now();
    const alive = [...this.heartbeats.entries()].filter(([, v]) => now - v.at <= aliveTtlMs);
    const llm = alive.map(([, v]) => v.llm_ok).filter((x): x is boolean => x !== null);
    return {
      near_height: Number(this.db.cursor('height') ?? 0),
      indexer_lag_s: this.lastPollOkMs ? Math.round((now - this.lastPollOkMs) / 100) / 10 : null,
      agents_alive: alive.map(([name]) => name).sort(),
      llm_ok: llm.length ? llm.every(Boolean) : null,
      last_error: this.lastError,
    };
  }
}

function stripText(c: ByLawParams): Omit<ByLawParams, 'text'> {
  const { text: _t, ...rest } = c;
  return rest;
}

export type { Seat };
