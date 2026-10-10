import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCloudStore } from './cloud-sqlite-store';
import { cloudStoreConformance } from './cloud-store-conformance';

// The local SQLite adapter must pass the same suite a company production adapter will run.
cloudStoreConformance('SqliteCloudStore (file)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-store-conformance-')), path = join(directory, 'cloud.sqlite');
  const opened = [new SqliteCloudStore(path)];
  return { store: opened[0]!, reopen: async () => { const store = new SqliteCloudStore(path); opened.push(store); return store; },
    close: async () => { opened.forEach(store => store.close()); await rm(directory, { recursive: true, force: true }); } };
});
cloudStoreConformance('SqliteCloudStore (memory)', async () => {
  const store = new SqliteCloudStore(':memory:');
  return { store, close: async () => store.close() };
});
