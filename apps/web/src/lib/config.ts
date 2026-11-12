const env = import.meta.env;

// `vite --mode mock` (npm run dev:mock) or VITE_USE_MOCKS=true turns on the MSW backend and the mock wallet.
export const USE_MOCKS: boolean = env.MODE === "mock" || env.MODE === "test" || String(env.VITE_USE_MOCKS ?? "").toLowerCase() === "true";
export const NETWORK: "testnet" = "testnet"; // ByLaw is testnet-only by design.

export const INDEXER_URL: string = (env.VITE_INDEXER_URL as string) || "http://localhost:8788";
export const RPC_URL: string = (env.VITE_NEAR_RPC_URL as string) || "https://rpc.testnet.near.org";
export const EXPLORER_URL = "https://testnet.nearblocks.io";

// In mock mode these are demo names; on testnet they come from VITE_* env (or GET /config).
export const ENV_CONTRACT_ID: string = (env.VITE_CONTRACT_ID as string) || (USE_MOCKS ? "bylaw.demo.testnet" : "");
export const ENV_DAO_ID: string = (env.VITE_DAO_ID as string) || (USE_MOCKS ? "bylaw-dao.sputnikv2.testnet" : "");
export const ENV_TOKEN_ID: string = (env.VITE_TOKEN_ID as string) || (USE_MOCKS ? "tusd.demo.testnet" : "");

export const GAS_30T = "30000000000000";
export const GAS_100T = "100000000000000";
export const GAS_300T = "300000000000000";
export const ONE_YOCTO = "1";
/** Sputnik DAO default proposal bond is 0.1 NEAR. */
export const PROPOSAL_BOND = "100000000000000000000000";
