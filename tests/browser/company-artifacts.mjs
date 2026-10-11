import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
import { createOrganizationApiServer } from '../../dist-company-api/organization.mjs';

if (process.env.CLOUDOPS_OFFLINE_TEST !== '1') throw new Error('Set CLOUDOPS_OFFLINE_TEST=1 for synthetic company verification.');
const root = resolve('dist-company');
const api = createOrganizationApiServer(undefined); // Missing composition must fail closed; no fallback.
api.listen(0, '127.0.0.1'); await once(api, 'listening');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  try {
    if (!file.startsWith(`${root}/`) || pathname.startsWith('/api/')) throw new Error('Not a static asset');
    const data = await readFile(file);
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] ?? 'application/octet-stream');
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  for (const path of ['/api/state', '/api/aws/status', '/api/organization/sso/config', '/api/aws-local-trial/status']) expect((await fetch(`${apiOrigin}${path}`)).status).toBe(404);
  expect((await fetch(`${apiOrigin}/api/organizations/v1/any/workspaces/any/aws/connections`)).status).toBe(503);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, locale: 'ko-KR' });
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(request.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByRole('heading', { name: '조직 AWS 계정 상태', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Google Cloud|On-Prem|개인용|합성 데모/ })).toHaveCount(0);
  // Unconfigured sign-in shows guidance only: no synthetic or demo accounts in the company build.
  await expect(page.getByText('조직 로그인이 설정되지 않았습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /예시|Example/ })).toHaveCount(0);
  const directory = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, 'company-aws-module.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Language / 언어' }).selectOption('en'); await page.reload();
  await expect(page.getByRole('heading', { name: 'Organization AWS account status', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic account example', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]); expect(calls.filter(url => new URL(url).pathname !== '/api/organizations/config')).toEqual([]);
  await checkLocalHost(browser);
  await checkSamlLocalHost(browser);
  console.log('Company artifacts passed: independent API routes, unconfigured fail-closed, unconfigured web guidance, language reload, mobile navigation and the loopback host with synthetic OIDC and Identity Center SAML popup sign-in.');
} finally {
  await browser?.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => api.close(resolve))]);
}

