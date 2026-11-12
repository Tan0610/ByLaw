// @vitest-environment node
// Contract test: the web normalizers accept the REAL indexer responses (services/indexer over the
// @charter/near-client FakeContract), not just our MSW fixtures.
import { DEMO_ACCOUNTS, FakeContract, ManualClock, seedDemoWorld } from "@charter/near-client";
import { createIndexerApp } from "@charter/indexer";
import { normAgent, normHistory, normJob, normSeat, normSpend, normStats, normTimeline, reviewFromTimeline } from "../lib/normalize";

describe("real indexer shapes", () => {
  it("normalizes agents, jobs, timeline, spends, seats, stats and history", async () => {
    const clock = new ManualClock();
    const fake = new FakeContract({ clock: clock.now });
    seedDemoWorld(fake);
    const A = DEMO_ACCOUNTS;
    const { indexer, app } = await createIndexerApp({
      client: fake.as(null), cfg: { contract_id: fake.contractId, dao_id: fake.ownerId, token_id: fake.tokenId }, dbPath: ":memory:",
    });
    const get = async (url: string) => (await app.inject({ method: "GET", url })).json();

    const id = (await fake.as(A.customer).postJob("dex.testnet", "100000000"))!;
    await fake.as(A.sales).acceptJob(id);
    await fake.as(A.analyst1).placeBid(id, "60000000");
    await fake.as(A.analyst2).placeBid(id, "55000000");
    clock.advanceSec(61);
    await fake.as(A.sales).awardJob(id);
    const job0 = await fake.as(null).getJob(id);
    const winnerAcct = (await fake.as(null).listAgents()).find((a) => a.token_id === job0!.winner)!.account;
    await fake.as(winnerAcct).submitWork(id, "0x" + "ab".repeat(32), "uri", null);
    await fake.as(A.reviewer).reviewWork(id, true, "0x" + "00".repeat(32));
    await fake.as(A.treasurer).requestSpend("attacker-wallet.testnet", "1000000", null, "attack");
    await indexer.poll(); // the indexer records charter versions it observes
    fake.setCharter({ text: "v2 text" });
    await indexer.poll();

    const agents = (await get("/agents")).map(normAgent);
    expect(agents).toHaveLength(5);
    expect(typeof agents[0].earnings).toBe("string");

    const job = normJob(await get(`/jobs/${id}`));
    expect(job.state).toBe("Settled");
    expect(job.bids).toHaveLength(2);
    expect(Number.isFinite(job.bids[0].score)).toBe(true);
    expect(job.deliverable_hash).toBe("0x" + "ab".repeat(32));
    expect(job.credits && Object.values(job.credits).reduce((s, v) => s + BigInt(v), 0n)).toBe(100_000_000n);
    expect(job.created_iso).toMatch(/^\d{4}-/);

    const tl = normTimeline(await get(`/jobs/${id}/timeline`));
    expect(tl.map((e) => e.event)).toContain("job_settled");
    expect(reviewFromTimeline(tl)?.approve).toBe(true);

    const spends = (await get("/spends")).map(normSpend);
    expect(spends[0].state).toBe("Rejected");
    expect(spends[0].reason).toMatch(/^Rejected/);

    const seats = (await get("/seats")).map(normSeat);
    expect(seats.length).toBe(2);

    const stats = normStats(await get("/stats"));
    expect(stats.solvency_ok).toBe(true);

    const hist = normHistory(await get("/charter/history"));
    expect(hist.map((h) => h.version)).toEqual([1, 2]);
    expect(hist[1].text).toBe("v2 text");

    const claim = await get(`/claimable/${A.owners.reviewer}`);
    expect(claim.claimable ?? claim.amount).toBe("8000000");
    await app.close();
  });
});
