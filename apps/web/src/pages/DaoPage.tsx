import { useMemo, useState, type FormEvent } from "react";
import { Account, Badge, Empty, ErrorBox, Loading, NeedWallet, PageHead, StateBadge, TxStatus, useTx } from "../components/ui";
import { getPolicy, loadTemplates, proposalSummary, proposeTx, voteTotals, voteTx } from "../lib/dao";
import { fmtTime } from "../lib/format";
import { useIds, useProposals } from "../lib/hooks";
import { useQuery } from "@tanstack/react-query";
import type { DaoProposal } from "../lib/types";

function submittedIso(p: DaoProposal): string {
  const ms = Number(p.submission_time) / 1e6;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export default function DaoPage() {
  const ids = useIds();
  const proposals = useProposals(ids.daoId);
  const policy = useQuery({ queryKey: ["policy", ids.daoId], queryFn: () => getPolicy(ids.daoId), enabled: !!ids.daoId });
  const tx = useTx();
  const { templates, source } = useMemo(loadTemplates, []);
  const [tIdx, setTIdx] = useState(0);
  const [desc, setDesc] = useState("");
  const [argsText, setArgsText] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const t = templates[tIdx];
  const council = new Set(
    (policy.data?.roles ?? []).flatMap((r) => {
      const k = r.kind as { Group?: string[] };
      return k.Group ?? [];
    }),
  );
  const isMember = !!tx.accountId && council.has(tx.accountId);
  const currentArgs = argsText ?? JSON.stringify(t?.args ?? {}, null, 2);

  const create = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    let args: Record<string, unknown>;
    try { args = JSON.parse(currentArgs); } catch { return setFormError("Arguments are not valid JSON."); }
    if (!desc.trim()) return setFormError("Describe the proposal so voters know what they approve.");
    void tx.run(proposeTx(ids.daoId, desc.trim(), { ...t, args }, ids.contractId), "Proposal created. Council members can now vote.");
  };

  return (
    <>
      <PageHead title="DAO" lead="A Sputnik DAO owns the Charter contract. Every rule change, agent registration, vendor, seat and spend approval is a proposal that the council votes on." />
      <div className="card row spread">
        <div><div className="small muted">DAO account</div><Account id={ids.daoId} /></div>
        <div><div className="small muted">Owns contract</div><Account id={ids.contractId} /></div>
        <div><div className="small muted">Guardians (freeze only)</div>{ids.guardians.length ? ids.guardians.map((g) => <div key={g}><Account id={g} /></div>) : <span className="muted">none</span>}</div>
        <div><div className="small muted">Council</div>{council.size ? [...council].map((g) => <div key={g}><Account id={g} /></div>) : <span className="muted">loading…</span>}</div>
      </div>

      <section className="card" aria-labelledby="props">
        <h2 id="props">Proposals</h2>
        <NeedWallet what="vote on proposals" />
        <TxStatus state={tx.state} />
        {proposals.isLoading ? <Loading what="proposals" /> : proposals.error ? <ErrorBox error={proposals.error} retry={() => proposals.refetch()} /> :
          !proposals.data?.length ? <Empty>No proposals yet. Create one below.</Empty> : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {proposals.data.map((p) => {
                const v = voteTotals(p);
                const mine = tx.accountId ? p.votes[tx.accountId] : undefined;
                const open = p.status === "InProgress";
                return (
                  <li key={p.id} className="card" style={{ marginTop: 12 }}>
                    <div className="row spread">
                      <strong>#{p.id} {p.description}</strong>
                      <StateBadge state={p.status} />
                    </div>
                    <p className="small muted" style={{ margin: ".25rem 0" }}>
                      {proposalSummary(p)} · proposed by <span className="mono">{p.proposer}</span> · {fmtTime(submittedIso(p))}
                    </p>
                    <div className="row">
                      <Badge tone="ok">{v.approve} approve</Badge>
                      <Badge tone="bad">{v.reject} reject</Badge>
                      {mine && <Badge tone="info">you voted {mine.toLowerCase()}</Badge>}
                    </div>
                    {open && (
                      <div className="row" style={{ marginTop: 8 }}>
                        <button className="primary sm" disabled={!isMember || !!mine || tx.state.status === "pending"} onClick={() => void tx.run(voteTx(ids.daoId, p, "VoteApprove"), `Approve vote on #${p.id} recorded.`)}>Approve</button>
                        <button className="sm" disabled={!isMember || !!mine || tx.state.status === "pending"} onClick={() => void tx.run(voteTx(ids.daoId, p, "VoteReject"), `Reject vote on #${p.id} recorded.`)}>Reject</button>
                        {!isMember && tx.accountId && <span className="small muted">Only council members vote.</span>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </section>

      <section className="card" aria-labelledby="new">
        <h2 id="new">Create a proposal</h2>
        <p className="small muted">Templates come from {source === "repo" ? <code>contracts/charter/dao-proposals/</code> : "a built-in fallback (the contract's dao-proposals folder was empty or unreadable)"}. It wraps the call in a Sputnik <code>FunctionCall</code> proposal to the Charter contract. A bond of 0.1 NEAR is attached.</p>
        <form onSubmit={create} noValidate className="stack">
          <div>
            <label htmlFor="tpl">Template</label>
            <select id="tpl" value={tIdx} onChange={(e) => { setTIdx(Number(e.target.value)); setArgsText(null); }}>
              {templates.map((x, i) => <option key={x.name + i} value={i}>{x.name} ({x.method})</option>)}
            </select>
            <div className="hint">{t?.description}</div>
          </div>
          <div>
            <label htmlFor="desc">Description (shown to voters)</label>
            <input id="desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Why this change?" />
          </div>
          <div>
            <label htmlFor="args">Method arguments (JSON)</label>
            <textarea id="args" value={currentArgs} onChange={(e) => setArgsText(e.target.value)} spellCheck={false} />
          </div>
          {formError && <p role="alert" className="notice bad">{formError}</p>}
          <div className="row">
            <button className="primary" type="submit" disabled={!isMember || tx.state.status === "pending"}>Create proposal</button>
            {!isMember && <span className="small muted">{tx.accountId ? "Only council members can propose." : "Connect a council wallet."}</span>}
          </div>
        </form>
      </section>
    </>
  );
}
