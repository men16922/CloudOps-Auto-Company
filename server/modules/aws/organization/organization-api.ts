import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z, ZodError } from 'zod';
import { CloudOperationError } from '../../../../src/domain/cloud-workflow';
import type { OrganizationWebAccess } from '../../../cloud-auth';
import type { OrganizationConnections } from './organization-connections';
import { webConfigurationSchema, type WebConfiguration } from '../../../../src/platform/web-config';
import { connectionServices } from '../../../../src/modules/aws/domain/connections';

export type OrganizationApiServices = { access: OrganizationWebAccess; connections: OrganizationConnections; publicOrigin: string; web?: WebConfiguration };
const createSchema = z.object({ configurationId: z.string().min(1).max(64) }).strict();
const actionSchema = z.object({ operation: z.enum(['login', 'verify', 'inspect', 'directory', 'disconnect', 'logout', 'sync']), service: z.enum(connectionServices).optional(), cursor: z.uuid().optional() }).strict();

/** Authenticated edition boundary. Demo headers and personal/SDK cookies confer no access here. */
export async function handleOrganizationApi(request: IncomingMessage, response: ServerResponse, services?: OrganizationApiServices) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
  try {
    if (!services && request.url === '/api/organizations/config' && request.method === 'GET') { send(200, { configured: false }); return; }
    if (!services) throw new CloudOperationError(503, 'organization_api_not_configured', 'Organization web authentication and worker routing are not configured.');
    const origin = new URL(services.publicOrigin);
    if (origin.origin !== services.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new CloudOperationError(503, 'organization_api_not_configured', 'The organization endpoint is not configured.');
    if (request.headers.host !== origin.host || (request.headers.origin ? request.headers.origin !== origin.origin : !(request.method === 'GET' && request.headers['sec-fetch-site'] === 'same-origin'))
      || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) throw new CloudOperationError(403, 'origin_required', 'Use the configured organization application.');
    const url = new URL(request.url ?? '/', origin);
    if (url.search || url.hash) throw new CloudOperationError(400, 'invalid_request', 'Query overrides are not supported.');
    if (url.pathname === '/api/organizations/config' && request.method === 'GET') { send(200, webConfigurationSchema.parse(services.web ?? { configured: false })); return; }
    const route = /^\/api\/organizations\/v1\/([A-Za-z0-9_.:-]{1,128})\/workspaces\/([A-Za-z0-9_.:-]{1,128})\/aws\/connections(?:\/([a-f0-9-]{36})\/(status|actions|observations|sync|inventory|report|views|alerts)(?:\/([a-z0-9]{2,16}))?)?$/.exec(url.pathname);
    if (!route) throw new CloudOperationError(404, 'not_found', 'The organization route was not found.');
    if (request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization').length !== 1) throw new CloudOperationError(401, 'web_sign_in_required', 'Sign in to the web application again.');
    const session = await services.access.authenticate(request.headers.authorization, route[1], route[2]);
    // Only the inventory route carries a service segment.
    if (route[5] !== undefined && route[4] !== 'inventory' || route[4] === 'inventory' && route[5] === undefined) throw new CloudOperationError(404, 'not_found', 'The organization route was not found.');
    if (request.method === 'GET') {
      if (!route[3]) { send(200, await services.connections.list(session)); return; }
      if (route[4] === 'sync') { send(200, await services.connections.syncStatus(session, route[3])); return; }
      if (route[4] === 'inventory') { send(200, await services.connections.inventory(session, route[3], route[5])); return; }
      if (route[4] === 'status') { send(200, await services.connections.status(session, route[3])); return; }
      if (route[4] === 'observations') { send(200, await services.connections.observations(session, route[3])); return; }
      if (route[4] === 'report') { send(200, await services.connections.report(session, route[3])); return; }
      if (route[4] === 'views') { send(200, await services.connections.views(session, route[3])); return; }
      if (route[4] === 'alerts') { send(200, await services.connections.alerts(session, route[3])); return; }
    }
    if (request.method !== 'POST' || (route[3] && route[4] !== 'actions' && route[4] !== 'views' && route[4] !== 'alerts')) throw new CloudOperationError(405, 'method_not_allowed', 'Use the registered request method.');
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new CloudOperationError(415, 'json_required', 'A JSON request is required.');
    const requestKey = z.uuid().parse(request.headers['idempotency-key']);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const value = Buffer.from(chunk); size += value.byteLength; if (size > 32_768) throw new CloudOperationError(413, 'body_too_large', 'The request exceeds the size limit.'); chunks.push(value); }
    let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CloudOperationError(400, 'invalid_json', 'A JSON request is required.'); }
    if (!route[3]) { send(200, await services.connections.create(session, { ...createSchema.parse(body), requestKey })); return; }
    if (route[4] === 'views') { send(200, await services.connections.updateViews(session, route[3], { ...z.object({}).loose().parse(body), requestKey })); return; }
    if (route[4] === 'alerts') { send(200, await services.connections.updateAlerts(session, route[3], { ...z.object({}).loose().parse(body), requestKey })); return; }
    send(200, await services.connections.perform(session, route[3], { ...actionSchema.parse(body), requestKey }));
  } catch (error) {
    if (error instanceof CloudOperationError) send(error.status, { code: error.code, message: error.message });
    else if (error instanceof ZodError) send(400, { code: 'invalid_request', message: 'Use the registered request fields.' });
    else send(500, { code: 'organization_request_failed', message: 'The organization request could not be completed.' });
  }
}

/** Request listener for a trusted host that also serves the same-origin web build. */
export function organizationRequestListener(services: OrganizationApiServices | undefined) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if ((request.url ?? '').startsWith('/api/organizations/')) { void handleOrganizationApi(request, response, services); return; }
    response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ code: 'not_found', message: 'The organization route was not found.' }));
  };
}

/** Company composition supplies identity, storage and isolated worker transport. No demo/personal fallback. */
export function createOrganizationApiServer(services: OrganizationApiServices | undefined) {
  return organizationHttpServer(organizationRequestListener(services));
}
export function organizationHttpServer(listener: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(listener);
  server.requestTimeout = 35_000; server.headersTimeout = 10_000; server.maxHeadersCount = 64;
  return server;
}
