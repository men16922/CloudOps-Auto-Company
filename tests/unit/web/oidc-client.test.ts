import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OidcWebIdentityClient, oidcCallbackChannel, type OidcClientDependencies } from '../../../apps/web/src/identity/oidc-client';
import type { WebIdentity } from '../../../apps/web/src/identity/web-identity';

// Synthetic IdP responses only. The popup and token endpoint are injected; nothing leaves the process.
const origin = 'https://cloudops.example.invalid', issuer = 'https://idp.example.invalid/synthetic';
const config = { issuer, clientId: 'cloudops-synthetic-web', authorizationEndpoint: 'https://idp.example.invalid/authorize', tokenEndpoint: 'https://idp.example.invalid/token', endSessionEndpoint: 'https://idp.example.invalid/logout' };
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${part({ alg: 'RS256', kid: 'synthetic' })}.${part(claims)}.c2lnbmF0dXJl`;

function harness(t: TestContext, options: { blocked?: boolean; claims?: (nonce: string) => Record<string, unknown>; status?: number; extra?: Record<string, unknown> } = {}) {
  let now = 1_800_000_000_000;
  const navigations: string[] = [], closes: number[] = [], requests: URLSearchParams[] = [];
  const deps: OidcClientDependencies = {
    origin, now: () => now, timeoutMs: 200,
    openPopup: () => options.blocked ? null : { navigate: url => { navigations.push(url); }, close: () => { closes.push(now); } },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), config.tokenEndpoint); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      const body = new URLSearchParams(String(init?.body)); requests.push(body);
      const authorize = new URL(navigations.at(-1)!), nonce = authorize.searchParams.get('nonce')!;
      // The synthetic IdP enforces PKCE like a real public-client token endpoint.
      const challenge = createHash('sha256').update(body.get('code_verifier')!).digest('base64url');
      if (challenge !== authorize.searchParams.get('code_challenge')) return new Response('{"error":"invalid_grant"}', { status: 400 });
      const claims = options.claims?.(nonce) ?? { iss: issuer, aud: config.clientId, sub: 'employee-a', nonce, exp: Math.floor(now / 1000) + 600, name: 'Synthetic Employee' };
      return new Response(JSON.stringify({ id_token: idToken(claims), access_token: 'synthetic-access', expires_in: 300, ...options.extra }), { status: options.status ?? 200 });
    }) as typeof fetch,
  };
  const client = new OidcWebIdentityClient(config, deps), identities: Array<WebIdentity | null> = [];
  client.subscribe(identity => identities.push(identity));
  t.after(() => client.close());
  let seen = 0;
  const authorize = async () => { for (let i = 0; i < 100 && navigations.length <= seen; i++) await delay(2); seen = navigations.length; return new URL(navigations.at(-1)!); };
  const callback = (message: Record<string, unknown>) => { const channel = new BroadcastChannel(oidcCallbackChannel); channel.postMessage({ type: 'cloudops-oidc-callback', code: null, error: null, ...message }); channel.close(); };
  return { client, identities, navigations, closes, requests, authorize, callback, advance: (ms: number) => { now += ms; } };
}

test('PKCE popup sign-in exchanges the code once and keeps the id_token only in memory', async t => {
  const h = harness(t), pending = h.client.signIn(), url = await h.authorize();
  assert.equal(url.origin + url.pathname, config.authorizationEndpoint);
  assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([key]) => !['state', 'nonce', 'code_challenge'].includes(key))),
    { response_type: 'code', client_id: config.clientId, redirect_uri: `${origin}/oidc-callback.html`, scope: 'openid', code_challenge_method: 'S256' });
  h.callback({ state: 'another-tab-state', code: 'foreign-code' });
  h.callback({ state: url.searchParams.get('state'), code: 'synthetic-code' });
  await pending;
  assert.equal(h.requests.length, 1, 'the foreign state was ignored');
  assert.deepEqual(Object.fromEntries([...h.requests[0]!].filter(([key]) => key !== 'code_verifier')),
    { grant_type: 'authorization_code', code: 'synthetic-code', redirect_uri: `${origin}/oidc-callback.html`, client_id: config.clientId });
  const identity = h.identities.at(-1)!;
  assert.equal(identity.label, 'Synthetic Employee'); assert.match(identity.key, /^[A-Za-z0-9_-]{43}$/);
  assert.match(await h.client.tokenFor(identity.key), /^[^.]+\.[^.]+\.[^.]+$/);
  await assert.rejects(h.client.tokenFor('another-identity'), /identity_changed/);
});

test('nonce, issuer, audience, expiry, IdP errors and token endpoint failures leave the user signed out', async t => {
  const variants: Array<Parameters<typeof harness>[1]> = [
    { claims: () => ({ iss: issuer, aud: config.clientId, sub: 'employee-a', nonce: 'replayed', exp: 1_800_000_600 }) },
    { claims: nonce => ({ iss: 'https://idp.example.invalid/other', aud: config.clientId, sub: 'employee-a', nonce, exp: 1_800_000_600 }) },
    { claims: nonce => ({ iss: issuer, aud: 'another-client', sub: 'employee-a', nonce, exp: 1_800_000_600 }) },
    { claims: nonce => ({ iss: issuer, aud: config.clientId, sub: 'employee-a', nonce, exp: 1_799_999_000 }) },
    { status: 400 },
  ];
  for (const variant of variants) {
    const h = harness(t, variant), pending = h.client.signIn(), url = await h.authorize();
    h.callback({ state: url.searchParams.get('state'), code: 'synthetic-code' });
    await assert.rejects(pending); assert.deepEqual(h.identities, [null]); assert.equal(h.closes.length, 1);
  }
  const rejected = harness(t), pending = rejected.client.signIn(), url = await rejected.authorize();
  rejected.callback({ state: url.searchParams.get('state'), error: 'access_denied' });
  await assert.rejects(pending, /sign_in_rejected/); assert.equal(rejected.requests.length, 0);
});

test('blocked popups, timeouts and a newer attempt fail closed without leaking the old attempt', async t => {
  await assert.rejects(harness(t, { blocked: true }).client.signIn(), /popup_blocked/);
  const slow = harness(t);
  await assert.rejects(slow.client.signIn(), /sign_in_timeout/); assert.equal(slow.closes.length, 1);
  const h = harness(t), first = h.client.signIn(), firstUrl = await h.authorize();
  const second = h.client.signIn();
  await assert.rejects(first, /sign_in_cancelled/);
  const secondUrl = await h.authorize();
  h.callback({ state: firstUrl.searchParams.get('state'), code: 'stale-code' });
  h.callback({ state: secondUrl.searchParams.get('state'), code: 'fresh-code' });
  await second;
  assert.deepEqual(h.requests.map(body => body.get('code')), ['fresh-code']);
});

test('expiry clears the identity, sign-out ends the IdP session and access_token bearer uses the shorter lifetime', async t => {
  const h = harness(t), pending = h.client.signIn(), url = await h.authorize();
  h.callback({ state: url.searchParams.get('state'), code: 'synthetic-code' }); await pending;
  const key = h.identities.at(-1)!.key;
  h.advance(571_000);
  await assert.rejects(h.client.tokenFor(key), /web_sign_in_required/); assert.equal(h.identities.at(-1), null);
  const again = h.client.signIn(), next = await h.authorize();
  h.callback({ state: next.searchParams.get('state'), code: 'synthetic-code-2' }); await again;
  await h.client.signOut();
  assert.equal(h.identities.at(-1), null);
  const logout = new URL(h.navigations.at(-1)!);
  assert.equal(logout.origin + logout.pathname, config.endSessionEndpoint); assert.equal(logout.searchParams.get('client_id'), config.clientId);
  assert.ok(logout.searchParams.get('id_token_hint')); assert.equal(logout.searchParams.get('post_logout_redirect_uri'), `${origin}/oidc-callback.html`);
  const access = { navigations: [] as string[], seen: 0, async authorize() { for (let i = 0; i < 100 && this.navigations.length <= this.seen; i++) await delay(2); this.seen = this.navigations.length; return new URL(this.navigations.at(-1)!); },
    callback: h.callback }, accessClient = new OidcWebIdentityClient({ ...config, bearer: 'access_token' }, { origin, now: () => 1_800_000_000_000, timeoutMs: 200,
    openPopup: () => ({ navigate: url => { access.navigations.push(url); }, close: () => undefined }),
    fetch: (async () => { const nonce = new URL(access.navigations.at(-1)!).searchParams.get('nonce');
      return new Response(JSON.stringify({ id_token: idToken({ iss: issuer, aud: config.clientId, sub: 'employee-a', nonce, exp: 1_800_000_600 }), access_token: 'synthetic-access', expires_in: 60 })); }) as typeof fetch });
  t.after(() => accessClient.close());
  let accessIdentity: WebIdentity | null = null; accessClient.subscribe(value => { accessIdentity = value; });
  const accessPending = accessClient.signIn(), accessUrl = await access.authorize();
  access.callback({ state: accessUrl.searchParams.get('state'), code: 'synthetic-code' }); await accessPending;
  assert.equal(await accessClient.tokenFor(accessIdentity!.key), 'synthetic-access');
});
