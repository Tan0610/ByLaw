import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Empty, ErrorBox, Loading, NeedWallet, PageHead, StateBadge, Table, TxStatus, useTx, Account } from "../components/ui";
import { JobSteps } from "../components/viz";
import { fmtTime, fmtToken, parseToken } from "../lib/format";
import { useByLaw, useIds, useJobs } from "../lib/hooks";
import { ONE_YOCTO, GAS_300T } from "../lib/config";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export default function JobsPage() {
  const jobs = useJobs();
  const bylaw = useByLaw();
  const ids = useIds();
  const tx = useTx();
  const [target, setTarget] = useState("dex.demo.testnet");
  const [price, setPrice] = useState("100");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const t = target.trim();
    if (t.length < 2 || t.length > 64 || !ACCOUNT_RE.test(t)) return setFormError("Enter a valid NEAR account id, for example dex.testnet.");
    let amount: string;
    try { amount = parseToken(price); } catch (err) { return setFormError((err as Error).message); }
    const c = bylaw.data;
    if (c && (BigInt(amount) < BigInt(c.min_price) || BigInt(amount) > BigInt(c.max_price)))
      return setFormError(`The bylaw price band is ${fmtToken(c.min_price)} to ${fmtToken(c.max_price)} tUSD.`);
    void tx.run({
      receiverId: ids.tokenId, methodName: "ft_transfer_call", deposit: ONE_YOCTO, gas: GAS_300T,
      args: { receiver_id: ids.contractId, amount, msg: JSON.stringify({ action: "post_job", target: t }) },
    }, "Paid into escrow. The job appears below and updates live.");
  };

  return (
    <>
      <PageHead title="Jobs" lead="Order a contract health brief. Your payment is held in escrow until a reviewer agent approves the work, and refunded if it fails." />
      <section className="card" aria-labelledby="post">
        <h2 id="post">Order a brief</h2>
        <NeedWallet what="pay for a job" />
        <form onSubmit={submit} noValidate className="grid cols-3" aria-describedby="postnote">
          <div>
            <label htmlFor="target">NEAR contract to analyse</label>
            <input id="target" value={target} onChange={(e) => setTarget(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="price">Price (tUSD)</label>
            <input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
            {bylaw.data && <div className="hint">Band {fmtToken(bylaw.data.min_price, 0)} to {fmtToken(bylaw.data.max_price, 0)} tUSD</div>}
          </div>
          <div style={{ alignSelf: "end" }}>
            <button className="primary" type="submit" disabled={!tx.accountId || tx.state.status === "pending"}>Pay and post job</button>
          </div>
        </form>
        <p id="postnote" className="hint">Sends <code>ft_transfer_call</code> on the tUSD token with message <code>{`{"action":"post_job","target":"…"}`}</code>.</p>
        {formError && <p role="alert" className="notice bad">{formError}</p>}
        <TxStatus state={tx.state} />
      </section>

      <section className="card" aria-labelledby="all">
        <h2 id="all">All jobs</h2>
        {jobs.isLoading ? <Loading what="jobs" /> : jobs.error ? <ErrorBox error={jobs.error} retry={() => jobs.refetch()} /> :
          !jobs.data?.length ? <Empty>No jobs yet. Order one above.</Empty> : (
            <Table label="Jobs" minRem={34}>
              <thead><tr><th>Job</th><th>Target</th><th>Customer</th><th className="num">Price</th><th>Progress</th><th>Created</th></tr></thead>
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id}>
                    <td><Link to={`/jobs/${j.id}`}>#{j.id}</Link> <StateBadge state={j.state} /></td>
                    <td className="mono break">{j.target}</td>
                    <td><Account id={j.customer} /></td>
                    <td className="num nowrap">{fmtToken(j.price)}</td>
                    <td><JobSteps state={j.state} /></td>
                    <td className="small nowrap">{fmtTime(j.created_iso)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
      </section>
    </>
  );
}
