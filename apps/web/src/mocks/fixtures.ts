import type {
  Agent, AppConfig, ByLawParams, ByLawVersion, DaoProposal, Job, Report, Seat, Spend, TimelineEvent,
} from "../lib/types";

const MIN = 60_000;
export const T0 = Date.parse("2026-11-11T09:00:00Z");
export const iso = (offsetMin: number) => new Date(T0 + offsetMin * MIN).toISOString();

export const CONTRACT = "bylaw.demo.testnet";
export const DAO = "bylaw-dao.sputnikv2.testnet";
export const TOKEN = "tusd.demo.testnet";
export const COUNCIL = ["ana.demo.testnet", "dev.demo.testnet", "mem.demo.testnet"];

export const config: AppConfig = {
  contract_id: CONTRACT, dao_id: DAO, token_id: TOKEN,
  guardians: ["guardian.demo.testnet", "ana.demo.testnet"],
  bylaw: { version: 2, text_hash: "0x" + "b2".repeat(32) },
};

export const BYLAW_V1 = `# ByLaw of NEAR Contract Health Briefs

1. Purpose. We sell short, verifiable health briefs for NEAR contracts.
2. Agents act inside budgets. No agent may spend beyond its earned budget.
3. Separation of duties. The reviewer's owner must differ from the producer's owner.
4. Revenue. Every accepted job is split by the parameters below.
5. Safety. Any guardian may freeze an agent. Only the DAO may unfreeze.`;

export const BYLAW_V2 = `# ByLaw of NEAR Contract Health Briefs

1. Purpose. We sell short, verifiable health briefs for NEAR contracts.
2. Agents act inside budgets. No agent may spend beyond its earned budget.
3. Separation of duties. The reviewer's owner must differ from the producer's owner.
4. Revenue. Every accepted job is split by the parameters below.
5. Safety. Any guardian may freeze an agent. Only the DAO may unfreeze.
6. Procurement. Vendors must be on the DAO allowlist; spends of 10 tUSD or more need DAO approval.`;

export const BYLAW_V3 = `# ByLaw of NEAR Contract Health Briefs

1. Purpose. We sell short, verifiable health briefs for NEAR contracts.
2. Agents act inside budgets. No agent may spend beyond its earned budget.
3. Separation of duties. The reviewer's owner must differ from the producer's owner.
4. Revenue. Every accepted job is split by the parameters below.
5. Safety. Any guardian may freeze an agent. Only the DAO may unfreeze.
6. Procurement. Vendors must be on the DAO allowlist; spends of 5 tUSD or more need DAO approval.
7. Reputation. Two rejected briefs in a row freeze the producer automatically.`;

export const bylaw: ByLawParams = {
  version: 2, text: BYLAW_V2, text_hash: config.bylaw.text_hash,
  min_price: "10000000", max_price: "500000000",
  bid_window_ns: "120000000000", submit_window_ns: "900000000000", review_window_ns: "600000000000",
  max_bid_bps: 9000,
  split: { reviewer: 800, producer: 5500, sales: 700, treasury: 1500, seats: 1500 },
  rep_start: 100, rep_gain: 20, rep_loss: 40, rep_expire_loss: 30, rep_freeze_below: 40,
  base_budget: "20000000", per_rep_budget: "10000000", max_budget: "80000000", budget_window_ns: "86400000000000",
  per_tx_cap: "30000000", approval_threshold: "10000000",
};

export const bylawHistory: ByLawVersion[] = [
  { version: 1, text: BYLAW_V1, text_hash: "0x" + "a1".repeat(32), changed_at_iso: iso(-60 * 48), note: "Initial bylaw, set at deploy" },
  { version: 2, text: BYLAW_V2, text_hash: config.bylaw.text_hash, changed_at_iso: iso(-60 * 5), proposal_id: 4, note: "Add procurement rule" },
];

export const amendedByLaw = { text: BYLAW_V3, hash: "0x" + "c3".repeat(32) };

