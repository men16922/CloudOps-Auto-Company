import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CloudOperationError } from '../../../../packages/contracts/errors';
import type { CloudStore, CloudTransaction } from './store';

export type AwsCredentials = Readonly<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
export type AwsCredentialProvider = () => Promise<AwsCredentials>;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 for a single non-S3 request (the already-encoded path is encoded again). No SDK; only node:crypto. */
export function signAwsRequest(input: { method: string; url: string; region: string; service: string; headers: Record<string, string>; body: string;
  credentials: AwsCredentials; date: Date }) {
  const url = new URL(input.url), amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value])), host: url.host, 'x-amz-date': amzDate };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort(), signedHeaders = names.join(';');
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)]).sort(([a, x], [b, y]) => a === b ? (x! < y! ? -1 : 1) : (a! < b! ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join('&');
  const canonical = [input.method, url.pathname.split('/').map(segment => encode(segment)).join('/') || '/', query,
    ...names.map(name => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}`), '', signedHeaders, sha256(input.body)].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Explicit server credentials from the process environment. The company host may inject a role-based provider instead. */
export function environmentCredentials(env: NodeJS.ProcessEnv = process.env): AwsCredentialProvider {
  return async () => {
    const accessKeyId = env.AWS_ACCESS_KEY_ID, secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new CloudOperationError(503, 'store_credentials_unavailable', 'Store credentials are not configured.');
    return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  };
}

const region = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/);
export const dynamoDbStoreConfigSchema = z.object({
  tableName: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  region,
  /** Default is the regional https endpoint. http is accepted only for a loopback DynamoDB Local test endpoint. */
  endpoint: z.url().refine(value => {
    const url = new URL(value);
    return url.origin === value.replace(/\/$/, '') && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)));
  }).optional(),
}).strict();
export type DynamoDbStoreConfig = z.infer<typeof dynamoDbStoreConfigSchema>;
type Item = { pk: { S: string }; version: { N: string }; payload: { S: string } };
const itemSchema = z.object({ Item: z.object({ pk: z.object({ S: z.string() }), version: z.object({ N: z.string().regex(/^\d+$/) }), payload: z.object({ S: z.string() }) }).loose().optional() }).loose();
const MAX_PAYLOAD = 350_000, MAX_ACTIONS = 100;
class DynamoDbError extends Error {
  readonly type: string; readonly status: number; readonly reasons: string[];
  constructor(type: string, status: number, reasons: string[] = []) { super(type); this.type = type; this.status = status; this.reasons = reasons; }
}

/** DynamoDB adapter for the CloudStore contract (table: string partition key `pk`).
 * Optimistic isolation: every read records `version`; commit is one TransactWriteItems where written keys are
 * conditional Puts and read-only keys are ConditionChecks, so a changed or newly created record retries the
 * callback. Multi-key read-only transactions are validated the same way. Callbacks may run repeatedly and must
 * contain only storage reads/writes. Items are limited to 350 KB of payload and 100 keys per transaction.
 */
export class DynamoDbCloudStore implements CloudStore {
  private readonly config: DynamoDbStoreConfig;
  private readonly credentials: AwsCredentialProvider;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly endpoint: string;
  constructor(config: unknown, options: { credentials: AwsCredentialProvider; fetch?: typeof fetch; now?: () => Date }) {
    this.config = dynamoDbStoreConfigSchema.parse(config); this.credentials = options.credentials;
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? (() => new Date());
    this.endpoint = this.config.endpoint?.replace(/\/$/, '') ?? `https://dynamodb.${this.config.region}.amazonaws.com`;
  }
  /** Signed DynamoDB JSON call. Exposed for trusted setup such as creating a local test table. */
  async call(target: string, body: unknown): Promise<unknown> {
    const text = JSON.stringify(body), credentials = await this.credentials();
    const headers = signAwsRequest({ method: 'POST', url: `${this.endpoint}/`, region: this.config.region, service: 'dynamodb', body: text, credentials, date: this.now(),
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${target}` } });
    delete (headers as Record<string, string>).host;
    let response: Response;
    try { response = await this.fetcher(`${this.endpoint}/`, { method: 'POST', headers, body: text, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new DynamoDbError('NetworkError', 0); }
    const raw = await response.text();
    if (raw.length > 4_000_000) throw new DynamoDbError('ResponseTooLarge', response.status);
    const value = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    if (!response.ok) {
      const type = String(value.__type ?? 'UnknownError').split('#').pop()!;
      const reasons = Array.isArray(value.CancellationReasons) ? value.CancellationReasons.map(reason => String((reason as { Code?: string }).Code ?? 'None')) : [];
      throw new DynamoDbError(type, response.status, reasons);
    }
    return value;
  }
  private key(key: string) { return { pk: { S: key } }; }
  async transact<T>(body: (transaction: CloudTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const reads = new Map<string, { version: number; value: unknown }>(), writes = new Map<string, string>();
      let writing = false;
      const result = await body({
        get: async <V>(key: string) => {
          if (writing) throw new Error('Complete transaction reads before writes.');
          if (!reads.has(key)) {
            let item: Item | undefined;
            try { item = itemSchema.parse(await this.call('GetItem', { TableName: this.config.tableName, Key: this.key(key), ConsistentRead: true })).Item as Item | undefined; }
            catch (error) { throw this.failure(error); }
            reads.set(key, { version: item ? Number(item.version.N) : 0, value: item ? JSON.parse(item.payload.S) : undefined });
          }
          return structuredClone(reads.get(key)!.value) as V | undefined;
        },
        put: (key, value) => {
          if (!reads.has(key)) throw new Error('Read a record before writing it.');
          const payload = JSON.stringify(value);
          if (!payload || Buffer.byteLength(payload) > MAX_PAYLOAD) throw new CloudOperationError(413, 'record_too_large', 'The record exceeds the storage limit.');
          writing = true; writes.set(key, payload);
        },
      });
      if (!writes.size && reads.size <= 1) return result;
      if (reads.size > MAX_ACTIONS) throw new CloudOperationError(413, 'transaction_too_large', 'The transaction touches too many records.');
      const condition = (version: number) => version === 0
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': { N: String(version) } } };
      const items = [...reads].map(([key, read]) => writes.has(key)
        ? { Put: { TableName: this.config.tableName, Item: { ...this.key(key), version: { N: String(read.version + 1) }, payload: { S: writes.get(key)! } }, ...condition(read.version) } }
        : { ConditionCheck: { TableName: this.config.tableName, Key: this.key(key), ...condition(read.version) } });
      // The same token makes a resend after a lost response idempotent for 10 minutes instead of committing twice.
      const request = { TransactItems: items, ClientRequestToken: randomUUID() };
      let committed = false, conflicted = false;
      for (let send = 0; send < 3 && !committed && !conflicted; send++) {
        try { await this.call('TransactWriteItems', request); committed = true; }
        catch (error) {
          if (error instanceof DynamoDbError && error.type === 'TransactionCanceledException'
            && error.reasons.every(reason => ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason))) conflicted = true;
          else if (!(error instanceof DynamoDbError && (error.status === 0 || error.status >= 500 || ['ThrottlingException', 'ProvisionedThroughputExceededException', 'TransactionInProgressException'].includes(error.type)))) throw this.failure(error);
        }
      }
      if (committed) return result;
      if (!conflicted) throw new CloudOperationError(503, 'store_unavailable', 'The record store did not confirm the change.');
    }
    throw new CloudOperationError(409, 'concurrent_change', 'The record changed concurrently. Refresh and retry.');
  }
  private failure(error: unknown) {
    if (error instanceof CloudOperationError) return error;
    return new CloudOperationError(503, 'store_unavailable', 'The record store is unavailable.');
  }
}
