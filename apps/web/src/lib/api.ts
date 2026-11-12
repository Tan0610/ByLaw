import { INDEXER_URL } from "./config";
import { normAgent, normHistory, normJob, normSeat, normSpend, normStats, normTimeline, reviewFromTimeline } from "./normalize";
import type {
  Agent, AppConfig, CharterParams, CharterVersion, Health, Job, Report, Seat, Spend, Stats, TimelineEvent,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${INDEXER_URL}${path}`);
  } catch {
    throw new ApiError(0, "unreachable", `Cannot reach the indexer at ${INDEXER_URL}. Is it running?`);
  }
  if (!res.ok) {
    let code = "http_error", message = `Indexer returned ${res.status}`;
    try { const b = await res.json(); code = b.error?.code ?? code; message = b.error?.message ?? message; } catch { /* keep default */ }
    throw new ApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

export const api = {
  health: () => get<Health>("/health"),
  config: () => get<AppConfig>("/config"),
  charter: () => get<CharterParams>("/charter"),
  charterHistory: async (): Promise<CharterVersion[]> => normHistory(await get<unknown[]>("/charter/history")),
  agents: async (): Promise<Agent[]> => (await get<unknown[]>("/agents")).map(normAgent),
  agent: async (id: string): Promise<Agent> => normAgent(await get(`/agents/${enc(id)}`)),
  jobs: async (q: { state?: string; customer?: string } = {}): Promise<Job[]> => {
    const p = new URLSearchParams();
    if (q.state) p.set("state", q.state);
    if (q.customer) p.set("customer", q.customer);
    const s = p.toString();
    const list = (await get<unknown[]>(`/jobs${s ? `?${s}` : ""}`)).map(normJob);
    return list.sort((a, b) => Number(b.id) - Number(a.id));
  },
  job: async (id: string): Promise<Job> => {
    const j = normJob(await get(`/jobs/${enc(id)}`));
    if (!j.review) {
      try { j.review = reviewFromTimeline(await api.timeline(id)); } catch { /* timeline optional */ }
    }
    return j;
  },
  timeline: async (id: string): Promise<TimelineEvent[]> => normTimeline(await get<unknown[]>(`/jobs/${enc(id)}/timeline`)),
  spends: async (): Promise<Spend[]> => (await get<unknown[]>("/spends")).map(normSpend),
  seats: async (): Promise<Seat[]> => (await get<unknown[]>("/seats")).map(normSeat),
  claimable: async (account: string): Promise<{ account: string; amount: string }> => {
    const r = await get<{ account: string; amount?: string; claimable?: string }>(`/claimable/${enc(account)}`);
    return { account: r.account, amount: String(r.amount ?? r.claimable ?? "0") };
  },
  artifact: (hash: string) => get<Report>(`/artifacts/${enc(hash)}`),
  stats: async (): Promise<Stats> => normStats(await get("/stats")),
};
