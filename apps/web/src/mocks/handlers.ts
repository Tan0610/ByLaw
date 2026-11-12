import { http, HttpResponse, delay } from "msw";
import { INDEXER_URL, RPC_URL } from "../lib/config";
import { COUNCIL, DAO, config } from "./fixtures";
import { timelineFor } from "./fixtures";
import { mockStore as S } from "./store";

const u = (p: string) => `${INDEXER_URL}${p}`;
const err = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

export const handlers = [
  http.get(u("/health"), () => HttpResponse.json({
    near_height: 187_421_000, indexer_lag_s: 1,
    agents_alive: S.agents.filter((a) => a.state === "Active").map((a) => a.account), llm_ok: true,
  })),
  http.get(u("/config"), () => HttpResponse.json({ ...config, charter: { version: S.charter.version, text_hash: S.charter.text_hash } })),
  http.get(u("/charter"), () => HttpResponse.json(S.charter)),
  http.get(u("/charter/history"), () => HttpResponse.json(S.history)),
  http.get(u("/agents"), () => HttpResponse.json(S.agents)),
  http.get(u("/agents/:id"), ({ params }) => {
    const a = S.agent(String(params.id));
    return a ? HttpResponse.json(a) : err(404, "not_found", "No such agent");
  }),
  http.get(u("/jobs"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    const state = q.get("state"), customer = q.get("customer");
    return HttpResponse.json(S.jobs.filter((j) => (!state || j.state === state) && (!customer || j.customer === customer)));
  }),
  http.get(u("/jobs/:id/timeline"), ({ params }) => {
    const id = String(params.id);
    const j = S.job(id);
    if (!j) return err(404, "not_found", "No such job");
    return HttpResponse.json(S.timelines[id] ?? timelineFor(j));
  }),
  http.get(u("/jobs/:id"), ({ params }) => {
    const j = S.job(String(params.id));
    return j ? HttpResponse.json(j) : err(404, "not_found", "No such job");
  }),
  http.get(u("/spends"), () => HttpResponse.json(S.spends)),
  http.get(u("/pools"), () => HttpResponse.json([])),
  http.get(u("/seats"), () => HttpResponse.json(S.seats)),
  http.get(u("/seats/:id"), ({ params }) => {
    const s = S.seats.find((x) => x.token_id === String(params.id));
    return s ? HttpResponse.json(s) : err(404, "not_found", "No such seat");
  }),
  http.get(u("/claimable/:account"), ({ params }) => {
    const account = String(params.account);
    return HttpResponse.json({ account, amount: S.claimable[account] ?? "0" });
  }),
  http.get(u("/artifacts/:hash"), ({ params }) => {
    const r = S.artifacts[String(params.hash)];
    return r ? HttpResponse.json(r) : err(404, "not_found", "No such artifact");
  }),
  http.get(u("/attestations/:job_id"), ({ params }) =>
    HttpResponse.json({ job_id: String(params.job_id), attestation: null, verified: null, note: "T4 attestation is not part of this build." })),
  http.get(u("/stats"), () => HttpResponse.json(S.stats)),
  http.get(u("/stream"), async () => {
    await delay(10);
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"hello"}\n\n')); c.close(); },
    });
    return new HttpResponse(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }),

  // Sputnik DAO views over JSON-RPC (same code path as testnet).
  http.post(RPC_URL, async ({ request }) => {
    const body = (await request.json()) as { params?: { account_id?: string; method_name?: string; args_base64?: string } };
    const p = body.params ?? {};
    const args = p.args_base64 ? JSON.parse(atob(p.args_base64)) : {};
    let result: unknown;
    if (p.account_id !== DAO) return HttpResponse.json({ jsonrpc: "2.0", id: "x", error: { message: "mock: unknown account" } });
    switch (p.method_name) {
      case "get_last_proposal_id": result = S.nextProposal; break;
      case "get_proposals": {
        const from = Number(args.from_index ?? 0), limit = Number(args.limit ?? 20);
        result = [...S.proposals].sort((a, b) => a.id - b.id).filter((x) => x.id >= from).slice(0, limit);
        break;
      }
      case "get_policy":
        result = { roles: [{ name: "council", kind: { Group: COUNCIL }, permissions: ["*:*"] }], proposal_bond: "100000000000000000000000" };
        break;
      default: return HttpResponse.json({ jsonrpc: "2.0", id: "x", error: { message: `mock: no ${p.method_name}` } });
    }
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(result)));
    return HttpResponse.json({ jsonrpc: "2.0", id: "x", result: { result: bytes, logs: [], block_height: 1 } });
  }),
];
