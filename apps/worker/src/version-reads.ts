import { z } from 'zod';
import type { connectionItemSchema } from '../../../packages/contracts/aws/connections';
import { cliFailure } from '../../../packages/worker-protocol/cli-contract';

type Item = z.infer<typeof connectionItemSchema>;
const date = z.string().max(40).nullable().optional();
const parsed = <T>(schema: z.ZodType<T>, raw: string) => { try { return schema.parse(JSON.parse(raw)); } catch { throw cliFailure('invalid_read_result'); } };

/** EKS: AWS's own version list (support status and end dates); no built-in version calendar. */
export type EksVersion = { support: 'STANDARD_SUPPORT' | 'EXTENDED_SUPPORT' | 'UNSUPPORTED'; standardEnd?: string; extendedEnd?: string };
const eksPage = z.object({ Items: z.array(z.object({ name: z.string().max(20), state: z.string().max(40).nullable().optional(), modified: date, detail: date }).strict()).max(100), HasMore: z.boolean() }).strict();
export function eksVersions(raw: string) {
  const result = new Map<string, EksVersion>();
  for (const item of parsed(eksPage, raw).Items) {
    if (item.state !== 'STANDARD_SUPPORT' && item.state !== 'EXTENDED_SUPPORT' && item.state !== 'UNSUPPORTED') continue;
    result.set(item.name, { support: item.state, ...(item.modified ? { standardEnd: item.modified } : {}), ...(item.detail ? { extendedEnd: item.detail } : {}) });
  }
  return result;
}
export function withEksSupport(item: Item, versions: ReadonlyMap<string, EksVersion>): Item {
  const version = item.version ? versions.get(item.version) : undefined;
  if (!version) return item;
  const eos = version.support === 'STANDARD_SUPPORT' ? version.standardEnd : version.support === 'EXTENDED_SUPPORT' ? version.extendedEnd : version.extendedEnd ?? version.standardEnd;
  return { ...item, support: version.support, ...(eos ? { eos } : {}) };
}

/** RDS: standard/extended support windows per engine major version (MySQL, PostgreSQL, Aurora, MariaDB). */
export type RdsLifecycle = { standardEnd?: string; extendedEnd?: string };
const rdsPage = z.object({ Items: z.array(z.object({ engine: z.string().max(40), major: z.string().max(20),
  lifecycles: z.array(z.object({ name: z.string().max(80), start: date, end: date }).strict()).max(10).nullable().optional() }).strict()).max(100), HasMore: z.boolean() }).strict();
export function rdsLifecycles(raw: string) {
  const result = new Map<string, RdsLifecycle>();
  for (const item of parsed(rdsPage, raw).Items) {
    const standard = item.lifecycles?.find(entry => entry.name.includes('standard'))?.end ?? undefined, extended = item.lifecycles?.find(entry => entry.name.includes('extended'))?.end ?? undefined;
    if (standard || extended) result.set(`${item.engine}|${item.major}`, { ...(standard ? { standardEnd: standard } : {}), ...(extended ? { extendedEnd: extended } : {}) });
  }
  return result;
}
/** "postgres 16.4" → postgres|16; "aurora-mysql 8.0.mysql_aurora.3.05.2" → aurora-mysql|8.0; "mariadb 10.11.6" → mariadb|10.11. */
export function rdsMajorKey(version: string | undefined) {
  const [engine, engineVersion] = (version ?? '').split(' ');
  if (!engine || !engineVersion) return undefined;
  const parts = engineVersion.split('.');
  return `${engine}|${engine.includes('postgres') ? parts[0] : parts.slice(0, 2).join('.')}`;
}
export function withRdsSupport(item: Item, lifecycles: ReadonlyMap<string, RdsLifecycle>, now: number): Item {
  const key = rdsMajorKey(item.version), lifecycle = key ? lifecycles.get(key) : undefined;
  if (!lifecycle) return item;
  const before = (value?: string) => value !== undefined && Date.parse(value) >= now;
  if (before(lifecycle.standardEnd)) return { ...item, support: 'STANDARD_SUPPORT', eos: lifecycle.standardEnd };
  if (before(lifecycle.extendedEnd)) return { ...item, support: 'EXTENDED_SUPPORT', eos: lifecycle.extendedEnd };
  const last = lifecycle.extendedEnd ?? lifecycle.standardEnd;
  return { ...item, support: 'UNSUPPORTED', ...(last ? { eos: last } : {}) };
}

/** MSK: Kafka version status from AWS (ACTIVE/DEPRECATED); end dates come from the documented catalog in the UI. */
const kafkaPage = z.object({ Items: z.array(z.object({ name: z.string().max(40), state: z.string().max(40).nullable().optional() }).strict()).max(100), HasMore: z.boolean() }).strict();
export function kafkaVersions(raw: string) {
  return new Map(parsed(kafkaPage, raw).Items.filter(item => item.state === 'ACTIVE' || item.state === 'DEPRECATED').map(item => [item.name, item.state as 'ACTIVE' | 'DEPRECATED']));
}
export function withKafkaStatus(item: Item, versions: ReadonlyMap<string, 'ACTIVE' | 'DEPRECATED'>): Item {
  const status = item.version ? versions.get(item.version) : undefined;
  return status ? { ...item, support: status === 'DEPRECATED' ? 'DEPRECATED' : 'STANDARD_SUPPORT' } : item;
}
