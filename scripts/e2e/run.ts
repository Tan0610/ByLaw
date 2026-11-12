// End-to-end demo run.
//
//   npm run e2e:mock -w scripts          full demo on Lane B's in-memory FakeContract + the real indexer (no network)
//   npm run e2e -w scripts -- --check    read-only testnet check of a deployed contract (needs BYLAW_CONTRACT_ID etc.)
//
// --mock drives the real packages: @bylaw/near-client (FakeContract, ManualClock, seedDemoWorld),
// @bylaw/indexer (createIndexerApp; REST is queried through Fastify inject) and, when it exports them,
// @bylaw/agents (SalesAgent, AnalystAgent, ReviewerAgent, TreasurerAgent). If the agents package has no
// public index yet, the same role calls are scripted here and the transcript says so.
// Nothing is signed or sent to any network in either mode.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DEMO_ACCOUNTS, FakeContract, ManualClock, NearContractClient, artifactHash, seedDemoWorld } from "@bylaw/near-client";
import type { ContractClient } from "@bylaw/near-client";
import { createIndexerApp } from "@bylaw/indexer";

const argv = process.argv.slice(2);
const MOCK = argv.includes("--mock");
const QUIET = argv.includes("--quiet");

// ---------- transcript helpers ----------
const failures: string[] = [];
let stepNo = 0;
const out = (s = "") => { if (!QUIET) console.log(s); };
const step = (title: string) => out(`\n=== ${++stepNo}. ${title}`);
const info = (s: string) => out(`    ${s}`);
function check(cond: boolean, label: string) {
  out(`    [${cond ? "ok" : "FAIL"}] ${label}`);
  if (!cond) failures.push(label);
}
const tusd = (raw: string | bigint) => {
  const v = BigInt(raw);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0").slice(0, 2)} tUSD`;
};

