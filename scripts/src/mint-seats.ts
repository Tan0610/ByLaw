// Seat NFT helper: prints one DAO proposal minting all seats.
//   SEATS=ana.testnet:50,dev.testnet:30,mem.testnet:20 npm run mint-seats -w scripts
import { banner, env, ids, nearView, parseFlags, printProposal } from "./lib.ts";

parseFlags();
const i = ids();
const seats = env("SEATS", "<member1>.testnet:50,<member2>.testnet:30,<member3>.testnet:20")
  .split(",").filter(Boolean).map((p) => { const [owner, w] = p.split(":"); return { owner: owner.trim(), weight: Number(w ?? 1) }; });
for (const s of seats) if (!Number.isInteger(s.weight) || s.weight <= 0) { console.error(`bad weight for ${s.owner}`); process.exit(2); }

banner("ByLaw seat minting");
printProposal(`Mint ${seats.length} seat NFT(s)`, i, `Mint seats: ${seats.map((s) => `${s.owner}=${s.weight}`).join(", ")}`,
  seats.map((s) => ({ method: "mint_seat", args: { owner: s.owner, weight: s.weight } })));
console.log("\nmint_seat is not payable in contracts/bylaw/src/lib.rs, so no deposit is attached.");
console.log("Verify:");
console.log("  " + nearView(i.bylaw, "nft_tokens", { from_index: "0", limit: 50 }));