/** Built loopback host with a synthetic OIDC IdP, keys and membership. No real IdP, AWS CLI or Docker is called. */
async function checkLocalHost(browser) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-local-host-')), keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, issuer = 'https://idp.example.invalid/synthetic', clientId = 'cloudops-synthetic-web';
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = claims => { const data = `${part({ alg: 'RS256', typ: 'JWT', kid: 'synthetic-1' })}.${part(claims)}`; return `${data}.${sign('sha256', Buffer.from(data), keys.privateKey).toString('base64url')}`; };
  // Synthetic IdP: immediate consent, PKCE-checked public-client token endpoint with CORS for the app origin only.
  const grants = new Map(), idpCalls = [];
  const idp = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); idpCalls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const redirect = url.searchParams.get('redirect_uri');
      if (url.searchParams.get('client_id') !== clientId || redirect !== `${origin}/oidc-callback.html` || url.searchParams.get('code_challenge_method') !== 'S256') { response.writeHead(400); response.end(); return; }
      const code = `code-${grants.size + 1}`; grants.set(code, { challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce') });
      response.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}` }); response.end(); return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      let text = ''; for await (const chunk of request) text += chunk;
      const body = new URLSearchParams(text), grant = grants.get(body.get('code')); grants.delete(body.get('code'));
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin, 'Cache-Control': 'no-store' };
      if (!grant || body.get('client_id') !== clientId || createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) { response.writeHead(400, headers); response.end('{"error":"invalid_grant"}'); return; }
      const now = Math.floor(Date.now() / 1000);
      response.writeHead(200, headers); response.end(JSON.stringify({ id_token: signed({ iss: issuer, aud: clientId, sub: 'employee-a', nonce: grant.nonce, iat: now, exp: now + 600, name: 'Synthetic Employee' }), token_type: 'Bearer', expires_in: 600 })); return;
    }
    response.writeHead(404); response.end();
  });
  idp.listen(0, '127.0.0.1'); await once(idp, 'listening');
  const idpOrigin = `http://127.0.0.1:${idp.address().port}`;
  const example = JSON.parse(await readFile('deploy/organization-web.example.json', 'utf8')), scope = example.web.scope;
  const env = { ...process.env, CLOUDOPS_LOCAL_STORE: join(directory, 'store', 'local.sqlite'), CLOUDOPS_LOCAL_PORT: String(port),
    CLOUDOPS_DEPLOYMENT: join(directory, 'deployment.json'), CLOUDOPS_WEB_IDENTITY: join(directory, 'identity.json') };
  await writeFile(env.CLOUDOPS_DEPLOYMENT, JSON.stringify({ ...example, publicOrigin: origin, web: { ...example.web, identity: { method: 'company',
    oidc: { issuer, clientId, authorizationEndpoint: `${idpOrigin}/authorize`, tokenEndpoint: `${idpOrigin}/token` } } } }));
  await writeFile(env.CLOUDOPS_WEB_IDENTITY, JSON.stringify({ kind: 'oidc', issuer, audience: clientId, jwks: { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-1', use: 'sig' }] } }));
  const cli = (...args) => { const result = spawnSync(process.execPath, ['dist-company-api/local.mjs', ...args], { env, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
  const actorId = cli('actor', '--issuer', issuer, '--subject', 'employee-a');
  await writeFile(join(directory, 'membership.json'), JSON.stringify({ organizationId: scope.organizationId, workspaceId: scope.workspaceId, actorId, active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() }));
  cli('provision-membership', join(directory, 'membership.json'));
  const host = spawn(process.execPath, ['dist-company-api/local.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; !output.includes('Local organization host') && attempt < 100; attempt++) {
      if (host.exitCode !== null) throw new Error(`Local host exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(output).toContain('identity: oidc, worker provisioner: none');
    const now = Math.floor(Date.now() / 1000);
    const list = await fetch(`${origin}/api/organizations/v1/${scope.organizationId}/workspaces/${scope.workspaceId}/aws/connections`,
      { headers: { Origin: origin, Authorization: `Bearer ${signed({ iss: issuer, aud: clientId, sub: 'employee-a', iat: now, exp: now + 600 })}` } });
    expect(list.status).toBe(200); expect((await list.json()).configurations.map(item => item.id)).toEqual(['aws-read']);
    const context = await browser.newContext({ locale: 'ko-KR' }), page = await context.newPage(), problems = [];
    context.on('weberror', error => problems.push(error.error().message));
    page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: '조직 AWS 계정 상태', exact: true })).toBeVisible();
    const popupOpened = context.waitForEvent('page');
    await page.getByRole('button', { name: '조직 웹 로그인', exact: true }).click();
    const popup = await popupOpened;
    await expect(page.getByRole('button', { name: '조직 프로필 열기' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '조직 프로필 열기' }).click(); await expect(page.getByText('Synthetic Employee', { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect.poll(() => popup.isClosed()).toBe(true);
    // The single permitted payer is preselected; one click registers the connection and tries Device Code.
    await page.getByRole('button', { name: '조직 프로필 열기' }).click();
    await expect(page.getByRole('button', { name: /^Payer 선택/ })).toContainText('Synthetic AWS read access · 123456789012');
    await page.keyboard.press('Escape'); await expect(page.getByText('AWS 로그인이 필요합니다', { exact: true })).toBeVisible(); // in-page prompt before any AWS session
    const devicePopup = context.waitForEvent('page');
    await page.getByRole('button', { name: 'AWS Device Code 로그인', exact: true }).click();
    const blank = await devicePopup;
    await expect(page.getByText(/^전용 AWS 연결 환경을 시작하지 못했습니다\./)).toBeVisible(); // no provisioner in this host
    await expect(page.getByRole('button', { name: '같은 요청 결과 확인' })).toHaveCount(0); // an unknown request is not replayed
    await expect.poll(() => blank.isClosed()).toBe(true);
    await expect(page.getByText(/123456789012/).first()).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(stored).not.toMatch(/eyJ|code_verifier|code-\d/);
    if (!(await page.getByRole('button', { name: '웹 로그아웃', exact: true }).isVisible())) await page.getByRole('button', { name: '조직 프로필 열기' }).click();
    await page.getByRole('button', { name: '웹 로그아웃', exact: true }).click();
    await expect(page.getByRole('button', { name: '조직 웹 로그인', exact: true })).toBeVisible();
    expect(idpCalls).toEqual(['GET /authorize', 'POST /token']); expect(problems).toEqual([]);
    await context.close();
  } finally {
    host.kill('SIGTERM'); if (host.exitCode === null) await once(host, 'exit');
    await new Promise(resolve => idp.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

/** Built loopback host with the Identity Center SAML bridge and a synthetic SAML IdP (local cert, auto-posted assertion). */
async function checkSamlLocalHost(browser) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-saml-host-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'idp.key'), '-out', join(directory, 'idp.crt'), '-days', '1', '-subj', '/CN=synthetic-idp'], { stdio: 'ignore' });
  const key = await readFile(join(directory, 'idp.key'), 'utf8'), cert = await readFile(join(directory, 'idp.crt'), 'utf8');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`, issuer = 'https://cloudops.example.invalid/saml', idpEntity = 'https://portal.sso.us-east-1.amazonaws.com/saml/assertion/SYNTHETIC', spEntity = 'https://cloudops.example.invalid/saml/sp';
  const nameId = 'employee-a@example.invalid', iso = offset => new Date(Date.now() + offset).toISOString(), idpCalls = [];
  const idp = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); idpCalls.push(`${request.method} ${url.pathname}`);
    if (url.pathname !== '/sso') { response.writeHead(404); response.end(); return; }
    const authn = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
    const requestId = /ID="([^"]+)"/.exec(authn)[1], acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(authn)[1];
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1${Date.now()}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${idpEntity}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${iso(300000)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60000)}" NotOnOrAfter="${iso(300000)}"><saml:AudienceRestriction><saml:Audience>${spEntity}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
    const signer = new SignedXml({ privateKey: key, publicCert: cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    signer.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    signer.computeSignature(assertion, { prefix: 'ds', location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1${Date.now()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${requestId}"><saml:Issuer>${idpEntity}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signer.getSignedXml()}</samlp:Response>`;
    const escape = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><form id="f" method="post" action="${escape(acs)}"><input type="hidden" name="SAMLResponse" value="${Buffer.from(xml).toString('base64')}"><input type="hidden" name="RelayState" value="${escape(url.searchParams.get('RelayState'))}"></form><script>document.getElementById('f').submit()</script>`);
  });
  idp.listen(0, '127.0.0.1'); await once(idp, 'listening');
  const example = JSON.parse(await readFile('deploy/organization-web.example.json', 'utf8')), scope = example.web.scope;
  const env = { ...process.env, CLOUDOPS_LOCAL_STORE: join(directory, 'store', 'local.sqlite'), CLOUDOPS_LOCAL_PORT: String(port), CLOUDOPS_DEPLOYMENT: join(directory, 'deployment.json') };
  delete env.CLOUDOPS_WEB_IDENTITY;
  await writeFile(env.CLOUDOPS_DEPLOYMENT, JSON.stringify({ ...example, publicOrigin: origin,
    samlBridge: { issuer, clientId: 'cloudops-web', idp: { entityId: idpEntity, ssoUrl: `http://127.0.0.1:${idp.address().port}/sso`, certificates: [cert] }, sp: { entityId: spEntity } } }));
  const cli = (...args) => { const result = spawnSync(process.execPath, ['dist-company-api/local.mjs', ...args], { env, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); };
  await writeFile(join(directory, 'membership.json'), JSON.stringify({ organizationId: scope.organizationId, workspaceId: scope.workspaceId, actorId: cli('actor', '--issuer', issuer, '--subject', nameId), active: true, roles: ['viewer'], version: 1, updatedAt: new Date().toISOString() }));
  cli('provision-membership', join(directory, 'membership.json'));
  const host = spawn(process.execPath, ['dist-company-api/local.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; host.stdout.on('data', chunk => { output += chunk; }); host.stderr.on('data', chunk => { output += chunk; });
  try {
    for (let attempt = 0; !output.includes('Local organization host') && attempt < 100; attempt++) {
      if (host.exitCode !== null) throw new Error(`Local host exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(output).toContain('identity: identity-center-saml');
    const context = await browser.newContext({ locale: 'ko-KR' }), page = await context.newPage(), problems = [];
    context.on('weberror', error => problems.push(error.error().message));
    page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
    await page.goto(origin);
    const popupOpened = context.waitForEvent('page');
    await page.getByRole('button', { name: '조직 웹 로그인', exact: true }).click();
    const popup = await popupOpened;
    await expect(page.getByRole('button', { name: '조직 프로필 열기' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '조직 프로필 열기' }).click(); await expect(page.getByText(nameId, { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect.poll(() => popup.isClosed()).toBe(true);
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(stored).not.toMatch(/eyJ|SAMLResponse|code_verifier/);
    if (!(await page.getByRole('button', { name: '웹 로그아웃', exact: true }).isVisible())) await page.getByRole('button', { name: '조직 프로필 열기' }).click();
    await page.getByRole('button', { name: '웹 로그아웃', exact: true }).click();
    await expect(page.getByRole('button', { name: '조직 웹 로그인', exact: true })).toBeVisible();
    expect(idpCalls).toEqual(['GET /sso']); expect(problems).toEqual([]);
    await context.close();
  } finally {
    host.kill('SIGTERM'); if (host.exitCode === null) await once(host, 'exit');
    await new Promise(resolve => idp.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
