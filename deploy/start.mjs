// Container entry point. Runs the indexer (REST + SSE, serves the seed reports) and, when all five agent
// keys are present, the five agents. Restarts either process if it exits.
//
// Public settings (contract ids, agent account names, RPC) come from deploy/defaults.json and can be
// overridden with environment variables. Secrets are NEVER in this repo: the five AGENT_*_PRIVATE_KEY values
// are provided by the host as secrets. Without them the service runs read-only (no agent acts).
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'supervisor', msg, ...extra }));

const env = { ...process.env };
for (const [k, v] of Object.entries(JSON.parse(readFileSync(resolve(root, 'deploy/defaults.json'), 'utf8')))) if (!env[k]) env[k] = v;
env.PORT ||= '7860';
env.HOST ||= '0.0.0.0';
env.INDEXER_URL = `http://127.0.0.1:${env.PORT}`;
// Shared by the indexer and the agents; only they can post reports or heartbeats. A fresh random value per boot is fine.
env.INDEXER_WRITE_TOKEN ||= randomUUID();
mkdirSync(resolve(root, 'data'), { recursive: true });

const ROLES = ['SALES', 'ANALYST1', 'ANALYST2', 'REVIEWER', 'TREASURER'];
const missing = ROLES.filter((r) => !env[`AGENT_${r}_PRIVATE_KEY`]);
const agentsEnabled = missing.length === 0;

let stopping = false;
const children = new Map();

function run(name, script) {
  let fails = 0;
  const start = () => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [script], { cwd: root, env, stdio: 'inherit' });
    children.set(name, child);
    log('info', 'started', { name, pid: child.pid });
    child.on('exit', (code, signal) => {
      children.delete(name);
      if (stopping) return;
      // a run that lasted a minute counts as healthy, so the back-off starts over
      fails = Date.now() - startedAt > 60_000 ? 1 : fails + 1;
      const delay = Math.min(60_000, 2_000 * 2 ** (fails - 1));
      log('error', 'exited, restarting', { name, code, signal, restart_in_ms: delay });
      setTimeout(() => { if (!stopping) start(); }, delay);
    });
  };
  start();
}

async function waitHealthy(ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopping) {
    try { if ((await fetch(`${env.INDEXER_URL}/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { sig });
  for (const c of children.values()) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log('info', 'starting', { port: env.PORT, contract: env.BYLAW_CONTRACT_ID, network: env.NEAR_NETWORK, agents: agentsEnabled ? 'enabled' : 'disabled (read-only)', missing_agent_keys: missing.length });
run('indexer', 'services/indexer/src/main.ts');
if (agentsEnabled) {
  if (await waitHealthy()) run('agents', 'services/agents/src/main.ts');
  else log('error', 'indexer did not become healthy, agents not started');
} else {
  log('warn', 'agent keys are not set: running read-only. Set AGENT_<ROLE>_PRIVATE_KEY for SALES, ANALYST1, ANALYST2, REVIEWER and TREASURER to let the agents act.', { missing: missing.map((r) => `AGENT_${r}_PRIVATE_KEY`) });
}