const A = (n: number) => `${n}`;
export const agents: Agent[] = [
  { token_id: "1", account: "sales-1.bylaw.demo.testnet", kind: "Sales", state: "Active", owner: "ana.demo.testnet", rep: 120, delivered: 4, rejected: 0,
    budget: "0", win_spent: "0", win_start_iso: iso(-300), earnings: "28000000" },
  { token_id: "2", account: "analyst-1.bylaw.demo.testnet", kind: "Analyst", state: "Active", owner: "ben.demo.testnet", rep: 140, delivered: 5, rejected: 1,
    budget: "34000000", win_spent: "12000000", win_start_iso: iso(-300), earnings: "220000000" },
  { token_id: "3", account: "analyst-2.bylaw.demo.testnet", kind: "Analyst", state: "Active", owner: "cara.demo.testnet", rep: 100, delivered: 2, rejected: 0,
    budget: "30000000", win_spent: "5000000", win_start_iso: iso(-300), earnings: "110000000" },
  { token_id: "4", account: "reviewer-1.bylaw.demo.testnet", kind: "Reviewer", state: "Active", owner: "dev.demo.testnet", rep: 130, delivered: 7, rejected: 0,
    budget: "0", win_spent: "0", win_start_iso: iso(-300), earnings: "56000000" },
  { token_id: "5", account: "treasurer-1.bylaw.demo.testnet", kind: "Treasurer", state: "Active", owner: DAO, rep: 110, delivered: 3, rejected: 0,
    budget: "31000000", win_spent: "9000000", win_start_iso: iso(-300), earnings: "0" },
];
void A;

export const seats: Seat[] = [
  { token_id: "101", owner: "ana.demo.testnet", weight: 50, pending: "7500000" },
  { token_id: "102", owner: "dev.demo.testnet", weight: 30, pending: "4500000" },
  { token_id: "103", owner: "mem.demo.testnet", weight: 20, pending: "3000000" },
];

export const claimable: Record<string, string> = {
  "ana.demo.testnet": "7000000",
  "ben.demo.testnet": "55000000",
  "cara.demo.testnet": "0",
  "dev.demo.testnet": "8000000",
  "customer.demo.testnet": "0",
};

export const report: Report = {
  schema: "bylaw.report.v1", target: "dex.demo.testnet",
  facts: {
    code_hash: "5Hq8x2eY9bK1mQ7zV3nLwPaTRfD6cJuG4sXo2yZtNvWk", storage_usage: 48213, balance: "152300000000000000000000000",
    full_access_keys: 0, function_call_keys: 2, upgradeable: false, fetched_at_block: 187420931,
  },
  summary: "dex.demo.testnet holds about 152 NEAR and has no full-access keys, so nobody can redeploy or drain it. Two function-call keys exist; both are scoped. Storage usage is modest. No upgrade path was found.",
  model: "qwen3-30b (demo fixture)", attestation: null,
};
export const REPORT_HASH = "0x" + "d4".repeat(32);

const bid = (id: string, price: string, score: number, min: number, acct: string) =>
  ({ agent: id, agent_account: acct, price, score: Math.round(score * 1e6), ts_iso: iso(min) });

export const jobs: Job[] = [
  {
    id: "1", customer: "customer.demo.testnet", target: "dex.demo.testnet", price: "100000000", state: "Settled",
    created_iso: iso(-180), deadline_iso: iso(-150), sales: "1", winner: "2", reviewer: "4",
    deliverable_hash: REPORT_HASH, uri: `artifact:${REPORT_HASH}`, attestation: null, attempts: 0,
    bids: [
      bid("2", "62000000", 62 * 1000 / 1140, -176, "analyst-1.bylaw.demo.testnet"),
      bid("3", "64000000", 64 * 1000 / 1100, -175, "analyst-2.bylaw.demo.testnet"),
    ],
    review: { approve: true, reason: "Facts recomputed at block 187420931 and matched." },
    credits: { reviewer: "8000000", producer: "55000000", sales: "7000000", seats: "15000000", treasury: "15000000" },
  },
  {
    id: "2", customer: "customer.demo.testnet", target: "vault.demo.testnet", price: "80000000", state: "Open",
    created_iso: iso(-4), deadline_iso: iso(-2 + 2), sales: "1", winner: null, reviewer: null, attempts: 0,
    bids: [bid("2", "60000000", 60 * 1000 / 1140, -1, "analyst-1.bylaw.demo.testnet")],
  },
];

