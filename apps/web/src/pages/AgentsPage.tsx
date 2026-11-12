import { BudgetBar } from "../components/viz";
import { Account, Badge, Empty, ErrorBox, Loading, NeedWallet, PageHead, StateBadge, TxStatus, useTx } from "../components/ui";
import { fmtToken } from "../lib/format";
import { useAgents, useByLaw, useIds } from "../lib/hooks";
import type { Agent } from "../lib/types";

const ROLE_METHODS: Record<string, string> = {
  Sales: "accept_job, award_job", Analyst: "place_bid, submit_work",
  Reviewer: "review_work", Treasurer: "request_spend, open_pool, contribute_pool",
};

function AgentCard({ a, canFreeze, onFreeze, floor }: { a: Agent; canFreeze: boolean; onFreeze: (a: Agent) => void; floor?: number }) {
  const spends = a.kind === "Analyst" || a.kind === "Treasurer";
  return (
    <article className="card" aria-labelledby={`ag${a.token_id}`}>
      <div className="row spread">
        <h2 id={`ag${a.token_id}`} style={{ margin: 0 }}>{a.kind} <span className="muted small">#{a.token_id}</span></h2>
        <StateBadge state={a.state} />
      </div>
      <p className="mono small break" style={{ margin: ".25rem 0" }}>{a.account}</p>
      <dl className="small" style={{ margin: ".5rem 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: ".2rem .75rem" }}>
        <dt className="muted">Owner (earnings go to)</dt><dd style={{ margin: 0 }}><Account id={a.owner} /></dd>
        <dt className="muted">Reputation</dt>
        <dd style={{ margin: 0 }}>{a.rep} {floor !== undefined && a.rep < floor + 30 && a.state === "Active" && <Badge tone="warn">near auto-freeze at {floor}</Badge>}</dd>
        <dt className="muted">Delivered / rejected</dt><dd style={{ margin: 0 }}>{a.delivered} / {a.rejected}</dd>
        <dt className="muted">Earnings</dt><dd style={{ margin: 0 }}>{fmtToken(a.earnings)} tUSD</dd>
        <dt className="muted">Key scope</dt><dd style={{ margin: 0 }} className="mono">{ROLE_METHODS[a.kind]}</dd>
      </dl>
      {spends ? <BudgetBar label="Budget this window" spent={a.win_spent} budget={a.budget} /> : <p className="small muted">This role does not spend.</p>}
      {a.state === "Frozen" && <p className="notice bad small" style={{ marginTop: ".75rem" }}>Frozen: {a.frozen_reason ?? "no reason recorded"}. Only the DAO can unfreeze.</p>}
      {a.state === "Active" && (
        <div style={{ marginTop: ".75rem" }}>
          <button className="danger sm" disabled={!canFreeze} onClick={() => onFreeze(a)} aria-label={`Freeze ${a.account}`}>Freeze agent</button>
          {!canFreeze && <span className="small muted"> Guardians only.</span>}
        </div>
      )}
    </article>
  );
}

export default function AgentsPage() {
  const agents = useAgents();
  const bylaw = useByLaw();
  const ids = useIds();
  const tx = useTx();
  const isGuardian = !!tx.accountId && (ids.guardians.includes(tx.accountId) || tx.accountId === ids.daoId);

  const freeze = (a: Agent) => {
    if (!window.confirm(`Freeze ${a.account}? It stops acting immediately. Only the DAO can unfreeze it.`)) return;
    void tx.run({ receiverId: ids.contractId, methodName: "freeze_agent", args: { token_id: a.token_id, reason: "Frozen by guardian from the ByLaw UI" } }, `Froze ${a.account}.`);
  };

  return (
    <>
      <PageHead title="Agents" lead="Each agent is a NEAR sub-account with a key limited to its role's methods, and an NFT whose owner receives its earnings. Spending limits rise with delivered work." />
      <NeedWallet what="freeze an agent (guardians only)" />
      <TxStatus state={tx.state} />
      {agents.isLoading ? <Loading what="agents" /> : agents.error ? <ErrorBox error={agents.error} retry={() => agents.refetch()} /> :
        !agents.data?.length ? <Empty>No agents are registered yet. The DAO registers them with register_agent.</Empty> : (
          <div className="grid cols-3">
            {agents.data.map((a) => <AgentCard key={a.token_id} a={a} canFreeze={isGuardian} onFreeze={freeze} floor={bylaw.data?.rep_freeze_below} />)}
          </div>
        )}
    </>
  );
}
