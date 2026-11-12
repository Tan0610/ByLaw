// Entry: `node src/main.ts [serve|reindex]`. Env: INDEXER_MODE=fake|near, DATABASE_URL, PORT, POLL_MS, see .env names in INTERFACES.md.
import { FakeContract, NearContractClient, seedDemoWorld } from '@bylaw/near-client';
import type { ContractClient } from '@bylaw/near-client';
import { createIndexerApp, dbPathFromUrl } from './index.ts';

const env = process.env;
const mode = (env.INDEXER_MODE ?? 'near').toLowerCase();
const cmd = process.argv[2] ?? 'serve';
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'indexer', msg, ...extra }));

let client: ContractClient;
let cfg;
if (mode === 'fake') {
  const fake = new FakeContract();
  seedDemoWorld(fake);
  client = fake.as(null);
  cfg = { contract_id: fake.contractId, dao_id: fake.ownerId, token_id: fake.tokenId };
  log('warn', 'INDEXER_MODE=fake: in-memory contract with demo agents, no network');
} else {
  const contractId = env.BYLAW_CONTRACT_ID;
  if (!contractId) { log('error', 'BYLAW_CONTRACT_ID is required in near mode'); process.exit(2); }
  const network = env.NEAR_NETWORK ?? 'testnet';
  const rpcUrl = env.NEAR_RPC_URL || (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
  client = new NearContractClient({ rpcUrl, contractId, tokenId: env.TOKEN_ID ?? '' });
  cfg = { contract_id: contractId, dao_id: env.DAO_ID ?? '', token_id: env.TOKEN_ID ?? '' };
}

const { indexer, app, db } = await createIndexerApp({
  client, cfg, dbPath: dbPathFromUrl(env.DATABASE_URL ?? 'file:./indexer.db'),
  server: {
    webOrigins: (env.WEB_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    writeToken: env.INDEXER_WRITE_TOKEN || undefined, logger: false,
  },
});

if (cmd === 'reindex') {
  const r = await indexer.reindex();
  log('info', 'reindex done', r);
  db.close();
  process.exit(0);
}

const port = Number(env.PORT ?? 8788);
indexer.start(Number(env.POLL_MS ?? 2000), (e) => log('error', 'poll failed', { error: e instanceof Error ? e.message : String(e) }));
await app.listen({ port, host: env.HOST ?? '0.0.0.0' });
log('info', 'indexer listening', { port, mode });

const shutdown = async (sig: string) => {
  log('info', 'shutting down', { sig });
  indexer.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
