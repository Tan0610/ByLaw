import { useCallback, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EXPLORER_URL, USE_MOCKS } from "../lib/config";
import { useWallet, type TxRequest, type TxResult } from "../lib/wallet";

export function Badge({ tone, children }: { tone?: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}

const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "info" | undefined> = {
  Active: "ok", Frozen: "bad", Retired: undefined,
  Posted: "info", Open: "info", Awarded: "info", Submitted: "warn", Accepted: "ok", Settled: "ok",
  Rejected: "bad", Refunded: "warn", Expired: "bad",
  Paid: "ok", Pending: "warn", Approved: "ok",
  InProgress: "warn",
};
export function StateBadge({ state }: { state: string }) {
  return <Badge tone={STATE_TONE[state]}>{state}</Badge>;
}

export function Loading({ what = "data" }: { what?: string }) {
  return <p role="status" className="muted">Loading {what}…</p>;
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="notice bad">
      <strong>Something went wrong.</strong> <span className="break">{msg}</span>
      {retry && <> <button className="sm" onClick={retry}>Retry</button></>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

export function PageHead({ title, lead, children }: { title: string; lead?: string; children?: ReactNode }) {
  return (
    <div className="row spread" style={{ alignItems: "flex-start", marginBottom: 8 }}>
      <div>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="v">{value}</span>
      <span className="l">{label}</span>
      {sub && <span className="l">{sub}</span>}
    </div>
  );
}

export function Account({ id }: { id?: string | null }) {
  if (!id) return <span className="muted">none</span>;
  if (USE_MOCKS) return <span className="mono break">{id}</span>;
  return <a className="mono break" href={`${EXPLORER_URL}/address/${id}`} target="_blank" rel="noreferrer">{id}</a>;
}

export function TxLink({ hash }: { hash?: string }) {
  if (!hash) return null;
  if (USE_MOCKS) return <span className="mono small">tx {hash.slice(0, 12)}… (mock)</span>;
  return <a className="small" href={`${EXPLORER_URL}/txns/${hash}`} target="_blank" rel="noreferrer">View transaction</a>;
}

export interface TxState { status: "idle" | "pending" | "ok" | "error"; message?: string; hash?: string }

/** Runs a wallet call, tracks status for an aria-live region, and refreshes cached data afterwards. */
export function useTx() {
  const wallet = useWallet();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });
  const run = useCallback(async (tx: TxRequest, okMessage = "Transaction sent."): Promise<TxResult> => {
    setState({ status: "pending" });
    const r = await wallet.call(tx);
    if (r.ok) {
      setState({ status: "ok", message: r.redirected ? "Approve in your wallet; you will return here." : okMessage, hash: r.hash });
      await qc.invalidateQueries();
    } else {
      setState({ status: "error", message: r.error });
    }
    return r;
  }, [wallet, qc]);
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset, accountId: wallet.accountId };
}

export function TxStatus({ state }: { state: TxState }) {
  return (
    <div aria-live="polite" role="status">
      {state.status === "pending" && <p className="muted">Waiting for the wallet…</p>}
      {state.status === "ok" && <p className="notice ok">{state.message} <TxLink hash={state.hash} /></p>}
      {state.status === "error" && <p className="notice bad" role="alert">{state.message}</p>}
    </div>
  );
}

export function NeedWallet({ what }: { what: string }) {
  const w = useWallet();
  if (w.accountId) return null;
  return (
    <p className="notice warn">
      Connect a wallet to {what}. <button className="sm" onClick={w.connect}>Connect</button>
    </p>
  );
}

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label={label}><table>{children}</table></div>;
}
