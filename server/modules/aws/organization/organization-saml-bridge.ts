import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { z } from 'zod';
import type { OidcVerifierConfig } from '../../../oidc-web-identity';
import type { BrowserOidcConfiguration } from '../../../../src/platform/web-config';

// The IdP SSO URL is https; http is accepted only on loopback for local synthetic verification.
const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) && !url.username && !url.password && !url.hash;
});
const pem = z.string().max(16_384).regex(/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/);
/** Trusted server configuration for an IAM Identity Center customer managed SAML 2.0 application. */
export const samlBridgeConfigSchema = z.object({
  /** Identifier (not a URL that is fetched) used as the bridge token issuer and actor namespace. */
  issuer: z.url().refine(value => new URL(value).protocol === 'https:'),
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  idp: z.object({ entityId: z.string().min(1).max(1024), ssoUrl: endpoint, certificates: z.array(pem).min(1).max(3) }).strict(),
  sp: z.object({ entityId: z.string().min(1).max(1024) }).strict(),
  sessionSeconds: z.number().int().min(300).max(3600).default(3600),
}).strict();
export type SamlBridgeConfig = z.input<typeof samlBridgeConfigSchema>;

const b64url = /^[A-Za-z0-9_-]{43,128}$/;
const random = () => randomBytes(32).toString('base64url');
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
type Pending = { state: string; nonce: string; challenge: string; expiresAt: number };
type Grant = { subject: string; label: string; nonce: string; challenge: string; expiresAt: number };

/** Bounded in-memory map with expiry. A multi-instance host needs sticky sessions or a shared store. */
class ExpiringMap<V extends { expiresAt: number }> {
  private readonly values = new Map<string, V>();
  private readonly now: () => number;
  private readonly limit: number;
  constructor(now: () => number, limit = 1000) { this.now = now; this.limit = limit; }
  set(key: string, value: V) {
    for (const [existing, item] of this.values) if (item.expiresAt <= this.now()) this.values.delete(existing);
    if (this.values.size >= this.limit) throw new Error('bridge_capacity');
    this.values.set(key, value);
  }
  take(key: string) { const value = this.values.get(key); this.values.delete(key); return value && value.expiresAt > this.now() ? value : undefined; }
}

/** IAM Identity Center SAML → same-origin OIDC-style bridge for the existing popup PKCE web client.
 * - /authorize: browser popup arrives with state/nonce/S256 challenge; the bridge sends a signed-for-InResponseTo
 *   AuthnRequest to Identity Center. IdP-initiated responses are rejected.
 * - /acs: validates the signed assertion (certificate, issuer, audience, InResponseTo, time conditions) and
 *   redirects the popup to the same-origin callback with a one-time 60-second code.
 * - /token: same-origin PKCE exchange for a short-lived ES256 id_token signed by this bridge.
 * The bridge token is the web identity. It is never an AWS credential, and Device Code login stays separate.
 */
