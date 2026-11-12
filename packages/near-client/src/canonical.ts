import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, no whitespace. Rejects undefined/NaN/functions. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
    return v;
  }
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) throw new Error(`canonicalJson: undefined at key ${k}`);
      out[k] = sortKeys(x);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof v}`);
}

/** `0x` + 64 hex sha256 of a string or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return '0x' + createHash('sha256').update(data).digest('hex');
}

/** deliverable_hash = sha256(canonical_json(artifact)) per INTERFACES.md section 4. */
export function artifactHash(artifact: unknown): string {
  return sha256Hex(canonicalJson(artifact));
}

export const HASH_RE = /^0x[0-9a-f]{64}$/;
