// DAO bootstrap helper: prints the exact steps to create the Sputnik DAO, hand it ownership of the
// ByLaw contract, and configure guardians and vendors.
//   COUNCIL=ana.testnet,dev.testnet,mem.testnet DAO_NAME=bylaw-dao BYLAW_CONTRACT_ID=... TOKEN_ID=... \
//   PROPOSER=ana.testnet GUARDIANS=guardian.testnet VENDORS=data-vendor.testnet npm run bootstrap -w scripts
import { b64, banner, env, ids, nearCall, nearView, parseFlags, printProposal } from "./lib.ts";

parseFlags();
const i = ids();
const name = env("DAO_NAME", "bylaw-dao");
const council = env("COUNCIL", "<member1>.testnet,<member2>.testnet,<member3>.testnet").split(",").map((s) => s.trim()).filter(Boolean);
const guardians = env("GUARDIANS", "<guardian>.testnet").split(",").map((s) => s.trim()).filter(Boolean);
const vendors = env("VENDORS", "<data-vendor>.testnet").split(",").map((s) => s.trim()).filter(Boolean);
const dao = env("DAO_ID", `${name}.sputnikv2.testnet`);
const creator = env("CREATOR", council[0] ?? "<you>.testnet");

banner("ByLaw DAO bootstrap");
console.log(`\nDAO ${dao}, council ${council.join(", ")}, contract ${i.bylaw}, token ${i.token}`);

console.log("\n## 1. Check balances (the Sputnik factory needs about 6 NEAR attached; use the testnet faucet first)");
console.log(`  near account view-account-summary ${creator} network-config testnet now`);

console.log("\n## 2. Create the DAO with the council as the default policy (2 of 3 approve)");
const createArgs = { name, args: b64({ config: { name, purpose: "Owner of the ByLaw contract", metadata: "" }, policy: council }) };
console.log("  " + nearCall({ contract: "sputnikv2.testnet", method: "create", args: createArgs, signer: creator, depositNear: "6", gasT: 300 }));
console.log("  Verify:");
console.log("  " + nearView(dao, "get_policy"));

console.log("\n## 3. Deploy tUSD and ByLaw with owner = the DAO");
console.log(`  Follow contracts/bylaw/deploy.md (Lane A). The init call must pass "owner": "${dao}".`);
console.log("  Verify the owner and bylaw:");
console.log("  " + nearView(i.bylaw, "get_bylaw"));

const di = { ...i, dao };
printProposal("4. Set guardians (freeze-only role)", di, `Set guardians: ${guardians.join(", ")}`, [{ method: "set_guardians", args: { guardians } }]);
printProposal("5. Allowlist procurement vendors", di, `Allowlist vendors: ${vendors.join(", ")}`,
  vendors.map((v) => ({ method: "set_vendor", args: { vendor: v, allowed: true } })));

console.log("\n## Next");
console.log("  npm run register-agents -w scripts   (generates agent keys locally and prints register_agent proposals)");
console.log("  npm run mint-seats -w scripts        (seat NFTs)");
console.log("  npm run fund-treasury -w scripts     (tUSD into the treasury)");
console.log("\nNote: the DAO must hold enough NEAR for proposals that attach deposits (register_agent needs >= 0.5 NEAR each).");
console.log(`  near tokens ${creator} send-near ${dao} '3 NEAR' network-config testnet sign-with-keychain send`);
