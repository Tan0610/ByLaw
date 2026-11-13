import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactHash } from '@bylaw/near-client';
import type { Db } from './db.ts';

/**
 * Reports are stored by the indexer, not on-chain (the chain keeps only each report's hash). A host with an
 * ephemeral disk loses them on every restart, so the reports of jobs that already settled on-chain ship with
 * the code (services/indexer/seed/artifacts/*.json) and are loaded at start-up.
 *
 * Nothing is trusted from the file name: each file is stored under the hash COMPUTED from its content, so a
 * report that was edited in any way no longer matches the deliverable hash recorded on-chain and is simply
 * never shown for that job.
 */
export function loadSeedArtifacts(db: Db, dir: string): { loaded: number; skipped: number } {
  if (!existsSync(dir)) return { loaded: 0, skipped: 0 };
  let loaded = 0;
  let skipped = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const art = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      if (art.schema !== 'bylaw.report.v1' || typeof art.target !== 'string' || typeof art.facts !== 'object') { skipped++; continue; }
      db.putArtifact(artifactHash(art), JSON.stringify(art));
      loaded++;
    } catch { skipped++; }
  }
  return { loaded, skipped };
}
