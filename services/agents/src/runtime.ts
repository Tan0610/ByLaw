import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ContractClient, Kind } from '@bylaw/near-client';
import type { Logger } from './log.ts';
import { errMsg } from './log.ts';

/**
 * Idempotency ledger keyed by `${job_id}:${step}`. A step is marked done only after it succeeds;
 * failures are retried on the next tick up to `maxAttempts`, then abandoned (logged). Optional JSON
 * file persistence makes restarts safe. The contract state machine is the second line of defence:
 * roles re-read job state every tick and only act on the state their step expects.
 */
export class StepLedger {
  private done = new Set<string>();
  private attempts = new Map<string, number>();
  private file?: string;
  private maxAttempts: number;
  constructor(opts: { file?: string; maxAttempts?: number } = {}) {
    this.file = opts.file;
    this.maxAttempts = opts.maxAttempts ?? 5;
    if (this.file && existsSync(this.file)) {
      for (const k of JSON.parse(readFileSync(this.file, 'utf8')) as string[]) this.done.add(k);
    }
  }
  has(key: string): boolean { return this.done.has(key); }
  /** Runs fn once per key. Returns true if fn ran and succeeded now. */
  async once(key: string, log: Logger, fn: () => Promise<void>): Promise<boolean> {
    if (this.done.has(key)) return false;
    const n = (this.attempts.get(key) ?? 0) + 1;
    if (n > this.maxAttempts) return false;
    this.attempts.set(key, n);
    try {
      await fn();
      this.done.add(key);
      if (this.file) writeFileSync(this.file, JSON.stringify([...this.done]));
      return true;
    } catch (e) {
      log.warn('step failed', { step: key, attempt: n, error: errMsg(e), gave_up: n >= this.maxAttempts });
      return false;
    }
  }
}

export interface AgentContext {
  name: string;
  client: ContractClient;
  log: Logger;
  ledger: StepLedger;
}

export interface Agent {
  readonly name: string;
  readonly kind: Kind;
  tick(): Promise<void>;
}

/** Look up this agent's on-chain record (token id, rep, state) by its account. */
export async function whoAmI(c: ContractClient) {
  const me = (await c.listAgents()).find((a) => a.account === c.accountId);
  if (!me) throw new Error(`no agent registered for ${c.accountId}`);
  return me;
}

export interface RunnerOptions {
  intervalMs: number;
  log: Logger;
  heartbeat?: (agent: string) => Promise<void>;
}

/** Runs each agent loop until stop(); stop() waits for in-flight ticks (graceful shutdown). */
export class AgentRunner {
  private stopped = false;
  private loops: Promise<void>[] = [];
  private wake: (() => void)[] = [];
  private o: RunnerOptions;
  constructor(o: RunnerOptions) { this.o = o; }

  start(agents: Agent[]): void {
    for (const a of agents) this.loops.push(this.loop(a));
  }
  private async loop(a: Agent): Promise<void> {
    const log = this.o.log.child({ agent: a.name });
    log.info('agent started', { kind: a.kind });
    while (!this.stopped) {
      try { await a.tick(); } catch (e) { log.error('tick failed', { error: errMsg(e) }); }
      if (this.o.heartbeat) await this.o.heartbeat(a.name).catch(() => {});
      if (this.stopped) break;
      await new Promise<void>((r) => { const t = setTimeout(r, this.o.intervalMs); this.wake.push(() => { clearTimeout(t); r(); }); });
    }
    log.info('agent stopped');
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.wake.splice(0)) w();
    await Promise.all(this.loops);
  }
}

/** SIGINT/SIGTERM -> runner.stop() -> onDone. */
export function installShutdown(runner: AgentRunner, log: Logger, onDone: () => Promise<void> | void = () => {}): void {
  let shutting = false;
  const h = (sig: string) => {
    if (shutting) return;
    shutting = true;
    log.info('graceful shutdown', { sig });
    runner.stop().then(onDone).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => h('SIGINT'));
  process.on('SIGTERM', () => h('SIGTERM'));
}
