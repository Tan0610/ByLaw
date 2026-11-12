import { canonicalJson, nearRpc, sha256Hex } from '@bylaw/near-client';

/** Deterministic contract-health facts (INTERFACES.md section 4). */
export interface Facts {
  code_hash: string;
  storage_usage: number;
  balance: string; // yocto, decimal string
  full_access_keys: number;
  function_call_keys: number;
  upgradeable: boolean; // true iff at least one full-access key exists (it can redeploy code)
  fetched_at_block: number;
}

export const FACT_KEYS = ['balance', 'code_hash', 'fetched_at_block', 'full_access_keys', 'function_call_keys', 'storage_usage', 'upgradeable'];

export class FactsError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Source of facts; tests inject CannedFactsProvider so nothing touches the network. */
export interface FactsProvider {
  /** `atBlock` pins the query so a reviewer can recompute exactly what the analyst saw. */
  getFacts(accountId: string, atBlock?: number): Promise<Facts>;
}

export interface RpcFactsOptions { rpcUrl: string }

/**
 * contractFacts: NEAR RPC view_account + view_access_key_list (+ code hash from view_account.code_hash,
 * which is the sha256 base58 hash `view_code` would hash to). Returned object has sorted keys, so
 * canonicalJson(contractFacts(...)) is stable across repeats at the same block.
 */
export async function contractFacts(accountId: string, opts: RpcFactsOptions, atBlock?: number): Promise<Facts> {
  const ref = atBlock === undefined ? { finality: 'final' } : { block_id: atBlock };
  let acct: { amount: string; code_hash: string; storage_usage: number; block_height: number };
  try {
    acct = await nearRpc(opts.rpcUrl, 'query', { request_type: 'view_account', account_id: accountId, ...ref });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/UnknownAccount|does not exist/i.test(m)) throw new FactsError('account_not_found', `account ${accountId} not found`);
    throw e;
  }
  const height = atBlock ?? acct.block_height;
  const keys = await nearRpc<{ keys: { access_key: { permission: unknown } }[] }>(opts.rpcUrl, 'query', {
    request_type: 'view_access_key_list', account_id: accountId, block_id: height,
  });
  let full = 0, fc = 0;
  for (const k of keys.keys) {
    if (k.access_key.permission === 'FullAccess') full++;
    else fc++;
  }
  return sortedFacts({
    balance: acct.amount, code_hash: acct.code_hash, fetched_at_block: height, full_access_keys: full,
    function_call_keys: fc, storage_usage: acct.storage_usage, upgradeable: full > 0,
  });
}

export class RpcFactsProvider implements FactsProvider {
  private opts: RpcFactsOptions;
  constructor(opts: RpcFactsOptions) { this.opts = opts; }
  getFacts(accountId: string, atBlock?: number): Promise<Facts> { return contractFacts(accountId, this.opts, atBlock); }
}

export function sortedFacts(f: Facts): Facts {
  return JSON.parse(canonicalJson(f)) as Facts;
}

/** Offline provider with deterministic synthetic facts per account; override with `set`. */
export class CannedFactsProvider implements FactsProvider {
  private overrides = new Map<string, Partial<Facts>>();
  height: number;
  calls: { accountId: string; atBlock?: number }[] = [];
  constructor(height = 5_000_000) { this.height = height; }
  set(accountId: string, f: Partial<Facts>): void { this.overrides.set(accountId, f); }
  async getFacts(accountId: string, atBlock?: number): Promise<Facts> {
    this.calls.push({ accountId, atBlock });
    const h = sha256Hex(accountId).slice(2);
    const base: Facts = {
      code_hash: `canned-${h.slice(0, 32)}`,
      storage_usage: 50_000 + (parseInt(h.slice(0, 4), 16) % 100_000),
      balance: String(BigInt(`0x${h.slice(4, 12)}`) * 10n ** 15n),
      full_access_keys: parseInt(h.slice(12, 13), 16) % 3,
      function_call_keys: parseInt(h.slice(13, 14), 16) % 4,
      upgradeable: false,
      fetched_at_block: atBlock ?? this.height,
    };
    base.upgradeable = base.full_access_keys > 0;
    const o = this.overrides.get(accountId) ?? {};
    return sortedFacts({ ...base, ...o, fetched_at_block: atBlock ?? o.fetched_at_block ?? this.height });
  }
}
