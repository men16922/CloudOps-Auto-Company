import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { identityActor } from '../../../apps/host/src/identity/web-access';
import { OidcJwtVerifier, oidcVerifierConfigSchema, type OidcVerifierConfig } from '../../../apps/host/src/identity/oidc-verifier';

// Synthetic keys and claims only. No IdP, discovery document or network endpoint is contacted.
const issuer = 'https://idp.example.invalid/tenant', audience = 'cloudops-synthetic-api';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }), ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }), rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string, extra: Record<string, string> = {}) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig', ...extra });
const keys = { keys: [jwk(rsa.publicKey, 'rsa-1'), jwk(ec.publicKey, 'ec-1'), jwk(weak.publicKey, 'weak-1'), jwk(rsa.publicKey, 'rsa-ps', { alg: 'PS256' })] } as OidcVerifierConfig['jwks'];
let now = 1_800_000_000_000;
const seconds = () => Math.floor(now / 1000);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(options: { alg?: string; kid?: string; key?: KeyObject; header?: Record<string, unknown>; claims?: Record<string, unknown> } = {}) {
  const alg = options.alg ?? 'RS256', key = options.key ?? (alg === 'ES256' ? ec.privateKey : rsa.privateKey);
  const data = `${b64({ alg, typ: 'JWT', kid: options.kid ?? (alg === 'ES256' ? 'ec-1' : 'rsa-1'), ...options.header })}.${b64({ iss: issuer, aud: audience, sub: 'employee-a', iat: seconds(), exp: seconds() + 600, ...options.claims })}`;
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
    : alg === 'PS256' ? sign('sha256', Buffer.from(data), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
      : sign('sha256', Buffer.from(data), key);
  return `${data}.${signature.toString('base64url')}`;
}
const verifier = (config: Partial<OidcVerifierConfig> = {}, options: ConstructorParameters<typeof OidcJwtVerifier>[1] = {}) =>
  new OidcJwtVerifier({ kind: 'oidc', issuer, audience, jwks: keys, ...config }, { now: () => now, ...options });

test('a signed RS256 token maps issuer/tenant/subject to a stable actor and keeps the token expiry', async () => {
  const identity = await verifier().verify(token());
  assert.deepEqual(identity, { actorId: identityActor(issuer, 'employee-a'), expiresAt: (seconds() + 600) * 1000 });
  assert.notEqual(identity.actorId, (await verifier().verify(token({ claims: { sub: 'employee-b' } }))).actorId);
  // Email/role claims do not change the actor or grant anything.
  assert.equal((await verifier().verify(token({ claims: { email: 'other@example.invalid', roles: ['admin'] } }))).actorId, identity.actorId);
});

test('ES256 and PS256 need explicit configuration; none, HMAC and key-type confusion are rejected', async () => {
  await assert.rejects(verifier().verify(token({ alg: 'ES256' })));
  await assert.rejects(verifier().verify(token({ alg: 'PS256', kid: 'rsa-ps' })));
  const both = verifier({ algorithms: ['RS256', 'ES256', 'PS256'] });
  assert.equal((await both.verify(token({ alg: 'ES256' }))).actorId, identityActor(issuer, 'employee-a'));
  assert.equal((await both.verify(token({ alg: 'PS256', kid: 'rsa-ps' }))).actorId, identityActor(issuer, 'employee-a'));
  await assert.rejects(both.verify(token({ alg: 'RS256', kid: 'rsa-ps' })), 'a key pinned to PS256 cannot verify RS256');
  await assert.rejects(both.verify(token({ alg: 'ES256', kid: 'rsa-1', key: ec.privateKey })), 'an EC header cannot select an RSA key');
  const unsigned = `${b64({ alg: 'none', kid: 'rsa-1' })}.${b64({ iss: issuer, aud: audience, sub: 'employee-a', iat: seconds(), exp: seconds() + 600 })}.`;
  await assert.rejects(both.verify(unsigned));
  const hmacData = `${b64({ alg: 'HS256', kid: 'rsa-1' })}.${b64({ iss: issuer, aud: audience, sub: 'employee-a', iat: seconds(), exp: seconds() + 600 })}`;
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(both.verify(`${hmacData}.${createHmac('sha256', pem).update(hmacData).digest('base64url')}`));
});

test('issuer, audience, time window, lifetime, header and signature checks fail closed', async () => {
  const v = verifier(), cases: Array<[string, string]> = [
    ['issuer', token({ claims: { iss: 'https://idp.example.invalid/other' } })],
    ['audience', token({ claims: { aud: 'another-api' } })],
    ['multi-audience without azp', token({ claims: { aud: [audience, 'another-api'] } })],
    ['expired', token({ claims: { exp: seconds() } })],
    ['issued in the future', token({ claims: { iat: seconds() + 120, exp: seconds() + 600 } })],
    ['not yet valid', token({ claims: { nbf: seconds() + 120 } })],
    ['lifetime', token({ claims: { exp: seconds() + 7200 } })],
    ['missing subject', token({ claims: { sub: '' } })],
    ['critical header', token({ header: { crit: ['exp'] } })],
    ['unexpected type', token({ header: { typ: 'logout+jwt' } })],
    ['unknown kid', token({ kid: 'missing' })],
    ['weak RSA key', token({ kid: 'weak-1', key: weak.privateKey })],
    ['wrong signer', token({ key: rotated.privateKey })],
    ['malformed', 'not.a-token'],
  ];
  for (const [name, value] of cases) await assert.rejects(v.verify(value), `${name} must be rejected`);
  const [header, , signature] = token().split('.');
  await assert.rejects(v.verify(`${header}.${b64({ iss: issuer, aud: audience, sub: 'employee-b', iat: seconds(), exp: seconds() + 600 })}.${signature}`), 'tampered payload');
  assert.ok(await v.verify(token({ claims: { aud: [audience, 'another-api'], azp: audience } })));
  assert.ok(await v.verify(token({ claims: { iat: seconds() + 30, nbf: seconds() + 30 } })), 'small clock skew is tolerated');
});

test('tenant allow-list and revocation hook are part of the verified identity', async () => {
  const tenant = { claim: 'tid', allowed: ['tenant-a'] };
  await assert.rejects(verifier({ tenant }).verify(token()));
  await assert.rejects(verifier({ tenant }).verify(token({ claims: { tid: 'tenant-b' } })));
  const actor = (await verifier({ tenant }).verify(token({ claims: { tid: 'tenant-a' } }))).actorId;
  assert.equal(actor, identityActor(issuer, 'employee-a', 'tenant-a')); assert.notEqual(actor, identityActor(issuer, 'employee-a'));
  const seen: string[] = [];
  await assert.rejects(verifier({}, { isRevoked: async claims => { seen.push(claims.sub); return true; } }).verify(token()));
  await assert.rejects(verifier({}, { isRevoked: async () => { throw new Error('revocation service unavailable'); } }).verify(token()));
  assert.ok(await verifier({}, { isRevoked: async () => false }).verify(token()));
  assert.deepEqual(seen, ['employee-a']);
});

test('remote JWKS is cached, refreshed for rotation at most once a minute and never amplified by unknown kids or outages', async () => {
  const uri = 'https://idp.example.invalid/tenant/jwks';
  // An unsupported provider key (OKP) and a symmetric key are skipped without dropping the usable RSA key.
  let body: unknown = { keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'AAAA', kid: 'okp-1' }, { kty: 'oct', k: 'c2VjcmV0', kid: 'rsa-1-shadow' }, jwk(rsa.publicKey, 'rsa-1')] }, status = 200, calls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal(String(input), uri); assert.equal(init?.redirect, 'error');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  const v = verifier({ jwks: { uri, cacheSeconds: 600 } }, { fetch: fetcher });
  assert.ok(await v.verify(token())); assert.ok(await v.verify(token())); assert.equal(calls, 1);
  await assert.rejects(v.verify(token({ kid: 'forged-1' }))); await assert.rejects(v.verify(token({ kid: 'forged-2' })));
  assert.equal(calls, 1, 'unknown kids within a minute of the last fetch do not call the provider');
  now += 61_000; body = { keys: [jwk(rotated.publicKey, 'rsa-2')] };
  assert.ok(await v.verify(token({ kid: 'rsa-2', key: rotated.privateKey }))); assert.equal(calls, 2);
  await assert.rejects(v.verify(token()), 'a removed key is no longer trusted after rotation');
  now += 601_000; status = 503;
  assert.ok(await v.verify(token({ kid: 'rsa-2', key: rotated.privateKey })), 'an outage keeps the last good key set');
  await assert.rejects(v.verify(token({ kid: 'forged-3' }))); assert.equal(calls, 3);
  now += 61_000; status = 200; body = 'x'.repeat(70_000);
  await assert.rejects(v.verify(token({ kid: 'forged-4' }))); assert.equal(calls, 4);
  assert.ok(await v.verify(token({ kid: 'rsa-2', key: rotated.privateKey })), 'an oversized response does not replace keys');
});

test('verifier configuration requires https issuer/JWKS and bounded settings', () => {
  const base = { kind: 'oidc', issuer, audience, jwks: keys };
  assert.ok(oidcVerifierConfigSchema.parse(base));
  for (const invalid of [{ issuer: 'http://idp.example.invalid' }, { jwks: { uri: 'http://idp.example.invalid/jwks' } }, { jwks: { uri: 'https://idp.example.invalid/jwks?tenant=a' } },
    { algorithms: ['HS256'] }, { clockSkewSeconds: 3600 }, { maxLifetimeSeconds: 10 }, { tenant: { claim: 'tid', allowed: [] } }, { profile: 'default' }]) {
    assert.equal(oidcVerifierConfigSchema.safeParse({ ...base, ...invalid }).success, false, JSON.stringify(invalid));
  }
});
