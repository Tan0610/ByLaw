import { ENV_CONTRACT_ID, GAS_100T, PROPOSAL_BOND, RPC_URL } from "./config";
import type { DaoProposal, ProposalTemplate } from "./types";
import type { TxRequest } from "./wallet";

/** Read-only call to any contract via NEAR JSON-RPC `query/call_function`. */
export async function rpcView<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "charter-web", method: "query",
      params: {
        request_type: "call_function", finality: "optimistic", account_id: contractId,
        method_name: method, args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data ?? body.error.message ?? "RPC error");
  const bytes: number[] = body.result?.result ?? [];
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export interface DaoPolicy { roles: { name: string; kind: unknown; permissions: string[] }[]; proposal_bond: string }

export async function listProposals(daoId: string): Promise<DaoProposal[]> {
  const last = await rpcView<number>(daoId, "get_last_proposal_id");
  if (!last) return [];
  const from = Math.max(0, last - 20);
  const list = await rpcView<DaoProposal[]>(daoId, "get_proposals", { from_index: from, limit: 20 });
  return list.sort((a, b) => b.id - a.id);
}

export const getPolicy = (daoId: string) => rpcView<DaoPolicy>(daoId, "get_policy");

export function proposalSummary(p: DaoProposal): string {
  const k = p.kind;
  if ("FunctionCall" in k) {
    const fc = k.FunctionCall as { receiver_id: string; actions: { method_name: string }[] };
    return `Call ${fc.actions.map((a) => a.method_name).join(", ")} on ${fc.receiver_id}`;
  }
  return Object.keys(k)[0] ?? "Proposal";
}

export function voteTotals(p: DaoProposal) {
  let approve = 0, reject = 0, remove = 0;
  Object.values(p.vote_counts ?? {}).forEach((c) => { approve += Number(c[0]); reject += Number(c[1]); remove += Number(c[2]); });
  return { approve, reject, remove };
}

export function voteTx(daoId: string, p: DaoProposal, action: "VoteApprove" | "VoteReject"): TxRequest {
  return { receiverId: daoId, methodName: "act_proposal", args: { id: p.id, action, proposal: p.kind }, gas: GAS_100T };
}

export function proposeTx(daoId: string, description: string, t: ProposalTemplate, charterId: string): TxRequest {
  return {
    receiverId: daoId, methodName: "add_proposal", deposit: PROPOSAL_BOND, gas: GAS_100T,
    args: {
      proposal: {
        description,
        kind: {
          FunctionCall: {
            receiver_id: charterId,
            actions: [{
              method_name: t.method,
              args: toBase64(JSON.stringify(t.args)),
              deposit: t.deposit ?? "0",
              gas: t.gas ?? "150000000000000",
            }],
          },
        },
      },
    },
  };
}

// Built-in fallbacks so the page works before Lane A's templates exist or are readable.
const FALLBACK: ProposalTemplate[] = [
  {
    name: "Amend the charter", method: "set_charter",
    description: "Replace charter text and parameters. The contract bumps the version and emits old and new hashes.",
    args: { params: { text: "Edit me: the new charter text.", note: "Replace this object with the full CharterParams (see contracts/charter/ABI.md)." } },
  },
  { name: "Allow a vendor", method: "set_vendor", description: "Add a vendor to the procurement allowlist.", args: { vendor: "data-vendor.demo.testnet", allowed: true } },
  { name: "Approve a pending spend", method: "approve_spend", description: "Approve a spend above the approval threshold.", args: { id: "3" } },
  { name: "Unfreeze an agent", method: "unfreeze_agent", description: "Only the DAO can unfreeze. Guardians can only freeze.", args: { token_id: "3" } },
  { name: "Mint a seat", method: "mint_seat", description: "Mint a revenue-weighted, transferable seat NFT.", args: { owner: "new-member.demo.testnet", weight: 10 } },
];

const modules = import.meta.glob("../../../../contracts/charter/dao-proposals/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

/** Accepts Sputnik-style proposals or a plain `{method, args}` and normalises both. */
export function normalizeTemplate(file: string, raw: unknown): ProposalTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const base = file.split("/").pop()!.replace(/\.json$/, "");
  const prop = r.proposal ?? r;
  const fc = prop?.kind?.FunctionCall;
  const act = fc?.actions?.[0];
  if (act) {
    let args: Record<string, unknown> = {};
    try {
      args = typeof act.args === "string" ? JSON.parse(atob(act.args)) : act.args ?? {};
    } catch { args = {}; }
    return {
      name: r.name ?? prop.description ?? base, method: act.method_name, description: r.description ?? prop.description ?? "",
      args, deposit: act.deposit, gas: act.gas,
    };
  }
  const method = r.method ?? r.method_name;
  if (typeof method === "string") {
    return { name: r.name ?? base, method, description: r.description ?? "", args: r.args ?? {}, deposit: r.deposit, gas: r.gas };
  }
  return null;
}

export function loadTemplates(): { templates: ProposalTemplate[]; source: "repo" | "fallback" } {
  const found = Object.entries(modules).map(([f, m]) => normalizeTemplate(f, m)).filter((t): t is ProposalTemplate => !!t);
  return found.length ? { templates: found, source: "repo" } : { templates: FALLBACK, source: "fallback" };
}

export const defaultCharterId = ENV_CONTRACT_ID;
