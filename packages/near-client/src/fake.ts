import { sha256Hex } from './canonical.ts';
import type { ContractClient } from './client.ts';
import { ACC_SCALE, budgetFor, computeWaterfall, maxBidFor, pickReviewer, pickWinner, validateSplit } from './rules.ts';
import type {
  Agent, Bid, CharterParams, ContractEvent, Job, JobListOpts, JobState, Kind, Seat, SpendRequest, Stats,
} from './types.ts';

export class ContractError extends Error {
  constructor(message: string) { super(message); this.name = 'ContractError'; }
}
function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ContractError(msg);
}
const B = (x: string | bigint | number): bigint => BigInt(x);

export class ManualClock {
  ns: bigint;
  constructor(startMs = Date.UTC(2026, 10, 11, 12, 0, 0)) { this.ns = BigInt(startMs) * 1_000_000n; }
  now = (): bigint => this.ns;
  advanceSec(s: number): void { this.ns += BigInt(Math.round(s * 1000)) * 1_000_000n; }
}

const SEC = 1_000_000_000n;
export function defaultParams(): CharterParams {
  const text = 'Charter v1: agents act only inside budgets; a different owner reviews every deliverable; the DAO may override.';
  return {
    version: 1, text, text_hash: sha256Hex(text),
    min_price: '10000000', max_price: '1000000000',
    bid_window_ns: String(60n * SEC), submit_window_ns: String(600n * SEC), review_window_ns: String(600n * SEC),
    max_bid_bps: 9000,
    split: { reviewer: 800, producer: 5500, sales: 700, seats: 1500, treasury: 1500 },
    rep_start: 100, rep_gain: 10, rep_loss: 20, rep_expire_loss: 10, rep_freeze_below: 50,
    base_budget: '5000000', per_rep_budget: '1000000', max_budget: '50000000', budget_window_ns: String(86400n * SEC),
    per_tx_cap: '10000000', approval_threshold: '5000000',
  };
}

export interface FakeOptions {
  clock?: () => bigint;
  params?: Partial<CharterParams>;
  guardians?: string[];
}

const POSTED_MAX_AGE_NS = 24n * 3600n * SEC;

/**
 * In-memory simulation of the charter contract rules (CONTRACT_SPEC 4). Faithful for the job state
 * machine, bids/scoring, waterfall, budgets/reputation, spends (denials recorded, never panicking),
 * seats, claims and the solvency invariant. Panics throw ContractError. Pools are out of scope (T3).
 */
export class FakeContract {
  readonly contractId = 'charter.fake.testnet';
  readonly tokenId = 'tusd.fake.testnet';
  readonly ownerId = 'dao.fake.testnet';
  readonly events: ContractEvent[] = [];
  params: CharterParams;
  guardians: string[];
  paused = false;
  private clock: () => bigint;
  private height = 1000;
  private nextToken = 1;
  private nextJob = 1;
  private nextSpend = 1;
  private agents = new Map<string, Agent>();
  private seats = new Map<string, Seat>();
  private jobs = new Map<string, Job>();
  private spends = new Map<string, SpendRequest>();
  private rejectedWinners = new Map<string, Set<string>>();
  private vendors = new Set<string>();
  private claimable = new Map<string, bigint>();
  private escrow = new Map<string, bigint>();
  private treasury = 0n;
  private seatPool = 0n;
  private acc = 0n;
  private totalIn = 0n;
  private totalOut = 0n;
  private history: CharterParams[] = [];

  constructor(opts: FakeOptions = {}) {
    this.clock = opts.clock ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.params = { ...defaultParams(), ...(opts.params ?? {}) };
    this.guardians = opts.guardians ?? ['guardian.fake.testnet'];
    this.history.push(structuredClone(this.params));
  }

