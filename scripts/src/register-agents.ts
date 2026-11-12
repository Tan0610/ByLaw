// Agent registration helper.
// 1. Generates one ed25519 key pair per agent LOCALLY (no network) and writes them to secrets/ (git-ignored).
// 2. Prints one DAO proposal per agent: register_agent(kind, name, owner_account, pubkey) with 0.5 NEAR attached.
// The contract creates <name>.<charter> with ONLY a function-call key for the role's methods.
//   OWNERS=sales:ana.testnet,analyst1:ben.testnet,analyst2:cara.testnet,reviewer:dev.testnet,treasurer:<dao> \
//   npm run register-agents -w scripts            (add --reuse to keep existing keys)
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { banner, env, ids, NEAR, parseFlags, printProposal } from "./lib.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}

export function newKeyPair(): { publicKey: string; secretKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const pub = Buffer.from(jwk.x, "base64url");
  const seed = Buffer.from(jwk.d, "base64url");
  void publicKey;
  return { publicKey: `ed25519:${base58(pub)}`, secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}` };
}

const AGENTS = [
  { env: "SALES", name: "sales", kind: "Sales" },
  { env: "ANALYST1", name: "analyst1", kind: "Analyst" },
  { env: "ANALYST2", name: "analyst2", kind: "Analyst" },
  { env: "REVIEWER", name: "reviewer", kind: "Reviewer" },
  { env: "TREASURER", name: "treasurer", kind: "Treasurer" },
] as const;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = parseFlags();
  const i = ids();
  const owners = Object.fromEntries(env("OWNERS").split(",").filter(Boolean).map((p) => p.split(":").map((s) => s.trim())));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dir = join(root, "secrets");
  const keyFile = join(dir, "agent-keys.json");
  mkdirSync(dir, { recursive: true });

  banner("Charter agent registration");
  let keys: Record<string, { publicKey: string; secretKey: string }> = {};
  if (flags.has("--reuse") && existsSync(keyFile)) keys = JSON.parse(readFileSync(keyFile, "utf8"));
  for (const a of AGENTS) keys[a.name] ??= newKeyPair();
  writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  const envLines = AGENTS.flatMap((a) => [
    `AGENT_${a.env}_ACCOUNT=${a.name}.${i.charter}`,
    `AGENT_${a.env}_PRIVATE_KEY=${keys[a.name].secretKey}`,
  ]);
  writeFileSync(join(dir, "agents.env"), envLines.join("\n") + "\n", { mode: 0o600 });
  console.log(`\nWrote ${keyFile} and ${join(dir, "agents.env")} (git-ignored; secret keys are NOT printed).`);
  console.log("Copy secrets/agents.env into your .env for services/agents.");

  for (const a of AGENTS) {
    const owner = owners[a.name] ?? (a.kind === "Treasurer" ? i.dao : `<${a.name}-owner>.testnet`);
    printProposal(`Register ${a.kind} "${a.name}" -> ${a.name}.${i.charter}, NFT to ${owner}`, i,
      `Register ${a.kind} agent ${a.name} (earnings to ${owner})`,
      [{ method: "register_agent", args: { kind: a.kind, name: a.name, owner_account: owner, pubkey: keys[a.name].publicKey }, deposit: NEAR("0.5"), gas: "200000000000000" }]);
  }
  console.log("\nSeparation of duties: the reviewer's owner must differ from both analysts' owners.");
  console.log("Verify each key is function-call only and scoped to its role's methods:");
  console.log(`  near account list-keys ${AGENTS[1].name}.${i.charter} network-config testnet now`);
}
