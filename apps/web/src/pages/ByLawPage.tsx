import { useState } from "react";
import { DiffView } from "../components/viz";
import { Empty, ErrorBox, Loading, PageHead, Table } from "../components/ui";
import { bpsPct, fmtNs, fmtTime, fmtToken, shortHash } from "../lib/format";
import { useByLaw, useByLawHistory } from "../lib/hooks";
import type { ByLawParams } from "../lib/types";

function paramRows(c: ByLawParams): [string, string, string][] {
  return [
    ["Price band", `${fmtToken(c.min_price)} to ${fmtToken(c.max_price)} tUSD`, "Jobs outside the band are refunded in full."],
    ["Bid window", fmtNs(c.bid_window_ns), "Analysts bid during this time."],
    ["Submit window", fmtNs(c.submit_window_ns), "The winner must deliver in time or loses reputation."],
    ["Review window", fmtNs(c.review_window_ns), "Then anyone can escalate to the DAO."],
    ["Max bid", bpsPct(c.max_bid_bps) + " of price", "Bids above this are rejected."],
    ["Split: producer", bpsPct(c.split.producer), "To the owner of the winning analyst."],
    ["Split: seats", bpsPct(c.split.seats), "To seat holders by weight."],
    ["Split: treasury", bpsPct(c.split.treasury), "Plus all rounding."],
    ["Split: reviewer", bpsPct(c.split.reviewer), "To the owner of the reviewer."],
    ["Split: sales", bpsPct(c.split.sales), "To the owner of the sales agent."],
    ["Reputation", `start ${c.rep_start}, +${c.rep_gain} accepted, -${c.rep_loss} rejected, -${c.rep_expire_loss} expired`, `Auto-freeze below ${c.rep_freeze_below}.`],
    ["Budget", `${fmtToken(c.base_budget)} + ${fmtToken(c.per_rep_budget)} per 100 rep, max ${fmtToken(c.max_budget)} tUSD`, `Per ${fmtNs(c.budget_window_ns)} window.`],
    ["Per-spend cap", `${fmtToken(c.per_tx_cap)} tUSD`, "Single spend limit."],
    ["Approval threshold", `${fmtToken(c.approval_threshold)} tUSD`, "Spends at or above this wait for DAO approval."],
  ];
}

export default function ByLawPage() {
  const bylaw = useByLaw();
  const history = useByLawHistory();
  const [pick, setPick] = useState<number | null>(null);

  if (bylaw.isLoading || history.isLoading) return <Loading what="bylaw" />;
  if (bylaw.error) return <ErrorBox error={bylaw.error} retry={() => bylaw.refetch()} />;
  const c = bylaw.data!;
  const versions = [...(history.data ?? [])].sort((a, b) => b.version - a.version);
  const selected = versions.find((v) => v.version === pick) ?? versions[0];
  const prev = selected ? versions.find((v) => v.version === selected.version - 1) : undefined;

  return (
    <>
      <PageHead title="ByLaw" lead="The company constitution. It lives on-chain, only the DAO can change it, and the contract enforces the parameters below." />
      <div className="grid cols-2 start">
        <div>
        <section className="card" aria-labelledby="ct">
          <div className="row spread">
            <h2 id="ct">Text, version {c.version}</h2>
            <span className="mono small muted" title={c.text_hash}>sha256 {shortHash(c.text_hash)}</span>
          </div>
          <pre className="text">{c.text}</pre>
        </section>

        <section className="card" aria-labelledby="hist">
          <h2 id="hist">Version history</h2>
          {history.error ? <ErrorBox error={history.error} /> : !versions.length ? <Empty>No history yet.</Empty> : (
            <div className="stack">
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="ByLaw versions">
                {versions.map((v) => (
                  <li key={v.version} style={{ marginBottom: ".5rem" }}>
                    <button
                      onClick={() => setPick(v.version)}
                      aria-pressed={selected?.version === v.version}
                      className={selected?.version === v.version ? "primary" : ""}
                      style={{ width: "100%", justifyContent: "space-between" }}
                    >
                      <span>Version {v.version}</span>
                      <span className="small">{v.changed_at_iso ? fmtTime(v.changed_at_iso) : "earlier version"}</span>
                    </button>
                    <div className="small muted">{v.note}{v.proposal_id !== undefined ? ` · DAO proposal #${v.proposal_id}` : ""} · <span className="mono">{shortHash(v.text_hash)}</span></div>
                  </li>
                ))}
              </ul>
              <div>
                <h3>{prev ? `Changes from version ${prev.version} to ${selected!.version}` : selected?.version === 1 ? "Version 1 (original text)" : `Version ${selected?.version}`}</h3>
                {selected && (prev ? <DiffView before={prev.text} after={selected.text} /> : <pre className="text">{selected.text}</pre>)}
              </div>
            </div>
          )}
        </section>
        </div>
        <section className="card" aria-labelledby="cp">
          <h2 id="cp">Parameters</h2>
          <Table label="ByLaw parameters">
            <tbody>
              {paramRows(c).map(([k, v, note]) => (
                <tr key={k}><th scope="row" style={{ textTransform: "none", fontSize: ".9rem" }}>{k}</th><td>{v}<div className="small muted">{note}</div></td></tr>
              ))}
            </tbody>
          </Table>
        </section>
      </div>
    </>
  );
}