  // ---------- plumbing ----------
  private emit(event: string, data: Record<string, unknown>): void {
    this.events.push({ standard: 'charter', version: '1.0.0', event, data: [data] });
  }
  private tick(): void { this.height += 1; }
  private now(): bigint { return this.clock(); }
  private findAgent(account: string, kind: Kind): Agent {
    const a = [...this.agents.values()].find((x) => x.account === account);
    req(a, `no agent for ${account}`);
    req(a.kind === kind, `wrong kind: ${account} is ${a.kind}, need ${kind}`);
    return a;
  }
  private activeAgent(account: string, kind: Kind): Agent {
    const a = this.findAgent(account, kind);
    req(a.state === 'Active', `agent ${a.token_id} is ${a.state}`);
    return a;
  }
  private getJobOrPanic(id: string): Job {
    const j = this.jobs.get(id);
    req(j, `no such job ${id}`);
    return j;
  }
  private credit(account: string, amount: bigint): void {
    if (amount > 0n) this.claimable.set(account, (this.claimable.get(account) ?? 0n) + amount);
  }
  private changeRep(a: Agent, delta: number, cause: string): void {
    const old = a.rep;
    a.rep = Math.max(0, a.rep + delta);
    this.emit('rep_changed', { token_id: a.token_id, old, new: a.rep, cause });
    if (a.rep < this.params.rep_freeze_below && a.state === 'Active') {
      a.state = 'Frozen';
      this.emit('agent_frozen', { token_id: a.token_id, by: this.contractId, reason: 'rep_below_threshold' });
    }
  }
  private rollWindow(a: Agent): void {
    const now = this.now();
    if (a.win_start_ns === '0' || now - B(a.win_start_ns) >= B(this.params.budget_window_ns)) {
      a.win_start_ns = now.toString();
      a.win_spent = '0';
    }
  }
  private sum(m: Map<string, bigint>): bigint { let s = 0n; for (const v of m.values()) s += v; return s; }

  /** Solvency invariant C2: sum(claimable)+sum(escrow)+treasury+seat_pool == total_in - total_out. */
  checkSolvency(): { ok: boolean; lhs: bigint; rhs: bigint } {
    const lhs = this.sum(this.claimable) + this.sum(this.escrow) + this.treasury + this.seatPool;
    const rhs = this.totalIn - this.totalOut;
    return { ok: lhs === rhs, lhs, rhs };
  }

  // ---------- owner / admin (DAO) ----------
  registerAgent(kind: Kind, name: string, owner: string, account?: string): Agent {
    const token_id = String(this.nextToken++);
    const a: Agent = {
      token_id, account: account ?? `${name}.${this.contractId}`, owner, kind, state: 'Active',
      rep: this.params.rep_start, delivered: 0, rejected: 0, win_start_ns: '0', win_spent: '0',
    };
    this.agents.set(token_id, a);
    this.emit('agent_registered', { token_id, account: a.account, kind, owner });
    this.tick();
    return structuredClone(a);
  }
  setCharter(next: Partial<CharterParams>): CharterParams {
    const merged: CharterParams = { ...this.params, ...next };
    if (next.text !== undefined) merged.text_hash = sha256Hex(next.text);
    req(validateSplit(merged.split), 'split must sum to 10000');
    req(merged.text.length <= 8192, 'text too long');
    const old_hash = this.params.text_hash;
    merged.version = this.params.version + 1;
    this.params = merged;
    this.history.push(structuredClone(merged));
    this.emit('charter_updated', { version: merged.version, old_hash, new_hash: merged.text_hash });
    this.tick();
    return structuredClone(merged);
  }
  setVendor(vendor: string, allowed: boolean): void { if (allowed) this.vendors.add(vendor); else this.vendors.delete(vendor); }
  setGuardians(g: string[]): void { this.guardians = g; }
  setPaused(p: boolean): void { this.paused = p; }
  unfreezeAgent(tokenId: string): void {
    const a = this.agents.get(tokenId);
    req(a, 'no such agent');
    req(a.state === 'Frozen', 'not frozen');
    a.state = 'Active';
    this.emit('agent_unfrozen', { token_id: tokenId, by: this.ownerId });
  }
  retireAgent(tokenId: string): void {
    const a = this.agents.get(tokenId);
    req(a, 'no such agent');
    a.state = 'Retired';
    this.emit('agent_retired', { token_id: tokenId, by: this.ownerId });
  }
  /** Treasury funding (ft_on_transfer fund_treasury). */
  fundTreasury(amount: string | bigint): void {
    this.treasury += B(amount); this.totalIn += B(amount); this.tick();
  }
  mintSeat(owner: string, weight: number): Seat {
    req(weight > 0, 'weight must be positive');
    const token_id = String(this.nextToken++);
    const s: Seat = { token_id, owner, weight, last_acc: this.acc.toString() };
    this.seats.set(token_id, s);
    this.emit('seat_minted', { token_id, owner, weight });
    return structuredClone(s);
  }
  /** NEP-171 seat transfer; checkpoints pending dividends to the old owner first. */
  transferSeat(tokenId: string, newOwner: string): void {
    this.doCheckpoint(tokenId);
    const s = this.seats.get(tokenId);
    req(s, 'no such seat');
    s.owner = newOwner;
  }
  approveSpend(id: string): void {
    const sp = this.spends.get(id);
    req(sp, 'no such spend');
    req(sp.state === 'Pending', 'spend not pending');
    const amt = B(sp.amount);
    if (this.treasury < amt) { sp.state = 'Rejected'; sp.reason = 'treasury_insufficient'; return; }
    const a = this.agents.get(sp.agent)!;
    this.rollWindow(a);
    a.win_spent = (B(a.win_spent) + amt).toString();
    this.treasury -= amt; this.totalOut += amt; sp.state = 'Paid'; sp.reason = '';
    this.emit('spend_approved', { request_id: id });
    this.emit('spend_paid', { request_id: id });
  }
  rejectSpend(id: string): void {
    const sp = this.spends.get(id);
    req(sp, 'no such spend');
    req(sp.state === 'Pending', 'spend not pending');
    sp.state = 'Rejected'; sp.reason = 'dao_rejected';
  }
  overrideReview(jobId: string, approve: boolean): void {
    const j = this.getJobOrPanic(jobId);
    req(j.state === 'Submitted', 'job not Submitted');
    this.emit('review_overridden', { job_id: jobId, approve });
    if (approve) this.approve(j); else this.reject(j);
    this.tick();
  }
  charterHistory(): CharterParams[] { return structuredClone(this.history); }

