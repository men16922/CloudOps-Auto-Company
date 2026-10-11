import type { Located, Service, ServiceData } from './operations-assessment';

/** Documented lifecycle dates (vendor/AWS documentation), captured on this date. AWS may change them; API data wins where available. */
export const lifecycleCapturedAt = '2026-10-11';
type RuntimeDates = { deprecation: string; blockCreate?: string; blockUpdate?: string };
const r = (deprecation: string, blockCreate?: string, blockUpdate?: string): RuntimeDates => ({ deprecation, ...(blockCreate ? { blockCreate } : {}), ...(blockUpdate ? { blockUpdate } : {}) });
const many = (names: string[], dates: RuntimeDates) => Object.fromEntries(names.map(name => [name, dates]));
/** AWS Lambda runtimes page: deprecation / block function create / block function update. */
export const lambdaRuntimes: Record<string, RuntimeDates> = {
  'provided.al2': r('2026-07-31', '2027-07-29', '2027-08-31'),
  ...many(['nodejs20.x'], r('2026-04-30', '2027-07-29', '2027-08-31')), ...many(['ruby3.2'], r('2026-03-31', '2027-07-29', '2027-08-31')),
  ...many(['python3.9'], r('2025-12-15', '2027-07-29', '2027-08-31')), ...many(['nodejs18.x'], r('2025-09-01', '2027-07-29', '2027-08-31')),
  ...many(['dotnet6'], r('2024-12-20', '2027-07-29', '2027-08-31')), ...many(['python3.8'], r('2024-10-14', '2027-07-29', '2027-08-31')),
  ...many(['nodejs16.x'], r('2024-06-12', '2027-07-29', '2027-08-31')), ...many(['java8', 'go1.x', 'provided'], r('2024-01-08', '2024-02-08', '2027-08-31')),
  ...many(['ruby2.7'], r('2023-12-07', '2024-01-09', '2027-08-31')), ...many(['nodejs14.x', 'python3.7'], r('2023-12-04', '2024-01-09', '2027-08-31')),
  'dotnetcore3.1': r('2023-04-03', '2023-04-03', '2023-05-03'), 'nodejs12.x': r('2023-03-31', '2023-03-31', '2023-04-30'),
  'python3.6': r('2022-07-18', '2022-07-18', '2022-08-29'), 'dotnetcore2.1': r('2022-01-05', '2022-01-05', '2022-04-13'), 'nodejs10.x': r('2021-07-30', '2021-07-30', '2022-02-14'),
  'ruby2.5': r('2021-07-30', '2021-07-30', '2022-03-31'), 'python2.7': r('2021-07-15', '2021-07-15', '2022-05-30'), dotnet7: r('2024-05-14'), 'dotnet5.0': r('2022-05-10'),
  'python3.10': r('2026-10-31', '2027-07-29', '2027-08-31'), dotnet8: r('2026-11-10', '2027-07-29', '2027-08-31'), dotnet9: r('2026-11-10'),
  'ruby3.3': r('2027-03-31', '2027-07-29', '2027-08-31'), 'nodejs22.x': r('2027-04-30', '2027-06-01', '2027-07-01'),
  ...many(['python3.11', 'java17', 'java11', 'java8.al2'], r('2027-06-30', '2027-07-29', '2027-08-31')), 'ruby3.4': r('2028-03-31', '2028-04-30', '2028-05-31'),
  'nodejs24.x': r('2028-04-30', '2028-06-01', '2028-07-01'), 'python3.12': r('2028-10-31', '2028-11-30', '2029-01-10'), dotnet10: r('2028-11-14', '2028-12-14', '2029-01-15'),
  'ruby4.0': r('2029-03-31', '2029-04-30', '2029-05-31'),
  ...many(['python3.13', 'python3.14', 'java21', 'java25', 'java8.al2023', 'java11.al2023', 'java17.al2023', 'provided.al2023'], r('2029-06-30', '2029-07-31', '2029-08-31')),
};
/** ElastiCache for Redis OSS: end of standard support and of paid Extended Support (EOL). */
const redis: Record<string, { standardEnd: string; extendedEnd?: string }> = { '2': { standardEnd: '2023-01-13' }, '3': { standardEnd: '2023-07-31' }, '4': { standardEnd: '2026-01-31', extendedEnd: '2029-01-31' },
  '5': { standardEnd: '2026-01-31', extendedEnd: '2029-01-31' }, '6': { standardEnd: '2027-01-31', extendedEnd: '2030-01-31' } };
