import { useState } from "react";
import { Account, Badge, Empty, ErrorBox, Loading, NeedWallet, PageHead, Stat, StateBadge, Table, TxStatus, useTx } from "../components/ui";
import { proposeTx } from "../lib/dao";
import { fmtTime, fmtToken, shortAcct } from "../lib/format";
import { useIds, useSpends, useStats } from "../lib/hooks";
import type { Spend } from "../lib/types";

export default function TreasuryPage() {
  const stats = useStats();
  const spends = useSpends();
  const ids = useIds();
  const tx = useTx();
  const [filter, setFilter] = useState<"all" | "rejected" | "pending">("all");

  const rows = (spends.data ?? []).filter((s) => filter === "all" || s.state.toLowerCase() === filter)
    .sort((a, b) => b.ts_iso.localeCompare(a.ts_iso));
  const rejected = (spends.data ?? []).filter((s) => s.state === "Rejected").length;

  const propose = (s: Spend) =>
    tx.run(
      proposeTx(ids.daoId, `Approve spend ${s.id}: ${fmtToken(s.amount)} tUSD to ${s.vendor}`, {
        name: "Approve spend", method: "approve_spend", description: "", args: { id: s.id },
      }, ids.contractId),
      `Proposal created on ${ids.daoId}. Council members vote on the DAO page.`,
    );

  return (
    <>
      <PageHead title="Treasury" lead="Every spend the treasurer agent attempts is recorded, including the ones the contract refused. Spends at or above the approval threshold wait for the DAO." />
      {stats.error ? <ErrorBox error={stats.error} /> : stats.data && (
        <section className="card grid cols-3" aria-label="Treasury totals">
          <Stat label="Treasury (tUSD)" value={fmtToken(stats.data.treasury)} />
          <Stat label="In escrow (open jobs)" value={fmtToken(stats.data.escrow)} />
          <Stat label="Claimable by owners" value={fmtToken(stats.data.claimable_total)} />
          <Stat label="Total in / out" value={`${fmtToken(stats.data.total_in, 0)} / ${fmtToken(stats.data.total_out, 0)}`} />
          <Stat label="Jobs settled" value={stats.data.jobs_settled} />
          <Stat label="Solvency invariant" value={<Badge tone={stats.data.solvency_ok ? "ok" : "bad"}>{stats.data.solvency_ok ? "holds" : "VIOLATED"}</Badge>}
            sub="claimable + escrow + treasury = in minus out" />
        </section>
      )}

      <section className="card" aria-labelledby="sp">
        <div className="row spread">
          <h2 id="sp">Spend attempts</h2>
          <div className="row" role="group" aria-label="Filter spends">
            {(["all", "rejected", "pending"] as const).map((f) => (
              <button key={f} className={`sm ${filter === f ? "primary" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "rejected" ? `Rejected (${rejected})` : "Pending approval"}
              </button>
            ))}
          </div>
        </div>
        <NeedWallet what="request DAO approval for a pending spend" />
        <TxStatus state={tx.state} />
        {spends.isLoading ? <Loading what="spends" /> : spends.error ? <ErrorBox error={spends.error} retry={() => spends.refetch()} /> :
          !rows.length ? <Empty>Nothing to show for this filter.</Empty> : (
            <Table label="Spend attempts" minRem={36}>
              <thead><tr><th>#</th><th>Outcome</th><th>Vendor</th><th className="num">Amount</th><th>Agent</th><th>Memo</th><th>When</th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>
                      <StateBadge state={s.state} />
                      <div className="small muted">{s.reason}</div>
                      {s.state === "Pending" && <button className="sm" style={{ marginTop: 4 }} disabled={!tx.accountId} onClick={() => void propose(s)}>Propose approval to DAO</button>}
                    </td>
                    <td><Account id={s.vendor} /></td>
                    <td className="num nowrap">{fmtToken(s.amount)}</td>
                    <td className="mono" title={s.agent_account}>{shortAcct(s.agent_account)}</td>
                    <td className="small">{s.memo}{s.job ? ` (job #${s.job})` : ""}</td>
                    <td className="small nowrap">{fmtTime(s.ts_iso)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        <p className="small muted">Budget and allowlist violations never revert: the contract records them as rejected attempts, so the attack attempts stay visible here.</p>
      </section>
    </>
  );
}