// ---------- --check: read-only testnet ----------
async function readOnlyCheck() {
  const contractId = process.env.BYLAW_CONTRACT_ID;
  if (!contractId) {
    console.log([
      "Testnet e2e is human-run. This script never signs. Two options:",
      "  1. Read-only check of a deployed contract:",
      "       BYLAW_CONTRACT_ID=bylaw.<you>.testnet TOKEN_ID=tusd.<you>.testnet npm run e2e -w scripts -- --check",
      "  2. Full run: follow docs/demo/TESTNET_RUNBOOK.md (deploy, DAO bootstrap, agents, then the web app).",
      "For an offline run of the whole story: npm run e2e:mock -w scripts",
    ].join("\n"));
    process.exit(argv.includes("--check") ? 2 : 0);
  }
  const rpcUrl = process.env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com";
  const c = new NearContractClient({ rpcUrl, contractId, tokenId: process.env.TOKEN_ID ?? "" });
  step(`Read-only check of ${contractId} via ${rpcUrl}`);
  const bylaw = await c.getByLaw();
  info(`bylaw v${bylaw.version} text_hash ${bylaw.text_hash}`);
  const agents = await c.listAgents();
  agents.forEach((a) => info(`agent #${a.token_id} ${a.kind} ${a.account} state=${a.state} rep=${a.rep} owner=${a.owner}`));
  const jobs = await c.listJobs({ from: 0, limit: 50 });
  info(`${jobs.length} job(s): ${jobs.map((j) => `#${j.id} ${j.state}`).join(", ") || "none"}`);
  const spends = await c.listSpends();
  info(`${spends.length} spend(s), ${spends.filter((s) => s.state === "Rejected").length} rejected`);
  const s = await c.getStats();
  const lhs = BigInt(s.treasury) + BigInt(s.escrow_total) + BigInt(s.claimable_total) + BigInt(s.pools_total) + BigInt(s.seat_pool);
  check(lhs === BigInt(s.total_in) - BigInt(s.total_out), "solvency invariant holds on testnet");
  check(agents.length >= 5, "five agents registered");
  out(`\nExplorer: https://testnet.nearblocks.io/address/${contractId}`);
}

// ---------- --mock: full story ----------
type Tick = () => Promise<void>;

async function loadAgentsPackage(): Promise<any | null> {
  try {
    const m: any = await import("@bylaw/agents");
    const need = ["SalesAgent", "AnalystAgent", "ReviewerAgent", "TreasurerAgent", "StepLedger"];
    return need.every((k) => typeof m[k] === "function") ? m : null;
  } catch {
    return null;
  }
}

async function mockRun() {
  const A = DEMO_ACCOUNTS;
  const clock = new ManualClock();
  const fake = new FakeContract({ clock: clock.now });
  seedDemoWorld(fake);
  const GUARDIAN = fake.guardians[0];
  const as = (acct: string | null): ContractClient => fake.as(acct);

  const { indexer, app } = await createIndexerApp({
    client: fake.as(null),
    cfg: { contract_id: fake.contractId, dao_id: fake.ownerId, token_id: fake.tokenId },
    dbPath: ":memory:",
    server: { logger: false } as any,
  });
  const rest = async (url: string, method: "GET" | "POST" = "GET", payload?: unknown): Promise<any> => {
    const r = await app.inject({ method, url, payload: payload as any });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const sync = () => indexer.poll();

  // Artifact store backed by the indexer REST (POST/GET /artifacts), same contract as HttpArtifactStore.
  const store = {
    async put(r: unknown) {
      const { hash } = await rest("/artifacts", "POST", r);
      if (hash !== artifactHash(r)) throw new Error("indexer hash mismatch");
      return hash as string;
    },
    async get(h: string) { try { return await rest(`/artifacts/${h}`); } catch { return null; } },
  };

  out("ByLaw e2e (mock): FakeContract from @bylaw/near-client + real @bylaw/indexer. No network, nothing signed.");
  const agentsPkg = await loadAgentsPackage();
  let ticks: { sales: Tick; analysts: Tick; reviewer: Tick; treasurer: Tick };

  if (agentsPkg) {
    out("Agents: real role loops from @bylaw/agents.");
    const g = agentsPkg;
    const log = g.silentLogger ?? { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
    const facts = new g.CannedFactsProvider();
    const summarizer = new g.TemplateSummarizer();
    const ctx = (name: string, acct: string) => ({ name, client: as(acct), log, ledger: new g.StepLedger() });
    const sales = new g.SalesAgent(ctx("sales", A.sales));
    const a1 = new g.AnalystAgent(ctx("analyst1", A.analyst1), { facts, summarizer, store, uriFor: (h: string) => `indexer:/artifacts/${h}`, aggressionBps: 6000, costFloor: 1_000_000n });
    const a2 = new g.AnalystAgent(ctx("analyst2", A.analyst2), { facts, summarizer, store, uriFor: (h: string) => `indexer:/artifacts/${h}`, aggressionBps: 5500, costFloor: 1_000_000n });
    const reviewer = new g.ReviewerAgent(ctx("reviewer", A.reviewer), { facts, store });
    const treasurer = new g.TreasurerAgent(ctx("treasurer", A.treasurer), { vendor: A.vendor, amountPerJob: 2_000_000n });
    ticks = {
      sales: () => sales.tick(), analysts: async () => { await a1.tick(); await a2.tick(); },
      reviewer: () => reviewer.tick(), treasurer: () => treasurer.tick(),
    };
  } else {
    out("Agents: @bylaw/agents has no public index yet, so the role calls below are scripted against the same client API.");
    const facts = { code_hash: "scripted", storage_usage: 1000, balance: "0", full_access_keys: 0, function_call_keys: 1, upgradeable: false, fetched_at_block: 1 };
    ticks = {
      sales: async () => {
        const c = as(A.sales);
        for (const j of await c.listJobs({})) {
          if (j.state === "Posted") await c.acceptJob(j.id);
          else if (j.state === "Open" && (await c.nowNs()) >= BigInt(j.deadline_ns)) await c.awardJob(j.id);
        }
      },
      analysts: async () => {
        for (const [acct, bps] of [[A.analyst1, 6000n], [A.analyst2, 5500n]] as const) {
          const c = as(acct);
          const me = (await c.listAgents()).find((a) => a.account === acct)!;
          for (const j of await c.listJobs({})) {
            if (j.state === "Open" && !j.bids.some((b) => b.agent === me.token_id)) await c.placeBid(j.id, ((BigInt(j.price) * bps) / 10000n).toString());
            if (j.state === "Awarded" && j.winner === me.token_id) {
              const hash = await store.put({ schema: "bylaw.report.v1", target: j.target, facts, summary: "scripted", model: "none", attestation: null });
              await c.submitWork(j.id, hash, `indexer:/artifacts/${hash}`, null);
            }
          }
        }
      },
      reviewer: async () => {
        const c = as(A.reviewer);
        for (const j of await c.listJobs({})) if (j.state === "Submitted") await c.reviewWork(j.id, true, "0x" + "00".repeat(32));
      },
      treasurer: async () => {
        const c = as(A.treasurer);
        const done = new Set((await c.listSpends()).map((s) => s.job));
        for (const j of await c.listJobs({ state: "Settled" })) if (!done.has(j.id)) await c.requestSpend(A.vendor, "2000000", j.id, `rpc credits for job ${j.id}`);
      },
    };
  }

  // 1. world
  await sync();
  step("The company: bylaw, DAO, agents, seats");
  const cfg = await rest("/config");
  info(`contract ${cfg.contract_id} owned by DAO ${cfg.dao_id}; token ${cfg.token_id}; guardians ${cfg.guardians.join(", ")}`);
  const ch0 = await rest("/bylaw");
  info(`bylaw v${ch0.version}: "${ch0.text}"`);
  for (const a of await rest("/agents")) info(`agent #${a.token_id} ${a.kind.padEnd(9)} ${a.account}  owner=${a.owner} rep=${a.rep} budget=${tusd(a.budget)}`);
  for (const s of await rest("/seats")) info(`seat #${s.token_id} owner=${s.owner} weight=${s.weight}`);
  check((await rest("/agents")).length === 5, "five agents registered (each an NFT)");

  // 2. customer pays
  step("Customer pays 100 tUSD into escrow (ft_transfer_call post_job)");
  const jobId = await as(A.customer).postJob("dex.testnet", "100000000");
  check(jobId !== null, `job #${jobId} posted`);
  await sync();
  check((await rest(`/jobs/${jobId}`)).state === "Posted", "indexer shows the job as Posted");

  // 3. sales accepts
  step("Sales agent accepts the job (price band check, bid window opens)");
  await ticks.sales(); await sync();
  check((await rest(`/jobs/${jobId}`)).state === "Open", "job is Open");

  // 4. two analysts bid
  step("Two analysts bid; score = price x 1000 / (1000 + rep)");
  await ticks.analysts(); await sync();
  const jOpen = await rest(`/jobs/${jobId}`);
  for (const b of jOpen.bids) info(`bid by ${b.agent_account}: ${tusd(b.price)} score=${b.score}`);
  check(jOpen.bids.length === 2, "two bids recorded");

  // 5. award
  step("Bid window closes; sales awards; reviewer assigned with a different owner");
  clock.advanceSec(Number(BigInt(ch0.bid_window_ns) / 1_000_000_000n) + 1);
  await ticks.sales(); await sync();
  const jAw = await rest(`/jobs/${jobId}`);
  info(`winner ${jAw.winner_account}, reviewer ${jAw.reviewer_account}`);
  check(jAw.state === "Awarded", "job is Awarded");
  const agentsNow = await rest("/agents");
  const ownerOf = (id: string) => agentsNow.find((a: any) => a.token_id === id)?.owner;
  check(ownerOf(jAw.winner) !== ownerOf(jAw.reviewer), "producer owner differs from reviewer owner");
  const winnerBudgetBefore = agentsNow.find((a: any) => a.token_id === jAw.winner).budget;

  // 6. submit
  step("Winner builds the report (facts + summary), publishes it, and calls submit_work");
  await ticks.analysts(); await sync();
  const jSub = await rest(`/jobs/${jobId}`);
  check(jSub.state === "Submitted", "job is Submitted");
  const art = await rest(`/artifacts/${jSub.deliverable.hash}`);
  info(`artifact ${jSub.deliverable.hash}: ${String(art.summary).slice(0, 100)}...`);
  check(artifactHash(art) === jSub.deliverable.hash, "artifact hash matches the on-chain deliverable hash");

  // 7. review + waterfall
  step("Reviewer recomputes the facts and approves; waterfall splits the 100 tUSD");
  await ticks.reviewer(); await sync();
  const jSet = await rest(`/jobs/${jobId}`);
  check(jSet.state === "Settled", "job is Settled");
  const wf = jSet.waterfall ?? {};
  for (const k of ["producer", "seats", "treasury", "reviewer", "sales"]) info(`${k.padEnd(9)} ${tusd(wf[k] ?? "0")}`);
  const wfSum = Object.values(wf).reduce((s: bigint, v: any) => s + BigInt(v), 0n);
  check(wfSum === 100_000_000n, "waterfall conserves value to the unit");

  // 8. budget rises
  step("Earned budget: the winner's spending limit rises after delivered work");
  const winnerAfter = (await rest("/agents")).find((a: any) => a.token_id === jAw.winner);
  info(`budget ${tusd(winnerBudgetBefore)} -> ${tusd(winnerAfter.budget)}, rep ${winnerAfter.rep}`);
  check(BigInt(winnerAfter.budget) > BigInt(winnerBudgetBefore), "budget increased");

  // 9. claims
  step("Owners claim: agent NFT owner and a seat holder");
  const prodOwner = ownerOf(jAw.winner)!;
  const before = await rest(`/claimable/${prodOwner}`);
  info(`${prodOwner} claimable ${tusd(before.claimable ?? before.amount)}`);
  const paid = await as(prodOwner).claim();
  info(`claim() paid ${tusd(paid)}`);
  check(BigInt(paid) > 0n, "producer owner claimed earnings");
  const seat = (await rest("/seats"))[0];
  const seatClient = as(seat.owner);
  const pend = await seatClient.seatPending(seat.token_id);
  await seatClient.checkpointSeat(seat.token_id);
  const seatPaid = await seatClient.claim();
  info(`seat #${seat.token_id} (${seat.owner}) pending ${tusd(pend)} -> claimed ${tusd(seatPaid)}`);
  check(BigInt(pend) > 0n && BigInt(seatPaid) >= BigInt(pend), "seat holder claimed dividends");
  await sync();

  // 10. treasurer buys within budget
  step("Treasurer buys data from an allowlisted vendor within budget");
  await ticks.treasurer(); await sync();
  const spends1 = await rest("/spends");
  for (const s of spends1) info(`spend #${s.id} ${tusd(s.amount)} to ${s.vendor}: ${s.state} ${s.reason ?? ""}`);
  check(spends1.some((s: any) => s.state === "Paid"), "a purchase was paid");

  // 11. attacks
  step("Attack: overspend and a non-allowlisted vendor (recorded as rejected, never paid)");
  const t = as(A.treasurer);
  const ch = await t.getByLaw();
  const overCap = await t.requestSpend(A.vendor, (BigInt(ch.per_tx_cap) + 1n).toString(), null, "attack: above per-tx cap");
  const me = (await t.listAgents()).find((a) => a.account === A.treasurer)!;
  const budget = BigInt(await t.budgetOf(me.token_id));
  const overBudgetAmt = budget - BigInt(me.win_spent) + 1n;
  const overBudget = await t.requestSpend(A.vendor, overBudgetAmt.toString(), null, "attack: window budget overspend");
  const rogue = await t.requestSpend("attacker-wallet.testnet", "1000000", null, "attack: non-allowlisted vendor");
  await sync();
  for (const id of [overCap, overBudget, rogue]) {
    const s = await t.getSpend(id);
    info(`spend #${id} ${tusd(s!.amount)} to ${s!.vendor}: ${s!.state} (${s!.reason})`);
    check(s!.state === "Rejected" || (id === overBudget && s!.state === "Pending"), `spend #${id} not paid`);
  }
  check((await rest("/spends")).filter((s: any) => s.state === "Rejected").length >= 2, "indexer lists the rejected attempts");

  // 12. guardian freeze
  step("Guardian freezes an agent; a non-guardian cannot; the frozen agent cannot act");
  let nonGuardianBlocked = false;
  try { await as(A.customer).freezeAgent(me.token_id, "not my job"); } catch { nonGuardianBlocked = true; }
  check(nonGuardianBlocked, "customer cannot freeze");
  await as(GUARDIAN).freezeAgent(me.token_id, "suspicious spending pattern");
  await sync();
  check((await rest(`/agents/${me.token_id}`)).state === "Frozen", `${A.treasurer} is Frozen`);
  const afterFreeze = await t.requestSpend(A.vendor, "1000000", null, "after freeze").then((id) => t.getSpend(id)).catch((e) => ({ state: "Rejected", reason: String(e.message ?? e) }) as any);
  info(`frozen treasurer tries to spend: ${afterFreeze?.state} (${afterFreeze?.reason})`);
  check(afterFreeze?.state === "Rejected", "frozen agent's spend is rejected");

  // 13. bylaw amendment through the DAO
  step("DAO amends the bylaw (Sputnik FunctionCall proposal -> set_bylaw)");
  const newText = `${ch.text}\nAmendment: spends of 3 tUSD or more need DAO approval.`;
  const proposal = {
    description: "Lower the approval threshold to 3 tUSD",
    kind: { FunctionCall: { receiver_id: fake.contractId, actions: [{ method_name: "set_bylaw", args: "<base64 of {params:{...new ByLawParams}}>", deposit: "0", gas: "150000000000000" }] } },
  };
  info(`proposal: ${JSON.stringify(proposal)}`);
  info("council votes 2 of 3 approve -> the DAO calls set_bylaw (simulated here as the DAO owner of the fake)");
  fake.setByLaw({ text: newText, approval_threshold: "3000000" });
  await sync();
  const hist = await rest("/bylaw/history");
  const last = hist[hist.length - 1];
  info(`bylaw v${last.version}, text hash ${last.text_hash}`);
  info(`diff: ${JSON.stringify(last.diff).slice(0, 160)}`);
  check(hist.length >= 2 && last.version === ch.version + 1, "bylaw version bumped with history and diff");

  // 14. invariants
  step("Invariants");
  const stats = await rest("/stats");
  info(`treasury ${tusd(stats.treasury)}, escrow ${tusd(stats.escrow_total)}, claimable ${tusd(stats.claimable_total)}, in ${tusd(stats.total_in)}, out ${tusd(stats.total_out)}`);
  check(stats.solvency?.ok === true, "global solvency invariant holds (indexer /stats)");
  check(fake.checkSolvency().ok, "global solvency invariant holds (FakeContract)");

  await app.close();
}

const run = MOCK ? mockRun : readOnlyCheck;
run().then(() => {
  out(`\n${failures.length ? `FAILED: ${failures.length} check(s): ${failures.join("; ")}` : "All checks passed."}`);
  process.exit(failures.length ? 1 : 0);
}, (e) => {
  console.error(`\nE2E crashed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
