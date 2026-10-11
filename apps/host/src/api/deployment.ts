import { z } from 'zod';
import { OrganizationWebAccess, type WebIdentityVerifier } from '../identity/web-access';
import type { CloudStore } from '../storage/store';
import type { ObservationCache } from '../connections/observation-cache';
import { webConfigurationSchema } from '../../../../packages/contracts/web-config';
import { connectionConfigurationSchema } from '../connections/connections';
import { createOrganizationWorkerRuntime, type OrganizationWorkerProvisioner } from '../workers/supervisor';
import { createOrganizationApiServer, organizationHttpServer, organizationRequestListener } from './routes';
import { createSamlBridge, samlBridgeConfigSchema } from '../identity/saml-bridge';
import { EmailAlerts, notificationsSchema, type AlertSender } from '../notifications/email-alerts';
import { OidcJwtVerifier } from '../identity/oidc-verifier';

const loopback = ['localhost', '127.0.0.1'];
export const publicOriginSchema = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback.includes(url.hostname)));
  } catch { return false; }
}, 'Use an https origin, or an http loopback origin for local verification.');

/** Trusted deployment data: browser web config plus the server-fixed connection registry.
 * A company edition only accepts the company identity method; other provider identifiers in the
 * shared web contract are rejected here.
 */
export const organizationDeploymentSchema = z.object({
  publicOrigin: publicOriginSchema,
  web: webConfigurationSchema,
  connections: z.array(connectionConfigurationSchema).max(1000),
  /** Web sign-in through an IAM Identity Center SAML 2.0 application; server-only, never sent to the browser. */
  samlBridge: samlBridgeConfigSchema.optional(),
  /** Server-only alert delivery (SMTP relay and recipients per payer configuration); never sent to the browser. */
  notifications: notificationsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.samlBridge && (!value.web.configured || value.web.identity.method !== 'company' || value.web.identity.oidc)) {
    context.addIssue({ code: 'custom', path: ['samlBridge'], message: 'The SAML bridge needs a configured company web identity without explicit oidc settings.' });
  }
  if (!value.web.configured) {
    if (value.connections.length) context.addIssue({ code: 'custom', path: ['connections'], message: 'An unconfigured web edition cannot register connections.' });
    return;
  }
  if (value.web.identity.method !== 'company') context.addIssue({ code: 'custom', path: ['web', 'identity', 'method'], message: 'Only the company identity method is supported.' });
  const { organizationId, workspaceId } = value.web.scope, seen = new Set<string>();
  value.connections.forEach((connection, index) => {
    if (connection.organizationId !== organizationId || connection.workspaceId !== workspaceId) context.addIssue({ code: 'custom', path: ['connections', index], message: 'Connections must use the configured web scope.' });
    if (seen.has(connection.configurationId)) context.addIssue({ code: 'custom', path: ['connections', index, 'configurationId'], message: 'Duplicate configuration.' });
    seen.add(connection.configurationId);
  });
  value.notifications?.email?.routes.forEach((route, index) => {
    if (!seen.has(route.configurationId)) context.addIssue({ code: 'custom', path: ['notifications', 'email', 'routes', index, 'configurationId'], message: 'Routes must name a registered connection configuration.' });
  });
});
export type OrganizationDeployment = z.infer<typeof organizationDeploymentSchema>;

export type OrganizationCompositionOptions = {
  deployment: unknown;
  store: CloudStore;
  /** Company-selected verifier. Absent means the API stays unconfigured (fail closed). */
  verifier?: WebIdentityVerifier;
  /** Company infrastructure driver. Absent means worker operations return worker_unavailable. */
  provisioner?: OrganizationWorkerProvisioner;
  /** Optional host-chosen cache of the last read results per user connection. */
  observations?: ObservationCache;
  /** Test seam for alert delivery; the default sends through the configured SMTP relay. */
  sendMail?: AlertSender;
  now?: () => number;
};

/** Explicit trusted composition. It never selects a store, verifier or driver by itself. */
export function composeOrganizationApi(options: OrganizationCompositionOptions) {
  const deployment = organizationDeploymentSchema.parse(options.deployment);
  const bridge = deployment.samlBridge && createSamlBridge(deployment.samlBridge, { publicOrigin: deployment.publicOrigin, now: options.now });
  if (bridge && options.verifier) throw new Error('A SAML bridge supplies its own verifier; do not inject another.');
  const verifier = bridge ? new OidcJwtVerifier(bridge.verifierConfig, { now: options.now }) : options.verifier;
  if (!verifier || !deployment.web.configured) {
    const server = createOrganizationApiServer(undefined);
    return { deployment, configured: false as const, server, listener: organizationRequestListener(undefined), access: undefined, runtime: undefined, bridge: undefined,
      async close() { await new Promise<void>(resolve => server.close(() => resolve())); } };
  }
  const access = new OrganizationWebAccess(verifier, options.store, options.now);
  const alerts = deployment.notifications?.email && options.observations ? new EmailAlerts({ config: deployment.notifications.email, cache: options.observations, publicOrigin: deployment.publicOrigin,
    labels: new Map(deployment.connections.map(connection => [connection.configurationId, connection.label])), now: options.now, send: options.sendMail }) : undefined;
  const runtime = createOrganizationWorkerRuntime({ store: options.store, access, configurations: deployment.connections, provisioner: options.provisioner, now: options.now, observations: options.observations, alerts });
  const web = bridge && deployment.web.configured ? { ...deployment.web, identity: { method: 'company' as const, oidc: bridge.browserOidc } } : deployment.web;
  const services = { access, connections: runtime.connections, publicOrigin: deployment.publicOrigin, web };
  const api = organizationRequestListener(services);
  const listener: typeof api = (request, response) => {
    if (bridge && (request.url ?? '').startsWith('/api/organizations/saml/')) { void bridge.handle(request, response); return; }
    api(request, response);
  };
  const server = organizationHttpServer(listener);
  return { deployment, configured: true as const, server, listener, access, runtime, bridge,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await runtime.connections.close();
      await runtime.supervisor.close();
    } };
}
