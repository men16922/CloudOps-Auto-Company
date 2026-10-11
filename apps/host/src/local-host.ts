import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { OrganizationWebAccess, membershipSchema } from './identity/web-access';
import type { CloudStore } from './storage/store';
import type { ObservationCache } from './connections/observation-cache';
import { OidcJwtVerifier, oidcVerifierConfigSchema, type OidcVerifierOptions } from './identity/oidc-verifier';
import { composeOrganizationApi, organizationDeploymentSchema } from './api/deployment';
import { DockerOrganizationWorkerProvisioner } from './workers/docker/provisioner';
import { createLocalDockerWorkerEngine } from './workers/docker/docker-cli';
import { OrganizationWorkerLeases, workerLeaseHandle } from './workers/leases';
import { cliBindingSchema } from '../../../packages/worker-protocol/cli-contract';
import type { OrganizationWorkerProvisioner } from './workers/supervisor';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png' };
const securityHeaders = (connect: string[]) => ({
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src ${["'self'", ...connect].join(' ')}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
});
export const localHostSchema = z.object({
  host: z.enum(['127.0.0.1', 'localhost']),
  port: z.number().int().min(1024).max(65_535),
}).strict();

/** Validates trusted deployment/verifier files together. The browser client and server verifier must
 * describe the same issuer and, for id_token Bearer, the same audience.
 */
export function checkedConfiguration(deploymentInput: unknown, webIdentity?: unknown) {
  const deployment = organizationDeploymentSchema.parse(deploymentInput);
  const verifierConfig = webIdentity === undefined ? undefined : oidcVerifierConfigSchema.parse(webIdentity);
  if (deployment.samlBridge && verifierConfig) throw new Error('A SAML bridge supplies its own verifier; remove CLOUDOPS_WEB_IDENTITY.');
  const browser = deployment.web.configured && deployment.web.identity.method === 'company' ? deployment.web.identity.oidc : undefined;
  if (browser && verifierConfig && (browser.issuer !== verifierConfig.issuer || (browser.bearer === 'id_token' && verifierConfig.audience !== browser.clientId))) {
    throw new Error('The browser OIDC issuer/client must match the server verifier issuer/audience.');
  }
  return { deployment, verifierConfig, browser };
}

/** Redacted operator summary: account IDs and hosts are masked so it can be pasted into a review. */
export function deploymentSummary(deploymentInput: unknown, webIdentity?: unknown) {
  const { deployment, verifierConfig, browser } = checkedConfiguration(deploymentInput, webIdentity);
  const mask = (value: string) => `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  const host = (value: string) => { const name = new URL(value).hostname; return name.length <= 8 ? '***' : `${name.slice(0, 3)}***${name.slice(-8)}`; };
  const warnings: string[] = [];
  if (!deployment.web.configured) warnings.push('web is unconfigured: the API answers configured:false and 503.');
  else {
    if (!browser && !deployment.samlBridge) warnings.push('no browser oidc settings: this build shows the unconfigured state.');
    if (!verifierConfig && !deployment.samlBridge) warnings.push('no server verifier: the API stays unconfigured (503).');
    if (deployment.samlBridge && new URL(deployment.samlBridge.idp.ssoUrl).protocol === 'http:') warnings.push('SAML IdP SSO URL uses http loopback; use the Identity Center https URL outside local verification.');
    if (browser && new URL(browser.tokenEndpoint).protocol === 'http:') warnings.push('browser OIDC endpoints use http loopback; use https outside local verification.');
  }
  if (new URL(deployment.publicOrigin).protocol === 'http:') warnings.push('publicOrigin is http loopback; production requires https.');
  const email = deployment.notifications?.email;
  // The password file is checked for presence and permissions only; its content is never read here.
  const passwordFile = email ? (() => { try { const info = statSync(email.smtp.passwordFile); return !info.isFile() ? 'missing' : info.mode & 0o077 ? 'too-permissive' : 'ok'; } catch { return 'missing'; } })() : undefined;
  if (email && passwordFile !== 'ok') warnings.push(`SMTP password file is ${passwordFile}: create it with mode 0600 before alerts can be sent.`);
  return {
    publicOrigin: deployment.publicOrigin.startsWith('https:') ? `https://${host(deployment.publicOrigin)}` : deployment.publicOrigin,
    web: deployment.web.configured ? { scope: `${deployment.web.scope.organizationId}/${deployment.web.scope.workspaceId}`, browserOidc: browser ? { bearer: browser.bearer, scope: browser.scope } : null } : null,
    webSignIn: deployment.samlBridge ? { method: 'identity-center-saml', idpEntity: host(deployment.samlBridge.idp.ssoUrl), certificates: deployment.samlBridge.idp.certificates.length, sessionSeconds: deployment.samlBridge.sessionSeconds } : browser ? { method: 'oidc' } : null,
    verifier: verifierConfig ? { algorithms: verifierConfig.algorithms, jwks: 'uri' in verifierConfig.jwks ? 'remote' : 'static', tenant: Boolean(verifierConfig.tenant) } : null,
    connections: deployment.connections.map(item => ({ configurationId: item.configurationId, account: mask(item.accountId), roleName: item.roleName, region: item.region,
      ssoRegion: item.ssoRegion, startUrlHost: host(item.startUrl), directory: Boolean(item.directory) })),
    notifications: email ? { email: { relay: `${host(`https://${email.smtp.host}`)}:${email.smtp.port} ${email.smtp.security}`, passwordFile,
      routes: email.routes.map(route => ({ configurationId: route.configurationId, recipients: route.to.length, minSeverity: route.minSeverity, detail: route.detail })) } } : null,
    warnings,
  };
}

