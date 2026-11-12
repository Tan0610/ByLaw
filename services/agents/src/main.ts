// Agent runtime entry. AGENTS_MODE=fake (default; zero network: FakeContract + embedded indexer + 5 agents)
// or AGENTS_MODE=near (real contract, keys from AGENT_<NAME>_ACCOUNT / AGENT_<NAME>_PRIVATE_KEY).
import { mkdirSync } from 'node:fs';
import { DEMO_ACCOUNTS } from '@bylaw/near-client';
import { CannedFactsProvider, RpcFactsProvider } from './facts.ts';
import type { FactsProvider } from './facts.ts';
import { createSummarizer } from './llm.ts';
import { createLogger, errMsg } from './log.ts';
import { HttpArtifactStore } from './report.ts';
import { AgentRunner, installShutdown } from './runtime.ts';
import { AGENT_NAMES, buildAgents, createFakeStack, loadAgentKeys, nearClientFactory } from './stack.ts';
import type { AgentName } from './stack.ts';

const env = process.env;
const log = createLogger({ svc: 'agents' });
const mode = (env.AGENTS_MODE ?? 'fake').toLowerCase();
const intervalMs = Number(env.AGENT_TICK_MS ?? 2000);
const rpcUrl = env.NEAR_RPC_URL || 'https://near-testnet.drpc.org';
const facts: FactsProvider = (env.FACTS_SOURCE ?? (mode === 'near' ? 'rpc' : 'canned')) === 'rpc' ? new RpcFactsProvider({ rpcUrl }) : new CannedFactsProvider();
const summarizer = createSummarizer(env, log);
const tamper = Object.fromEntries((env.DEMO_TAMPER ?? '').split(',').filter(Boolean).map((n) => [n.trim(), true])) as Partial<Record<AgentName, boolean>>;

if (mode === 'fake') {
  const sec = 1_000_000_000n;
  const stack = await createFakeStack({
    facts, port: Number(env.PORT ?? 8788), log, tamper, summarizer,
    params: { bid_window_ns: String(BigInt(env.DEMO_BID_WINDOW_S ?? '5') * sec) },
  });
  log.warn('AGENTS_MODE=fake: in-memory contract, embedded indexer', { indexer: stack.base, facts: facts.constructor.name, llm: summarizer.constructor.name });
  stack.indexer.start(1000, (e) => log.error('poll failed', { error: errMsg(e) }));
  const runner = new AgentRunner({
    intervalMs, log,
    heartbeat: async (a) => { stack.indexer.heartbeats.set(a, { at: Date.now(), llm_ok: await summarizer.health() }); },
  });
  runner.start(stack.agents);
  const targets = (env.DEMO_TARGETS ?? 'guest-book.testnet,v2.ref-finance.testnet,wrap.testnet').split(',');
  let n = 0;
  const post = async () => {
    const t = targets[n++ % targets.length];
    const id = await stack.fake.as(DEMO_ACCOUNTS.customer).postJob(t, env.DEMO_JOB_PRICE ?? '100000000');
    log.info('demo customer posted job', { job_id: id, target: t });
  };
  await post();
  const every = Number(env.DEMO_JOB_EVERY_S ?? 30);
  const timer = every > 0 ? setInterval(() => void post().catch((e) => log.error('post failed', { error: errMsg(e) })), every * 1000) : null;
  installShutdown(runner, log, async () => { if (timer) clearInterval(timer); await stack.close(); });
} else {
  const only = (env.AGENTS_ONLY ? env.AGENTS_ONLY.split(',').map((s) => s.trim()) : [...AGENT_NAMES]) as AgentName[];
  const { keys, missing } = loadAgentKeys(env, only);
  if (missing.length) { log.error('missing agent env vars', { missing }); process.exit(2); }
  if (!env.BYLAW_CONTRACT_ID || !env.INDEXER_URL) { log.error('BYLAW_CONTRACT_ID and INDEXER_URL are required in near mode'); process.exit(2); }
  const store = new HttpArtifactStore(env.INDEXER_URL, env.INDEXER_WRITE_TOKEN || undefined);
  if (env.AGENT_LEDGER_DIR) mkdirSync(env.AGENT_LEDGER_DIR, { recursive: true });
  const agents = buildAgents({
    clientFor: nearClientFactory(env, keys), facts, summarizer, store, uriFor: (h) => store.uriFor(h), log,
    vendor: env.TREASURER_VENDOR ?? '', spendPerJob: BigInt(env.TREASURER_SPEND_PER_JOB ?? '1000000'),
    tamper, only, ledgerDir: env.AGENT_LEDGER_DIR ?? '.agent-ledger',
  });
  if (!env.AGENT_LEDGER_DIR) mkdirSync('.agent-ledger', { recursive: true });
  const runner = new AgentRunner({
    intervalMs, log,
    heartbeat: async (a) => {
      await fetch(`${env.INDEXER_URL!.replace(/\/$/, '')}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(env.INDEXER_WRITE_TOKEN ? { 'x-indexer-token': env.INDEXER_WRITE_TOKEN } : {}) },
        body: JSON.stringify({ agent: a, llm_ok: await summarizer.health() }),
      });
    },
  });
  runner.start(agents);
  log.info('agents running against NEAR', { contract: env.BYLAW_CONTRACT_ID, agents: only });
  installShutdown(runner, log);
}
