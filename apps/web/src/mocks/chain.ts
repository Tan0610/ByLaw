import type { TxRequest, TxResult } from "../lib/wallet";
import { COUNCIL, CONTRACT, DAO, TOKEN, config } from "./fixtures";
import { mockStore as S } from "./store";

const fail = (error: string): TxResult => ({ ok: false, error });
let counter = 0;
const ok = (): TxResult => ({ ok: true, hash: `mocktx${(++counter).toString().padStart(4, "0")}${"a".repeat(20)}` });

/**
 * Mock of "the wallet sends a function call to the chain".
 * Enforces the same access rules as the contract so UI flows can be demonstrated and tested without a network.
 */
export const mockChain = {
  call(signer: string, tx: TxRequest): TxResult {
    const { receiverId: to, methodName: m, args } = tx;
    const a = args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (to === TOKEN && m === "ft_transfer_call") {
      if (a.receiver_id !== CONTRACT) return fail("Mock supports ft_transfer_call to the Charter contract only.");
      let msg: { action?: string; target?: string } = {};
      try { msg = JSON.parse(String(a.msg)); } catch { return fail("msg is not valid JSON"); }
      if (msg.action === "post_job") {
        const r = S.postJob(signer, String(a.amount), String(msg.target ?? ""));
        return r.ok ? ok() : fail(r.error!);
      }
      return fail("Unknown action: the contract refunds the whole amount.");
    }

    if (to === CONTRACT) {
      switch (m) {
        case "freeze_agent": {
          if (!config.guardians.includes(signer) && signer !== DAO) return fail("Smart contract panicked: only a guardian or the DAO can freeze");
          return S.freeze(String(a.token_id), String(a.reason ?? "")) ? ok() : fail("Unknown agent");
        }
        case "claim": {
          const amt = S.claimable[signer] ?? "0";
          if (amt === "0") return fail("Nothing to claim");
          S.claimable[signer] = "0";
          S.stats.claimable_total = (BigInt(S.stats.claimable_total) - BigInt(amt)).toString();
          S.stats.total_out = (BigInt(S.stats.total_out) + BigInt(amt)).toString();
          S.ping("claimable"); S.ping("stats");
          return ok();
        }
        case "checkpoint_seat": {
          const s = S.seats.find((x) => x.token_id === String(a.token_id));
          if (!s) return fail("Unknown seat");
          S.claimable[s.owner] = (BigInt(S.claimable[s.owner] ?? "0") + BigInt(s.pending)).toString();
          S.stats.claimable_total = (BigInt(S.stats.claimable_total) + BigInt(s.pending)).toString();
          s.pending = "0";
          S.ping("seats"); S.ping("claimable");
          return ok();
        }
        default:
          return fail(`Mock does not implement ${m}. Owner methods go through the DAO.`);
      }
    }

    if (to === DAO) {
      if (!COUNCIL.includes(signer)) return fail("Smart contract panicked: ERR_PERMISSION_DENIED (not a council member)");
      if (m === "add_proposal") {
        const p = a.proposal as { description: string; kind: Record<string, unknown> };
        S.proposals.unshift({
          id: S.nextProposal++, proposer: signer, description: p.description, kind: p.kind, status: "InProgress",
          vote_counts: {}, votes: {}, submission_time: String(Date.now() * 1e6),
        });
        S.ping("proposals");
        return ok();
      }
      if (m === "act_proposal") {
        const p = S.proposals.find((x) => x.id === Number(a.id));
        if (!p) return fail("ERR_NO_PROPOSAL");
        if (p.status !== "InProgress") return fail("ERR_PROPOSAL_NOT_IN_PROGRESS");
        if (p.votes[signer]) return fail("ERR_ALREADY_VOTED");
        const approve = a.action === "VoteApprove";
        p.votes[signer] = approve ? "Approve" : "Reject";
        const c = (p.vote_counts.council ??= ["0", "0", "0"]);
        c[approve ? 0 : 1] = String(Number(c[approve ? 0 : 1]) + 1);
        const need = Math.floor(COUNCIL.length / 2) + 1;
        if (Number(c[0]) >= need) { p.status = "Approved"; S.applyProposal(p); }
        else if (Number(c[1]) >= need) p.status = "Rejected";
        S.ping("proposals");
        return ok();
      }
    }
    return fail(`Mock does not implement ${to}.${m}`);
  },
};