  // ---------- change methods (caller = predecessor) ----------
  private doFreeze(by: string, tokenId: string, reason: string): void {
    req(by === this.ownerId || this.guardians.includes(by), 'only guardians or owner may freeze');
    const a = this.agents.get(tokenId);
    req(a, 'no such agent');
    a.state = 'Frozen';
    this.emit('agent_frozen', { token_id: tokenId, by, reason });
    this.tick();
  }
  private doPostJob(sender: string, target: string, amount: bigint): string | null {
    // ft_on_transfer(post_job); out-of-band amounts are returned (no job).
    if (this.paused || amount < B(this.params.min_price) || amount > B(this.params.max_price)) return null;
    const id = String(this.nextJob++);
    this.totalIn += amount;
    this.escrow.set(id, amount);
    this.jobs.set(id, {
      id, customer: sender, target, price: amount.toString(), state: 'Posted', created_ns: this.now().toString(),
      sales: null, bids: [], winner: null, reviewer: null, deliverable_hash: null, uri: null, attestation: null,
      attempts: 0, deadline_ns: '0',
    });
    this.emit('job_posted', { job_id: id, customer: sender, target, price: amount.toString() });
    this.tick();
    return id;
  }
  private doAccept(caller: string, jobId: string): void {
    const s = this.activeAgent(caller, 'Sales');
    const j = this.getJobOrPanic(jobId);
    req(!this.paused, 'paused');
    req(j.state === 'Posted', `job ${jobId} is ${j.state}, need Posted`);
    j.state = 'Open'; j.sales = s.token_id;
    j.deadline_ns = (this.now() + B(this.params.bid_window_ns)).toString();
    this.emit('job_opened', { job_id: jobId, sales_token_id: s.token_id, bid_deadline_ns: j.deadline_ns });
    this.tick();
  }
  private doBid(caller: string, jobId: string, price: bigint): void {
    const a = this.activeAgent(caller, 'Analyst');
    const j = this.getJobOrPanic(jobId);
    req(j.state === 'Open', `job ${jobId} is ${j.state}, need Open`);
    req(this.now() < B(j.deadline_ns), 'bid window closed');
    req(price > 0n && price <= maxBidFor(this.params, j.price), 'bid above max_bid_bps cap');
    req(!j.bids.some((b) => b.agent === a.token_id), 'one bid per agent');
    req(j.bids.length < 16, 'too many bids');
    j.bids.push({ agent: a.token_id, price: price.toString(), ts_ns: this.now().toString() });
    this.emit('bid_placed', { job_id: jobId, agent: a.token_id, price: price.toString() });
    this.tick();
  }
  private repOf = (id: string): number => this.agents.get(id)?.rep ?? 0;
  private assign(j: Job, winner: Bid): void {
    const wa = this.agents.get(winner.agent)!;
    const reviewer = pickReviewer(j.id, [...this.agents.values()].filter((a) => a.kind === 'Reviewer'), wa.owner);
    req(reviewer, 'no eligible reviewer (owner conflict)');
    j.winner = wa.token_id; j.reviewer = reviewer.token_id; j.state = 'Awarded';
    j.deadline_ns = (this.now() + B(this.params.submit_window_ns)).toString();
    j.deliverable_hash = null; j.uri = null; j.attestation = null;
    this.emit('job_awarded', { job_id: j.id, winner: wa.token_id, reviewer: reviewer.token_id, deadline_ns: j.deadline_ns });
  }
  private doAward(caller: string, jobId: string): void {
    this.activeAgent(caller, 'Sales');
    const j = this.getJobOrPanic(jobId);
    req(j.state === 'Open', `job ${jobId} is ${j.state}, need Open`);
    req(this.now() >= B(j.deadline_ns), 'bid window still open');
    const w = pickWinner(j.bids, this.repOf);
    if (!w) this.refund(j, 'no_bids');
    else this.assign(j, w);
    this.tick();
  }
  private doSubmit(caller: string, jobId: string, hash: string, uri: string, attestation: string | null): void {
    const a = this.activeAgent(caller, 'Analyst');
    const j = this.getJobOrPanic(jobId);
    req(j.winner === a.token_id, 'only the winner may submit');
    req(j.state === 'Awarded', `job ${jobId} is ${j.state}, need Awarded`);
    req(this.now() <= B(j.deadline_ns), 'submit deadline passed');
    req(/^0x[0-9a-f]{64}$/.test(hash), 'bad deliverable hash');
    j.deliverable_hash = hash; j.uri = uri; j.attestation = attestation; j.state = 'Submitted';
    j.deadline_ns = (this.now() + B(this.params.review_window_ns)).toString();
    this.emit('work_submitted', { job_id: jobId, deliverable_hash: hash, uri, attestation });
    this.tick();
  }
  private doReview(caller: string, jobId: string, approve: boolean, reasonHash: string): void {
    const r = this.activeAgent(caller, 'Reviewer');
    const j = this.getJobOrPanic(jobId);
    req(j.reviewer === r.token_id, 'not the assigned reviewer');
    req(j.state === 'Submitted', `job ${jobId} is ${j.state}, need Submitted`);
    const w = this.agents.get(j.winner!)!;
    req(w.owner !== r.owner, 'reviewer owner conflict');
    this.emit('work_reviewed', { job_id: jobId, reviewer: r.token_id, approve, reason_hash: reasonHash });
    if (approve) this.approve(j); else this.reject(j);
    this.tick();
  }
  private approve(j: Job): void {
    j.state = 'Accepted';
    const w = this.agents.get(j.winner!)!;
    const wf = this.settle(j);
    j.state = 'Settled';
    w.delivered += 1;
    this.changeRep(w, this.params.rep_gain, 'delivered');
    this.emit('job_settled', {
      job_id: j.id, price: j.price,
      credits: {
        reviewer: wf.reviewer.toString(), producer: wf.producer.toString(), sales: wf.sales.toString(),
        seats: wf.seats.toString(), treasury: wf.treasury.toString(),
      },
    });
  }
  private settle(j: Job) {
    const price = B(j.price);
    const totalWeight = [...this.seats.values()].reduce((s, x) => s + B(x.weight), 0n);
    const wf = computeWaterfall(price, this.params.split, totalWeight);
    this.credit(this.agents.get(j.reviewer!)!.owner, wf.reviewer);
    this.credit(this.agents.get(j.winner!)!.owner, wf.producer);
    this.credit(this.agents.get(j.sales!)!.owner, wf.sales);
    this.acc += wf.acc_delta;
    this.seatPool += wf.seats;
    this.treasury += wf.treasury;
    this.escrow.set(j.id, 0n);
    return wf;
  }
  private reject(j: Job): void {
    const w = this.agents.get(j.winner!)!;
    w.rejected += 1;
    this.changeRep(w, -this.params.rep_loss, 'rejected');
    this.reopenOrRefund(j, w.token_id, 'rejected');
  }
  private reopenOrRefund(j: Job, loserId: string, why: string): void {
    const ex = this.rejectedWinners.get(j.id) ?? new Set<string>();
    ex.add(loserId);
    this.rejectedWinners.set(j.id, ex);
    if (j.attempts === 0) {
      const next = pickWinner(j.bids, this.repOf, ex);
      if (next) { j.attempts += 1; this.assign(j, next); return; }
    }
    this.refund(j, why);
  }
  private refund(j: Job, reason: string): void {
    const amt = this.escrow.get(j.id) ?? 0n;
    this.escrow.set(j.id, 0n);
    this.credit(j.customer, amt);
    j.state = 'Refunded';
    this.emit('job_refunded', { job_id: j.id, reason });
  }
  private doExpire(jobId: string): 'refunded' | 'reopened' | 'escalated' {
    const j = this.getJobOrPanic(jobId);
    const now = this.now();
    let out: 'refunded' | 'reopened' | 'escalated';
    if (j.state === 'Posted' && now - B(j.created_ns) > POSTED_MAX_AGE_NS) {
      this.refund(j, 'posted_expired'); out = 'refunded';
    } else if (j.state === 'Awarded' && now > B(j.deadline_ns)) {
      const w = this.agents.get(j.winner!)!;
      this.changeRep(w, -this.params.rep_expire_loss, 'expired');
      this.emit('job_expired', { job_id: jobId, reason: 'submit_deadline' });
      this.reopenOrRefund(j, w.token_id, 'expired');
      out = (j.state as JobState) === 'Refunded' ? 'refunded' : 'reopened';
    } else if (j.state === 'Submitted' && now > B(j.deadline_ns)) {
      this.emit('job_expired', { job_id: jobId, reason: 'review_timeout_escalated_to_dao' });
      out = 'escalated';
    } else {
      throw new ContractError(`job ${jobId} is not expirable in state ${j.state}`);
    }
    this.tick();
    return out;
  }
  private doSpend(caller: string, vendor: string, amount: bigint, job: string | null, memo: string): string {
    const a = this.findAgent(caller, 'Treasurer'); // frozen agents get a recorded denial, not a panic
    const id = String(this.nextSpend++);
    const sp: SpendRequest = {
      id, agent: a.token_id, vendor, amount: amount.toString(), job, state: 'Rejected', reason: '', memo,
      ts_ns: this.now().toString(),
    };
    this.spends.set(id, sp);
    this.tick();
    const deny = (reason: string): string => {
      sp.state = 'Rejected'; sp.reason = reason;
      this.emit('spend_recorded', { request_id: id, agent: a.token_id, vendor, amount: amount.toString(), outcome: `Rejected:${reason}` });
      return id;
    };
    if (a.state !== 'Active') return deny('agent_not_active');
    if (this.paused) return deny('paused');
    if (!this.vendors.has(vendor)) return deny('vendor_not_allowlisted');
    if (amount > B(this.params.per_tx_cap)) return deny('per_tx_cap_exceeded');
    this.rollWindow(a);
    if (B(a.win_spent) + amount > budgetFor(this.params, a.rep)) return deny('budget_exceeded');
    if (this.treasury < amount) return deny('treasury_insufficient');
    if (amount >= B(this.params.approval_threshold)) {
      sp.state = 'Pending'; sp.reason = 'awaiting_dao_approval';
      this.emit('spend_recorded', { request_id: id, agent: a.token_id, vendor, amount: amount.toString(), outcome: 'Pending' });
      return id;
    }
    a.win_spent = (B(a.win_spent) + amount).toString();
    this.treasury -= amount; this.totalOut += amount; sp.state = 'Paid';
    this.emit('spend_recorded', { request_id: id, agent: a.token_id, vendor, amount: amount.toString(), outcome: 'Paid' });
    this.emit('spend_paid', { request_id: id });
    return id;
  }
  private doClaim(caller: string): string {
    const amt = this.claimable.get(caller) ?? 0n;
    req(amt > 0n, 'nothing to claim');
    this.claimable.set(caller, 0n);
    this.totalOut += amt;
    this.emit('claimed', { account: caller, amount: amt.toString() });
    this.tick();
    return amt.toString();
  }
  private pendingOf(tokenId: string): bigint {
    const s = this.seats.get(tokenId);
    req(s, 'no such seat');
    return (B(s.weight) * (this.acc - B(s.last_acc))) / ACC_SCALE;
  }
  private doCheckpoint(tokenId: string): void {
    const s = this.seats.get(tokenId);
    req(s, 'no such seat');
    const p = this.pendingOf(tokenId);
    this.credit(s.owner, p);
    this.seatPool -= p;
    s.last_acc = this.acc.toString();
  }

