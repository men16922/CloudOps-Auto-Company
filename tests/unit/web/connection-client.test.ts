import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { OrganizationConnectionClient } from '../../../apps/web/src/api/connection-client';
import type { WebIdentity, WebIdentityClient } from '../../../apps/web/src/identity/web-identity';

const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', label: 'Synthetic organization' };
const row = { id: '11111111-1111-4111-8111-111111111111', configurationId: 'read', accountId: '123456789012', roleName: 'ReadOnlyAccess', region: 'us-east-1', createdAt: '2026-10-10T00:00:00Z' };
const config = { id: 'read', label: 'Read access', accountId: row.accountId, roleName: row.roleName, region: row.region };
const status = { connectionId: row.id, accountId: row.accountId, roleName: row.roleName, region: row.region, status: 'connected' };
class Identity implements WebIdentityClient {
  listeners = new Set<(identity: WebIdentity | null) => void>();
  current: WebIdentity | null = null;
  tokens: string[] = [];
  emit(key: string | null) { this.current = key ? { key, label: key } : null; this.listeners.forEach(listener => listener(this.current)); }
  subscribe(listener: (identity: WebIdentity | null) => void) { this.listeners.add(listener); listener(this.current); return () => { this.listeners.delete(listener); }; }
  async signIn() { this.emit('user-a'); }
  async signOut() { this.emit(null); }
  async tokenFor(key: string) { if (this.current?.key !== key) throw new Error('changed'); this.tokens.push(key); return `synthetic-${key}`; }
  async close() { this.listeners.clear(); }
}
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json' } });
const fixture = (fetcher: typeof fetch) => { const identity = new Identity(); const client = new OrganizationConnectionClient(identity, scope, fetcher); return { identity, client }; };

test('web client drops in-flight account data across identity switches and signs out before late auth callbacks', async t => {
  let resolve!: (value: Response) => void;
  const old = new Promise<Response>(done => { resolve = done; });
  const { identity, client } = fixture(async (_url, request) => new Headers(request?.headers).get('Authorization') === 'Bearer synthetic-user-a' ? old : json({ items: [], configurations: [] }));
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); identity.emit('user-b'); await nextTurn();
  resolve(json({ items: [row], configurations: [config] })); await nextTurn();
  assert.equal(client.getSnapshot().identity?.key, 'user-b'); assert.deepEqual(client.getSnapshot().list.items, []);
  identity.signOut = async () => { identity.emit('user-b'); }; await client.signOut();
  assert.equal(client.getSnapshot().identity, null); assert.deepEqual(client.getSnapshot().list.items, []);
});

test('web client refuses credentials in worker results and clears all data on revoked membership', async t => {
  let denied = false, secret = false;
  const { identity, client } = fixture(async url => String(url).endsWith('/status') ? denied ? json({ code: 'organization_access_denied' }, 403) : json(secret ? { ...status, accessToken: 'synthetic-secret' } : status) : json({ items: [row], configurations: [config] }));
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); await client.select(row.id);
  assert.equal(client.getSnapshot().status?.status, 'connected'); secret = true; await client.refreshStatus();
  assert.equal(client.getSnapshot().status, undefined); assert.ok(!JSON.stringify(client.getSnapshot()).includes('synthetic-secret'));
  denied = true; await client.refreshStatus(); assert.deepEqual(client.getSnapshot().list.items, []); assert.equal(client.getSnapshot().selectedId, undefined);
});

test('web client retries the same mutation key after lost replies and never sends scope/profile overrides', async t => {
  const writes: { headers: Headers; body: unknown; url: string }[] = []; let lost = true;
  const { identity, client } = fixture(async (url, request) => {
    if (request?.method === 'POST') { writes.push({ headers: new Headers(request.headers), body: JSON.parse(String(request.body)), url: String(url) }); if (lost) { lost = false; throw new Error('Lost reply'); } return json(status); }
    return json(String(url).endsWith('/status') ? status : { items: [row], configurations: [config] });
  });
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); await client.select(row.id); await client.perform({ operation: 'login' });
  assert.equal(client.getSnapshot().retryable, true); await client.retry(); assert.equal(writes.length, 2);
  assert.equal(writes[0].headers.get('Idempotency-Key'), writes[1].headers.get('Idempotency-Key'));
  assert.deepEqual(writes[0].body, { operation: 'login' }); assert.ok(writes[0].url.startsWith('/api/organizations/v1/synthetic-org/workspaces/synthetic-workspace/'));
  assert.ok(!JSON.stringify(client.getSnapshot()).includes('synthetic-user-a'));
});

