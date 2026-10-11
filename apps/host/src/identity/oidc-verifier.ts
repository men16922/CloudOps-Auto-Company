import { createPublicKey, constants, verify as verifySignature, type KeyObject, type webcrypto } from 'node:crypto';
import { z } from 'zod';
import { identityActor, type VerifiedWebIdentity, type WebIdentityVerifier } from './web-access';

const algorithmSchema = z.enum(['RS256', 'PS256', 'ES256']);
type Algorithm = z.infer<typeof algorithmSchema>;
const httpsUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'An https URL without credentials or fragment is required.');
const jwkSchema = z.object({
  kty: z.enum(['RSA', 'EC']), kid: z.string().min(1).max(256), use: z.string().optional(), alg: z.string().optional(),
  n: z.string().optional(), e: z.string().optional(), crv: z.string().optional(), x: z.string().optional(), y: z.string().optional(),
}).loose();
// Provider key sets may also publish key types this verifier does not accept; those keys are skipped one by one.
const jwksSchema = z.object({ keys: z.array(z.unknown()).max(100) }).loose();

/** Trusted server configuration only. Nothing here comes from the browser or a token header. */
export const oidcVerifierConfigSchema = z.object({
  kind: z.literal('oidc'),
  issuer: httpsUrl,
  audience: z.string().min(1).max(256),
  algorithms: z.array(algorithmSchema).min(1).max(3).default(['RS256']),
  jwks: z.union([
    z.object({ uri: httpsUrl.refine(value => !new URL(value).search, 'Query strings are not supported.'), cacheSeconds: z.number().int().min(60).max(86_400).default(600) }).strict(),
    z.object({ keys: z.array(jwkSchema).min(1).max(100) }).strict(),
  ]),
  clockSkewSeconds: z.number().int().min(0).max(300).default(60),
  maxLifetimeSeconds: z.number().int().min(60).max(86_400).default(3600),
  tenant: z.object({ claim: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), allowed: z.array(z.string().min(1).max(256)).min(1).max(100) }).strict().optional(),
}).strict();
export type OidcVerifierConfig = z.input<typeof oidcVerifierConfigSchema>;
export type OidcClaims = Readonly<Record<string, unknown> & { iss: string; sub: string; exp: number; iat: number }>;
export type OidcVerifierOptions = {
  /** Injected for tests and the company proxy/CA setup. It is never called inside a store transaction. */
  fetch?: typeof fetch;
  /** Provider revocation/session check. A thrown error rejects the identity. */
  isRevoked?: (claims: OidcClaims) => Promise<boolean>;
  now?: () => number;
};

const rejected = () => new Error('web_identity_rejected');
const base64url = /^[A-Za-z0-9_-]+$/;
function segment(value: string): unknown {
  if (!base64url.test(value)) throw rejected();
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}
const headerSchema = z.object({ alg: z.string(), kid: z.string().min(1).max(256), typ: z.string().optional(), crit: z.never().optional() }).loose();
const claimsSchema = z.object({
  iss: z.string(), sub: z.string().min(1).max(255), aud: z.union([z.string(), z.array(z.string()).min(1).max(10)]),
  exp: z.number().int(), iat: z.number().int(), nbf: z.number().int().optional(), azp: z.string().optional(),
}).loose();

/** Standard OIDC/JWT verifier candidate for a company that selects an OIDC IdP.
 * It checks signature, issuer, audience, time window and lifetime, optional tenant allow-list and an
 * optional revocation hook. The actor is derived from issuer/tenant/subject, never from email or roles.
 */
