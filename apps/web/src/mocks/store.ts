import { emitMockPing } from "../lib/stream";
import { waterfall } from "../lib/format";
import type { Agent, ByLawParams, ByLawVersion, DaoProposal, Job, Report, Seat, Spend, Stats, TimelineEvent } from "../lib/types";
import * as F from "./fixtures";

const clone = <T,>(v: T): T => structuredClone(v);

function budgetOf(a: Agent, c: ByLawParams): string {
  if (a.kind !== "Analyst" && a.kind !== "Treasurer") return "0";
  const b = BigInt(c.base_budget) + (BigInt(c.per_rep_budget) * BigInt(a.rep)) / 100n;
  const m = BigInt(c.max_budget);
  return (b < m ? b : m).toString();
}

class MockStore {
  bylaw!: ByLawParams;
  history!: ByLawVersion[];
  agents!: Agent[];
  seats!: Seat[];
  jobs!: Job[];
  timelines!: Record<string, TimelineEvent[]>;
  spends!: Spend[];
  claimable!: Record<string, string>;
  proposals!: DaoProposal[];
  artifacts!: Record<string, Report>;
  stats!: Stats;
  nextJob = 3;
  nextProposal = 6;
  nextSpend = 6;
  /** Mock "agents" advance a posted job on timers. Tests turn this off and step manually. */
  autoAdvance = true;
  stepMs = 1400;

  constructor() { this.reset(); }

  reset() {
    this.bylaw = clone(F.bylaw);
    this.history = clone(F.bylawHistory);
    this.agents = clone(F.agents);
    this.seats = clone(F.seats);
    this.jobs = clone(F.jobs);
    this.timelines = Object.fromEntries(this.jobs.map((j) => [j.id, F.timelineFor(j)]));
    this.spends = clone(F.spends);
    this.claimable = clone(F.claimable);
    this.proposals = F.proposalsInitial();
    this.artifacts = { [F.REPORT_HASH]: clone(F.report) };
    this.stats = clone(F.stats);
    this.nextJob = 3; this.nextProposal = 6; this.nextSpend = 6;
    this.agents.forEach((a) => { a.budget = budgetOf(a, this.bylaw); });
  }

  ping(type: string, id?: string) { emitMockPing({ type, id }); }

  agent(id: string) { return this.agents.find((a) => a.token_id === id); }
  job(id: string) { return this.jobs.find((j) => j.id === id); }

  log(jobId: string, event: string, data: Record<string, unknown>) {
    (this.timelines[jobId] ??= []).push({ event, ts_iso: new Date().toISOString(), data: { job_id: jobId, ...data } });
    this.ping("job", jobId);
  }

  postJob(customer: string, amount: string, target: string): { ok: boolean; error?: string; id?: string } {
    const p = BigInt(amount);
    if (p < BigInt(this.bylaw.min_price) || p > BigInt(this.bylaw.max_price))
      return { ok: false, error: "Price outside bylaw band: the whole amount is refunded by ft_on_transfer." };
    if (!/^[a-z0-9._-]{2,64}$/.test(target)) return { ok: false, error: "Target must be a NEAR account id." };
    const id = String(this.nextJob++);
    const job: Job = {
      id, customer, target, price: amount, state: "Posted", created_iso: new Date().toISOString(),
      bids: [], attempts: 0, sales: null, winner: null, reviewer: null,
    };
    this.jobs.unshift(job);
    this.stats.escrow = (BigInt(this.stats.escrow) + p).toString();
    this.stats.total_in = (BigInt(this.stats.total_in) + p).toString();
    this.log(id, "job_posted", { customer, target, price: amount });
    this.ping("stats");
    if (this.autoAdvance) this.schedule(id);
    return { ok: true, id };
  }

  private schedule(id: string) {
    const tick = () => {
      const j = this.job(id);
      if (!j || j.state === "Settled" || j.state === "Refunded") return;
      this.advanceJob(id);
      setTimeout(tick, this.stepMs);
    };
    setTimeout(tick, this.stepMs);
  }

