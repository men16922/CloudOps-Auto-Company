import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
if (process.env.CLOUDOPS_OFFLINE_TEST !== '1') throw new Error('This fixture server is offline only.');
const root = await mkdtemp(join(tmpdir(), 'cloudops-org-web-'));
const base = '/api/organizations/v1/synthetic-org/workspaces/synthetic-workspace/aws/connections';
const accounts = { 'synthetic-user-a': '123456789012', 'synthetic-user-b': '999999999999' };
const ids = { 'synthetic-user-a': '11111111-1111-4111-8111-111111111111', 'synthetic-user-b': '22222222-2222-4222-8222-222222222222' };
const created = new Set(), states = new Map(), keys = new Set(); let revoked = false, directoryDenied = false, cursorsExpired = false;
let browser, server;
try {
  await build({ entryPoints: ['tests/fixtures/organization-web.tsx'], outfile: join(root, 'app.js'), bundle: true, platform: 'browser', format: 'esm', loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file' }, logLevel: 'silent' });
  await copyFile('public/cloudops-mark.svg', join(root, 'cloudops-mark.svg'));
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const send = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (path === '/fixture/complete') { states.set('synthetic-user-a', 'connected'); send(200, {}); return; }
      if (path === '/fixture/cursor-expired') { cursorsExpired = true; send(200, {}); return; }
      if (path === '/fixture/directory-denied') { directoryDenied = true; send(200, {}); return; }
      if (path === '/fixture/revoke') { revoked = true; send(200, {}); return; }
      if (path.startsWith('/api/')) {
        const actor = request.headers.authorization?.replace(/^Bearer /, '');
        if (!accounts[actor]) { send(401, { code: 'web_sign_in_required' }); return; }
        if (revoked) { send(403, { code: 'organization_access_denied' }); return; }
        const row = { id: ids[actor], configurationId: 'read', accountId: accounts[actor], roleName: 'ReadOnlyAccess', region: 'us-east-1', createdAt: '2026-10-10T00:00:00Z', directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' } };
        const state = () => ({ connectionId: row.id, accountId: row.accountId, roleName: row.roleName, region: row.region, status: states.get(actor) ?? 'disconnected', ...(states.get(actor) === 'awaiting-user' ? { userCode: 'DEMO-CODE', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/' } : {}) });
        if (path === base && request.method === 'GET') { send(200, { items: created.has(actor) ? [row] : [], configurations: [{ id: 'read', label: 'Synthetic read access', accountId: row.accountId, roleName: row.roleName, region: row.region, directory: row.directory }] }); return; }
        if (path === `${base}/${row.id}/status` && request.method === 'GET') { send(200, state()); return; }
        if (request.method !== 'POST') { send(404, {}); return; }
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); const key = request.headers['idempotency-key'];
        if (!key || keys.has(key)) { send(409, { code: 'request_key_conflict' }); return; } keys.add(key);
        if (path === base) { expect(body).toEqual({ configurationId: 'read' }); created.add(actor); send(200, row); return; }
        if (path !== `${base}/${row.id}/actions`) { send(404, {}); return; }
        if (body.operation === 'login') { states.set(actor, 'awaiting-user'); const result = state(); delete result.userCode; delete result.verificationUri; send(200, result); return; }
        if (body.operation === 'inspect') { expect(body).toEqual({ operation: 'inspect', service: 'lambda' }); send(200, { connectionId: row.id, accountId: row.accountId, region: row.region, operation: 'lambda', collectedAt: '2026-10-10T00:00:00Z', items: [{ name: `synthetic-${actor}-resource` }], hasMore: false }); return; }
        if (body.operation === 'directory') {
          expect(Object.keys(body).sort()).toEqual(body.cursor ? ['cursor', 'operation'] : ['operation']);
          if (body.cursor && cursorsExpired) { send(409, { code: 'directory_cursor_expired' }); return; }
          if (!body.cursor) cursorsExpired = false;
          const cursors = { root: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', account2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', child: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ou2: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', account3: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
          if (body.cursor) expect(Object.values(cursors)).toContain(body.cursor);
          const nested = body.cursor === cursors.child, accountPage = body.cursor === cursors.account2 ? 2 : body.cursor === cursors.account3 ? 3 : 1, ouPage = body.cursor === cursors.ou2 ? 2 : 1;
          const observedAt = '2026-10-10T00:00:00Z', parentId = nested ? 'ou-demo-12345678' : 'r-demo';
          send(200, { connectionId: row.id, accountId: row.accountId, region: row.region, scope: row.directory, parentId, parentName: nested ? 'Synthetic direct OU' : 'Synthetic root', collectedAt: observedAt, coverage: 'direct-children-page',
            navigation: { expiresAt: new Date(Date.now() + 600000).toISOString(), path: [{ id: 'r-demo', name: 'Synthetic root', cursor: cursors.root }, ...(nested ? [{ id: parentId, name: 'Synthetic direct OU', cursor: cursors.child }] : [])] },
            accounts: directoryDenied ? { status: 'denied', code: 'access_denied', observedAt, source: 'organizations:ListAccountsForParent' } : { status: 'collected', source: 'organizations:ListAccountsForParent', observedAt, pageNumber: accountPage, hasMore: !nested && accountPage < 3,
              ...(!nested && accountPage < 3 ? { nextCursor: accountPage === 1 ? cursors.account2 : cursors.account3 } : {}), items: nested ? [{ id: '444444444444', name: 'Synthetic nested account', lifecycle: 'PENDING_CLOSURE', access: 'not-checked', inspection: 'not-collected' }] : accountPage === 2 ? [] : accountPage === 3 ? [{ id: '555555555555', name: 'Synthetic later account', lifecycle: 'ACTIVE', access: 'not-checked', inspection: 'not-collected' }] : [
              { id: '111111111111', name: 'Synthetic active account', lifecycle: 'ACTIVE', access: 'not-checked', inspection: 'not-collected' },
              { id: '222222222222', name: 'Synthetic suspended account', lifecycle: 'SUSPENDED', access: 'not-checked', inspection: 'not-collected' },
              { id: '333333333333', name: 'Synthetic unknown account', lifecycle: 'UNKNOWN', access: 'not-checked', inspection: 'not-collected' },
            ] }, organizationalUnits: { status: 'collected', observedAt, source: 'organizations:ListOrganizationalUnitsForParent', pageNumber: ouPage,
              items: nested ? [] : [{ id: ouPage === 1 ? 'ou-demo-12345678' : 'ou-demo-87654321', name: ouPage === 1 ? 'Synthetic direct OU' : 'Synthetic second OU', ...(ouPage === 1 ? { browseCursor: cursors.child } : {}) }], hasMore: !nested && ouPage === 1, ...(!nested && ouPage === 1 ? { nextCursor: cursors.ou2 } : {}) } }); return;
        }
        if (body.operation === 'logout') { states.set(actor, 'disconnected'); send(200, { disconnected: true, remoteLogout: 'confirmed' }); return; }
        send(400, { code: 'invalid_request' }); return;
      }
      if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Synthetic organization contract</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return; }
      const file = resolve(root, `.${path}`); if (!file.startsWith(`${root}/`)) throw new Error('Invalid path');
      response.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file));
    } catch (error) { console.error('Synthetic server error:', error.message); response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 }, locale: 'ko-KR' });
  const page = await context.newPage(); const errors = []; page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '조직 웹 로그인', exact: true }).click();
  const add = async account => {
    await page.getByRole('button', { name: /^허용된 AWS 연결/ }).click();
    await page.getByRole('option', { name: new RegExp(account) }).click();
    await page.getByRole('button', { name: '내 연결 추가', exact: true }).click();
    await expect(page.getByRole('button', { name: account, exact: true })).toBeVisible();
  };
  await add(accounts['synthetic-user-a']);
  await page.getByRole('button', { name: 'AWS Device Code 로그인', exact: true }).click(); await expect(page.getByText('DEMO-CODE', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'AWS 인증 페이지 열기' })).toHaveAttribute('href', 'https://device.sso.us-east-1.amazonaws.com/');
  await fetch(`${origin}/fixture/complete`); await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await page.getByRole('button', { name: 'Lambda 목록 조회', exact: true }).click(); await expect(page.getByText('synthetic-synthetic-user-a-resource', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '지정 Root/OU 계정 상태 조회', exact: true }).click();
  await expect(page.getByText('Synthetic active account', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic direct OU', { exact: true })).toBeVisible();
  await expect(page.getByText('계정의 다음 페이지가 있습니다. 빈 페이지여도 전체 계정이 0개라는 뜻은 아닙니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계정 다음 페이지', exact: true }).click();
  await expect(page.getByText('이번 페이지에 반환된 계정이 없습니다.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계정 다음 페이지', exact: true }).click(); await expect(page.getByText('Synthetic later account', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '계정 다음 페이지', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정 범위 처음부터', exact: true }).click();
  await page.getByRole('button', { name: 'OU 다음 페이지', exact: true }).click(); await expect(page.getByText('Synthetic second OU', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '설정 범위 처음부터', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic direct OU', exact: true }).click(); await expect(page.getByText('Synthetic nested account', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic active account', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '설정 범위 처음부터', exact: true }).click();
  await fetch(`${origin}/fixture/cursor-expired`); await page.getByRole('button', { name: '계정 다음 페이지', exact: true }).click();
  await expect(page.getByText('탐색 시간이 만료됐습니다. 지정 Root/OU부터 새로 조회하세요.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '지정 Root/OU 계정 상태 조회', exact: true }).click(); await expect(page.getByText('Synthetic active account', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^계정 수명주기 필터/ }).click(); await page.getByRole('option', { name: '일시 중지', exact: true }).click();
  await expect(page.getByText('Synthetic active account', { exact: true })).toHaveCount(0); await expect(page.getByText('Synthetic suspended account', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^계정 수명주기 필터/ }).click(); await page.getByRole('option', { name: '모든 수명주기', exact: true }).click();
  const directory = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await mkdir(directory, { recursive: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(directory, 'organization-connected-synthetic.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Language / 언어' }).selectOption('en'); await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.failureSummary) }))).toEqual([]);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: join(directory, 'organization-connected-en-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1500, height: 1200 }); await page.getByRole('combobox', { name: 'Language / 언어' }).selectOption('ko');
  await fetch(`${origin}/fixture/directory-denied`); await page.getByRole('button', { name: '지정 Root/OU 계정 상태 조회', exact: true }).click();
  await expect(page.getByText('계정 목록 미수집', { exact: true })).toBeVisible(); await expect(page.getByText('Synthetic active account', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic direct OU', { exact: true })).toBeVisible();
  await page.getByTestId('switch-user').click(); await expect(page.getByText('Synthetic direct OU', { exact: true })).toHaveCount(0); await expect(page.getByText('synthetic-synthetic-user-a-resource', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: accounts['synthetic-user-a'], exact: true })).toHaveCount(0);
  await add(accounts['synthetic-user-b']); await fetch(`${origin}/fixture/revoke`); await page.getByRole('button', { name: '연결 목록 새로고침', exact: true }).click();
  await expect(page.getByText('조직 접근 권한을 확인할 수 없어 계정 정보를 지웠습니다.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: accounts['synthetic-user-b'], exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '웹 로그아웃', exact: true }).click(); await expect(page.getByRole('button', { name: '조직 웹 로그인', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language / 언어' }).selectOption('en'); await page.reload(); await expect(page.getByRole('button', { name: 'Sign in to organization', exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-user');
  console.log('Organization web synthetic contract passed: sign-in, owned connection, device code, inventory, scoped directory pages/OU navigation/expiry/lifecycle/filter/partial denial, user switch, membership revocation, logout and reload.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { const directory = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await mkdir(directory, { recursive: true }); await page.screenshot({ path: join(directory, 'organization-web-failure.png'), fullPage: true }); console.error(await page.locator('body').ariaSnapshot()); }
  throw error;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
