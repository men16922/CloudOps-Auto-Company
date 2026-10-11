import { z } from 'zod';
import { browserOidcSchema, type BrowserOidcConfiguration } from '../../../../packages/contracts/web-config';
import type { WebIdentity, WebIdentityClient } from './web-identity';

export const oidcCallbackChannel = 'cloudops-oidc';
export const oidcCallbackPath = '/oidc-callback.html';
export type OidcPopup = { navigate(url: string): void; close(): void };
export type OidcClientDependencies = {
  origin: string;
  /** Must open synchronously inside the click so the browser keeps the user activation. */
  openPopup(): OidcPopup | null;
  fetch: typeof fetch;
  now(): number;
  timeoutMs?: number;
};
const callbackSchema = z.object({ type: z.literal('cloudops-oidc-callback'), state: z.string().nullable(), code: z.string().nullable(), error: z.string().nullable() }).strict();
const tokenSchema = z.object({ id_token: z.string().max(16_384), access_token: z.string().max(16_384).optional(), expires_in: z.number().int().positive().optional() }).loose();
const idClaimsSchema = z.object({ iss: z.string(), sub: z.string().min(1).max(255), aud: z.union([z.string(), z.array(z.string())]), exp: z.number().int(), nonce: z.string(),
  name: z.string().optional(), preferred_username: z.string().optional(), email: z.string().optional() }).loose();
const bytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const sha256 = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
function claims(token: string) {
  const part = token.split('.')[1];
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('invalid_id_token');
  const text = new TextDecoder().decode(Uint8Array.from(atob(part.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0)));
  return idClaimsSchema.parse(JSON.parse(text));
}

/** OIDC Authorization Code + PKCE through a same-origin popup callback.
 * Tokens, verifier, state and nonce stay in this object's memory; nothing enters browser storage.
 * The id_token is only checked for issuer/audience/nonce/expiry here; the server verifies the signature.
 * There is no refresh token: on expiry the identity is cleared and the user signs in again.
 */