/** Amazon MSK supported versions page: end of support (3.8 and later had no date when captured; older versions rely on the API's DEPRECATED status). */
const kafka: Array<[RegExp, string]> = [[/^3\.4\.0$/, '2025-08-04'], [/^3\.5\.1$/, '2025-10-23'], [/^3\.6\.0$/, '2026-06-01'], [/^3\.7\./, '2026-09-01']];
/** Operating system end of (standard/maintenance) support from vendor lifecycle pages, matched on SSM platform name/version. */
const operatingSystems: Array<{ label: string; test: (name: string, version: string) => boolean; end: string }> = [
  { label: 'Amazon Linux 2', test: (name, version) => /amazon linux/i.test(name) && /^2(\.|$)/.test(version) && !/^2023/.test(version), end: '2026-06-30' },
  { label: 'Amazon Linux 2023', test: (name, version) => /amazon linux/i.test(name) && /^2023/.test(version), end: '2027-06-30' },
  ...[['18.04', '2023-05-31'], ['20.04', '2025-05-31'], ['22.04', '2027-05-31'], ['24.04', '2029-05-31']].map(([version, end]) => ({ label: `Ubuntu ${version}`, test: (name: string, value: string) => /ubuntu/i.test(name) && value.startsWith(version!), end: end! })),
  ...[['7', '2024-06-30'], ['8', '2029-05-31'], ['9', '2032-05-31']].map(([major, end]) => ({ label: `RHEL ${major}`, test: (name: string, value: string) => /red hat/i.test(name) && value.split('.')[0] === major, end: end! })),
  { label: 'CentOS 7', test: (name, version) => /centos/i.test(name) && version.split('.')[0] === '7', end: '2024-06-30' },
  ...[['2012 R2', '2023-10-10'], ['2016', '2027-01-12'], ['2019', '2029-01-09'], ['2022', '2031-10-14'], ['2025', '2034-11-14']].map(([release, end]) => ({ label: `Windows Server ${release}`,
    test: (name: string) => /windows server/i.test(name) && name.includes(release!) && (release !== '2012 R2' || /2012 R2/i.test(name)), end: end! })),
];

export type EosStatus = 'ended' | 'extended' | 'deprecated' | 'upcoming' | 'supported' | 'unknown';
export type EosRow = Located & { service: Service; component: 'EKS' | 'RDS' | 'ElastiCache' | 'MSK' | 'Lambda' | 'OS'; current: string; status: EosStatus; date?: string; daysLeft?: number; basis: 'api' | 'docs' };
const day = 86_400_000;
const days = (value: string | undefined, now: number) => value === undefined ? undefined : Math.ceil((Date.parse(value.length === 10 ? `${value}T23:59:59Z` : value) - now) / day);
/** Upcoming ends within this window are reported (30 days or less: attention). */
export const upcomingWindowDays = 90;

