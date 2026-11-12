import { FakeContract, ManualClock, NearContractClient, seedDemoWorld, DEMO_ACCOUNTS } from '@bylaw/near-client';
import type { ByLawParams, ContractClient } from '@bylaw/near-client';
import { createIndexerApp } from '@bylaw/indexer';
import type { FactsProvider } from './facts.ts';
import type { Summarizer } from './llm.ts';
import { TemplateSummarizer } from './llm.ts';
import type { Logger } from './log.ts';
import { silentLogger } from './log.ts';
import type { ArtifactStore } from './report.ts';
import { HttpArtifactStore } from './report.ts';
import { StepLedger } from './runtime.ts';
import type { Agent } from './runtime.ts';
import { SalesAgent } from './roles/sales.ts';
import { AnalystAgent } from './roles/analyst.ts';
import { ReviewerAgent } from './roles/reviewer.ts';
import { TreasurerAgent } from './roles/treasurer.ts';

export const AGENT_NAMES = ['sales', 'analyst1', 'analyst2', 'reviewer', 'treasurer'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export interface AgentKeys { account: string; privateKey: string }

/** Reads AGENT_<NAME>_ACCOUNT / AGENT_<NAME>_PRIVATE_KEY. Missing names are reported, never logged with values. */
export function loadAgentKeys(env: Record<string, string | undefined>, names: readonly AgentName[] = AGENT_NAMES): { keys: Partial<Record<AgentName, AgentKeys>>; missing: string[] } {
  const keys: Partial<Record<AgentName, AgentKeys>> = {};
  const missing: string[] = [];
  for (const n of names) {
    const up = n.toUpperCase();
    const account = env[`AGENT_${up}_ACCOUNT`]?.trim();
    const privateKey = env[`AGENT_${up}_PRIVATE_KEY`]?.trim();
    if (!account) missing.push(`AGENT_${up}_ACCOUNT`);
    if (!privateKey) missing.push(`AGENT_${up}_PRIVATE_KEY`);
    if (account && privateKey) keys[n] = { account, privateKey };
  }
  return { keys, missing };
}

export interface BuildAgentsOptions {
  clientFor: (name: AgentName) => ContractClient;
  facts: FactsProvider;
  summarizer?: Summarizer;
  store: ArtifactStore;
  uriFor: (hash: string) => string;
  log?: Logger;
  vendor: string;
  spendPerJob?: bigint;
  tamper?: Partial<Record<AgentName, boolean>>;
  aggression?: Partial<Record<AgentName, number>>;
  costFloor?: bigint;
  ledgerDir?: string;
  only?: AgentName[];
}

/** Builds the five role agents over any ContractClient factory (fake or real). */
export function buildAgents(o: BuildAgentsOptions): Agent[] {
  const log = o.log ?? silentLogger;
  const summarizer = o.summarizer ?? new TemplateSummarizer();
  const names = o.only ?? [...AGENT_NAMES];
  const ctx = (name: AgentName) => ({
    name, client: o.clientFor(name), log: log.child({ agent: name }),
    ledger: new StepLedger({ file: o.ledgerDir ? `${o.ledgerDir}/ledger-${name}.json` : undefined }),
  });
  const agents: Agent[] = [];
  for (const n of names) {
    if (n === 'sales') agents.push(new SalesAgent(ctx(n)));
    if (n === 'analyst1' || n === 'analyst2') {
      agents.push(new AnalystAgent(ctx(n), {
        facts: o.facts, summarizer, store: o.store, uriFor: o.uriFor,
        aggressionBps: o.aggression?.[n] ?? (n === 'analyst1' ? 5500 : 6500),
        costFloor: o.costFloor ?? 3_000_000n, tamper: o.tamper?.[n] ?? false,
      }));
    }
    if (n === 'reviewer') agents.push(new ReviewerAgent(ctx(n), { facts: o.facts, store: o.store }));
    if (n === 'treasurer') agents.push(new TreasurerAgent(ctx(n), { vendor: o.vendor, amountPerJob: o.spendPerJob ?? 1_000_000n }));
  }
  return agents;
}

/** Real-network clients from env keys (keys stay in memory only). */
export function nearClientFactory(env: Record<string, string | undefined>, keys: Partial<Record<AgentName, AgentKeys>>) {
  const network = env.NEAR_NETWORK ?? 'testnet';
  const rpcUrl = env.NEAR_RPC_URL || (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.fastnear.com');
  const contractId = env.BYLAW_CONTRACT_ID ?? '';
  const tokenId = env.TOKEN_ID ?? '';
  return (name: AgentName): ContractClient => {
    const k = keys[name];
    if (!k) throw new Error(`missing keys for ${name}`);
    return new NearContractClient({ rpcUrl, contractId, tokenId, accountId: k.account, privateKey: k.privateKey });
  };
}

export const FAKE_ACCOUNT: Record<AgentName, string> = {
  sales: DEMO_ACCOUNTS.sales, analyst1: DEMO_ACCOUNTS.analyst1, analyst2: DEMO_ACCOUNTS.analyst2,
  reviewer: DEMO_ACCOUNTS.reviewer, treasurer: DEMO_ACCOUNTS.treasurer,
};

/**
 * Whole stack in one process with zero network: FakeContract + indexer (REST/SSE on `port`) + 5 agents.
 * Artifacts go through the indexer over HTTP (POST /artifacts, GET /artifacts/:hash).
 */
export async function createFakeStack(o: {
  facts: FactsProvider; port?: number; manualClock?: boolean; params?: Partial<ByLawParams>; log?: Logger;
  tamper?: Partial<Record<AgentName, boolean>>; summarizer?: Summarizer; dbPath?: string;
}) {
  const clock = o.manualClock ? new ManualClock() : null;
  const fake = new FakeContract({ clock: clock?.now, params: o.params });
  seedDemoWorld(fake);
  const { indexer, app, db } = await createIndexerApp({
    client: fake.as(null), cfg: { contract_id: fake.contractId, dao_id: fake.ownerId, token_id: fake.tokenId }, dbPath: o.dbPath,
  });
  await app.listen({ port: o.port ?? 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const store = new HttpArtifactStore(base);
  const agents = buildAgents({
    clientFor: (n) => fake.as(FAKE_ACCOUNT[n]), facts: o.facts, summarizer: o.summarizer, store,
    uriFor: (h) => store.uriFor(h), log: o.log, vendor: DEMO_ACCOUNTS.vendor, tamper: o.tamper,
  });
  /** One deterministic round: every agent ticks once in role order, then the indexer polls. */
  const step = async () => { for (const a of agents) await a.tick(); await indexer.poll(); };
  const close = async () => { indexer.stop(); await app.close(); db.close(); };
  return { clock, fake, indexer, app, db, store, agents, base, port, step, close };
}
