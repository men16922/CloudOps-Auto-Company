import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Last read results for one user's connection. Values are re-validated against the current binding before use. */
type CachedObservations = { savedAt: string; directory?: unknown; inventories: Record<string, unknown> };
/** One cached sync unit (one service in one account/region) with the job that produced it. */
type CachedUnit = { jobId: string; key: string; unit: unknown };
export interface ObservationCache {
  load(scope: readonly string[]): Promise<CachedObservations | undefined>;
  save(scope: readonly string[], kind: 'directory' | `inventory:${string}`, value: unknown, savedAt: string): Promise<void>;
  clear(scope: readonly string[]): Promise<void>;
  loadSync(scope: readonly string[]): Promise<{ summary: unknown; fetched: string[] } | undefined>;
  saveSync(scope: readonly string[], summary: unknown, fetched: string[]): Promise<void>;
  saveUnit(scope: readonly string[], key: string, jobId: string, unit: unknown): Promise<void>;
  loadUnits(scope: readonly string[]): Promise<CachedUnit[]>;
  pruneUnits(scope: readonly string[], keep: ReadonlySet<string>): Promise<void>;
  loadReport(scope: readonly string[]): Promise<unknown[]>;
  saveReport(scope: readonly string[], snapshots: unknown[]): Promise<void>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Local-disk cache (0700 directories, 0600 files, atomic replace). Names are digests of
 * organization/workspace/actor/connection/binding, so users never share an entry. Not an audit store; the host decides
 * retention. Browser storage is never used for observations.
 */
export class FileObservationCache implements ObservationCache {
  private readonly root: string;
  private queue: Promise<void> = Promise.resolve();
  constructor(root: string) { this.root = root; }
  private path(scope: readonly string[]) { return join(this.root, `${digest(scope)}.json`); }
  private units(scope: readonly string[]) { return join(this.root, `${digest(scope)}.units`); }
  /** Serialize writes in this process so concurrent reads of different kinds do not lose each other. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task); this.queue = run.then(() => undefined, () => undefined); return run;
  }
  private async directory(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
  private async atomic(target: string, value: unknown, limit: number) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > limit) return;
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, target);
  }
  private async json(path: string) { try { return JSON.parse(await readFile(path, 'utf8')) as unknown; } catch { return undefined; } }
  async load(scope: readonly string[]) {
    const value = await this.json(this.path(scope)) as CachedObservations | undefined;
    return value && typeof value === 'object' && typeof value.savedAt === 'string' && value.inventories && typeof value.inventories === 'object' ? value : undefined;
  }
  save(scope: readonly string[], kind: 'directory' | `inventory:${string}`, value: unknown, savedAt: string) {
    return this.serial(async () => {
      await this.directory(this.root);
      const current = await this.load(scope) ?? { savedAt, inventories: {} };
      const next: CachedObservations = kind === 'directory' ? { ...current, savedAt, directory: value }
        : { ...current, savedAt, inventories: { ...current.inventories, [kind.slice('inventory:'.length)]: value } };
      await this.atomic(this.path(scope), next, 2_000_000);
    });
  }
  async clear(scope: readonly string[]) { await rm(this.path(scope), { force: true }); await rm(this.units(scope), { recursive: true, force: true }); }
  async loadSync(scope: readonly string[]) {
    const value = await this.json(join(this.units(scope), 'sync.json')) as { summary?: unknown; fetched?: unknown } | undefined;
    return value && value.summary && Array.isArray(value.fetched) ? { summary: value.summary, fetched: value.fetched.filter((item): item is string => typeof item === 'string') } : undefined;
  }
  saveSync(scope: readonly string[], summary: unknown, fetched: string[]) {
    return this.serial(async () => { await this.directory(this.root); await this.directory(this.units(scope)); await this.atomic(join(this.units(scope), 'sync.json'), { summary, fetched }, 4_000_000); });
  }
  /** One file per account/region/service key: a newer sync replaces the older unit for the same key. */
  saveUnit(scope: readonly string[], key: string, jobId: string, unit: unknown) {
    return this.serial(async () => { await this.directory(this.root); await this.directory(this.units(scope)); await this.atomic(join(this.units(scope), `u-${digest(key)}.json`), { jobId, key, unit }, 512_000); });
  }
  async loadUnits(scope: readonly string[]) {
    let names: string[]; try { names = await readdir(this.units(scope)); } catch { return []; }
    const units: CachedUnit[] = [];
    for (const name of names.filter(item => /^u-[a-f0-9]{64}\.json$/.test(item)).slice(0, 20_000)) {
      const value = await this.json(join(this.units(scope), name)) as Partial<CachedUnit> | undefined;
      if (value && typeof value.jobId === 'string' && typeof value.key === 'string' && name === `u-${digest(value.key)}.json`) units.push({ jobId: value.jobId, key: value.key, unit: value.unit });
    }
    return units;
  }
  /** Per-sync assessment snapshots for trend reports (bounded by the caller; never read by unit loading or pruning). */
  async loadReport(scope: readonly string[]) {
    const value = await this.json(join(this.units(scope), 'report.json'));
    return Array.isArray(value) ? value : [];
  }
  saveReport(scope: readonly string[], snapshots: unknown[]) {
    return this.serial(async () => { await this.directory(this.root); await this.directory(this.units(scope)); await this.atomic(join(this.units(scope), 'report.json'), snapshots, 8_000_000); });
  }
  /** After a complete sync, units for keys the sync no longer produced (e.g. a region that lost its tagged VPC) are removed. */
  pruneUnits(scope: readonly string[], keep: ReadonlySet<string>) {
    return this.serial(async () => {
      let names: string[]; try { names = await readdir(this.units(scope)); } catch { return; }
      const kept = new Set([...keep].map(key => `u-${digest(key)}.json`));
      for (const name of names) if (/^u-[a-f0-9]{64}\.json$/.test(name) && !kept.has(name)) await rm(join(this.units(scope), name), { force: true });
    });
  }
}
