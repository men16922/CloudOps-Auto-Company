import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const webScopeSchema = z.object({ organizationId: id, workspaceId: id, label: z.string().min(1).max(128) }).strict();
export const firebaseBrowserConfigSchema = z.object({
  apiKey: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  authDomain: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,252}$/),
  appId: z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/), tenantId: id.optional(),
}).strict();
// Browser OIDC endpoints: https, or http loopback for local verification. The issuer is an identifier and stays https.
const browserEndpoint = z.url().refine(value => {
  const url = new URL(value);
  return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) && !url.username && !url.password && !url.hash;
});
export const browserOidcSchema = z.object({
  issuer: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }),
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/),
  authorizationEndpoint: browserEndpoint, tokenEndpoint: browserEndpoint, endSessionEndpoint: browserEndpoint.optional(),
  scope: z.string().regex(/^[A-Za-z0-9_.:/ -]{1,512}$/).refine(value => value.split(' ').includes('openid')).default('openid'),
  /** Which token the API receives as Bearer. The server verifier audience must match it. */
  bearer: z.enum(['id_token', 'access_token']).default('id_token'),
}).strict();
export type BrowserOidcConfiguration = z.infer<typeof browserOidcSchema>;
export const webConfigurationSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }).strict(),
  z.object({ configured: z.literal(true), scope: webScopeSchema, identity: z.discriminatedUnion('method', [
    z.object({ method: z.literal('firebase-google'), firebase: firebaseBrowserConfigSchema }).strict(),
    z.object({ method: z.literal('company'), oidc: browserOidcSchema.optional() }).strict(),
  ]) }).strict(),
]);
export type WebConfiguration = z.infer<typeof webConfigurationSchema>;
export type WebScope = z.infer<typeof webScopeSchema>;
