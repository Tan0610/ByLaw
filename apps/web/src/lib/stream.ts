import { INDEXER_URL, USE_MOCKS } from "./config";

export interface Ping { type: string; id?: string }
type Listener = (p: Ping) => void;

/** In-browser bus used by the mock backend in place of SSE. */
const mockListeners = new Set<Listener>();
export function emitMockPing(p: Ping) { mockListeners.forEach((l) => l(p)); }

/**
 * Subscribe to indexer update pings (GET /stream, SSE).
 * Returns an unsubscribe function. Falls back to a slow poll if EventSource is unavailable or errors.
 */
export function subscribe(listener: Listener, opts: { fallbackMs?: number } = {}): () => void {
  if (USE_MOCKS) {
    mockListeners.add(listener);
    return () => { mockListeners.delete(listener); };
  }
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const startPoll = () => {
    if (timer) return;
    timer = setInterval(() => listener({ type: "poll" }), opts.fallbackMs ?? 8000);
  };
  if (typeof EventSource === "undefined") startPoll();
  else {
    es = new EventSource(`${INDEXER_URL}/stream`);
    es.onmessage = (e) => {
      try { listener(JSON.parse(e.data) as Ping); } catch { listener({ type: "unknown" }); }
    };
    es.onerror = () => startPoll(); // EventSource auto-reconnects; polling covers the gap.
    es.onopen = () => { if (timer) { clearInterval(timer); timer = null; } };
  }
  return () => { es?.close(); if (timer) clearInterval(timer); };
}
