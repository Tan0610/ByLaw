// Maps indexer responses to the UI types. Accepts both the shapes in services/indexer (Lane B, the
// source of truth) and the simpler shapes used by the MSW fixtures, so either backend renders the same.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Agent, CharterVersion, Job, Seat, Spend, Stats, TimelineEvent } from "./types";

const nsIso = (ns?: string | null) => (ns && ns !== "0" ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : "");

export function normAgent(a: any): Agent {
  const earnings = typeof a.earnings === "object" && a.earnings ? a.earnings.total : a.earnings;
  return {
    token_id: String(a.token_id), account: a.account, kind: a.kind, state: a.state, owner: a.owner,
    rep: Number(a.rep ?? 0), delivered: Number(a.delivered ?? 0), rejected: Number(a.rejected ?? 0),
    budget: String(a.budget ?? "0"), win_spent: String(a.win_spent ?? "0"),
    win_start_iso: a.win_start_iso ?? nsIso(a.win_start_ns), earnings: String(earnings ?? "0"),
    frozen_reason: a.frozen_reason,
  };
}

export function normJob(j: any): Job {
  const d = j.deliverable;
  return {
    id: String(j.id), customer: j.customer, target: j.target, price: String(j.price), state: j.state,
    created_iso: j.created_iso ?? nsIso(j.created_ns), deadline_iso: j.deadline_iso ?? nsIso(j.deadline_ns),
    sales: j.sales ?? null, winner: j.winner ?? null, reviewer: j.reviewer ?? null, attempts: Number(j.attempts ?? 0),
    bids: (j.bids ?? []).map((b: any) => ({
      agent: String(b.agent), agent_account: b.agent_account ?? `agent #${b.agent}`, price: String(b.price),
      score: b.score === null || b.score === undefined ? NaN : Number(b.score) / 1e6, ts_iso: b.ts_iso ?? nsIso(b.ts_ns),
    })),
    deliverable_hash: j.deliverable_hash ?? d?.hash ?? null,
    uri: j.uri ?? d?.uri ?? null,
    attestation: j.attestation ?? d?.attestation ?? null,
    review: j.review ?? null,
    credits: j.credits ?? j.waterfall ?? null,
  };
}

export function normTimeline(list: any[]): TimelineEvent[] {
  return list.map((e) => ({
    event: e.event ?? e.type, ts_iso: e.ts_iso ?? nsIso(e.ts_ns),
    data: (Array.isArray(e.data) ? e.data[0] : e.data) ?? {},
  }));
}

/** The review decision is not on the job view in the real indexer; derive it from the timeline. */
export function reviewFromTimeline(t: TimelineEvent[]): Job["review"] {
  const r = [...t].reverse().find((e) => e.event === "work_reviewed");
  if (!r) return null;
  return { approve: r.data.approve === true || r.data.approve === "true", reason: (r.data.reason as string) ?? undefined };
}

export function normHistory(list: any[]): CharterVersion[] {
  return list.map((v) => ({
    version: Number(v.version), text: v.text ?? "", text_hash: v.text_hash,
    changed_at_iso: v.changed_at_iso ?? v.first_seen_iso ?? "", proposal_id: v.proposal_id, note: v.note,
  }));
}

export function normSpend(s: any): Spend {
  const reason = s.reason || (s.outcome ?? s.state);
  return {
    id: String(s.id), agent: String(s.agent), agent_account: s.agent_account ?? `agent #${s.agent}`,
    vendor: s.vendor, amount: String(s.amount), job: s.job ?? null, memo: s.memo, state: s.state,
    reason: s.state === "Rejected" && !/^Rejected/i.test(reason) ? `Rejected: ${reason}` : reason,
    ts_iso: s.ts_iso ?? nsIso(s.ts_ns),
  };
}

export function normSeat(s: any): Seat {
  return { token_id: String(s.token_id), owner: s.owner, weight: Number(s.weight), pending: String(s.pending ?? "0") };
}

export function normStats(s: any): Stats {
  return {
    treasury: String(s.treasury ?? "0"), escrow: String(s.escrow ?? s.escrow_total ?? s.total_escrow ?? "0"),
    claimable_total: String(s.claimable_total ?? s.total_claimable ?? "0"), total_in: String(s.total_in ?? "0"), total_out: String(s.total_out ?? "0"),
    jobs_settled: Number(s.jobs_settled ?? 0),
    solvency_ok: typeof s.solvency_ok === "boolean" ? s.solvency_ok : typeof s.solvent === "boolean" ? s.solvent : !!s.solvency?.ok,
  };
}
