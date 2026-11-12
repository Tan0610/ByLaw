import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { HASH_RE, artifactHash } from '@charter/near-client';
import type { Seat } from '@charter/near-client';
import type { Indexer, Ping } from './indexer.ts';

export interface ServerOptions {
  webOrigins?: string[]; // empty/undefined => allow all
  writeToken?: string;   // if set, POST /artifacts and /heartbeat require header x-indexer-token
  logger?: boolean;
}

class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const ID_RE = /^[0-9]{1,20}$/;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const JOB_STATES = ['Posted', 'Open', 'Awarded', 'Submitted', 'Accepted', 'Rejected', 'Settled', 'Refunded', 'Expired'];

export async function buildServer(ix: Indexer, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: opts.webOrigins && opts.webOrigins.length ? opts.webOrigins : true });

  app.setErrorHandler((err: unknown, _req, reply: FastifyReply) => {
    const e = err as { statusCode?: number; message?: string; status?: number; code?: string };
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(status).send({ error: { code: status === 500 ? 'internal' : 'bad_request', message: e.message ?? 'error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } }));

  const id = (v: string, what = 'id'): string => {
    if (!ID_RE.test(v)) throw new ApiError(400, 'bad_request', `${what} must be a decimal integer string`);
    return v;
  };
  const checkWrite = (headers: Record<string, unknown>): void => {
    if (opts.writeToken && headers['x-indexer-token'] !== opts.writeToken) throw new ApiError(401, 'unauthorized', 'missing or bad x-indexer-token');
  };

  app.get('/health', async () => ix.health());

  app.get('/config', async () => {
    const c = ix.currentCharter();
    return {
      contract_id: ix.cfg.contract_id, dao_id: ix.cfg.dao_id, token_id: ix.cfg.token_id,
      guardians: await ix.client.getGuardians(),
      charter: c ? { version: c.version, text_hash: c.text_hash } : null,
    };
  });

  app.get('/charter', async () => {
    const c = ix.currentCharter();
    if (!c) throw new ApiError(503, 'not_indexed', 'charter not indexed yet');
    return c;
  });
  app.get('/charter/history', async () => ix.charterHistory());

  app.get('/agents', async () => ix.db.allJson<any>('agents').map((a) => ix.agentView(a)));
  app.get<{ Params: { token_id: string } }>('/agents/:token_id', async (req) => {
    const a = ix.db.getJson<any>('agents', id(req.params.token_id, 'token_id'));
    if (!a) throw new ApiError(404, 'not_found', 'agent not found');
    return ix.agentView(a);
  });

  app.get<{ Querystring: { state?: string; customer?: string } }>('/jobs', async (req) => {
    const { state, customer } = req.query;
    if (state && !JOB_STATES.includes(state)) throw new ApiError(400, 'bad_request', `state must be one of ${JOB_STATES.join(',')}`);
    if (customer && !ACCOUNT_RE.test(customer)) throw new ApiError(400, 'bad_request', 'bad customer account id');
    return ix.db.listJobs(state, customer).map((r) => ix.jobView(r));
  });
  app.get<{ Params: { id: string } }>('/jobs/:id', async (req) => {
    const row = ix.db.getJob(id(req.params.id));
    if (!row) throw new ApiError(404, 'not_found', 'job not found');
    return ix.jobView(row);
  });
  app.get<{ Params: { id: string } }>('/jobs/:id/timeline', async (req) => {
    const jid = id(req.params.id);
    if (!ix.db.getJob(jid)) throw new ApiError(404, 'not_found', 'job not found');
    return ix.timeline(jid);
  });

  app.get('/spends', async () => ix.db.allJson<any>('spends').reverse().map((s) => ({ ...s, outcome: s.state === 'Rejected' ? `Rejected:${s.reason}` : s.state })));
  app.get('/pools', async () => []); // pools are a T3 feature, intentionally not implemented

  app.get('/seats', async () => ix.db.allJson<Seat & { pending: string }>('seats'));
  app.get<{ Params: { token_id: string } }>('/seats/:token_id', async (req) => {
    const s = ix.db.getJson<any>('seats', id(req.params.token_id, 'token_id'));
    if (!s) throw new ApiError(404, 'not_found', 'seat not found');
    return s;
  });

  app.get<{ Params: { account: string } }>('/claimable/:account', async (req) => {
    const account = req.params.account;
    if (!ACCOUNT_RE.test(account)) throw new ApiError(400, 'bad_request', 'bad account id');
    try {
      return { account, claimable: await ix.client.claimableOf(account) };
    } catch (e) {
      throw new ApiError(502, 'upstream_error', e instanceof Error ? e.message : 'rpc failed');
    }
  });

  app.get<{ Params: { hash: string } }>('/artifacts/:hash', async (req, reply) => {
    const h = req.params.hash.toLowerCase();
    if (!HASH_RE.test(h)) throw new ApiError(400, 'bad_request', 'hash must be 0x + 64 hex');
    const raw = ix.db.getArtifact(h);
    if (!raw) throw new ApiError(404, 'not_found', 'artifact not found');
    reply.header('content-type', 'application/json; charset=utf-8').header('x-artifact-hash', h);
    return reply.send(raw);
  });

  // Extra (not in INTERFACES.md): agents publish report artifacts and heartbeats.
  app.post('/artifacts', async (req, reply) => {
    checkWrite(req.headers);
    const a = req.body as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || a.schema !== 'charter.report.v1' || typeof a.target !== 'string' || typeof a.facts !== 'object') {
      throw new ApiError(400, 'bad_request', 'body must be a charter.report.v1 artifact');
    }
    if (JSON.stringify(a).length > 256_000) throw new ApiError(413, 'too_large', 'artifact too large');
    const hash = artifactHash(a);
    ix.db.putArtifact(hash, JSON.stringify(a));
    ix.bus.emit('ping', { type: 'artifact', id: hash } satisfies Ping);
    return reply.code(201).send({ hash });
  });

  app.post('/heartbeat', async (req) => {
    checkWrite(req.headers);
    const b = (req.body ?? {}) as { agent?: string; llm_ok?: boolean | null };
    if (!b.agent || typeof b.agent !== 'string' || b.agent.length > 64) throw new ApiError(400, 'bad_request', 'agent required');
    ix.heartbeats.set(b.agent, { at: Date.now(), llm_ok: typeof b.llm_ok === 'boolean' ? b.llm_ok : null });
    return { ok: true };
  });

  app.get('/attestations/:job_id', async (req) => {
    const jid = id((req.params as { job_id: string }).job_id, 'job_id');
    const row = ix.db.getJob(jid);
    if (!row) throw new ApiError(404, 'not_found', 'job not found');
    const j = ix.jobView(row);
    return {
      job_id: jid, attestation: j.deliverable?.attestation ?? null, verified: false,
      verification: 'not_implemented', note: 'attestation (T4) is out of scope; the reference, if any, is only recorded',
    };
  });

  app.get('/stats', async () => ix.stats());

  app.get('/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
      'access-control-allow-origin': opts.webOrigins && opts.webOrigins.length ? (req.headers.origin ?? opts.webOrigins[0]) : '*',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', id: '0' })}\n\n`);
    const onPing = (p: Ping) => { res.write(`data: ${JSON.stringify(p)}\n\n`); };
    ix.bus.on('ping', onPing);
    const hb = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    req.raw.on('close', () => { ix.bus.off('ping', onPing); clearInterval(hb); });
  });

  return app;
}
