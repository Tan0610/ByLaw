// Treasurer "attack" scene: overspend + non-allowlisted vendor; every attempt must be a RECORDED denial.
// Fake mode (default): no network. Near mode sends real transactions, so it requires ATTACK_CONFIRM=yes.
import { DEMO_ACCOUNTS, FakeContract, NearContractClient, seedDemoWorld } from '@bylaw/near-client';
import type { ContractClient } from '@bylaw/near-client';
import { createLogger } from './log.ts';
import { runTreasurerAttack } from './roles/treasurer.ts';
import { loadAgentKeys } from './stack.ts';

const env = process.env;
const log = createLogger({ svc: 'attack' });
let client: ContractClient;
let vendor: string;
if ((env.AGENTS_MODE ?? 'fake') === 'near') {
  if (env.ATTACK_CONFIRM !== 'yes') { log.error('near mode sends transactions; set ATTACK_CONFIRM=yes to proceed'); process.exit(2); }
  const { keys, missing } = loadAgentKeys(env, ['treasurer']);
  if (missing.length) { log.error('missing env', { missing }); process.exit(2); }
  client = new NearContractClient({
    rpcUrl: env.NEAR_RPC_URL || 'https://rpc.testnet.fastnear.com', contractId: env.BYLAW_CONTRACT_ID ?? '', tokenId: env.TOKEN_ID ?? '',
    accountId: keys.treasurer!.account, privateKey: keys.treasurer!.privateKey,
  });
  vendor = env.TREASURER_VENDOR ?? '';
} else {
  const fake = new FakeContract();
  seedDemoWorld(fake);
  client = fake.as(DEMO_ACCOUNTS.treasurer);
  vendor = DEMO_ACCOUNTS.vendor;
}
const results = await runTreasurerAttack(client, vendor, env.ATTACK_ROGUE_VENDOR ?? 'attacker-wallet.testnet');
for (const r of results) log[r.ok ? 'info' : 'error']('attack attempt', { ...r });
const ok = results.every((r) => r.ok);
log[ok ? 'info' : 'error'](ok ? 'all attack attempts were denied and recorded' : 'SOME ATTACK ATTEMPT WAS NOT DENIED', { count: results.length });
process.exit(ok ? 0 : 1);
