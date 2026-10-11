import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { hostname } from 'node:os';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { z } from 'zod';

const label = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
/** Plain addr-spec only (no display names, comments or quoted parts), so nothing can be injected into a header or SMTP command. */
export const emailAddressSchema = z.string().max(254).regex(new RegExp(`^[A-Za-z0-9.!#$%&'*+/=?^_\`{|}~-]{1,64}@${label}(?:\\.${label})+$`));
/** Company relay or mailbox provider. TLS is always used (implicit TLS or STARTTLS) with certificate verification; the password
 * stays in a host file readable only by the host user and is read at send time. */
export const smtpConfigSchema = z.object({
  host: z.string().regex(new RegExp(`^${label}(?:\\.${label})+$`)), port: z.number().int().min(1).max(65535), security: z.enum(['tls', 'starttls']),
  username: z.string().min(1).max(256).regex(/^[^\r\n\0]+$/), passwordFile: z.string().regex(/^\/[^\0\r\n]{1,1023}$/),
}).strict();
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;
export type MailMessage = { from: string; fromName: string; to: string[]; subject: string; text: string; html: string };
export type SmtpFailure = 'smtp_credentials_missing' | 'smtp_connect_failed' | 'smtp_tls_failed' | 'smtp_auth_failed' | 'smtp_rejected' | 'smtp_timeout';
/** Carries only a fixed code: server replies, addresses and credentials never reach logs or the browser. */
export class SmtpError extends Error {
  readonly code: SmtpFailure;
  constructor(code: SmtpFailure) { super(code); this.code = code; }
}
type Reply = { code: number; lines: string[] };
export type SmtpOptions = {
  timeoutMs?: number; now?: () => Date;
  /** Tests inject an in-memory server here; the default opens TLS (or TCP for STARTTLS) to the configured host. */
  connect?: (config: SmtpConfig) => Promise<Duplex>; upgrade?: (socket: Duplex, host: string) => Promise<Duplex>; readPassword?: () => Promise<string>;
};

/** The file must be a small regular file without group/other access. Surrounding whitespace is removed. */
export async function readPasswordFile(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024) throw new Error('unsafe');
    const value = (await readFile(path, 'utf8')).trim();
    if (!value || /[\r\n\0]/.test(value)) throw new Error('empty');
    return value;
  } catch { throw new SmtpError('smtp_credentials_missing'); }
}

function opened<T extends Duplex>(socket: T, event: 'connect' | 'secureConnect', failure: SmtpFailure) {
  return new Promise<T>((resolve, reject) => {
    const fail = () => { socket.destroy(); reject(new SmtpError(failure)); };
    socket.once(event, () => { socket.off('error', fail); resolve(socket); }); socket.once('error', fail);
  });
}
const defaultConnect = (config: SmtpConfig): Promise<Duplex> => config.security === 'tls'
  ? opened(tlsConnect({ host: config.host, port: config.port, servername: config.host, minVersion: 'TLSv1.2' }), 'secureConnect', 'smtp_tls_failed')
  : opened(netConnect({ host: config.host, port: config.port }), 'connect', 'smtp_connect_failed');
const defaultUpgrade = (socket: Duplex, host: string): Promise<Duplex> => opened(tlsConnect({ socket: socket as import('node:net').Socket, servername: host, minVersion: 'TLSv1.2' }), 'secureConnect', 'smtp_tls_failed');

/** Multi-line SMTP replies from one socket; detached before a STARTTLS upgrade. */
function replies(socket: Duplex) {
  let buffer = '', lines: string[] = [], failure: SmtpError | undefined;
  const ready: Reply[] = [], waiting: Array<{ resolve: (reply: Reply) => void; reject: (error: Error) => void }> = [];
  const fail = (error: SmtpError) => { failure ??= error; waiting.splice(0).forEach(item => item.reject(failure!)); };
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, ''), match = /^(\d{3})([ -])(.*)$/.exec(line); buffer = buffer.slice(index + 1);
      if (!match || lines.length > 100) { fail(new SmtpError('smtp_rejected')); return; }
      lines.push(match[3]!);
      if (match[2] === ' ') { const reply = { code: Number(match[1]), lines }; lines = []; const next = waiting.shift(); if (next) next.resolve(reply); else ready.push(reply); }
    }
    if (buffer.length > 8192) fail(new SmtpError('smtp_rejected'));
  };
  const onEnd = () => fail(new SmtpError('smtp_connect_failed'));
  socket.on('data', onData); socket.on('error', onEnd); socket.on('close', onEnd);
  return {
    next: () => new Promise<Reply>((resolve, reject) => { const reply = ready.shift(); if (reply) resolve(reply); else if (failure) reject(failure); else waiting.push({ resolve, reject }); }),
    detach: () => { socket.off('data', onData); socket.off('error', onEnd); socket.off('close', onEnd); },
  };
}

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const wrap = (value: string) => value.replace(/.{1,76}/g, line => `${line}\r\n`).trimEnd();
/** RFC 2047 encoded words of at most 45 UTF-8 bytes each, never splitting a character; plain ASCII stays readable. */
export function encodeHeader(value: string) {
  const clean = value.replace(/[\r\n\0]+/g, ' ').slice(0, 500);
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 900) return clean;
  const words: string[] = []; let current = '';
  for (const character of clean) {
    if (Buffer.byteLength(current + character) > 45) { words.push(current); current = ''; }
    current += character;
  }
  if (current) words.push(current);
  return words.map(word => `=?UTF-8?B?${base64(word)}?=`).join('\r\n ');
}
/** multipart/alternative with base64 parts: no line can start with '.', so the DATA terminator cannot appear inside the body. */
export function composeMessage(message: MailMessage, now: Date, id = randomUUID()) {
  const boundary = `cloudops-${id}`, domain = message.from.split('@')[1]!;
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap(base64(body))].join('\r\n');
  return [`From: ${encodeHeader(message.fromName)} <${message.from}>`, `To: ${message.to.join(', ')}`, `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString().replace(/GMT$/, '+0000')}`, `Message-ID: <${id}@${domain}>`, 'MIME-Version: 1.0', 'Auto-Submitted: auto-generated', 'X-Auto-Response-Suppress: All',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '', part('text/plain', message.text), part('text/html', message.html), `--${boundary}--`, '.', ''].join('\r\n');
}