export class OidcWebIdentityClient implements WebIdentityClient {
  private readonly config: BrowserOidcConfiguration;
  private readonly deps: OidcClientDependencies;
  private readonly listeners = new Set<(identity: WebIdentity | null) => void>();
  private identity: WebIdentity | null = null;
  private session?: { token: string; idToken: string; expiresAt: number };
  private attempt?: { cancel(): void };
  private expiry?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(config: unknown, deps: OidcClientDependencies) {
    this.config = browserOidcSchema.parse(config); this.deps = deps;
  }
  private emit(identity: WebIdentity | null) { this.identity = identity; this.listeners.forEach(listener => listener(identity)); }
  private clearSession() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined; this.session = undefined;
    if (this.identity) this.emit(null);
  }
  subscribe(listener: (identity: WebIdentity | null) => void) {
    this.listeners.add(listener); listener(this.identity);
    return () => { this.listeners.delete(listener); };
  }
  signIn(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('client_closed'));
    this.attempt?.cancel();
    const popup = this.deps.openPopup();
    if (!popup) return Promise.reject(new Error('popup_blocked'));
    const redirectUri = `${this.deps.origin}${oidcCallbackPath}`, state = base64url(bytes(32)), nonce = base64url(bytes(32)), verifier = base64url(bytes(48));
    const channel = new BroadcastChannel(oidcCallbackChannel);
    let finish: (error?: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => { finish = error => (error ? reject(error) : resolve()); });
    const timer = setTimeout(() => stop(new Error('sign_in_timeout')), this.deps.timeoutMs ?? 300_000);
    const stop = (error?: Error) => { clearTimeout(timer); channel.close(); if (this.attempt === attempt) this.attempt = undefined; if (error) popup.close(); finish(error); };
    const attempt = { cancel: () => stop(new Error('sign_in_cancelled')) };
    this.attempt = attempt;
    channel.onmessage = event => {
      const message = callbackSchema.safeParse(event.data);
      // Another tab's sign-in is ignored; only this attempt's state completes it.
      if (!message.success || message.data.state !== state) return;
      channel.onmessage = null;
      if (message.data.error || !message.data.code) { stop(new Error('sign_in_rejected')); return; }
      void this.exchange(message.data.code, redirectUri, verifier, nonce).then(() => stop(), error => stop(error instanceof Error ? error : new Error('sign_in_failed')));
    };
    void sha256(verifier).then(challenge => {
      if (this.attempt !== attempt) return;
      const url = new URL(this.config.authorizationEndpoint);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, scope: this.config.scope,
        state, nonce, code_challenge: base64url(challenge), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
      popup.navigate(url.toString());
    }, () => stop(new Error('sign_in_failed')));
    return done;
  }
  private async exchange(code: string, redirectUri: string, verifier: string, nonce: string) {
    const response = await this.deps.fetch(this.config.tokenEndpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: this.config.clientId, code_verifier: verifier }).toString() });
    const text = await response.text();
    if (!response.ok || text.length > 65_536) throw new Error('token_exchange_failed');
    const tokens = tokenSchema.parse(JSON.parse(text)), idClaims = claims(tokens.id_token), now = this.deps.now();
    const audiences = typeof idClaims.aud === 'string' ? [idClaims.aud] : idClaims.aud;
    if (idClaims.iss !== this.config.issuer || !audiences.includes(this.config.clientId) || idClaims.nonce !== nonce || idClaims.exp * 1000 <= now) throw new Error('invalid_id_token');
    const token = this.config.bearer === 'id_token' ? tokens.id_token : tokens.access_token;
    if (!token) throw new Error('token_exchange_failed');
    const expiresAt = Math.min(idClaims.exp * 1000, this.config.bearer === 'access_token' && tokens.expires_in ? now + tokens.expires_in * 1000 : Number.POSITIVE_INFINITY);
    if (this.closed) return;
    const key = base64url(await sha256(JSON.stringify([idClaims.iss, idClaims.sub])));
    const label = (idClaims.name ?? idClaims.preferred_username ?? idClaims.email ?? 'Signed in').slice(0, 128);
    if (this.expiry) clearTimeout(this.expiry);
    this.session = { token, idToken: tokens.id_token, expiresAt };
    this.expiry = setTimeout(() => this.clearSession(), Math.max(0, expiresAt - now - 30_000));
    this.emit({ key, label });
  }
  async signOut() {
    this.attempt?.cancel();
    const idToken = this.session?.idToken;
    this.clearSession();
    if (idToken && this.config.endSessionEndpoint) {
      const popup = this.deps.openPopup();
      if (popup) {
        const url = new URL(this.config.endSessionEndpoint);
        url.searchParams.set('client_id', this.config.clientId); url.searchParams.set('id_token_hint', idToken);
        url.searchParams.set('post_logout_redirect_uri', `${this.deps.origin}${oidcCallbackPath}`);
        popup.navigate(url.toString());
      }
    }
  }
  async tokenFor(identityKey: string) {
    if (!this.session || this.identity?.key !== identityKey) throw new Error('identity_changed');
    if (this.session.expiresAt - 30_000 <= this.deps.now()) { this.clearSession(); throw new Error('web_sign_in_required'); }
    return this.session.token;
  }
  async close() {
    this.closed = true; this.attempt?.cancel(); this.clearSession(); this.listeners.clear();
  }
}

export function browserOidcDependencies(): OidcClientDependencies {
  return {
    origin: window.location.origin, fetch: window.fetch.bind(window), now: () => Date.now(),
    openPopup() {
      const popup = window.open('about:blank', 'cloudops-oidc', 'popup,width=520,height=680');
      return popup ? { navigate: url => { popup.location.href = url; }, close: () => popup.close() } : null;
    },
  };
}
