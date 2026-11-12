import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { subscribe } from "./stream";
import { ENV_CONTRACT_ID, ENV_DAO_ID, ENV_TOKEN_ID } from "./config";
import { listProposals } from "./dao";

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: 60_000 });
export const useByLaw = () => useQuery({ queryKey: ["bylaw"], queryFn: api.bylaw });
export const useByLawHistory = () => useQuery({ queryKey: ["bylaw-history"], queryFn: api.bylawHistory });
export const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: api.agents });
export const useJobs = (q: { state?: string; customer?: string } = {}) =>
  useQuery({ queryKey: ["jobs", q], queryFn: () => api.jobs(q) });
export const useJob = (id: string) => useQuery({ queryKey: ["job", id], queryFn: () => api.job(id) });
export const useTimeline = (id: string) => useQuery({ queryKey: ["timeline", id], queryFn: () => api.timeline(id) });
export const useSpends = () => useQuery({ queryKey: ["spends"], queryFn: api.spends });
export const useSeats = () => useQuery({ queryKey: ["seats"], queryFn: api.seats });
export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: api.stats });
export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
export const useClaimable = (account: string | null) =>
  useQuery({ queryKey: ["claimable", account], queryFn: () => api.claimable(account!), enabled: !!account });
export const useArtifact = (hash?: string | null) =>
  useQuery({ queryKey: ["artifact", hash], queryFn: () => api.artifact(hash!), enabled: !!hash, staleTime: Infinity });

/** Resolved ids: indexer /config first, VITE_* as fallback. */
export function useIds() {
  const { data } = useConfig();
  return {
    contractId: data?.contract_id || ENV_CONTRACT_ID,
    daoId: data?.dao_id || ENV_DAO_ID,
    tokenId: data?.token_id || ENV_TOKEN_ID,
    guardians: data?.guardians ?? [],
  };
}

export function useProposals(daoId: string) {
  return useQuery({ queryKey: ["proposals", daoId], queryFn: () => listProposals(daoId), enabled: !!daoId });
}

/** Live updates: every SSE ping refreshes cached queries. Mounted once at the app root. */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const off = subscribe(() => { void qc.invalidateQueries(); });
    return off;
  }, [qc]);
}