export function timelineFor(j: Job): TimelineEvent[] {
  const ev: TimelineEvent[] = [
    { event: "job_posted", ts_iso: j.created_iso, data: { job_id: j.id, customer: j.customer, target: j.target, price: j.price } },
  ];
  const base = Date.parse(j.created_iso);
  const at = (s: number) => new Date(base + s * 1000).toISOString();
  if (j.sales) ev.push({ event: "job_opened", ts_iso: at(8), data: { job_id: j.id, sales_token_id: j.sales } });
  j.bids.forEach((b, i) => ev.push({ event: "bid_placed", ts_iso: at(20 + i * 10), data: { job_id: j.id, agent: b.agent_account, price: b.price } }));
  if (j.winner) ev.push({ event: "job_awarded", ts_iso: at(140), data: { job_id: j.id, winner: j.winner, reviewer: j.reviewer } });
  if (j.deliverable_hash) ev.push({ event: "work_submitted", ts_iso: at(200), data: { job_id: j.id, deliverable_hash: j.deliverable_hash, uri: j.uri } });
  if (j.review) ev.push({ event: "work_reviewed", ts_iso: at(230), data: { job_id: j.id, approve: j.review.approve, reason: j.review.reason } });
  if (j.credits) ev.push({ event: "job_settled", ts_iso: at(232), data: { job_id: j.id, price: j.price, credits: j.credits } });
  return ev;
}

export const spends: Spend[] = [
  { id: "1", agent: "5", agent_account: "treasurer-1.bylaw.demo.testnet", vendor: "data-vendor.demo.testnet", amount: "4000000",
    job: "1", memo: "Shared on-chain dataset (collective purchase)", state: "Paid", reason: "Paid", ts_iso: iso(-170) },
  { id: "2", agent: "5", agent_account: "treasurer-1.bylaw.demo.testnet", vendor: "data-vendor.demo.testnet", amount: "5000000",
    job: "2", memo: "Key-usage snapshot", state: "Paid", reason: "Paid", ts_iso: iso(-30) },
  { id: "3", agent: "5", agent_account: "treasurer-1.bylaw.demo.testnet", vendor: "data-vendor.demo.testnet", amount: "15000000",
    job: null, memo: "Annual data subscription (above approval threshold)", state: "Pending", reason: "Pending: waiting for DAO approval", ts_iso: iso(-20) },
  { id: "4", agent: "5", agent_account: "treasurer-1.bylaw.demo.testnet", vendor: "data-vendor.demo.testnet", amount: "29000000",
    job: null, memo: "Attempted overspend (attack scene)", state: "Rejected", reason: "Rejected: window budget exceeded", ts_iso: iso(-12) },
  { id: "5", agent: "5", agent_account: "treasurer-1.bylaw.demo.testnet", vendor: "shady-vendor.testnet", amount: "2000000",
    job: null, memo: "Attempted payment to a non-allowlisted vendor (attack scene)", state: "Rejected", reason: "Rejected: vendor not allowlisted", ts_iso: iso(-11) },
];

export const stats = {
  treasury: "64000000", escrow: "80000000", claimable_total: "70000000",
  total_in: "300000000", total_out: "86000000", jobs_settled: 1, solvency_ok: true,
};

export function proposalsInitial(): DaoProposal[] {
  const fc = (method: string, args: object) => ({
    FunctionCall: { receiver_id: CONTRACT, actions: [{ method_name: method, args: btoa(JSON.stringify(args)), deposit: "0", gas: "150000000000000" }] },
  });
  return [
    {
      id: 4, proposer: "ana.demo.testnet", description: "Add procurement rule to the bylaw", kind: fc("set_bylaw", { params: "v2" }),
      status: "Approved", vote_counts: { council: ["3", "0", "0"] },
      votes: { "ana.demo.testnet": "Approve", "dev.demo.testnet": "Approve", "mem.demo.testnet": "Approve" },
      submission_time: String((T0 - 60 * 5 * MIN) * 1e6),
    },
    {
      id: 5, proposer: "dev.demo.testnet", description: "Approve the 15 tUSD data subscription (spend 3)", kind: fc("approve_spend", { id: "3" }),
      status: "InProgress", vote_counts: { council: ["1", "0", "0"] }, votes: { "dev.demo.testnet": "Approve" },
      submission_time: String((T0 - 20 * MIN) * 1e6),
    },
  ];
}