/** Loopback verification host only: same-origin web build plus the composed organization API.
 * It has no TLS, proxy or production store and must not be exposed beyond this machine.
 */
export async function startLocalOrganizationHost(options: { deployment: unknown; webIdentity?: unknown; store: CloudStore; webRoot: string;
  host: string; port: number; verifierOptions?: OidcVerifierOptions; provisioner?: OrganizationWorkerProvisioner; now?: () => number; observations?: ObservationCache;
  /** Optional TLS (PEM). Required when the IdP refuses an http loopback ACS; publicOrigin then uses https. */
  tls?: { cert: string; key: string } }) {
  const { host, port } = localHostSchema.parse({ host: options.host, port: options.port });
  const { deployment, verifierConfig, browser } = checkedConfiguration(options.deployment, options.webIdentity);
  const verifier = verifierConfig && new OidcJwtVerifier(verifierConfig, options.verifierOptions);
  // A SAML bridge composes its own verifier inside composeOrganizationApi.
  const composition = composeOrganizationApi({ deployment, store: options.store, verifier, provisioner: options.provisioner, now: options.now, observations: options.observations });
  const webHeaders = securityHeaders(browser ? [new URL(browser.tokenEndpoint).origin] : []);
  const scheme = options.tls ? 'https' : 'http';
  if (composition.deployment.publicOrigin !== `${scheme}://${host}:${port}`) { await composition.close(); throw new Error(`publicOrigin must be ${scheme}://${host}:${port} for the local host.`); }
  const root = await realpath(options.webRoot);
  const serveStatic = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD', ...webHeaders }); response.end(); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://local.invalid').pathname); } catch { response.writeHead(400, webHeaders); response.end(); return; }
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    try {
      const file = await realpath(candidate);
      if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile()) throw new Error('not a web asset');
      const data = await readFile(file);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600', ...webHeaders });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...webHeaders }); response.end('Not found'); }
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    if ((request.url ?? '').startsWith('/api/')) { composition.listener(request, response); return; }
    void serveStatic(request, response);
  };
  const server: Server = options.tls ? createTlsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handler) : createServer(handler);
  server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64;
  server.listen(port, host); await once(server, 'listening');
  const signIn = composition.bridge ? 'identity-center-saml' : composition.configured ? 'oidc' : 'unconfigured';
  return { server, configured: composition.configured, signIn, origin: composition.deployment.publicOrigin,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await composition.close();
    } };
}

/** Opt-in Docker worker driver for an authorized isolation run. It refuses to start unless the existing
 * guard (`CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1`, not offline test) enables the native engine.
 */
export function dockerProvisionerFromConfig(store: CloudStore, config: unknown) {
  const engine = createLocalDockerWorkerEngine(config);
  if (!engine) throw new Error('The Docker worker driver requires CLOUDOPS_ORGANIZATION_DOCKER_ENABLED=1 outside offline tests.');
  return new DockerOrganizationWorkerProvisioner({ store, leases: new OrganizationWorkerLeases(store), config, engine });
}

/** Operator recovery after an ungraceful host exit. Only an expired lease (read as `unknown`) is touched; a live
 * lease is refused. The provisioner must fence/remove the recorded worker and attest stop + cache revocation
 * before the lease is retired; otherwise it stays unknown and no new generation is allocated.
 */
export async function reconcileLocalWorker(store: CloudStore, connectionId: string, provisioner: OrganizationWorkerProvisioner & {
  adoptInvestigatedContainer?: DockerOrganizationWorkerProvisioner['adoptInvestigatedContainer'] }, now?: () => number, investigatedContainerId?: string) {
  const id = z.uuid().parse(connectionId);
  const record = await store.transact(tx => tx.get<{ binding: unknown }>(`organization-connection:${id}`));
  if (!record) throw new Error('Unknown connection.');
  const binding = cliBindingSchema.parse(record.binding), leases = new OrganizationWorkerLeases(store, { now });
  const lease = await leases.read(binding);
  if (!lease) return 'no-lease' as const;
  if (lease.state === 'retired') return 'already-retired' as const;
  if (lease.state !== 'unknown') throw new Error('The worker lease is still active. Stop its host and wait for the lease to expire before reconciling.');
  const handle = workerLeaseHandle(lease);
  // An investigated container ID is only for an unconfirmed create; the driver still verifies it completely.
  const signal = AbortSignal.timeout(25_000);
  if (investigatedContainerId !== undefined && !provisioner.adoptInvestigatedContainer) throw new Error('This provisioner cannot adopt an investigated container.');
  const receipt = investigatedContainerId === undefined ? await provisioner.fenceAndStop({ binding, handle }, signal)
    : await provisioner.adoptInvestigatedContainer!({ binding, handle }, investigatedContainerId, signal);
  await leases.retire(binding, handle, receipt);
  return 'retired' as const;
}

/** Trusted local administration. The verifier is unused because no web request is accepted here. */
export async function provisionLocalMembership(store: CloudStore, membership: unknown) {
  const value = membershipSchema.parse(membership);
  await new OrganizationWebAccess({ async verify() { throw new Error('not a web request'); } }, store).provision(value);
  return value;
}