/** Support state of every collected component with a known lifecycle. Unknown stays unknown (never presumed supported). */
export function lifecycleRows(data: Partial<Record<Service, ServiceData>>, now = Date.now()): EosRow[] {
  const rows: EosRow[] = [];
  const add = (item: Located, service: Service, component: EosRow['component'], current: string, status: EosStatus, basis: EosRow['basis'], date?: string) =>
    rows.push({ ...item, service, component, current, status, basis, ...(date ? { date, daysLeft: days(date, now) } : {}) });
  const dated = (end: string | undefined) => { const left = days(end, now); return left === undefined ? 'supported' as const : left < 0 ? 'ended' as const : left <= upcomingWindowDays ? 'upcoming' as const : 'supported' as const; };
  for (const item of data.eks?.items ?? []) {
    const current = item.version ? `Kubernetes ${item.version}` : 'Kubernetes ?';
    if (item.support === 'UNSUPPORTED') add(item, 'eks', 'EKS', current, 'ended', 'api', item.eos);
    else if (item.support === 'EXTENDED_SUPPORT') add(item, 'eks', 'EKS', current, 'extended', 'api', item.eos);
    else if (item.support === 'STANDARD_SUPPORT') add(item, 'eks', 'EKS', current, dated(item.eos) === 'upcoming' ? 'upcoming' : 'supported', 'api', item.eos);
    else add(item, 'eks', 'EKS', current, 'unknown', 'api');
  }
  for (const item of data.rds?.items ?? []) {
    const current = item.version ?? '?';
    if (item.support === 'UNSUPPORTED') add(item, 'rds', 'RDS', current, 'ended', 'api', item.eos);
    else if (item.support === 'EXTENDED_SUPPORT') add(item, 'rds', 'RDS', current, 'extended', 'api', item.eos);
    else if (item.support === 'STANDARD_SUPPORT') add(item, 'rds', 'RDS', current, dated(item.eos) === 'upcoming' ? 'upcoming' : 'supported', 'api', item.eos);
    else add(item, 'rds', 'RDS', current, 'unknown', 'api');
  }
  for (const item of data.lambda?.items ?? []) {
    if (!item.runtime) continue; // container images carry their own runtime
    const dates = lambdaRuntimes[item.runtime];
    if (!dates) { add(item, 'lambda', 'Lambda', item.runtime, 'unknown', 'docs'); continue; }
    const deprecated = (days(dates.deprecation, now) ?? 1) < 0, updateBlocked = dates.blockUpdate !== undefined && (days(dates.blockUpdate, now) ?? 1) < 0;
    if (updateBlocked) add(item, 'lambda', 'Lambda', item.runtime, 'ended', 'docs', dates.blockUpdate);
    else if (deprecated) add(item, 'lambda', 'Lambda', item.runtime, 'deprecated', 'docs', dates.blockUpdate ?? dates.blockCreate ?? dates.deprecation);
    else add(item, 'lambda', 'Lambda', item.runtime, dated(dates.deprecation), 'docs', dates.deprecation);
  }
  for (const item of data.elasticache?.items ?? []) {
    const [engine, version] = (item.version ?? '').split(' ');
    if (engine !== 'redis' || !version) { add(item, 'elasticache', 'ElastiCache', item.version ?? '?', 'unknown', 'docs'); continue; }
    const entry = redis[version.split('.')[0]!];
    if (!entry) { add(item, 'elasticache', 'ElastiCache', item.version!, 'unknown', 'docs'); continue; }
    const standard = days(entry.standardEnd, now)!;
    if (standard >= 0) add(item, 'elasticache', 'ElastiCache', item.version!, dated(entry.standardEnd), 'docs', entry.standardEnd);
    else if (entry.extendedEnd && days(entry.extendedEnd, now)! >= 0) add(item, 'elasticache', 'ElastiCache', item.version!, 'extended', 'docs', entry.extendedEnd);
    else add(item, 'elasticache', 'ElastiCache', item.version!, 'ended', 'docs', entry.extendedEnd ?? entry.standardEnd);
  }
  for (const item of data.msk?.items ?? []) {
    const version = item.version; if (!version) { add(item, 'msk', 'MSK', 'Kafka ?', 'unknown', 'docs'); continue; }
    const end = kafka.find(([pattern]) => pattern.test(version))?.[1], status = dated(end);
    if (status === 'ended') add(item, 'msk', 'MSK', `Kafka ${version}`, 'ended', 'docs', end);
    else if (item.support === 'DEPRECATED') add(item, 'msk', 'MSK', `Kafka ${version}`, 'deprecated', 'api', end);
    else if (end) add(item, 'msk', 'MSK', `Kafka ${version}`, status, 'docs', end);
    else add(item, 'msk', 'MSK', `Kafka ${version}`, item.support === 'STANDARD_SUPPORT' ? 'supported' : 'unknown', 'api');
  }
  for (const item of data.ssm?.items ?? []) {
    const name = item.version ?? '', version = item.detail ?? '', os = operatingSystems.find(entry => entry.test(name, version));
    const current = [name, version].filter(Boolean).join(' ') || item.type || '?';
    if (os) add(item, 'ssm', 'OS', current, dated(os.end), 'docs', os.end); else add(item, 'ssm', 'OS', current, 'unknown', 'docs');
  }
  const order: Record<EosStatus, number> = { ended: 0, extended: 1, deprecated: 2, upcoming: 3, unknown: 4, supported: 5 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || (a.daysLeft ?? 99_999) - (b.daysLeft ?? 99_999) || a.name.localeCompare(b.name));
}

/** Lambda runtime lifecycle state on its own (used for table cells). */
export function lambdaRuntimeStatus(runtime: string | null | undefined, now = Date.now()): EosStatus | undefined {
  if (!runtime) return undefined;
  const dates = lambdaRuntimes[runtime];
  if (!dates) return 'unknown';
  if (dates.blockUpdate && (days(dates.blockUpdate, now) ?? 1) < 0) return 'ended';
  if ((days(dates.deprecation, now) ?? 1) < 0) return 'deprecated';
  return (days(dates.deprecation, now) ?? 999) <= upcomingWindowDays ? 'upcoming' : 'supported';
}
