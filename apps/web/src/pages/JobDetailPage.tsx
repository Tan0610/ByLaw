import { Link, useParams } from "react-router-dom";
import { Account, ErrorBox, Loading, PageHead, Stat, StateBadge, Table } from "../components/ui";
import { JobSteps, Timeline, Waterfall } from "../components/viz";
import { fmtTime, fmtToken, shortHash, waterfall } from "../lib/format";
import { useAgents, useArtifact, useCharter, useJob, useTimeline } from "../lib/hooks";

export default function JobDetailPage() {
  const { id = "" } = useParams();
  const job = useJob(id);
  const timeline = useTimeline(id);
  const agents = useAgents();
  const charter = useCharter();
  const artifact = useArtifact(job.data?.deliverable_hash);

  if (job.isLoading) return <Loading what="job" />;
  if (job.error) return <ErrorBox error={job.error} retry={() => job.refetch()} />;
  const j = job.data!;
  const name = (tid?: string | null) => agents.data?.find((a) => a.token_id === tid)?.account ?? (tid ? `agent #${tid}` : "none yet");
  const sortedBids = [...j.bids].sort((a, b) => (Number.isFinite(a.score) ? a.score : 1e18) - (Number.isFinite(b.score) ? b.score : 1e18));
  const credits = j.credits ?? (charter.data ? waterfall(j.price, charter.data.split) : null);

  return (
    <>
      <p className="small"><Link to="/jobs">All jobs</Link></p>
      <PageHead title={`Job #${j.id}`} lead={`Contract health brief for ${j.target}`}>
        <StateBadge state={j.state} />
      </PageHead>
      <div className="card">
        <JobSteps state={j.state} />
        <div className="grid cols-3" style={{ marginTop: 16 }}>
          <Stat label="Price in escrow" value={`${fmtToken(j.price)} tUSD`} />
          <Stat label="Customer" value={<Account id={j.customer} />} />
          <Stat label="Posted" value={<span style={{ fontSize: "1rem" }}>{fmtTime(j.created_iso)}</span>} />
          <Stat label="Winner" value={<span style={{ fontSize: "1rem" }}>{name(j.winner)}</span>} />
          <Stat label="Reviewer" value={<span style={{ fontSize: "1rem" }}>{name(j.reviewer)}</span>} />
          <Stat label="Re-open attempts" value={j.attempts} />
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <section className="card" aria-labelledby="bids" style={{ margin: 0 }}>
          <h2 id="bids">Bids and scoring</h2>
          {!sortedBids.length ? <p className="muted">No bids yet.</p> : (
            <>
              <Table label="Bids">
                <thead><tr><th>Agent</th><th className="num">Price</th><th className="num">Score</th><th /></tr></thead>
                <tbody>
                  {sortedBids.map((b, i) => (
                    <tr key={b.agent}>
                      <td className="mono break">{b.agent_account}</td>
                      <td className="num">{fmtToken(b.price)}</td>
                      <td className="num">{Number.isFinite(b.score) ? b.score.toFixed(2) : "n/a"}</td>
                      <td>{(j.winner ? b.agent === j.winner : i === 0) ? <span className="badge ok">{j.winner ? "Winner" : "Leading"}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="small muted">Score = price × 1000 / (1000 + reputation). Lowest wins, so a better reputation beats a slightly lower price.</p>
            </>
          )}
        </section>

        <section className="card" aria-labelledby="rev" style={{ margin: 0 }}>
          <h2 id="rev">Review</h2>
          {j.review ? (
            <div className={`notice ${j.review.approve ? "ok" : "bad"}`}>
              <strong>{j.review.approve ? "Approved" : "Rejected"}</strong> by {name(j.reviewer)}
              {j.review.reason && <div className="small">{j.review.reason}</div>}
            </div>
          ) : <p className="muted">{j.state === "Submitted" ? "The reviewer is recomputing the report facts from NEAR RPC…" : "Waiting for work to be submitted."}</p>}
          <p className="small muted">The reviewer owner must differ from the producer owner. Rejections cost the producer reputation.</p>
        </section>
      </div>

      <section className="card" aria-labelledby="wf">
        <h2 id="wf">Where the money goes</h2>
        {credits ? <Waterfall price={j.price} credits={credits} preview={!j.credits} /> : <p className="muted">Loading charter split…</p>}
        {!j.credits && <p className="small muted">Not settled yet. Payouts are credited to owners' claimable balance when the reviewer approves.</p>}
      </section>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <section className="card" aria-labelledby="tl" style={{ margin: 0 }}>
          <h2 id="tl">Timeline <span className="small muted">(live)</span></h2>
          {timeline.isLoading ? <Loading what="timeline" /> : timeline.error ? <ErrorBox error={timeline.error} /> : <Timeline events={timeline.data ?? []} />}
        </section>

        <section className="card" aria-labelledby="art" style={{ margin: 0 }}>
          <h2 id="art">Report</h2>
          {!j.deliverable_hash ? <p className="muted">No report yet.</p> : artifact.isLoading ? <Loading what="report" /> :
            artifact.error ? <ErrorBox error={artifact.error} /> : artifact.data && (
              <div className="stack">
                <p className="break">{artifact.data.summary}</p>
                <Table label="Verified facts">
                  <tbody>
                    <tr><th scope="row">Code hash</th><td className="mono break">{artifact.data.facts.code_hash}</td></tr>
                    <tr><th scope="row">Storage used</th><td>{artifact.data.facts.storage_usage.toLocaleString()} bytes</td></tr>
                    <tr><th scope="row">Full-access keys</th><td>{artifact.data.facts.full_access_keys}</td></tr>
                    <tr><th scope="row">Function-call keys</th><td>{artifact.data.facts.function_call_keys}</td></tr>
                    <tr><th scope="row">Upgradeable</th><td>{artifact.data.facts.upgradeable ? "yes" : "no"}</td></tr>
                    <tr><th scope="row">At block</th><td>{artifact.data.facts.fetched_at_block}</td></tr>
                  </tbody>
                </Table>
                <p className="small muted">Report hash <span className="mono" title={j.deliverable_hash}>{shortHash(j.deliverable_hash)}</span>. The reviewer recomputes these facts; the summary text is not trusted. Model: {artifact.data.model}.</p>
                <details>
                  <summary>Raw artifact JSON</summary>
                  <pre className="json">{JSON.stringify(artifact.data, null, 2)}</pre>
                </details>
              </div>
            )}
        </section>
      </div>
    </>
  );
}
