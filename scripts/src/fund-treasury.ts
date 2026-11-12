// Treasury funding helper: prints the steps to mint test tUSD (open faucet on our mock token) and send it
// into the ByLaw treasury with ft_transfer_call msg {"action":"fund_treasury"}. Also customer setup.
//   FUNDER=ana.testnet AMOUNT=200 npm run fund-treasury -w scripts
import { banner, env, ids, nearCall, nearView, parseFlags } from "./lib.ts";

parseFlags();
const i = ids();
const funder = env("FUNDER", "<funder>.testnet");
const customer = env("CUSTOMER", "<customer>.testnet");
const amount = (BigInt(env("AMOUNT", "200")) * 1_000_000n).toString(); // tUSD has 6 decimals

banner("ByLaw treasury funding");
console.log("\n## 1. Register storage on the token (funder, customer, contract) if not yet registered");
for (const acct of [funder, customer, i.bylaw])
  console.log("  " + nearCall({ contract: i.token, method: "storage_deposit", args: { account_id: acct }, signer: funder, depositNear: "0.00125", network: i.network }));
console.log("\n## 2. Mint test tUSD (mock token has an open faucet)");
console.log("  " + nearCall({ contract: i.token, method: "mint", args: { account_id: funder, amount }, signer: funder, network: i.network }));
console.log("  " + nearCall({ contract: i.token, method: "mint", args: { account_id: customer, amount: "500000000" }, signer: customer, network: i.network }));
console.log("\n## 3. Fund the treasury");
console.log("  " + nearCall({
  contract: i.token, method: "ft_transfer_call", signer: funder, depositNear: "0.000000000000000000000001", gasT: 300, network: i.network,
  args: { receiver_id: i.bylaw, amount, msg: JSON.stringify({ action: "fund_treasury" }) },
}));
console.log("\n## 4. Verify");
console.log("  " + nearView(i.bylaw, "get_stats"));
console.log("\n## Customer job (what the web app's Jobs page sends)");
console.log("  " + nearCall({
  contract: i.token, method: "ft_transfer_call", signer: customer, depositNear: "0.000000000000000000000001", gasT: 300, network: i.network,
  args: { receiver_id: i.bylaw, amount: "100000000", msg: JSON.stringify({ action: "post_job", target: "<contract-to-analyse>.testnet" }) },
}));