test('web client discards cross-connection results and untrusted device links', async t => {
  let result: unknown = { ...status, accountId: '999999999999' };
  const { identity, client } = fixture(async url => json(String(url).endsWith('/status') ? result : { items: [row], configurations: [config] }));
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); await client.select(row.id); assert.equal(client.getSnapshot().status, undefined);
  for (const url of ['https://evil.invalid/', 'https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE', 'https://example.awsapps.com/start#token']) {
    result = { ...status, status: 'awaiting-user', userCode: 'DEMO-CODE', verificationUri: url }; await client.refreshStatus(); assert.equal(client.getSnapshot().status, undefined);
  }
  result = { ...status, status: 'awaiting-user', userCode: 'DEMO-CODE', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/' }; await client.refreshStatus(); assert.equal(client.getSnapshot().status?.userCode, 'DEMO-CODE');
  result = { ...status, status: 'awaiting-user', userCode: 'DEMO-CODE', verificationUri: 'https://example.awsapps.com/start/#/device' }; await client.refreshStatus(); assert.equal(client.getSnapshot().status?.verificationUri, 'https://example.awsapps.com/start/#/device');
  result = { ...status, status: 'awaiting-user', userCode: 'DEMO-CODE', verificationUri: 'https://example.awsapps.com/start/#/device', verificationUriComplete: 'https://example.awsapps.com/start/#/device?user_code=DEMO-CODE' };
  await client.refreshStatus(); assert.equal(client.getSnapshot().status?.verificationUriComplete, 'https://example.awsapps.com/start/#/device?user_code=DEMO-CODE');
  for (const complete of ['https://example.awsapps.com/start/#/device?user_code=OTHR-CODE', 'https://evil.invalid/start/#/device?user_code=DEMO-CODE', 'https://example.awsapps.com/start/#/device?user_code=DEMO-CODE&x=1']) {
    result = { ...status, status: 'awaiting-user', userCode: 'DEMO-CODE', verificationUri: 'https://example.awsapps.com/start/#/device', verificationUriComplete: complete };
    await client.refreshStatus(); assert.notEqual(client.getSnapshot().status?.verificationUriComplete, complete, complete);
  }
});

test('closing the web client cancels requests and prevents late results after unmount', async () => {
  let resolve!: (value: Response) => void, signal: AbortSignal | undefined | null;
  const response = new Promise<Response>(done => { resolve = done; });
  const { identity, client } = fixture(async (_url, request) => { signal = request?.signal; return response; });
  identity.emit('user-a'); await nextTurn(); client.close(); assert.equal(signal?.aborted, true);
  resolve(json({ items: [row], configurations: [config] })); await nextTurn(); assert.deepEqual(client.getSnapshot().list.items, []);
});