export class OidcJwtVerifier implements WebIdentityVerifier {
  private readonly config: z.output<typeof oidcVerifierConfigSchema>;
  private readonly fetcher: typeof fetch;
  private readonly isRevoked?: OidcVerifierOptions['isRevoked'];
  private readonly now: () => number;
  private keys = new Map<string, { key: KeyObject; jwk: z.infer<typeof jwkSchema> }>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private loading?: Promise<void>;
  constructor(config: OidcVerifierConfig, options: OidcVerifierOptions = {}) {
    this.config = oidcVerifierConfigSchema.parse(config);
    this.fetcher = options.fetch ?? fetch; this.isRevoked = options.isRevoked; this.now = options.now ?? Date.now;
    if ('keys' in this.config.jwks) this.keys = this.importKeys(this.config.jwks);
  }
  private importKeys(value: unknown) {
    const keys = new Map<string, { key: KeyObject; jwk: z.infer<typeof jwkSchema> }>();
    for (const raw of jwksSchema.parse(value).keys) {
      const parsed = jwkSchema.safeParse(raw);
      if (!parsed.success) continue;
      const jwk = parsed.data;
      if ((jwk.use !== undefined && jwk.use !== 'sig') || keys.has(jwk.kid)) continue;
      try {
        const key = createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: 'jwk' });
        if (key.type !== 'public') continue;
        if (jwk.kty === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
        if (jwk.kty === 'EC' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') continue;
        keys.set(jwk.kid, { key, jwk });
      } catch { /* Unsupported or malformed keys are skipped, never trusted. */ }
    }
    return keys;
  }
  private async refresh(force: boolean) {
    const jwks = this.config.jwks;
    if ('keys' in jwks) return;
    const now = this.now();
    // Any provider call is spaced by a minute, so forged kids or an IdP outage cannot amplify requests.
    if ((!force && now - this.loadedAt < jwks.cacheSeconds * 1000) || now - this.attemptedAt < 60_000) return;
    this.loading ??= (async () => {
      this.attemptedAt = now;
      try {
        const response = await this.fetcher(jwks.uri, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const text = await response.text();
        if (text.length > 65_536) return;
        this.keys = this.importKeys(JSON.parse(text));
        this.loadedAt = this.now();
      } catch { /* Keep the previous key set; an unknown kid stays rejected. */ } finally { this.loading = undefined; }
    })();
    await this.loading;
  }
  private async key(kid: string) {
    await this.refresh(false);
    if (!this.keys.has(kid)) await this.refresh(true);
    const entry = this.keys.get(kid);
    if (!entry) throw rejected();
    return entry;
  }
  async verify(token: string): Promise<VerifiedWebIdentity> {
    const parts = token.split('.');
    if (token.length > 16_384 || parts.length !== 3) throw rejected();
    const header = headerSchema.parse(segment(parts[0]!)), claims = claimsSchema.parse(segment(parts[1]!));
    if (!algorithmSchema.safeParse(header.alg).success || !this.config.algorithms.includes(header.alg as Algorithm)) throw rejected();
    if (header.typ !== undefined && !['JWT', 'at+jwt', 'application/at+jwt'].includes(header.typ)) throw rejected();
    const algorithm = header.alg as Algorithm, { key, jwk } = await this.key(header.kid);
    if ((algorithm === 'ES256') !== (jwk.kty === 'EC') || (jwk.alg !== undefined && jwk.alg !== algorithm)) throw rejected();
    if (!base64url.test(parts[2]!)) throw rejected();
    const data = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2]!, 'base64url');
    const valid = algorithm === 'ES256' ? verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
      : algorithm === 'PS256' ? verifySignature('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature)
        : verifySignature('sha256', data, key, signature);
    if (!valid) throw rejected();
    const now = Math.floor(this.now() / 1000), skew = this.config.clockSkewSeconds, audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (claims.iss !== this.config.issuer || !audiences.includes(this.config.audience) || (audiences.length > 1 && claims.azp !== this.config.audience)) throw rejected();
    if (claims.exp <= now || claims.iat > now + skew || (claims.nbf !== undefined && claims.nbf > now + skew)
      || claims.exp <= claims.iat || claims.exp - claims.iat > this.config.maxLifetimeSeconds) throw rejected();
    let tenant = '';
    if (this.config.tenant) {
      const value = claims[this.config.tenant.claim];
      if (typeof value !== 'string' || !this.config.tenant.allowed.includes(value)) throw rejected();
      tenant = value;
    }
    if (this.isRevoked && await this.isRevoked(Object.freeze({ ...claims }) as OidcClaims)) throw rejected();
    return { actorId: identityActor(claims.iss, claims.sub, tenant), expiresAt: claims.exp * 1000 };
  }
}