export function createSamlBridge(input: unknown, options: { publicOrigin: string; now?: () => number; signingKey?: KeyObject }) {
  const config = samlBridgeConfigSchema.parse(input), now = options.now ?? Date.now, origin = options.publicOrigin;
  const key = options.signingKey ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const publicJwk = { ...createPublicJwk(key), use: 'sig', alg: 'ES256' };
  const kid = createHash('sha256').update(JSON.stringify([publicJwk.crv, publicJwk.x, publicJwk.y])).digest('base64url').slice(0, 16);
  const callback = `${origin}/oidc-callback.html`, acs = `${origin}/api/organizations/saml/acs`;
  const requests = new Map<string, { value: string; createdAt: number }>();
  const cacheProvider: CacheProvider = {
    async saveAsync(id, value) { if (requests.size >= 1000) return null; const item = { value, createdAt: now() }; requests.set(id, item); return item; },
    async getAsync(id) { const item = requests.get(id); return item && now() - item.createdAt < 600_000 ? item.value : null; },
    async removeAsync(id) { if (!id) return null; const item = requests.get(id); requests.delete(id); return item?.value ?? null; },
  };
  const saml = new SAML({
    entryPoint: config.idp.ssoUrl, issuer: config.sp.entityId, callbackUrl: acs, idpCert: config.idp.certificates, idpIssuer: config.idp.entityId,
    audience: config.sp.entityId, wantAssertionsSigned: true, wantAuthnResponseSigned: false, acceptedClockSkewMs: 60_000, maxAssertionAgeMs: 300_000,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: 600_000, cacheProvider, identifierFormat: null, disableRequestedAuthnContext: true,
  });
  const pending = new ExpiringMap<Pending>(now), grants = new ExpiringMap<Grant>(now);
  const browserOidc: BrowserOidcConfiguration = { issuer: config.issuer, clientId: config.clientId, authorizationEndpoint: `${origin}/api/organizations/saml/authorize`,
    tokenEndpoint: `${origin}/api/organizations/saml/token`, scope: 'openid', bearer: 'id_token' };
  const verifierConfig: OidcVerifierConfig = { kind: 'oidc', issuer: config.issuer, audience: config.clientId, algorithms: ['ES256'],
    jwks: { keys: [{ ...publicJwk, kid, kty: 'EC' }] }, maxLifetimeSeconds: config.sessionSeconds };
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  const redirect = (response: ServerResponse, location: string) => { response.writeHead(303, { ...headers, Location: location }); response.end(); };
  const fail = (response: ServerResponse, status: number, code: string) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ code })); };
  const form = async (request: IncomingMessage, limit: number) => {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') throw new Error('form_required');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('body_too_large'); chunks.push(Buffer.from(chunk)); }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', origin), route = url.pathname.replace('/api/organizations/saml/', '');
    try {
      if (request.headers.host !== new URL(origin).host) { fail(response, 403, 'origin_required'); return; }
      if (route === 'authorize' && request.method === 'GET') {
        const q = url.searchParams, state = q.get('state') ?? '', nonce = q.get('nonce') ?? '', challenge = q.get('code_challenge') ?? '';
        if (q.get('response_type') !== 'code' || q.get('client_id') !== config.clientId || q.get('redirect_uri') !== callback || q.get('code_challenge_method') !== 'S256'
          || !b64url.test(state) || !b64url.test(nonce) || !b64url.test(challenge)) { fail(response, 400, 'invalid_authorization_request'); return; }
        const relay = random();
        pending.set(relay, { state, nonce, challenge, expiresAt: now() + 600_000 });
        redirect(response, await saml.getAuthorizeUrlAsync(relay, undefined, {})); return;
      }
      if (route === 'acs' && request.method === 'POST') {
        const body = await form(request, 262_144), flow = pending.take(body.get('RelayState') ?? '');
        if (!flow) { fail(response, 400, 'unsolicited_saml_response'); return; }
        try {
          const { profile, loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: body.get('SAMLResponse') ?? '' });
          if (loggedOut || !profile || profile.issuer !== config.idp.entityId || typeof profile.nameID !== 'string' || !profile.nameID || profile.nameID.length > 255) throw new Error('invalid_profile');
          const label = [profile.email, profile.mail, profile.nameID].find(value => typeof value === 'string' && value.length > 0) as string;
          const code = random();
          grants.set(code, { subject: profile.nameID, label: label.slice(0, 128), nonce: flow.nonce, challenge: flow.challenge, expiresAt: now() + 60_000 });
          redirect(response, `${callback}?code=${code}&state=${encodeURIComponent(flow.state)}`);
        } catch { redirect(response, `${callback}?error=access_denied&state=${encodeURIComponent(flow.state)}`); }
        return;
      }
      if (route === 'token' && request.method === 'POST') {
        if (request.headers.origin !== origin) { fail(response, 403, 'origin_required'); return; }
        const body = await form(request, 8192), grant = grants.take(body.get('code') ?? '');
        const verifier = body.get('code_verifier') ?? '';
        if (!grant || body.get('grant_type') !== 'authorization_code' || body.get('client_id') !== config.clientId || body.get('redirect_uri') !== callback
          || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) { fail(response, 400, 'invalid_grant'); return; }
        const issuedAt = Math.floor(now() / 1000), expiresIn = config.sessionSeconds;
        const data = `${part({ alg: 'ES256', typ: 'JWT', kid })}.${part({ iss: config.issuer, aud: config.clientId, sub: grant.subject, iat: issuedAt, exp: issuedAt + expiresIn, nonce: grant.nonce, name: grant.label })}`;
        const idToken = `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer', expires_in: expiresIn })); return;
      }
      fail(response, 404, 'not_found');
    } catch { fail(response, 400, 'invalid_request'); }
  }
  return { config, browserOidc, verifierConfig, acsUrl: acs, handle };
}

function createPublicJwk(key: KeyObject) {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('The bridge signing key must be an EC P-256 key.');
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}
