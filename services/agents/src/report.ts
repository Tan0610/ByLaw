import { HASH_RE, artifactHash, canonicalJson, sha256Hex } from '@bylaw/near-client';
import type { Job } from '@bylaw/near-client';
import { FACT_KEYS } from './facts.ts';
import type { Facts, FactsProvider } from './facts.ts';

export interface Report {
  schema: 'bylaw.report.v1';
  target: string;
  facts: Facts;
  summary: string;
  model: string;
  attestation: string | null;
}

export function buildReport(p: { target: string; facts: Facts; summary: string; model: string; attestation?: string | null }): Report {
  return { schema: 'bylaw.report.v1', target: p.target, facts: p.facts, summary: p.summary, model: p.model, attestation: p.attestation ?? null };
}

/** deliverable_hash = sha256(canonical_json(whole artifact)). */
export const reportHash = (r: Report): string => artifactHash(r);

export interface ArtifactStore {
  put(report: Report): Promise<string>;
  get(hash: string): Promise<Report | null>;
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly map = new Map<string, Report>();
  async put(r: Report): Promise<string> { const h = reportHash(r); this.map.set(h, structuredClone(r)); return h; }
  async get(h: string): Promise<Report | null> { const r = this.map.get(h); return r ? structuredClone(r) : null; }
}

/** Publishes to / reads from the indexer (`POST /artifacts`, `GET /artifacts/:hash`). */
export class HttpArtifactStore implements ArtifactStore {
  private base: string; private token?: string;
  constructor(baseUrl: string, token?: string) { this.base = baseUrl.replace(/\/$/, ''); this.token = token; }
  async put(r: Report): Promise<string> {
    const res = await fetch(`${this.base}/artifacts`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { 'x-indexer-token': this.token } : {}) },
      body: JSON.stringify(r),
    });
    if (!res.ok) throw new Error(`artifact publish failed: http ${res.status}`);
    const { hash } = (await res.json()) as { hash: string };
    if (hash !== reportHash(r)) throw new Error('indexer returned a different hash than computed locally');
    return hash;
  }
  async get(h: string): Promise<Report | null> {
    const res = await fetch(`${this.base}/artifacts/${h}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`artifact fetch failed: http ${res.status}`);
    return (await res.json()) as Report;
  }
  uriFor(hash: string): string { return `${this.base}/artifacts/${hash}`; }
}

export interface Verdict { approve: boolean; reasons: string[]; recomputed?: Facts }

/**
 * Reviewer logic. The LLM text is never trusted: the hash must match the artifact bytes, the target must
 * match the job, and `facts` must equal facts recomputed at the SAME block (canonical JSON compare).
 * Throws (so the caller retries) if facts cannot be fetched; returns approve=false on any mismatch.
 */
export async function verifyReport(job: Pick<Job, 'target' | 'deliverable_hash'>, report: Report | null, provider: FactsProvider): Promise<Verdict> {
  const reasons: string[] = [];
  if (!report) return { approve: false, reasons: ['artifact_unavailable'] };
  if (report.schema !== 'bylaw.report.v1') reasons.push('bad_schema');
  if (!job.deliverable_hash || !HASH_RE.test(job.deliverable_hash)) reasons.push('bad_deliverable_hash');
  let computed: string | null = null;
  try { computed = reportHash(report); } catch { reasons.push('artifact_not_canonicalizable'); }
  if (computed !== null && computed !== job.deliverable_hash) reasons.push('hash_mismatch');
  if (report.target !== job.target) reasons.push('target_mismatch');
  const f = report.facts as Partial<Facts> | undefined;
  if (!f || typeof f !== 'object' || canonicalJson(Object.keys(f).sort()) !== canonicalJson(FACT_KEYS)) reasons.push('facts_shape');
  if (reasons.length) return { approve: false, reasons };
  const recomputed = await provider.getFacts(job.target, report.facts.fetched_at_block);
  if (canonicalJson(recomputed) !== canonicalJson(report.facts)) {
    const diff = FACT_KEYS.filter((k) => canonicalJson((recomputed as unknown as Record<string, unknown>)[k]) !== canonicalJson((report.facts as unknown as Record<string, unknown>)[k]));
    return { approve: false, reasons: [`facts_mismatch:${diff.join(',')}`], recomputed };
  }
  return { approve: true, reasons: [], recomputed };
}

/** reason_hash passed to review_work: sha256 of the canonical reasons list. */
export const reasonHash = (v: Verdict): string => sha256Hex(canonicalJson({ approve: v.approve, reasons: v.reasons }));
