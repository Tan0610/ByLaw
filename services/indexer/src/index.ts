import type { ContractClient } from '@bylaw/near-client';
import { Db } from './db.ts';
import { Indexer } from './indexer.ts';
import type { IndexerConfig } from './indexer.ts';
import { buildServer } from './server.ts';
import type { ServerOptions } from './server.ts';

export { Db, dbPathFromUrl } from './db.ts';
export { Indexer, nsToIso } from './indexer.ts';
export type { IndexerConfig, Ping } from './indexer.ts';
export { buildServer } from './server.ts';
export type { ServerOptions } from './server.ts';
export { lineDiff } from './textdiff.ts';

/** Convenience: indexer + Fastify app over any ContractClient (used by main, tests and the demo stack). */
export async function createIndexerApp(opts: {
  client: ContractClient; cfg: IndexerConfig; dbPath?: string; server?: ServerOptions;
}) {
  const db = new Db(opts.dbPath ?? ':memory:');
  const indexer = new Indexer(db, opts.client, opts.cfg);
  const app = await buildServer(indexer, opts.server);
  return { db, indexer, app };
}
