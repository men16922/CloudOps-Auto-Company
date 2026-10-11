import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeMessage, emailAddressSchema, encodeHeader, readPasswordFile, sendMail, SmtpError } from '../../../apps/host/src/notifications/smtp';

const config = { host: 'smtp.example.invalid', port: 465, security: 'tls' as const, username: 'sender@example.invalid', passwordFile: '/synthetic/password' };
const message = { from: 'sender@example.invalid', fromName: 'CloudOps Auto', to: ['ops@example.invalid'], subject: '[CloudOps Auto] 신규 조치 1 · 주의 0', text: '본문\n.\n끝', html: '<p>본문</p>' };
const code = (expected: string) => (error: unknown) => error instanceof SmtpError && error.code === expected;
const decodeWords = (value: string) => value.split(/\r\n /).map(word => /^=\?UTF-8\?B\?(.*)\?=$/.exec(word)).map(match => Buffer.from(match![1]!, 'base64').toString('utf8')).join('');

/** In-memory SMTP peer on loopback (tests only; the real client always uses TLS to the configured relay). */
async function smtpServer(options: { auth?: string; rejectPassword?: boolean; starttls?: boolean } = {}) {
  const log: string[] = []; let data = '';
  const server = createServer((socket: Socket) => {
    let buffer = '', inData = false;
    socket.on('error', () => undefined); // the client may reset the connection right after QUIT
    socket.write('220 synthetic ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (let index = buffer.indexOf('\r\n'); index >= 0; index = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) { if (line === '.') { inData = false; socket.write('250 queued\r\n'); } else data += `${line}\r\n`; continue; }
        log.push(line.startsWith('AUTH PLAIN ') ? 'AUTH PLAIN <redacted>' : line);
        if (/^EHLO /.test(line)) socket.write(`250-synthetic\r\n${options.starttls ? '250-STARTTLS\r\n' : ''}250 AUTH ${options.auth ?? 'LOGIN PLAIN'}\r\n`);
        else if (line === 'STARTTLS') socket.write('220 go ahead\r\n');
        else if (line.startsWith('AUTH PLAIN ')) socket.write(options.rejectPassword ? '535 bad credentials\r\n' : '235 ok\r\n');
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (log.at(-2) === 'AUTH LOGIN') socket.write('334 UGFzc3dvcmQ6\r\n');
        else if (log.at(-3) === 'AUTH LOGIN') socket.write(options.rejectPassword ? '535 bad credentials\r\n' : '235 ok\r\n');
        else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 send\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const open = () => new Promise<Socket>((resolve, reject) => { const socket = connect(port, '127.0.0.1', () => resolve(socket)); socket.once('error', reject); });
  return { log, data: () => data, open, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('sends one message with AUTH PLAIN, MIME base64 parts and an encoded Korean subject', async t => {
  const server = await smtpServer(); t.after(server.close);
  await sendMail(config, message, { connect: server.open, readPassword: async () => 'synthetic-app-password', now: () => new Date('2026-10-11T00:00:00Z') });
  for (let wait = 0; wait < 50 && !server.log.includes('QUIT'); wait += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(server.log.filter(line => !line.startsWith('EHLO')), ['AUTH PLAIN <redacted>', 'MAIL FROM:<sender@example.invalid>', 'RCPT TO:<ops@example.invalid>', 'DATA', 'QUIT']);
  const body = server.data(), subject = /^Subject: ((?:.*\r\n )*.*)\r\n/m.exec(body)![1]!;
  assert.equal(decodeWords(subject), message.subject);
  assert.match(body, /^Date: Sun, 11 Oct 2026 00:00:00 \+0000\r\n/m); assert.match(body, /^Auto-Submitted: auto-generated\r\n/m);
  const parts = [...body.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(match => Buffer.from(match[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'));
  assert.deepEqual(parts, [message.text, message.html], 'a body line of "." cannot end DATA early');
});

test('AUTH LOGIN fallback, STARTTLS upgrade and fixed failure codes', async t => {
  const login = await smtpServer({ auth: 'LOGIN', starttls: true }); t.after(login.close);
  let upgraded = false;
  await sendMail({ ...config, security: 'starttls', port: 587 }, message, { connect: login.open, upgrade: async socket => { upgraded = true; return socket; }, readPassword: async () => 'synthetic-app-password' });
  assert.equal(upgraded, true); assert.deepEqual(login.log.filter(line => !line.startsWith('EHLO')).slice(0, 4), ['STARTTLS', 'AUTH LOGIN', Buffer.from(config.username).toString('base64'), Buffer.from('synthetic-app-password').toString('base64')]);
  const plainOnly = await smtpServer({ auth: 'PLAIN' }); t.after(plainOnly.close);
  await assert.rejects(sendMail({ ...config, security: 'starttls' }, message, { connect: plainOnly.open, readPassword: async () => 'x' }), code('smtp_tls_failed'), 'STARTTLS is required, never plaintext AUTH');
  const rejecting = await smtpServer({ rejectPassword: true }); t.after(rejecting.close);
  await assert.rejects(sendMail(config, message, { connect: rejecting.open, readPassword: async () => 'wrong' }), code('smtp_auth_failed'));
  await assert.rejects(sendMail(config, { ...message, to: ['ops@example.invalid>\r\nRCPT TO:<x@example.invalid'] }, { connect: rejecting.open, readPassword: async () => 'x' }), code('smtp_rejected'));
});

test('addresses and headers cannot carry injected lines; the password file must be private', async t => {
  assert.equal(emailAddressSchema.safeParse('ops@example.invalid').success, true);
  for (const value of ['Ops <ops@example.invalid>', 'ops@example.invalid\r\nBcc: x@example.invalid', 'ops@localhost', 'a,b@example.invalid']) assert.equal(emailAddressSchema.safeParse(value).success, false, value);
  assert.equal(encodeHeader('a\r\nBcc: x'), 'a Bcc: x');
  assert.ok(encodeHeader('가'.repeat(40)).split('\r\n ').every(word => word.length <= 75 && decodeWords(word).length > 0));
  assert.ok(composeMessage(message, new Date(0), '00000000-0000-4000-8000-000000000000').endsWith('\r\n.\r\n'));
  const directory = await mkdtemp(join(tmpdir(), 'cloudops-smtp-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'password'); await writeFile(file, 'synthetic-app-password\n', { mode: 0o644 });
  await assert.rejects(readPasswordFile(file), code('smtp_credentials_missing'), 'group/other-readable files are refused');
  await chmod(file, 0o600); assert.equal(await readPasswordFile(file), 'synthetic-app-password');
  await assert.rejects(readPasswordFile(join(directory, 'missing')), code('smtp_credentials_missing'));
});