  /** One step of the mock agent pipeline. Mirrors the real state machine. */
  advanceJob(id: string): Job["state"] | null {
    const j = this.job(id);
    if (!j) return null;
    const c = this.bylaw;
    switch (j.state) {
      case "Posted":
        j.state = "Open"; j.sales = "1";
        this.log(id, "job_opened", { sales_token_id: "1" });
        break;
      case "Open": {
        const analysts = this.agents.filter((a) => a.kind === "Analyst" && a.state === "Active");
        analysts.forEach((a, i) => {
          const price = (BigInt(j.price) * BigInt(i === 0 ? 7200 : 6800)) / 10000n;
          j.bids.push({ agent: a.token_id, agent_account: a.account, price: price.toString(), score: Number((price * 1000n) / BigInt(1000 + a.rep)), ts_iso: new Date().toISOString() });
          this.log(id, "bid_placed", { agent: a.account, price: price.toString() });
        });
        if (!j.bids.length) { j.state = "Refunded"; this.log(id, "job_refunded", { reason: "no bids" }); break; }
        const best = [...j.bids].sort((a, b) => a.score - b.score)[0];
        j.winner = best.agent; j.reviewer = "4"; j.state = "Awarded";
        j.deadline_iso = new Date(Date.now() + Number(c.submit_window_ns) / 1e6).toISOString();
        this.log(id, "job_awarded", { winner: j.winner, reviewer: j.reviewer });
        break;
      }
      case "Awarded": {
        const hash = "0x" + id.padStart(2, "0").repeat(32).slice(0, 64);
        this.artifacts[hash] = { ...clone(F.report), target: j.target, summary: `Brief for ${j.target}: no full-access keys found; code hash and storage recorded from NEAR RPC.` };
        j.deliverable_hash = hash; j.uri = `artifact:${hash}`; j.state = "Submitted";
        this.log(id, "work_submitted", { deliverable_hash: hash, uri: j.uri });
        break;
      }
      case "Submitted":
        j.review = { approve: true, reason: "Reviewer recomputed facts from NEAR RPC and they matched." };
        this.log(id, "work_reviewed", { approve: true, reviewer: j.reviewer });
        this.settle(j);
        break;
      default:
        return j.state;
    }
    return j.state;
  }

  private settle(j: Job) {
    const credits = waterfall(j.price, this.bylaw.split);
    j.credits = credits; j.state = "Settled";
    const owner = (id?: string | null) => this.agent(id ?? "")?.owner;
    const add = (acct: string | undefined, amt: string) => {
      if (!acct) return;
      this.claimable[acct] = (BigInt(this.claimable[acct] ?? "0") + BigInt(amt)).toString();
    };
    add(owner(j.reviewer), credits.reviewer);
    add(owner(j.winner), credits.producer);
    add(owner(j.sales), credits.sales);
    const totalW = this.seats.reduce((s, x) => s + x.weight, 0);
    this.seats.forEach((s) => { s.pending = (BigInt(s.pending) + (BigInt(credits.seats) * BigInt(s.weight)) / BigInt(totalW)).toString(); });
    this.stats.treasury = (BigInt(this.stats.treasury) + BigInt(credits.treasury)).toString();
    this.stats.escrow = (BigInt(this.stats.escrow) - BigInt(j.price)).toString();
    this.stats.claimable_total = (BigInt(this.stats.claimable_total) + BigInt(credits.reviewer) + BigInt(credits.producer) + BigInt(credits.sales)).toString();
    this.stats.jobs_settled += 1;
    const w = this.agent(j.winner ?? "");
    if (w) { w.rep += this.bylaw.rep_gain; w.delivered += 1; w.earnings = (BigInt(w.earnings) + BigInt(credits.producer)).toString(); w.budget = budgetOf(w, this.bylaw); }
    this.log(j.id, "job_settled", { price: j.price, credits });
    this.ping("agents"); this.ping("stats"); this.ping("seats");
  }

  freeze(tokenId: string, reason: string) {
    const a = this.agent(tokenId);
    if (!a) return false;
    a.state = "Frozen"; a.frozen_reason = reason || "frozen by guardian";
    this.ping("agents", tokenId);
    return true;
  }

  unfreeze(tokenId: string) {
    const a = this.agent(tokenId);
    if (!a) return false;
    a.state = "Active"; delete a.frozen_reason;
    this.ping("agents", tokenId);
    return true;
  }

  applyProposal(p: DaoProposal) {
    const fc = (p.kind as { FunctionCall?: { actions: { method_name: string; args: string }[] } }).FunctionCall;
    const act = fc?.actions?.[0];
    if (!act) return;
    let args: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { args = JSON.parse(atob(act.args)); } catch { /* ignore */ }
    if (act.method_name === "set_bylaw") {
      const text = typeof args.params?.text === "string" && args.params.text.length > 60 ? args.params.text : F.amendedByLaw.text;
      this.bylaw = { ...this.bylaw, version: this.bylaw.version + 1, text, text_hash: F.amendedByLaw.hash };
      this.history.push({ version: this.bylaw.version, text, text_hash: this.bylaw.text_hash, changed_at_iso: new Date().toISOString(), proposal_id: p.id, note: p.description });
      this.ping("bylaw");
    } else if (act.method_name === "approve_spend") {
      const s = this.spends.find((x) => x.id === String(args.id));
      if (s && s.state === "Pending") { s.state = "Paid"; s.reason = "Paid after DAO approval"; this.ping("spends"); }
    } else if (act.method_name === "unfreeze_agent") {
      this.unfreeze(String(args.token_id));
    }
  }
}

export const mockStore = new MockStore();
