import { diffLines, diffStats } from "../lib/diff";
import { fmtTime, fmtToken, pct, shortHash } from "../lib/format";
import type { Credits, TimelineEvent } from "../lib/types";

export function BudgetBar({ spent, budget, label }: { spent: string; budget: string; label: string }) {
  const p = pct(spent, budget);
  const remaining = BigInt(budget || "0") - BigInt(spent || "0");
  const tone = p >= 90 ? "bad" : p >= 70 ? "warn" : "";
  return (
    <div>
      <div className="row spread small">
        <span>{label}</span>
        <span className="nowrap">{fmtToken(spent)} of {fmtToken(budget)} tUSD used</span>
      </div>
      <div className={`bar ${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <span style={{ width: `${p}%` }} />
      </div>
      <div className="small muted">{fmtToken(remaining < 0n ? 0n : remaining)} tUSD left in this window</div>
    </div>
  );
}

const WF: { key: keyof Credits; label: string; cls: string; to: string }[] = [
  { key: "producer", label: "Producer", cls: "c1", to: "owner of the winning analyst" },
  { key: "seats", label: "Seats", cls: "c2", to: "seat holders, by weight" },
  { key: "treasury", label: "Treasury", cls: "c3", to: "DAO treasury (gets rounding)" },
  { key: "reviewer", label: "Reviewer", cls: "c4", to: "owner of the reviewer agent" },
  { key: "sales", label: "Sales", cls: "c5", to: "owner of the sales agent" },
];

export function Waterfall({ price, credits, preview }: { price: string; credits: Credits; preview?: boolean }) {
  const total = BigInt(price);
  const sum = (Object.values(credits) as string[]).reduce((s, v) => s + BigInt(v), 0n);
  return (
    <div>
      <div className="wf" role="img" aria-label={`Revenue split of ${fmtToken(price)} tUSD: ` + WF.map((w) => `${w.label} ${fmtToken(credits[w.key])}`).join(", ")}>
        {WF.map((w) => {
          const p = total === 0n ? 0 : Number((BigInt(credits[w.key]) * 10000n) / total) / 100;
          return p > 0 ? <div key={w.key} className={w.cls} style={{ width: `${p}%` }}>{p >= 9 ? `${p.toFixed(0)}%` : ""}</div> : null;
        })}
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: ".75rem 0 0" }}>
        {WF.map((w) => (
          <li key={w.key} className="row spread small" style={{ padding: ".15rem 0" }}>
            <span><span className={`dot ${w.cls}`} aria-hidden="true" />{w.label} <span className="muted">to {w.to}</span></span>
            <span className="mono nowrap">{fmtToken(credits[w.key])}</span>
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {preview ? "Preview from the bylaw split. " : ""}
        Sum {fmtToken(sum.toString())} of {fmtToken(price)} tUSD: {sum === total ? "conserved to the unit." : "MISMATCH, investigate."}
      </p>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  job_posted: "Customer paid into escrow", job_opened: "Sales agent accepted the job", bid_placed: "Analyst placed a bid",
  job_awarded: "Job awarded", work_submitted: "Analyst submitted the report", work_reviewed: "Reviewer decided",
  job_settled: "Revenue split settled", job_refunded: "Refunded to customer", job_expired: "Job expired", review_overridden: "DAO overrode the review",
  spend_recorded: "Treasurer spend recorded", spend_approved: "DAO approved a spend", spend_paid: "Spend paid out", bylaw_updated: "ByLaw amended by the DAO",
};

function detail(e: TimelineEvent): string {
  const d = e.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (e.event) {
    case "job_posted": return `${d.customer} paid ${fmtToken(d.price)} tUSD for ${d.target}`;
    case "bid_placed": return `${d.agent} bid ${fmtToken(d.price)} tUSD`;
    case "job_awarded": return `winner agent #${d.winner}, reviewer agent #${d.reviewer}`;
    case "work_submitted": return `report ${shortHash(String(d.deliverable_hash))}`;
    case "work_reviewed": return d.approve ? "Approved" : `Rejected${d.reason ? `: ${d.reason}` : ""}`;
    case "job_settled": return `${fmtToken(d.price)} tUSD distributed`;
    case "job_refunded": case "job_expired": return String(d.reason ?? "");
    case "spend_recorded": return `${fmtToken(d.amount)} tUSD to ${d.vendor} · ${String(d.outcome ?? "")}`;
    case "spend_approved": case "spend_paid": return `request #${d.request_id}`;
    case "bylaw_updated": return `version ${d.version}`;
    default: return "";
  }
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="muted">No events yet.</p>;
  return (
    <ol className="timeline" aria-label="Job timeline">
      {events.map((e, i) => {
        const bad = (e.event === "work_reviewed" && e.data.approve === false) || e.event === "job_expired";
        return (
          <li key={i} className={bad ? "bad" : ""}>
            <div className="ev">{EVENT_LABEL[e.event] ?? e.event}</div>
            <div className="small muted">{fmtTime(e.ts_iso)}{detail(e) ? ` · ${detail(e)}` : ""}</div>
          </li>
        );
      })}
    </ol>
  );
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const d = diffLines(before, after);
  const s = diffStats(d);
  return (
    <div>
      <p className="small muted" style={{ margin: "0 0 .4rem" }}>{s.added} added, {s.removed} removed</p>
      <div className="diff" role="group" aria-label="Text diff">
        {d.map((l, i) => <div key={i} className={l.kind}>{l.text || " "}<span className="sr-only">{l.kind === "add" ? " (added)" : l.kind === "del" ? " (removed)" : ""}</span></div>)}
      </div>
    </div>
  );
}

const STEPS = ["Posted", "Open", "Awarded", "Submitted", "Settled"] as const;
export function JobSteps({ state }: { state: string }) {
  const idx = state === "Accepted" ? 3 : STEPS.indexOf(state as (typeof STEPS)[number]);
  const dead = ["Refunded", "Expired", "Rejected"].includes(state);
  return (
    <ol className="steps" aria-label="Job progress">
      {STEPS.map((s, i) => (
        <li key={s} className={dead ? "" : i < idx || (state === "Settled" && i === idx) ? "done" : i === idx ? "now" : ""} aria-current={i === idx ? "step" : undefined}>{s}</li>
      ))}
      {dead && <li className="now" style={{ background: "var(--bad)" }}>{state}</li>}
    </ol>
  );
}
