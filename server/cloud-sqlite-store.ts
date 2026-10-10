import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { CloudStore, CloudTransaction } from './cloud-store';
import { CloudOperationError } from '../src/domain/cloud-workflow';

/** Local durable adapter only. Cloud Run must inject an external persistent store. */
export class SqliteCloudStore implements CloudStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') { const fd = openSync(path, 'a', 0o600); closeSync(fd); chmodSync(path, 0o600); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cloud_records (key TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  async transact<T>(body: (transaction: CloudTransaction) => Promise<T>): Promise<T> {
    // Optimistic reads keep awaited callbacks outside SQLite's write lock. Validate
    // every read (including absent keys) atomically, then commit all staged writes.
    for (let attempt = 0; attempt < 10; attempt++) {
      const reads = new Map<string, { version: number; value: unknown }>();
      const writes = new Map<string, string>();
      let writing = false;
      const result = await body({
        get: async <V>(key: string) => {
          if (writing) throw new Error('Complete transaction reads before writes.');
          if (!reads.has(key)) {
            const row = this.db.prepare('SELECT version, payload FROM cloud_records WHERE key=?').get(key);
            reads.set(key, { version: row ? Number(row.version) : 0, value: row ? JSON.parse(String(row.payload)) : undefined });
          }
          return structuredClone(reads.get(key)!.value) as V | undefined;
        },
        put: (key, value) => {
          if (!reads.has(key)) throw new Error('Read a record before writing it.');
          const payload = JSON.stringify(value);
          if (!payload || Buffer.byteLength(payload) > 750_000) throw new CloudOperationError(413, 'record_too_large', 'The record exceeds the storage limit.');
          writing = true; writes.set(key, payload);
        },
      });
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const conflicted = [...reads].some(([key, read]) => {
          const row = this.db.prepare('SELECT version FROM cloud_records WHERE key=?').get(key);
          return (row ? Number(row.version) : 0) !== read.version;
        });
        if (conflicted) { this.db.exec('ROLLBACK'); continue; }
        for (const [key, payload] of writes) {
          this.db.prepare(`INSERT INTO cloud_records(key, version, payload) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET version=version+1, payload=excluded.payload`).run(key, payload);
        }
        this.db.exec('COMMIT'); return result;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    throw new CloudOperationError(409, 'concurrent_change', 'The record changed concurrently. Refresh and retry.');
  }
}