/** One message per connection: EHLO, optional STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT. Any unexpected reply aborts with a fixed code. */
export async function sendMail(input: SmtpConfig, message: MailMessage, options: SmtpOptions = {}) {
  const config = smtpConfigSchema.parse(input);
  if (!emailAddressSchema.safeParse(message.from).success || !message.to.length || message.to.some(to => !emailAddressSchema.safeParse(to).success)) throw new SmtpError('smtp_rejected');
  const password = await (options.readPassword ?? (() => readPasswordFile(config.passwordFile)))();
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const bounded = <T>(value: Promise<T>, failure: SmtpFailure = 'smtp_timeout') => new Promise<T>((resolve, reject) => {
    if (deadline.aborted) { reject(new SmtpError('smtp_timeout')); return; }
    const abort = () => reject(new SmtpError('smtp_timeout')); deadline.addEventListener('abort', abort, { once: true });
    value.then(result => { deadline.removeEventListener('abort', abort); resolve(result); },
      error => { deadline.removeEventListener('abort', abort); reject(error instanceof SmtpError ? error : new SmtpError(failure)); });
  });
  let socket = await bounded((options.connect ?? defaultConnect)(config), 'smtp_connect_failed');
  const name = hostname().replace(/[^A-Za-z0-9.-]/g, '').slice(0, 63) || 'localhost';
  try {
    let reader = replies(socket);
    const expect = async (codes: number[], failure: SmtpFailure) => { const reply = await bounded(reader.next()); if (!codes.includes(reply.code)) throw new SmtpError(failure); return reply; };
    const command = (line: string, codes: number[], failure: SmtpFailure) => { socket.write(`${line}\r\n`); return expect(codes, failure); };
    await expect([220], 'smtp_connect_failed');
    let hello = await command(`EHLO ${name}`, [250], 'smtp_rejected');
    if (config.security === 'starttls') {
      if (!hello.lines.some(line => /^STARTTLS\b/i.test(line))) throw new SmtpError('smtp_tls_failed');
      await command('STARTTLS', [220], 'smtp_tls_failed');
      reader.detach(); socket = await bounded((options.upgrade ?? defaultUpgrade)(socket, config.host), 'smtp_tls_failed'); reader = replies(socket);
      hello = await command(`EHLO ${name}`, [250], 'smtp_rejected');
    }
    const methods = hello.lines.find(line => /^AUTH[ =]/i.test(line))?.toUpperCase().split(/[ =]+/).slice(1) ?? [];
    if (methods.includes('PLAIN')) await command(`AUTH PLAIN ${base64(`\0${config.username}\0${password}`)}`, [235], 'smtp_auth_failed');
    else if (methods.includes('LOGIN')) {
      await command('AUTH LOGIN', [334], 'smtp_auth_failed'); await command(base64(config.username), [334], 'smtp_auth_failed'); await command(base64(password), [235], 'smtp_auth_failed');
    } else throw new SmtpError('smtp_auth_failed');
    await command(`MAIL FROM:<${message.from}>`, [250], 'smtp_rejected');
    for (const to of message.to) await command(`RCPT TO:<${to}>`, [250, 251], 'smtp_rejected');
    await command('DATA', [354], 'smtp_rejected');
    socket.write(composeMessage(message, (options.now ?? (() => new Date()))()));
    await expect([250], 'smtp_rejected');
    // The message is accepted at this point; QUIT is flushed best-effort before the socket closes.
    await bounded(new Promise<void>(resolve => { socket.end('QUIT\r\n', () => resolve()); })).catch(() => undefined);
  } finally { socket.destroy(); }
}
