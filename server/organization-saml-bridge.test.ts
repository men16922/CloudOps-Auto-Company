import { test, before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { identityActor } from './cloud-auth';
import { SqliteCloudStore } from './cloud-sqlite-store';
import { composeOrganizationApi, organizationDeploymentSchema } from './modules/aws/organization';
import { provisionLocalMembership } from './organization-local-host';

// Synthetic IdP certificates are generated per run (openssl) and synthetic assertions are signed locally.
// No IAM Identity Center, IdP endpoint or AWS API is contacted.
const issuer = 'https://cloudops.example.invalid/saml', clientId = 'cloudops-web', idpEntity = 'https://portal.sso.us-east-1.amazonaws.com/saml/assertion/SYNTHETIC';
const spEntity = 'https://cloudops.example.invalid/saml/sp', ssoUrl = 'https://portal.sso.us-east-1.amazonaws.com/saml/assertion/SYNTHETIC';
let directory = '', idp = { key: '', cert: '' }, other = { key: '', cert: '' };
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cloudops-saml-'));
  const pair = async (name: string) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, `${name}.key`), '-out', join(directory, `${name}.crt`), '-days', '1', '-subj', `/CN=synthetic-${name}`], { stdio: 'ignore' });
    return { key: await readFile(join(directory, `${name}.key`), 'utf8'), cert: await readFile(join(directory, `${name}.crt`), 'utf8') };
  };
  idp = await pair('idp'); other = await pair('other');
});
after(() => rm(directory, { recursive: true, force: true }));

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
function assertionXml(options: { requestId: string; acs: string; nameId: string; audience?: string; notOnOrAfter?: string; issuerValue?: string; id?: string }) {
  const id = options.id ?? `_a${randomBytes(8).toString('hex')}`, until = options.notOnOrAfter ?? iso(300_000);
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${options.issuerValue ?? idpEntity}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${options.nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`
    + `<saml:SubjectConfirmationData InResponseTo="${options.requestId}" NotOnOrAfter="${until}" Recipient="${options.acs}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${options.audience ?? spEntity}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
}
function sign(xml: string, keys = idp) {
  const signer = new SignedXml({ privateKey: keys.key, publicCert: keys.cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
  signer.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
  signer.computeSignature(xml, { prefix: 'ds', location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return signer.getSignedXml();
}
const responseXml = (requestId: string, acs: string, assertion: string) => `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${requestId}">`
  + `<saml:Issuer>${idpEntity}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;

async function harness(t: TestContext) {
  let handler: RequestListener = (_request, response) => { response.writeHead(503); response.end(); };
  const server = createServer((request, response) => handler(request, response)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, store = new SqliteCloudStore(join(directory, `${randomUUID()}.sqlite`));
  const deployment = { publicOrigin: origin, web: { configured: true, scope: { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', label: 'Synthetic' }, identity: { method: 'company' } },
    connections: [], samlBridge: { issuer, clientId, idp: { entityId: idpEntity, ssoUrl, certificates: [idp.cert] }, sp: { entityId: spEntity } } };
  const composition = composeOrganizationApi({ deployment, store }); handler = composition.listener;
  t.after(async () => { await composition.close(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const callback = `${origin}/oidc-callback.html`, acs = `${origin}/api/organizations/saml/acs`;
  const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') }; };
  async function authorize(overrides: Record<string, string> = {}) {
    const flow = pkce(), url = new URL(`${origin}/api/organizations/saml/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback, scope: 'openid', state: flow.state, nonce: flow.nonce, code_challenge: flow.challenge, code_challenge_method: 'S256', ...overrides })) url.searchParams.set(key, value);
    const response = await fetch(url, { redirect: 'manual' });
    if (response.status !== 303) return { ...flow, status: response.status, requestId: '', relay: '' };
    const location = new URL(response.headers.get('location')!);
    assert.equal(`${location.origin}${location.pathname}`, ssoUrl);
    const request = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    assert.match(request, new RegExp(`AssertionConsumerServiceURL="${acs}"`));
    return { ...flow, status: 303, requestId: /ID="([^"]+)"/.exec(request)![1]!, relay: location.searchParams.get('RelayState')! };
  }
  const acsPost = (relay: string, xml: string) => fetch(acs, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
    body: new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString('base64'), RelayState: relay }).toString() });
  const token = (code: string, verifier: string, headerOrigin = origin) => fetch(`${origin}/api/organizations/saml/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: headerOrigin }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: clientId, code_verifier: verifier }).toString() });
  return { origin, store, acs, callback, authorize, acsPost, token };
}
const callbackParams = (response: Response) => new URL(response.headers.get('location')!).searchParams;

test('Identity Center SAML sign-in issues a bridge id_token that the API accepts only with membership', async t => {
  const h = await harness(t), flow = await h.authorize();
  const done = await h.acsPost(flow.relay, responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid' }))));
  assert.equal(done.status, 303);
  const params = callbackParams(done);
  assert.equal(params.get('state'), flow.state); assert.equal(params.get('error'), null);
  const issued = await h.token(params.get('code')!, flow.verifier);
  assert.equal(issued.status, 200);
  const { id_token: idToken } = await issued.json() as { id_token: string };
  const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8'));
  assert.equal(claims.iss, issuer); assert.equal(claims.aud, clientId); assert.equal(claims.sub, 'employee-a@example.invalid'); assert.equal(claims.nonce, flow.nonce);
  const config = await (await fetch(`${h.origin}/api/organizations/config`, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).json() as { identity: { oidc: { authorizationEndpoint: string } } };
  assert.equal(config.identity.oidc.authorizationEndpoint, `${h.origin}/api/organizations/saml/authorize`);
  const list = () => fetch(`${h.origin}/api/organizations/v1/synthetic-org/workspaces/synthetic-workspace/aws/connections`, { headers: { Origin: h.origin, Authorization: `Bearer ${idToken}` } });
  assert.equal((await list()).status, 403, 'a SAML sign-in alone is not organization membership');
  await provisionLocalMembership(h.store, { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', actorId: identityActor(issuer, 'employee-a@example.invalid'), active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() });
  assert.equal((await list()).status, 200);
  assert.equal((await h.token(params.get('code')!, flow.verifier)).status, 400, 'codes are one-time');
  assert.equal((await h.acsPost(flow.relay, 'x')).status, 400, 'relay state is one-time');
});

test('unsigned, re-signed, tampered, wrong-audience, expired, foreign-request and wrapped assertions are refused', async t => {
  const h = await harness(t);
  const cases: Array<[string, (flow: { requestId: string }) => string]> = [
    ['wrong signer', flow => responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid' }), other))],
    ['unsigned', flow => responseXml(flow.requestId, h.acs, assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid' }))],
    ['tampered subject', flow => responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid' })).replace('employee-a@', 'admin@'))],
    ['wrong audience', flow => responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid', audience: 'https://other.example.invalid/sp' })))],
    ['expired', flow => responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid', notOnOrAfter: iso(-120_000) })))],
    ['foreign request', () => responseXml('_foreign', h.acs, sign(assertionXml({ requestId: '_foreign', acs: h.acs, nameId: 'employee-a@example.invalid' })))],
    ['wrong issuer', flow => responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid', issuerValue: 'https://evil.example.invalid' })))],
    ['wrapped', flow => {
      const signed = sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-a@example.invalid' }));
      const evil = assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'admin@example.invalid', id: '_evil' });
      return responseXml(flow.requestId, h.acs, `${evil}${signed}`);
    }],
  ];
  for (const [name, build] of cases) {
    const flow = await h.authorize(), done = await h.acsPost(flow.relay, build(flow)), params = callbackParams(done);
    if (params.get('code')) {
      const claims = JSON.parse(Buffer.from((await (await h.token(params.get('code')!, flow.verifier)).json() as { id_token: string }).id_token.split('.')[1]!, 'base64url').toString('utf8'));
      assert.notEqual(claims.sub, 'admin@example.invalid', `${name} must never yield the unsigned subject`);
      assert.equal(name, 'wrapped', `${name} must be refused`);
    } else assert.equal(params.get('error'), 'access_denied', name);
  }
  assert.equal((await h.acsPost('unknown-relay', 'x')).status, 400, 'IdP-initiated or unknown relay state is refused');
});

test('authorize and token endpoints enforce client, redirect, PKCE and same-origin rules', async t => {
  const h = await harness(t);
  for (const overrides of [{ client_id: 'other' }, { redirect_uri: 'https://attacker.example.invalid/cb' }, { code_challenge_method: 'plain' }, { state: 'short' }, { response_type: 'token' }] as Array<Record<string, string>>) {
    assert.equal((await h.authorize(overrides)).status, 400, JSON.stringify(overrides));
  }
  const flow = await h.authorize(), done = await h.acsPost(flow.relay, responseXml(flow.requestId, h.acs, sign(assertionXml({ requestId: flow.requestId, acs: h.acs, nameId: 'employee-b@example.invalid' }))));
  const code = callbackParams(done).get('code')!;
  assert.equal((await h.token(code, flow.verifier, 'https://attacker.example.invalid')).status, 403);
  assert.equal((await h.token(code, randomBytes(32).toString('base64url'))).status, 400, 'wrong verifier');
  assert.equal((await h.token(code, flow.verifier)).status, 400, 'a failed exchange consumed the code');
});

test('deployment rules: the bridge owns the browser client and verifier', async t => {
  const base = { publicOrigin: 'https://cloudops.example.invalid', web: { configured: true, scope: { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', label: 'Synthetic' }, identity: { method: 'company' } }, connections: [],
    samlBridge: { issuer, clientId, idp: { entityId: idpEntity, ssoUrl, certificates: [idp.cert] }, sp: { entityId: spEntity } } };
  assert.ok(organizationDeploymentSchema.parse(base));
  assert.equal(organizationDeploymentSchema.safeParse({ ...base, web: { ...base.web, identity: { method: 'company', oidc: { issuer, clientId, authorizationEndpoint: 'https://idp.example.invalid/a', tokenEndpoint: 'https://idp.example.invalid/t' } } } }).success, false);
  assert.equal(organizationDeploymentSchema.safeParse({ ...base, samlBridge: { ...base.samlBridge, idp: { ...base.samlBridge.idp, ssoUrl: 'http://idp.example.invalid/sso' } } }).success, false);
  assert.equal(organizationDeploymentSchema.safeParse({ ...base, samlBridge: { ...base.samlBridge, idp: { ...base.samlBridge.idp, certificates: ['not a certificate'] } } }).success, false);
  const store = new SqliteCloudStore(':memory:'); t.after(() => store.close());
  assert.throws(() => composeOrganizationApi({ deployment: base, store, verifier: { async verify() { return { actorId: 'x', expiresAt: Date.now() + 1000 }; } } }), /SAML bridge/);
});
