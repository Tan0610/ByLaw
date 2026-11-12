// Shared helpers for the ops scripts. These scripts PRINT commands and JSON for a human to run.
// They never sign or send a transaction and never read private keys.

export const env = (k: string, fallback = ""): string => (process.env[k] ?? "").trim() || fallback;

export interface Ids { dao: string; charter: string; token: string; proposer: string; network: string }

export function ids(): Ids {
  return {
    dao: env("DAO_ID", "<your-dao>.sputnikv2.testnet"),
    charter: env("CHARTER_CONTRACT_ID", "charter.<you>.testnet"),
    token: env("TOKEN_ID", "tusd.<you>.testnet"),
    proposer: env("PROPOSER", "<council-member>.testnet"),
    network: env("NEAR_NETWORK", "testnet"),
  };
}

export const NEAR = (n: number | string): string => {
  const [w, f = ""] = String(n).split(".");
  return (BigInt(w) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString();
};
export const TGAS = (n: number): string => (BigInt(n) * 10n ** 12n).toString();
export const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface FnCall { method: string; args: unknown; deposit?: string; gas?: string }

/** Sputnik v2 `add_proposal` args for a FunctionCall on the Charter contract. */
export function proposal(description: string, receiver: string, calls: FnCall[]) {
  return {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: receiver,
          actions: calls.map((c) => ({ method_name: c.method, args: b64(c.args), deposit: c.deposit ?? "0", gas: c.gas ?? TGAS(150) })),
        },
      },
    },
  };
}

/** near-cli-rs (`near` 0.x) command for a function call, signed by the human's keychain. */
export function nearCall(o: { contract: string; method: string; args: unknown; signer: string; depositNear?: string; gasT?: number; network?: string }): string {
  return [
    `near contract call-function as-transaction ${o.contract} ${o.method}`,
    `json-args ${q(JSON.stringify(o.args))}`,
    `prepaid-gas '${o.gasT ?? 100} Tgas' attached-deposit '${o.depositNear ?? "0"} NEAR'`,
    `sign-as ${o.signer} network-config ${o.network ?? "testnet"} sign-with-keychain send`,
  ].join(" \\\n    ");
}

export function nearView(contract: string, method: string, args: unknown = {}, network = "testnet"): string {
  return `near contract call-function as-read-only ${contract} ${method} json-args ${q(JSON.stringify(args))} network-config ${network} now`;
}

/** Print an add_proposal command plus the vote command template. */
export function printProposal(title: string, i: Ids, description: string, calls: FnCall[], bondNear = "0.1") {
  const p = proposal(description, i.charter, calls);
  console.log(`\n## ${title}`);
  console.log("Decoded call(s):");
  for (const c of calls) console.log(`  ${i.charter}.${c.method}(${JSON.stringify(c.args)})${c.deposit && c.deposit !== "0" ? ` deposit ${c.deposit} yocto` : ""}`);
  console.log("Propose (any council member):");
  console.log("  " + nearCall({ contract: i.dao, method: "add_proposal", args: p, signer: i.proposer, depositNear: bondNear, network: i.network }));
  console.log("Then each voter (ID from get_last_proposal_id minus 1; `proposal` must repeat the kind):");
  console.log("  " + nearCall({ contract: i.dao, method: "act_proposal", args: { id: "<ID>", action: "VoteApprove", proposal: p.proposal.kind }, signer: "<voter>.testnet", gasT: 300, network: i.network }));
}

export function banner(name: string) {
  console.log(`# ${name}`);
  console.log("# DRY RUN: this script only prints commands. It signs nothing and sends nothing.");
  console.log("# A human reviews and runs each command with near-cli-rs (https://github.com/near/near-cli-rs).");
}

export function parseFlags(argv = process.argv.slice(2)) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  if (flags.has("--execute") || flags.has("--send")) {
    console.error("Refusing: these helpers never sign or send. Run the printed commands yourself after reviewing them.");
    process.exit(2);
  }
  return flags;
}
