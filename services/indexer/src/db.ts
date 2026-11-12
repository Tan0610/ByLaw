import { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

/** Parse DATABASE_URL (`file:./indexer.db`, `:memory:`, or a bare path). */
export function dbPathFromUrl(url: string | undefined): string {
  if (!url || url === ':memory:') return ':memory:';
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export interface EventRow {
  seq: number; ekey: string | null; type: string; id: string; job_id: string | null; ts_ns: string; data: Record<string, unknown>;
}

/** SQLite persistence. Everything here is rebuildable from chain (`reindex`). */
export class Db {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (token_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, customer TEXT NOT NULL, json TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS spends (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seats (token_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS charters (version INTEGER PRIMARY KEY, json TEXT NOT NULL, seen_ns TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ekey TEXT UNIQUE, type TEXT NOT NULL, id TEXT NOT NULL,
        job_id TEXT, ts_ns TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
      CREATE TABLE IF NOT EXISTS artifacts (hash TEXT PRIMARY KEY, json TEXT NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  /** Chain-derived tables are wiped by reindex; artifacts (off-chain, keyed by hash) are kept. */
  wipeChainData(): void {
    this.sql.exec('DELETE FROM agents; DELETE FROM jobs; DELETE FROM spends; DELETE FROM seats; DELETE FROM charters; DELETE FROM events; DELETE FROM cursors;');
  }

  getJson<T>(table: 'agents' | 'spends' | 'seats', key: string): T | null {
    const col = table === 'agents' || table === 'seats' ? 'token_id' : 'id';
    const r = this.sql.prepare(`SELECT json FROM ${table} WHERE ${col} = ?`).get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : null;
  }
  rawJson(table: 'agents' | 'spends' | 'seats', key: string): string | null {
    const col = table === 'agents' || table === 'seats' ? 'token_id' : 'id';
    const r = this.sql.prepare(`SELECT json FROM ${table} WHERE ${col} = ?`).get(key) as { json: string } | undefined;
    return r ? r.json : null;
  }
  putJson(table: 'agents' | 'spends' | 'seats', key: string, json: string): void {
    const col = table === 'agents' || table === 'seats' ? 'token_id' : 'id';
    this.sql.prepare(`INSERT INTO ${table} (${col}, json) VALUES (?, ?) ON CONFLICT(${col}) DO UPDATE SET json = excluded.json`).run(key, json);
  }
  allJson<T>(table: 'agents' | 'spends' | 'seats'): T[] {
    const col = table === 'agents' || table === 'seats' ? 'token_id' : 'id';
    const rows = this.sql.prepare(`SELECT json FROM ${table} ORDER BY CAST(${col} AS INTEGER)`).all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as T);
  }

  getJob(id: string): { json: string; meta: string } | null {
    const r = this.sql.prepare('SELECT json, meta FROM jobs WHERE id = ?').get(id) as { json: string; meta: string } | undefined;
    return r ?? null;
  }
  putJob(id: string, state: string, customer: string, json: string, meta: string): void {
    this.sql.prepare(
      'INSERT INTO jobs (id, state, customer, json, meta) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, customer = excluded.customer, json = excluded.json, meta = excluded.meta',
    ).run(id, state, customer, json, meta);
  }
  listJobs(state?: string, customer?: string): { json: string; meta: string }[] {
    const where: string[] = []; const args: string[] = [];
    if (state) { where.push('state = ?'); args.push(state); }
    if (customer) { where.push('customer = ?'); args.push(customer); }
    const sql = `SELECT json, meta FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CAST(id AS INTEGER) DESC`;
    return this.sql.prepare(sql).all(...args) as { json: string; meta: string }[];
  }

  putCharter(version: number, json: string, seenNs: string): void {
    this.sql.prepare('INSERT OR IGNORE INTO charters (version, json, seen_ns) VALUES (?, ?, ?)').run(version, json, seenNs);
  }
  charters(): { version: number; json: string; seen_ns: string }[] {
    return this.sql.prepare('SELECT version, json, seen_ns FROM charters ORDER BY version').all() as { version: number; json: string; seen_ns: string }[];
  }

  /** Returns the new event row, or null if `ekey` was already recorded. */
  addEvent(type: string, id: string, jobId: string | null, tsNs: string, data: Record<string, unknown>, ekey: string | null): EventRow | null {
    const r = this.sql.prepare('INSERT OR IGNORE INTO events (ekey, type, id, job_id, ts_ns, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ekey, type, id, jobId, tsNs, JSON.stringify(data));
    if (Number(r.changes) === 0) return null;
    return { seq: Number(r.lastInsertRowid), ekey, type, id, job_id: jobId, ts_ns: tsNs, data };
  }
  events(jobId: string): EventRow[] {
    const rows = this.sql.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq').all(jobId) as Row[];
    return rows.map(toEvent);
  }
  recentEvents(limit: number): EventRow[] {
    const rows = this.sql.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toEvent);
  }

  putArtifact(hash: string, json: string): void {
    this.sql.prepare('INSERT OR IGNORE INTO artifacts (hash, json, created_ms) VALUES (?, ?, ?)').run(hash, json, Date.now());
  }
  getArtifact(hash: string): string | null {
    const r = this.sql.prepare('SELECT json FROM artifacts WHERE hash = ?').get(hash) as { json: string } | undefined;
    return r ? r.json : null;
  }

  setCursor(k: string, v: string): void {
    this.sql.prepare('INSERT INTO cursors (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }
  cursor(k: string): string | null {
    const r = this.sql.prepare('SELECT v FROM cursors WHERE k = ?').get(k) as { v: string } | undefined;
    return r ? r.v : null;
  }
  close(): void { this.sql.close(); }
}

function toEvent(r: Row): EventRow {
  return {
    seq: Number(r.seq), ekey: (r.ekey as string | null) ?? null, type: String(r.type), id: String(r.id),
    job_id: (r.job_id as string | null) ?? null, ts_ns: String(r.ts_ns), data: JSON.parse(String(r.data)),
  };
}