test('directory web results must match the configured parent and clear on auth/connection changes', async t => {
  const directory = { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' };
  const observedAt = '2026-10-10T00:00:00Z'; let responseScope = directory;
  const { identity, client } = fixture(async (url, request) => request?.method === 'POST'
    ? json({ connectionId: row.id, accountId: row.accountId, region: row.region, scope: responseScope, coverage: 'direct-children-page', parentId: responseScope.parentId, navigation: { expiresAt: '2026-10-10T00:10:00Z', path: [{ id: responseScope.parentId, name: 'Synthetic root', cursor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }, collectedAt: observedAt,
      accounts: { status: 'collected', source: 'organizations:ListAccountsForParent', observedAt, items: [], hasMore: true, pageNumber: 1 },
      organizationalUnits: { status: 'denied', source: 'organizations:ListOrganizationalUnitsForParent', observedAt, code: 'access_denied' } })
    : json(String(url).endsWith('/status') ? status : { items: [{ ...row, directory }], configurations: [{ ...config, directory }] }));
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); await client.select(row.id);
  await client.perform({ operation: 'directory' }); assert.equal(client.getSnapshot().directory?.accounts.status, 'collected');
  await client.select(row.id); assert.equal(client.getSnapshot().directory, undefined);
  responseScope = { ...directory, parentId: 'r-other' }; await client.perform({ operation: 'directory' }); assert.equal(client.getSnapshot().directory, undefined); assert.equal(client.getSnapshot().error, 'invalid_response');
  responseScope = directory; await client.refreshStatus(); await client.perform({ operation: 'directory' }); assert.ok(client.getSnapshot().directory);
  await client.signOut(); assert.equal(client.getSnapshot().directory, undefined);
});

test('selecting a connected payer shows cached observations and inventory before the automatic sync can start', async t => {
  const calls: string[] = [], savedAt = '2026-10-10T00:00:00Z';
  const cached = { connectionId: row.id, accountId: row.accountId, region: row.region, operation: 'lambda', collectedAt: savedAt, items: [{ name: 'synthetic-function', runtime: 'python3.12' }], hasMore: false };
  const { identity, client } = fixture(async url => {
    const path = String(url); calls.push(path.split('/').at(-1)!);
    return json(path.endsWith('/status') ? status : path.endsWith('/report') ? { snapshots: [] } : path.endsWith('/views') ? { items: [] } : path.endsWith('/alerts') ? { configured: false, recipients: [], history: [] } : path.endsWith('/observations') ? { savedAt, inventories: { lambda: cached } } : path.endsWith('/inventory/all') ? { service: 'all', units: [{ accountId: row.accountId, region: row.region, service: 'lambda', collectedAt: savedAt, hasMore: false, items: [{ name: 'synthetic-function' }], source: 'direct' }], truncated: false } : { items: [row], configurations: [config] });
  });
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn();
  // The view starts refreshAll as soon as it sees a connected status; by then the cache must already be shown.
  let atConnected: unknown;
  const stop = client.subscribe(() => { const value = client.getSnapshot(); if (value.status?.status === 'connected' && atConnected === undefined) atConnected = value.inventories.lambda?.items[0]?.name ?? null; });
  t.after(stop); calls.length = 0; await client.select(row.id);
  assert.deepEqual(calls, ['observations', 'all', 'report', 'views', 'alerts', 'status'], 'report history, saved views and alert status come from the host, never a worker');
  assert.deepEqual(client.getSnapshot().alerts, { configured: false, recipients: [], history: [] });
  assert.deepEqual([client.getSnapshot().report, client.getSnapshot().views], [[], []]);
  assert.equal(atConnected, 'synthetic-function'); assert.equal(client.getSnapshot().observedFrom, 'cache');
  assert.deepEqual(client.getSnapshot().units.lambda?.map(unit => unit.items[0]?.name), ['synthetic-function'], 'the cached multi-account inventory is loaded before the session status');
});

test('an action without a running worker asks for a new AWS sign-in instead of replaying an unknown request', async t => {
  const savedAt = '2026-10-10T00:00:00Z', writes: unknown[] = [];
  const cached = { connectionId: row.id, accountId: row.accountId, region: row.region, operation: 'lambda', collectedAt: savedAt, items: [{ name: 'synthetic-function' }], hasMore: false };
  const { identity, client } = fixture(async (url, request) => {
    const path = String(url);
    if (request?.method === 'POST') { writes.push(JSON.parse(String(request.body))); return json({ code: 'worker_unavailable' }, 503); }
    return path.endsWith('/status') ? json({ code: 'worker_unavailable' }, 503) : json(path.endsWith('/report') ? { snapshots: [] } : path.endsWith('/views') ? { items: [] } : path.endsWith('/alerts') ? { configured: false, recipients: [], history: [] } : path.endsWith('/observations') ? { savedAt, inventories: { lambda: cached } } : path.endsWith('/inventory/all') ? { service: 'all', units: [], truncated: false } : { items: [row], configurations: [config] });
  });
  t.after(() => client.close()); identity.emit('user-a'); await nextTurn(); await client.select(row.id);
  assert.equal(client.getSnapshot().status, undefined, 'no worker after a host restart is the ordinary signed-out state');
  await client.perform({ operation: 'verify' });
  assert.deepEqual([client.getSnapshot().error, client.getSnapshot().retryable], ['aws_session_required', false]);
  assert.equal(client.getSnapshot().inventories.lambda?.items[0]?.name, 'synthetic-function', 'saved results stay visible');
  await client.retry(); assert.equal(writes.length, 1, 'the unknown request is not replayed');
  await client.perform({ operation: 'login' });
  assert.deepEqual([client.getSnapshot().error, client.getSnapshot().retryable], ['worker_unavailable', false], 'a worker that cannot start is reported, not replayed');
});
