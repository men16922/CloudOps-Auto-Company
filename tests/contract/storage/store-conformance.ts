import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudOperationError } from '../../../packages/contracts/errors';
import type { CloudStore } from '../../../apps/host/src/storage/store';

export type CloudStoreUnderTest = { store: CloudStore; reopen?: () => Promise<CloudStore>; close(): Promise<void> };

/** Behavior every CloudStore adapter must show before the organization API may use it.
 * Run it against a disposable, synthetic database only. It covers the contract the registry, leases and
 * memberships rely on: optimistic isolation without lost updates, retryable callbacks, no partial commits,
 * read-before-write and copied values. It does not prove production durability, backups or audit immutability.
 */
export function cloudStoreConformance(name: string, open: () => Promise<CloudStoreUnderTest>) {
  const withStore = (title: string, body: (subject: CloudStoreUnderTest) => Promise<void>) => test(`${name}: ${title}`, async () => {
    const subject = await open();
    try { await body(subject); } finally { await subject.close(); }
  });

  withStore('absent keys read as undefined and committed writes are visible to later transactions', async ({ store }) => {
    assert.equal(await store.transact(tx => tx.get('conformance:absent')), undefined);
    await store.transact(async tx => { await tx.get('conformance:a'); tx.put('conformance:a', { value: 1, nested: { list: [1, 2] } }); });
    assert.deepEqual(await store.transact(tx => tx.get('conformance:a')), { value: 1, nested: { list: [1, 2] } });
  });

  withStore('returned values are copies, so caller mutation never changes stored state', async ({ store }) => {
    await store.transact(async tx => { await tx.get('conformance:copy'); tx.put('conformance:copy', { items: ['kept'] }); });
    await store.transact(async tx => { const value = await tx.get<{ items: string[] }>('conformance:copy'); value!.items.push('mutated'); });
    assert.deepEqual(await store.transact(tx => tx.get('conformance:copy')), { items: ['kept'] });
  });

  withStore('a throwing callback commits none of its staged writes', async ({ store }) => {
    await assert.rejects(store.transact(async tx => {
      await tx.get('conformance:x'); await tx.get('conformance:y');
      tx.put('conformance:x', 1); tx.put('conformance:y', 2);
      throw new Error('synthetic failure');
    }), /synthetic failure/);
    assert.deepEqual(await store.transact(async tx => [await tx.get('conformance:x'), await tx.get('conformance:y')]), [undefined, undefined]);
  });

  withStore('writes require a prior read of the same key and all reads precede writes', async ({ store }) => {
    await assert.rejects(store.transact(async tx => { tx.put('conformance:unread', 1); }));
    await assert.rejects(store.transact(async tx => { await tx.get('conformance:r1'); tx.put('conformance:r1', 1); await tx.get('conformance:r2'); }));
    assert.equal(await store.transact(tx => tx.get('conformance:unread')), undefined);
    assert.equal(await store.transact(tx => tx.get('conformance:r1')), undefined);
  });

  withStore('concurrent read-modify-write transactions retry instead of losing updates', async ({ store }) => {
    let calls = 0, arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writers = 5;
    await Promise.all(Array.from({ length: writers }, () => store.transact(async tx => {
      calls++;
      const value = await tx.get<number>('conformance:counter') ?? 0;
      if (++arrived === writers) release();
      await barrier; // Every writer has read the same version before anyone stages a write.
      tx.put('conformance:counter', value + 1);
    })));
    assert.equal(await store.transact(tx => tx.get('conformance:counter')), writers);
    assert.ok(calls > writers, 'conflicting callbacks must be re-run, so they may contain only storage reads/writes');
  });

  withStore('a create conditioned on an absent key conflicts with a concurrent create', async ({ store }) => {
    let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const results = await Promise.all(['first', 'second'].map(candidate => store.transact(async tx => {
      const existing = await tx.get<string>('conformance:owner');
      if (++arrived === 2) release();
      await barrier;
      if (existing) return existing;
      tx.put('conformance:owner', candidate); return candidate;
    })));
    assert.equal(results[0], results[1], 'both transactions must agree on a single owner');
  });

  withStore('records over 1 MiB are rejected with record_too_large and leave no partial write', async ({ store }) => {
    await assert.rejects(store.transact(async tx => {
      await tx.get('conformance:small'); await tx.get('conformance:large');
      tx.put('conformance:small', 'staged'); tx.put('conformance:large', 'x'.repeat(1_100_000));
    }), (error: unknown) => error instanceof CloudOperationError && error.status === 413 && error.code === 'record_too_large');
    assert.equal(await store.transact(tx => tx.get('conformance:small')), undefined);
  });

  withStore('committed state survives reopening the store', async subject => {
    if (!subject.reopen) return;
    await subject.store.transact(async tx => { await tx.get('conformance:durable'); tx.put('conformance:durable', { version: 2 }); });
    const reopened = await subject.reopen();
    assert.deepEqual(await reopened.transact(tx => tx.get('conformance:durable')), { version: 2 });
  });
}