  // ---------- views ----------
  private statsView(): Stats {
    const seats = [...this.seats.values()];
    return {
      treasury: this.treasury.toString(),
      escrow_total: this.sum(this.escrow).toString(),
      claimable_total: this.sum(this.claimable).toString(),
      pools_total: '0',
      seat_pool: this.seatPool.toString(),
      total_in: this.totalIn.toString(),
      total_out: this.totalOut.toString(),
      jobs_total: this.jobs.size,
      jobs_settled: [...this.jobs.values()].filter((j) => j.state === 'Settled').length,
      agents_total: this.agents.size,
      seats_total: seats.length,
      total_seat_weight: seats.reduce((s, x) => s + B(x.weight), 0n).toString(),
    };
  }

  /** A signer-bound client. `account` null => read-only. */
  as(account: string | null): ContractClient {
    const f = this;
    const need = (): string => { req(account, 'no signer'); return account; };
    return {
      accountId: account,
      nowNs: async () => f.now(),
      blockHeight: async () => f.height,
      getCharter: async () => structuredClone(f.params),
      getGuardians: async () => [...f.guardians],
      getAgent: async (id) => structuredClone(f.agents.get(id) ?? null),
      listAgents: async () => structuredClone([...f.agents.values()]),
      getJob: async (id) => structuredClone(f.jobs.get(id) ?? null),
      listJobs: async (o: JobListOpts = {}) => {
        let all = [...f.jobs.values()].sort((a, b) => Number(B(a.id) - B(b.id)));
        if (o.state) all = all.filter((j) => j.state === o.state);
        return structuredClone(all.slice(o.from ?? 0, (o.from ?? 0) + (o.limit ?? 50)));
      },
      getSpend: async (id) => structuredClone(f.spends.get(id) ?? null),
      listSpends: async () => structuredClone([...f.spends.values()]),
      listSeats: async () => structuredClone([...f.seats.values()]),
      claimableOf: async (acct) => (f.claimable.get(acct) ?? 0n).toString(),
      budgetOf: async (id) => {
        const a = f.agents.get(id);
        req(a, 'no such agent');
        return budgetFor(f.params, a.rep).toString();
      },
      seatPending: async (id) => f.pendingOf(id).toString(),
      getStats: async () => f.statsView(),
      postJob: async (target, amount) => f.doPostJob(need(), target, B(amount)),
      acceptJob: async (id) => f.doAccept(need(), id),
      awardJob: async (id) => f.doAward(need(), id),
      placeBid: async (id, price) => f.doBid(need(), id, B(price)),
      submitWork: async (id, hash, uri, att = null) => f.doSubmit(need(), id, hash, uri, att),
      reviewWork: async (id, approve, reason) => f.doReview(need(), id, approve, reason),
      requestSpend: async (vendor, amount, job, memo) => f.doSpend(need(), vendor, B(amount), job, memo),
      expireJob: async (id) => { f.doExpire(id); },
      claim: async () => f.doClaim(need()),
      checkpointSeat: async (id) => f.doCheckpoint(id),
      freezeAgent: async (id, reason) => f.doFreeze(need(), id, reason),
    };
  }
}
