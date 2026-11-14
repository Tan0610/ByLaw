import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ENV_CONTRACT_ID, GAS_100T, NETWORK, USE_MOCKS } from "./config";

export interface TxRequest {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit?: string; // yoctoNEAR
  gas?: string;
}
export interface TxResult { ok: boolean; hash?: string; error?: string; redirected?: boolean }

export const MOCK_ACCOUNTS = [
  { id: "customer.demo.testnet", label: "Customer" },
  { id: "ana.demo.testnet", label: "Member and guardian (Ana)" },
  { id: "dev.demo.testnet", label: "Council member (Dev)" },
  { id: "guardian.demo.testnet", label: "Guardian" },
  { id: "ben.demo.testnet", label: "Analyst-1 owner (Ben)" },
];

interface WalletCtx {
  accountId: string | null;
  mode: "mock" | "testnet";
  ready: boolean;
  connect: () => void;
  disconnect: () => Promise<void>;
  setMockAccount: (id: string) => void;
  call: (tx: TxRequest) => Promise<TxResult>;
}

const Ctx = createContext<WalletCtx | null>(null);

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string | null) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } }

// Minimal structural types so the app compiles without leaking wallet-selector types everywhere.
type SelectorLike = {
  wallet: () => Promise<{
    signOut: () => Promise<void>;
    signAndSendTransaction: (p: unknown) => Promise<unknown>;
  }>;
  store: {
    getState: () => { accounts: { accountId: string; active?: boolean }[] };
    observable: { subscribe: (fn: (s: { accounts: { accountId: string; active?: boolean }[] }) => void) => { unsubscribe: () => void } };
  };
};
type ModalLike = { show: () => void };

export function WalletProvider({ children, initialMockAccount }: { children: ReactNode; initialMockAccount?: string | null }) {
  const [accountId, setAccountId] = useState<string | null>(
    USE_MOCKS ? (initialMockAccount !== undefined ? initialMockAccount : lsGet("bylaw.mockAccount")) : null,
  );
  const [ready, setReady] = useState(USE_MOCKS);
  const selectorRef = useRef<SelectorLike | null>(null);
  const modalRef = useRef<ModalLike | null>(null);

  useEffect(() => {
    if (USE_MOCKS) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }] = await Promise.all([
        import("@near-wallet-selector/core"),
        import("@near-wallet-selector/modal-ui"),
        import("@near-wallet-selector/meteor-wallet"),
      ]);
      await import("@near-wallet-selector/modal-ui/styles.css");
      const selector = (await setupWalletSelector({
        network: NETWORK,
        // Meteor Wallet (wallet.meteorwallet.app) signs in a popup and returns the outcome. MyNearWallet is retired and refuses new app connections, so it is not offered.
        modules: [setupMeteorWallet()],
      })) as unknown as SelectorLike;
      const modal = setupModal(selector as never, { contractId: ENV_CONTRACT_ID || "bylaw.testnet" }) as unknown as ModalLike;
      if (cancelled) return;
      selectorRef.current = selector;
      modalRef.current = modal;
      const pick = (s: { accounts: { accountId: string; active?: boolean }[] }) =>
        (s.accounts.find((a) => a.active) ?? s.accounts[0])?.accountId ?? null;
      setAccountId(pick(selector.store.getState()));
      const sub = selector.store.observable.subscribe((s) => setAccountId(pick(s)));
      unsub = () => sub.unsubscribe();
      setReady(true);
    })().catch((e) => { console.error("wallet init failed", e); setReady(true); });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const connect = useCallback(() => {
    if (USE_MOCKS) { const id = MOCK_ACCOUNTS[0].id; setAccountId(id); lsSet("bylaw.mockAccount", id); return; }
    modalRef.current?.show();
  }, []);

  const disconnect = useCallback(async () => {
    if (USE_MOCKS) { setAccountId(null); lsSet("bylaw.mockAccount", null); return; }
    const w = await selectorRef.current?.wallet();
    await w?.signOut();
    setAccountId(null);
  }, []);

  const setMockAccount = useCallback((id: string) => { setAccountId(id); lsSet("bylaw.mockAccount", id); }, []);

  const call = useCallback(async (tx: TxRequest): Promise<TxResult> => {
    if (!accountId) return { ok: false, error: "Connect a wallet first." };
    if (USE_MOCKS) {
      const { mockChain } = await import("../mocks/chain");
      return mockChain.call(accountId, tx);
    }
    try {
      const wallet = await selectorRef.current?.wallet();
      if (!wallet) return { ok: false, error: "Wallet not ready." };
      const out = (await wallet.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: [{ type: "FunctionCall", params: { methodName: tx.methodName, args: tx.args, gas: tx.gas ?? GAS_100T, deposit: tx.deposit ?? "0" } }],
      })) as { transaction?: { hash?: string } } | void;
      // Browser wallets (MyNearWallet) redirect, so no outcome is returned here.
      if (!out) return { ok: true, redirected: true };
      return { ok: true, hash: out.transaction?.hash };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [accountId]);

  const value = useMemo<WalletCtx>(
    () => ({ accountId, mode: USE_MOCKS ? "mock" : "testnet", ready, connect, disconnect, setMockAccount, call }),
    [accountId, ready, connect, disconnect, setMockAccount, call],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet must be used inside WalletProvider");
  return c;
}
