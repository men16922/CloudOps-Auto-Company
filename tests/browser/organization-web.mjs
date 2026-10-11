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
const created = new Set(), states = new Map(), keys = new Set(), syncs = new Map(), views = new Map(), runbookRequests = new Map(); let revoked = false, directoryDenied = false, cursorsExpired = false;
const member = '210987654321', unassigned = '310987654321';
let browser, server;
try {
  await build({ entryPoints: ['tests/browser/fixtures/organization-web.tsx'], outfile: join(root, 'app.js'), bundle: true, platform: 'browser', format: 'esm', loader: { '.woff2': 'file', '.woff': 'file', '.svg': 'file' }, logLevel: 'silent' });
  await copyFile('apps/web/public/cloudops-mark.svg', join(root, 'cloudops-mark.svg'));
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
        const row = { id: ids[actor], configurationId: 'read', accountId: accounts[actor], roleName: 'ReadOnlyAccess', region: 'us-east-1', createdAt: '2026-10-10T00:00:00Z', directory: { awsOrganizationId: 'o-synthetic1', parentId: 'r-demo' }, requiredTags: ['Owner', 'CostCenter'] };
        const state = () => ({ connectionId: row.id, accountId: row.accountId, roleName: row.roleName, region: row.region, status: states.get(actor) ?? 'disconnected', ...(states.get(actor) === 'awaiting-user' ? { userCode: 'DEMO-CODE', verificationUri: 'https://device.sso.us-east-1.amazonaws.com/', verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE' } : {}) });
        if (path === base && request.method === 'GET') { send(200, { items: created.has(actor) ? [row] : [], configurations: [{ id: 'read', label: 'Synthetic read access', accountId: row.accountId, roleName: row.roleName, region: row.region, directory: row.directory }] }); return; }
        if (path === `${base}/${row.id}/status` && request.method === 'GET') { send(200, state()); return; }
        if (path === `${base}/${row.id}/observations` && request.method === 'GET') { send(200, { inventories: {} }); return; }
        // Sync: the first progress poll completes the job; inventory is served from the (synthetic) host cache.
        const unit = (accountId, region, service, items, extra = {}) => ({ accountId, region, service, collectedAt: '2026-10-11T00:00:00.000Z', hasMore: false, items, source: 'direct', ...extra });
        const syncUnits = [
          unit(row.accountId, 'us-east-1', 'alarms', [{ name: 'synthetic-api-errors', state: 'ALARM' }, { name: 'synthetic-cpu', state: 'OK' }]),
          unit(row.accountId, 'us-east-1', 'lambda', [{ name: `synthetic-${actor}-resource`, runtime: 'python3.8' }]),
          unit(row.accountId, 'us-east-1', 'dynamodb', [{ name: 'synthetic-orders' }]),
          unit(row.accountId, 'us-east-1', 'apigateway', [{ name: 'synthetic-api', id: 'a1b2c3d4e5', type: 'REST', version: 'REGIONAL' }]),
          unit(row.accountId, 'us-east-1', 'ec2', [{ id: 'i-0123456789abcdef0', name: 'synthetic-batch', state: 'stopped', type: 't3.micro', tags: ['Name', 'Owner', 'CostCenter'] }]),
          unit(member, 'ap-northeast-2', 'ec2', [{ id: 'i-0123456789abcdef1', name: 'synthetic-web', state: 'running', type: 't3.large', tags: ['Name', 'Owner'] }]),
          unit(member, 'ap-northeast-2', 'securityhub', [{ name: 'Synthetic bucket allows public read', state: 'CRITICAL', type: 'Security Hub', detail: 'AwsS3Bucket', version: 'S3.2', modified: '2026-10-10T00:00:00Z' }]),
          unit(row.accountId, 'us-east-1', 'securityhub', [], { code: 'read_not_enabled' }),
          unit(member, 'ap-northeast-2', 'guardduty', [{ id: 'b'.repeat(32), name: 'Synthetic port probe', value: 8, type: 'Recon:EC2/PortProbeUnprotectedPort', detail: 'Instance', modified: '2026-10-10T00:00:00Z' }]),
          unit(row.accountId, 'us-east-1', 'guardduty', []),
          unit(row.accountId, 'us-east-1', 'health', [{ name: 'AWS_EC2_SYNTHETIC_RETIREMENT_SCHEDULED', type: 'EC2', version: 'scheduledChange', state: 'upcoming', detail: 'ap-northeast-2', modified: '2026-10-20T00:00:00Z' }]),
          unit(member, 'us-east-1', 'health', [], { code: 'read_not_subscribed' }),
          unit(member, 'ap-northeast-2', 'eks', [{ name: 'synthetic-legacy', state: 'ACTIVE', version: '1.33', support: 'EXTENDED_SUPPORT', type: 'eks.20' }]),
          unit(member, 'ap-northeast-2', 'rds', [{ name: 'synthetic-db', state: 'available', type: 'db.t4g.micro', version: 'postgres 16.4' }]),
          unit(member, 'ap-northeast-2', 'elasticache', [{ name: 'synthetic-cache', state: 'available', type: 'cache.t4g.micro', version: 'valkey 8.0' }]),
          unit(member, 'ap-northeast-2', 'msk', [], { code: 'read_access_denied' }),
          unit(member, 'ap-northeast-2', 'metrics', [{ name: 'i-0123456789abcdef1', id: 'i-0123456789abcdef1', metric: 'ec2_cpu', value: 50, peak: 96 }, { name: 'synthetic-db', metric: 'rds_storage', value: 3 * 1024 ** 3, peak: 1.5 * 1024 ** 3 }]),
          unit(member, 'ap-northeast-2', 'ssm', []),
          unit(member, 'ap-northeast-2', 'patch', [{ id: 'i-0123456789abcdef1', name: 'i-0123456789abcdef1', state: 'NON_COMPLIANT', detail: 'HIGH' }]),
          unit(member, 'ap-northeast-2', 'automation', [{ id: '12345678-1234-4234-8234-123456789012', name: 'AWS-RestartEC2Instance', state: 'Failed', modified: '2026-10-10T00:00:00Z', detail: '2026-10-10T00:05:00Z' }]),
        ];
        const summary = state => ({ connectionId: row.id, jobId: syncs.get(actor), mode: 'direct', state, startedAt: '2026-10-11T00:00:00.000Z', ...(state === 'running' ? {} : { finishedAt: '2026-10-11T00:02:00.000Z' }),
          progress: state === 'running' ? { done: 1, total: 20 } : { done: 20, total: 20 }, cachedUnits: state === 'running' ? 0 : syncUnits.length, live: true, accounts: state === 'running' ? [] : [
            { accountId: row.accountId, name: 'Synthetic payer', lifecycle: 'ACTIVE', access: 'verified', regions: [{ region: 'us-east-1', vpcs: 1, taggedVpcs: 0 }], candidateRegions: 3 },
            { accountId: member, name: 'Synthetic workload', lifecycle: 'ACTIVE', access: 'verified', regions: [{ region: 'ap-northeast-2', vpcs: 2, taggedVpcs: 1 }, { region: 'eu-west-1', vpcs: 1, taggedVpcs: 0 }], candidateRegions: 3 },
            { accountId: unassigned, name: 'Synthetic unassigned', lifecycle: 'ACTIVE', access: 'denied', code: 'access_denied', regions: [], candidateRegions: 0 }] });
        if (path === `${base}/${row.id}/sync` && request.method === 'GET') { if (!syncs.has(actor)) { send(404, { code: 'sync_not_found' }); return; } send(200, summary('partial')); return; }
        if (path === `${base}/${row.id}/inventory/all` && request.method === 'GET') { send(200, { service: 'all', units: syncs.has(actor) ? syncUnits : [], truncated: false }); return; }
        // Trend history: an older sync (8 days before) and the latest one. One alarm disappeared where the member account is still readable
        // (resolved); one MSK item disappeared where MSK could not be read (unverified); a Security Hub result is new.
        const finding = (id, severity, kind, subject, detail, source, accountId, region, extra = {}) => ({ id, severity, kind, subject, detail, source, accountId, region, ...extra });
        const persisting = finding(`alarm:${row.accountId}:us-east-1:synthetic-api-errors`, 'critical', 'alarm', 'synthetic-api-errors', 'ALARM', 'alarms', row.accountId, 'us-east-1');
        const reportSnapshots = [
          { jobId: '33333333-3333-4333-8333-333333333333', at: '2026-10-03T00:00:00.000Z', state: 'completed', mode: 'direct', verified: [row.accountId, member], accounts: 3, counts: { critical: 2, warning: 1, info: 0 }, truncated: false, findings: [persisting,
            finding(`alarm:${member}:ap-northeast-2:synthetic-old-alarm`, 'critical', 'alarm', 'synthetic-old-alarm', 'ALARM', 'alarms', member, 'ap-northeast-2'),
            finding(`msk-state:${member}:ap-northeast-2:synthetic-kafka`, 'warning', 'resource-state', 'synthetic-kafka', 'MSK HEALING', 'msk', member, 'ap-northeast-2')] },
          { jobId: '44444444-4444-4444-8444-444444444444', at: '2026-10-11T00:02:00.000Z', state: 'partial', mode: 'direct', verified: [row.accountId, member], accounts: 3, counts: { critical: 2, warning: 0, info: 1 }, truncated: false, findings: [persisting,
            finding(`security-hub:CRITICAL:${member}:ap-northeast-2`, 'critical', 'security-hub', 'Security Hub', 'CRITICAL', 'securityhub', member, 'ap-northeast-2', { value: 1 }),
            finding(`read:msk:${member}:ap-northeast-2`, 'info', 'read-failed', 'msk', 'read_access_denied', 'msk', member, 'ap-northeast-2')] },
        ];
        if (path === `${base}/${row.id}/report` && request.method === 'GET') { send(200, { snapshots: syncs.has(actor) ? reportSnapshots : [] }); return; }
        if (path === `${base}/${row.id}/views` && request.method === 'GET') { send(200, { items: views.get(actor) ?? [] }); return; }
        const runbookState = () => ({ enabled: true, allowed: ['connectivity-check', 'ec2-restart'], canRequest: true, canApprove: true, selfApproval: true, requests: runbookRequests.get(actor) ?? [] });
        if (path === `${base}/${row.id}/runbooks` && request.method === 'GET') { send(200, runbookState()); return; }
        if (request.method !== 'POST') { send(404, {}); return; }
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); const key = request.headers['idempotency-key'];
        if (!key || keys.has(key)) { send(409, { code: 'request_key_conflict' }); return; } keys.add(key);
        if (path === base) { expect(body).toEqual({ configurationId: 'read' }); created.add(actor); send(200, row); return; }
        if (path === `${base}/${row.id}/views`) {
          // Saved views carry only the page, scope and that page's search conditions.
          if (body.view?.name === 'Batch EC2') expect(body).toEqual({ operation: 'save', view: { name: 'Batch EC2', page: 'ec2', accounts: [], regions: [], queries: { 'ec2.ec2': { operation: 'and', tokens: [{ operator: ':', value: 'batch' }] } } } });
          const list = views.get(actor) ?? [], existing = list.find(item => item.view.name === body.view?.name);
          views.set(actor, body.operation === 'save' ? [...list.filter(item => item !== existing), { id: existing?.id ?? crypto.randomUUID(), updatedAt: '2026-10-11T00:03:00.000Z', view: body.view }] : list.filter(item => item.id !== body.id));
          send(200, { items: views.get(actor) }); return;
        }
        if (path === `${base}/${row.id}/runbooks`) {
          // Runbook actions name catalog entries and request ids only; documents and parameters never come from the browser.
          expect(Object.keys(body)).not.toContain('document');
          const list = runbookRequests.get(actor) ?? [], now = '2026-10-11T00:05:00.000Z', me = { self: true, label: 'abc123' };
          if (body.operation === 'request') {
            expect(body).toEqual({ operation: 'request', runbook: 'connectivity-check', target: { accountId: row.accountId, region: row.region }, reason: 'Synthetic permission check' });
            runbookRequests.set(actor, [{ id: crypto.randomUUID(), runbook: body.runbook, target: body.target, reason: body.reason, requester: me, createdAt: now, state: 'pending', events: [{ at: now, action: 'requested', by: me }] }, ...list]);
          } else {
            const item = list.find(value => value.id === body.requestId); expect(item).toBeTruthy();
            if (body.operation === 'approve') Object.assign(item, { state: 'approved', decision: { by: me, at: now, approved: true } });
            if (body.operation === 'execute') Object.assign(item, { state: 'running', execution: { executionId: '0d0d0d0d-1111-4222-8333-444444444444', status: 'InProgress' } });
            if (body.operation === 'refresh') Object.assign(item, { state: 'succeeded', execution: { executionId: '0d0d0d0d-1111-4222-8333-444444444444', status: 'Success' } });
          }
          send(200, runbookState()); return;
        }
        if (path !== `${base}/${row.id}/actions`) { send(404, {}); return; }
        if (body.operation === 'login') { states.set(actor, 'awaiting-user'); const result = state(); delete result.userCode; delete result.verificationUri; delete result.verificationUriComplete; send(200, result); return; }
        if (body.operation === 'sync') { expect(Object.keys(body)).toEqual(['operation']); syncs.set(actor, crypto.randomUUID()); send(200, summary('running')); return; }
        // The dashboard reads through sync only; single-service reads are a host/worker API for verification tools.
        expect(body.operation).not.toBe('inspect');
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
  // Offline: any AWS page a device link opens is answered locally, never by AWS.
  await context.route(/^https:\/\/([a-z0-9.-]+\.)?(amazonaws\.com|awsapps\.com)\//, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic AWS device page</title>' }));
  const page = await context.newPage(); const errors = []; page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '조직 웹 로그인', exact: true }).click();
  const openProfile = async () => { if (!(await page.getByRole('button', { name: /^Payer 선택/ }).first().isVisible())) await page.getByRole('button', { name: '조직 프로필 열기' }).click(); };
  const choosePayer = async account => {
    await openProfile(); await page.getByRole('button', { name: /^Payer 선택/ }).click();
    await page.getByRole('option', { name: new RegExp(account) }).click();
  };
  await choosePayer(accounts['synthetic-user-a']); await page.keyboard.press('Escape');
  await expect(page.getByText('아직 수집한 결과가 없습니다.', { exact: false })).toBeVisible(); // the page itself asks for AWS sign-in
  // One click registers the payer connection, starts Device Code and points the opened window at the code-carrying link.
  const popupOpened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'AWS Device Code 로그인', exact: true }).click(); await expect(page.getByText('DEMO-CODE', { exact: true })).toBeVisible();
  const devicePopup = await popupOpened; await page.keyboard.press('Escape');
  await expect.poll(() => devicePopup.url()).toBe('https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE');
  expect(await devicePopup.evaluate(() => window.opener)).toBeNull(); await devicePopup.close();
  await expect(page.getByRole('link', { name: 'AWS 인증 페이지 열기 (코드 자동 입력)' })).toHaveAttribute('href', 'https://device.sso.us-east-1.amazonaws.com/?user_code=DEMO-CODE');
  await fetch(`${origin}/fixture/complete`);
  // Connected: the first connection runs one sync; progress polling completes it and the dashboard reads the cached multi-account inventory.
  await expect(page.getByText('일부 실패 포함 완료', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/계정 3 · 사용 리전 1 \(VPC 태그 기준\)/)).toBeVisible();
  await expect(page.getByText('조치 필요', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: /synthetic-api-errors/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'synthetic-api-errors AWS 콘솔에서 열기' })).toHaveAttribute('href', 'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/synthetic-api-errors');
  // Security findings rank with other action items; the overview lists the top 10 and can expand to all of them.
  await expect(page.getByText('Security Hub 결과 · CRITICAL 1건', { exact: true })).toBeVisible(); await expect(page.getByText('GuardDuty 위협 탐지 · 높음 이상 1건', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^모두 보기 \(\d+\)$/ }).click();
  await expect(page.getByText('보안 서비스 미사용 · 이 리전에서 사용 안 함', { exact: true })).toBeVisible(); await expect(page.getByText('필수 태그 누락 · 자원 1개 · 누락 CostCenter', { exact: true })).toBeVisible();
  await expect(page.getByText('EOS · EKS · Kubernetes 1.33 · 확장 지원(추가 요금)', { exact: true })).toBeVisible();
  await expect(page.getByText('EOS · Lambda · python3.8 · 지원 중단(패치 없음) · 2027-08-31', { exact: true })).toBeVisible();
  await expect(page.getByText('RDS 여유 저장공간 · 지난 1시간 1.5 GiB', { exact: true })).toBeVisible();
  await expect(page.getByText('EC2 CPU 사용률 · 지난 1시간 96.0%', { exact: true })).toBeVisible();
  await expect(page.getByText('조회 실패 · 권한 없음(IAM)', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Synthetic workload/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CPU 사용률 상위' })).toBeVisible(); await expect(page.getByRole('heading', { name: '리전 사용 현황' })).toBeVisible();
  const shots = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, 'organization-overview-synthetic.png'), fullPage: true });
  // A full-page capture briefly changes the viewport metrics, which can make AppLayout close its navigation; reopen it.
  if (await page.getByRole('button', { name: '탐색 열기' }).count()) await page.getByRole('button', { name: '탐색 열기' }).click();
  const nav = page.getByRole('navigation');
  for (const name of ['운영 리포트', 'EC2', 'EKS', 'RDS', 'ElastiCache', 'MSK', 'Serverless', 'CloudWatch 경보', 'CloudWatch 표준 지표', 'Systems Manager', '런북 실행', '수명주기(EOS)', '보안 태세', '태그 준수', 'AWS Health', '조직 계정']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Lambda', exact: true })).toHaveCount(0);
  // Every table shows account and region; the scope filter and search conditions narrow it.
  await nav.getByRole('link', { name: 'EC2', exact: true }).click();
  await expect(page.getByRole('link', { name: /^synthetic-batch/ })).toBeVisible(); await expect(page.getByRole('link', { name: /^synthetic-web/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ap-northeast-2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^리전 범위/ }).click(); await page.getByRole('option', { name: 'ap-northeast-2' }).click(); await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: /^synthetic-batch/ })).toHaveCount(0); await expect(page.getByRole('link', { name: /^synthetic-web/ })).toBeVisible();
  await page.getByRole('button', { name: '범위 초기화', exact: true }).click(); await expect(page.getByRole('link', { name: /^synthetic-batch/ })).toBeVisible();
  await page.getByRole('combobox', { name: '검색 조건' }).fill('batch'); await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /^synthetic-web/ })).toHaveCount(0); await expect(page.getByRole('link', { name: /^synthetic-batch/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: '미관리', exact: true })).toHaveCount(0);
  // Saved view: page + scope + this page's search conditions, stored as a server-side user setting.
  await page.getByRole('button', { name: '저장된 보기', exact: true }).click(); await page.getByRole('menuitem', { name: '현재 보기 저장…' }).click();
  await page.getByRole('textbox', { name: '보기 이름' }).fill('Batch EC2'); await expect(page.getByText(/저장 내용: EC2 · 계정 전체 · 리전 전체 · 검색 조건 1/)).toBeVisible();
  await page.getByRole('button', { name: '저장', exact: true }).click(); await expect(page.getByRole('button', { name: '저장된 보기 (1)' })).toBeVisible();
  await page.getByRole('button', { name: '조건 지우기', exact: true }).click(); await expect(page.getByRole('link', { name: /^synthetic-web/ })).toBeVisible();
  await nav.getByRole('link', { name: 'Serverless', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Serverless', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^synthetic-synthetic-user-a-resource/ })).toBeVisible();
  await page.getByRole('tab', { name: /^DynamoDB/ }).click(); await expect(page.getByRole('link', { name: /^synthetic-orders/ })).toBeVisible();
  await page.getByRole('tab', { name: /^API Gateway/ }).click(); await expect(page.getByRole('link', { name: /^synthetic-api/ })).toBeVisible();
  await nav.getByRole('link', { name: 'EKS', exact: true }).click(); await expect(page.getByText('확장 지원(추가 요금)', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'RDS', exact: true }).click(); await expect(page.getByRole('cell', { name: '1.5 GiB', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'MSK', exact: true }).click(); await expect(page.getByText(/Synthetic workload \(210987654321\) · ap-northeast-2: 권한 없음\(IAM\)/)).toBeVisible();
  await nav.getByRole('link', { name: 'Systems Manager', exact: true }).click();
  await page.getByRole('tab', { name: '패치 준수' }).click(); await expect(page.getByText('NON_COMPLIANT', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Automation' }).click(); await expect(page.getByText('Failed', { exact: true })).toBeVisible();
  // Runbooks: catalog only, request with a reason → approval → the requester runs it → status read back.
  await nav.getByRole('link', { name: '런북 실행', exact: true }).click(); await expect(page.getByRole('heading', { name: '허용된 런북', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: '실행 요청', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^런북/ }).click(); await page.getByRole('option', { name: /^연결 점검/ }).click();
  await page.getByRole('textbox', { name: '사유' }).fill('Synthetic permission check');
  await page.getByRole('dialog').getByRole('button', { name: '요청', exact: true }).click(); await expect(page.getByText('승인 대기', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '승인', exact: true }).click(); await expect(page.getByText('승인됨 · 실행 가능', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '실행', exact: true }).click(); await expect(page.getByText('실행 중', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '상태 확인', exact: true }).click(); await expect(page.getByText('성공', { exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'CloudWatch 표준 지표', exact: true }).click(); await expect(page.getByRole('heading', { name: 'RDS 여유 저장공간' })).toBeVisible();
  // Governance: Security Hub/GuardDuty findings with "not enabled" coverage, required-tag compliance and AWS Health (support plan aware).
  await nav.getByRole('link', { name: '보안 태세', exact: true }).click();
  await expect(page.getByRole('link', { name: /^Synthetic bucket allows public read/ })).toBeVisible(); await expect(page.getByRole('cell', { name: 'S3.2', exact: true })).toBeVisible();
  await expect(page.getByText(/^Security Hub가 활성화되지 않은 계정·리전: 1곳/)).toBeVisible();
  await page.getByRole('tab', { name: /^GuardDuty/ }).click(); await expect(page.getByRole('link', { name: /^Synthetic port probe/ })).toBeVisible(); await expect(page.getByText('HIGH', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '적용 범위' }).click(); await expect(page.getByRole('cell', { name: '사용 안 함', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: '태그 준수', exact: true }).click();
  await expect(page.getByText('50%', { exact: true })).toBeVisible(); await expect(page.getByText('CostCenter', { exact: true }).first()).toBeVisible();
  const tagDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'CSV 내보내기' }).click(); expect((await tagDownload).suggestedFilename()).toMatch(/^tag-compliance-\d{4}-\d{2}-\d{2}\.csv$/);
  await nav.getByRole('link', { name: 'AWS Health', exact: true }).click();
  await expect(page.getByText(/지원 플랜에서만 쓸 수 있습니다/)).toBeVisible(); await expect(page.getByRole('link', { name: /^AWS_EC2_SYNTHETIC_RETIREMENT_SCHEDULED/ })).toBeVisible();
  // Applying the saved view opens its page with the saved search condition again.
  await page.getByRole('button', { name: '저장된 보기 (1)' }).click(); await page.getByRole('menuitem', { name: /^Batch EC2/ }).click();
  await expect(page.getByRole('heading', { name: 'EC2', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /^synthetic-web/ })).toHaveCount(0); await expect(page.getByRole('link', { name: /^synthetic-batch/ })).toBeVisible();
  // Operations report: trend, new/resolved since the comparison point (a disappearance where the read failed stays unverified), EOS schedule, exports.
  await nav.getByRole('link', { name: '운영 리포트', exact: true }).click();
  await expect(page.getByRole('heading', { name: '운영 리포트 · 최근 7일', level: 2 })).toBeVisible(); await expect(page.getByText(/^비교 기준: /).first()).toBeVisible();
  await expect(page.getByText('확인 불가 1', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: '추이', level: 2 })).toBeVisible();
  await expect(page.getByText('Security Hub 결과 · CRITICAL 1건', { exact: true })).toBeVisible();
  await expect(page.getByText('synthetic-old-alarm', { exact: true })).toBeVisible(); await expect(page.getByText('synthetic-kafka', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '해결', exact: true })).toHaveCount(1); await expect(page.getByRole('cell', { name: '확인 불가', exact: true })).toHaveCount(1);
  await expect(page.getByText('synthetic-legacy', { exact: true })).toBeVisible();
  const reportShots = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await page.screenshot({ path: join(reportShots, 'organization-report-synthetic.png'), fullPage: true });
  if (await page.getByRole('button', { name: '탐색 열기' }).count()) await page.getByRole('button', { name: '탐색 열기' }).click();
  for (const [format, pattern] of [['Markdown (위키·이슈용)', /^operations-report-\d{4}-\d{2}-\d{2}\.md$/], ['HTML (인쇄·PDF용)', /^operations-report-\d{4}-\d{2}-\d{2}\.html$/]]) {
    const exported = page.waitForEvent('download'); await page.getByRole('button', { name: '리포트 내보내기' }).click(); await page.getByRole('menuitem', { name: format }).click();
    const file = await exported; expect(file.suggestedFilename()).toMatch(pattern);
    const text = await readFile(await file.path(), 'utf8'); expect(text).toContain('synthetic-old-alarm'); expect(text).not.toContain('<script');
  }
  await page.getByRole('button', { name: '30일', exact: true }).click(); await expect(page.getByRole('heading', { name: '운영 리포트 · 최근 30일', level: 2 })).toBeVisible();
  await nav.getByRole('link', { name: '수명주기(EOS)', exact: true }).click(); await expect(page.getByRole('heading', { name: /^수명주기\(EOS\)/, level: 2 })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Kubernetes 1.33', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'CSV 내보내기' })).toBeEnabled();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'CSV 내보내기' }).click(); expect((await download).suggestedFilename()).toMatch(/^lifecycle-eos-\d{4}-\d{2}-\d{2}\.csv$/);
  await nav.getByRole('link', { name: '조직 계정', exact: true }).click();
  await expect(page.getByText('ap-northeast-2 · VPC 1/2', { exact: true })).toBeVisible(); await expect(page.getByText('권한 없음(할당 없음)', { exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: '다시 조회', exact: true }).click(); await expect(page.getByText('Synthetic active account', { exact: true })).toBeVisible();
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
  await fetch(`${origin}/fixture/directory-denied`); await page.getByRole('button', { name: '다시 조회', exact: true }).click();
  await expect(page.getByText('계정 목록 미수집', { exact: true })).toBeVisible(); await expect(page.getByText('Synthetic active account', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Synthetic direct OU', { exact: true })).toBeVisible();
  await page.getByTestId('switch-user').click(); await expect(page.getByText('Synthetic direct OU', { exact: true })).toHaveCount(0); await expect(page.getByText('synthetic-synthetic-user-a-resource', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: accounts['synthetic-user-a'], exact: true })).toHaveCount(0);
  await choosePayer(accounts['synthetic-user-b']); await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'AWS Device Code 로그인', exact: true })).toBeEnabled();
  await fetch(`${origin}/fixture/revoke`); await openProfile(); await page.getByRole('button', { name: 'Payer 목록 새로고침', exact: true }).click();
  await expect(page.getByText('조직 접근 권한을 확인할 수 없어 계정 정보를 지웠습니다.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: /^Payer 선택/ }).first()).toContainText('허용된 Payer가 없습니다'); await expect(page.getByText(accounts['synthetic-user-b'], { exact: true })).toHaveCount(0);
  if (!(await page.getByRole('button', { name: '웹 로그아웃', exact: true }).isVisible())) await page.getByRole('button', { name: '조직 프로필 열기' }).click();
  await page.getByRole('button', { name: '웹 로그아웃', exact: true }).click(); await expect(page.getByRole('button', { name: '조직 웹 로그인', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language / 언어' }).selectOption('en'); await page.reload(); await expect(page.getByRole('button', { name: 'Sign in to organization', exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-user');
  console.log('Organization web synthetic contract passed: sign-in, payer select, one-click device code with code-carrying link, first sync and progress, saved views, operations report (trend, new/resolved, exports), runbook request/approval/run, multi-account inventory with account/region columns, scope filter, search conditions, serverless tabs, Systems Manager, security posture, tag compliance, AWS Health, tagged-VPC region usage, derived status/findings/console links, scoped directory pages/OU navigation/expiry/lifecycle/filter/partial denial, user switch, membership revocation, logout and reload.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { const directory = process.env.CLOUDOPS_SCREENSHOT_DIR ?? 'test-results/screenshots'; await mkdir(directory, { recursive: true }); await page.screenshot({ path: join(directory, 'organization-web-failure.png'), fullPage: true }); console.error(await page.locator('body').ariaSnapshot()); }
  throw error;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
