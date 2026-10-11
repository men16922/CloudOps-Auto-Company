import type { ReportSnapshot, SnapshotFinding } from '../domain/report';

type Severity = SnapshotFinding['severity'];
type Counts = Record<Severity, number>;
export type ReportScope = { accounts: readonly string[]; regions: readonly string[] };
export type ResolvedFinding = SnapshotFinding & { verified: boolean };
export type ReportComparison = {
  latest: ReportSnapshot; baseline?: ReportSnapshot;
  /** The history is shorter than the period: the comparison starts at the oldest snapshot instead. */
  baselineShort: boolean; periodDays: number;
  trend: Array<{ at: string; counts: Counts; partial: boolean }>;
  current: Counts; previous?: Counts;
  /** Action/attention items that appeared or disappeared since the baseline (informational items are excluded). */
  added: SnapshotFinding[]; resolved: ResolvedFinding[]; persisting: number;
  /** Counts under a scope come from the stored findings; a truncated snapshot makes them a lower bound. */
  approximate: boolean;
};
const day = 86_400_000;

/** Same scope rule as the dashboard: AWS Health is account-wide, so it ignores the region scope. Organization-wide items stay in. */
export function inReportScope(finding: SnapshotFinding, scope: ReportScope) {
  return (!scope.accounts.length || !finding.accountId || scope.accounts.includes(finding.accountId))
    && (!scope.regions.length || !finding.region || finding.kind === 'health' || scope.regions.includes(finding.region));
}
const count = (findings: readonly SnapshotFinding[]): Counts => {
  const value: Counts = { critical: 0, warning: 0, info: 0 }; findings.forEach(item => { value[item.severity] += 1; }); return value;
};

/** A disappeared item counts as resolved only if this sync could still see that place: complete findings, a verified account
 * and no read failure for that service/account/region. Shared by the report and e-mail alerts. */
export function resolvedVisibility(latest: ReportSnapshot) {
  const failed = new Set(latest.findings.filter(item => item.kind === 'read-failed').map(item => `${item.subject}|${item.accountId}|${item.region}`));
  return (item: Pick<SnapshotFinding, 'source' | 'accountId' | 'region'>) => !latest.truncated && (!item.accountId || latest.verified.includes(item.accountId)) && !failed.has(`${item.source}|${item.accountId}|${item.region}`);
}

/** Compares the latest finished sync with the last one at or before the period start. Read failures never count as resolved. */
export function compareSnapshots(snapshots: readonly ReportSnapshot[], periodDays: number, scope: ReportScope): ReportComparison | undefined {
  const sorted = [...snapshots].sort((a, b) => a.at.localeCompare(b.at)), latest = sorted.at(-1);
  if (!latest) return undefined;
  const scoped = Boolean(scope.accounts.length || scope.regions.length);
  const findings = (snapshot: ReportSnapshot) => scoped ? snapshot.findings.filter(item => inReportScope(item, scope)) : snapshot.findings;
  const counts = (snapshot: ReportSnapshot) => scoped ? count(findings(snapshot)) : snapshot.counts;
  const start = Date.parse(latest.at) - periodDays * day, older = sorted.slice(0, -1);
  const atStart = older.filter(item => Date.parse(item.at) <= start).at(-1), baseline = atStart ?? older[0];
  const trend = sorted.filter(item => Date.parse(item.at) >= start || item === baseline).map(item => ({ at: item.at, counts: counts(item), partial: item.state === 'partial' }));
  const attention = (snapshot: ReportSnapshot) => new Map(findings(snapshot).filter(item => item.severity !== 'info').map(item => [item.id, item]));
  const now = attention(latest), before = baseline ? attention(baseline) : new Map<string, SnapshotFinding>();
  const visible = resolvedVisibility(latest);
  return {
    latest, ...(baseline ? { baseline, previous: counts(baseline) } : {}), baselineShort: Boolean(baseline && !atStart), periodDays, trend, current: counts(latest),
    added: baseline ? [...now.values()].filter(item => !before.has(item.id)) : [],
    resolved: [...before.values()].filter(item => !now.has(item.id)).map(item => ({ ...item, verified: visible(item) })),
    persisting: [...now.keys()].filter(id => before.has(id)).length,
    approximate: scoped && (latest.truncated || Boolean(baseline?.truncated)),
  };
}

/** A printable/pasteable report assembled by the dashboard in the viewer's language. */
export type ReportDocument = { title: string; subtitle: string[]; summary: Array<[string, string]>; sections: Array<{ title: string; note?: string; header: string[]; rows: string[][] }>; notes: string[] };

const markdownCell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/^([#>*+-])/, '\\$1');
/** Markdown (wiki/issue paste). Every value is escaped; nothing is interpreted as markup. */
export function reportMarkdown(document: ReportDocument) {
  const table = (header: string[], rows: string[][]) => [`| ${header.map(markdownCell).join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(markdownCell).join(' | ')} |`)].join('\n');
  return [`# ${markdownCell(document.title)}`, '', ...document.subtitle.map(line => `- ${markdownCell(line)}`), '', ...document.summary.map(([label, value]) => `- **${markdownCell(label)}**: ${markdownCell(value)}`), '',
    ...document.sections.flatMap(section => [`## ${markdownCell(section.title)}`, '', ...(section.note ? [markdownCell(section.note), ''] : []), section.rows.length ? table(section.header, section.rows) : '—', '']),
    ...(document.notes.length ? ['---', '', ...document.notes.map(note => `- ${markdownCell(note)}`), ''] : [])].join('\n');
}

const html = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Self-contained HTML for printing or saving as PDF: no scripts, no external resources, every value escaped. */
export function reportHtml(document: ReportDocument, lang: string) {
  const table = (header: string[], rows: string[][]) => `<table><thead><tr>${header.map(cell => `<th>${html(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${html(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html><html lang="${html(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${html(document.title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#16191f;background:#fff;margin:32px auto;max-width:960px;padding:0 16px}h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px;border-bottom:1px solid #d1d5db;padding-bottom:4px}
ul{color:#5f6b7a;padding-left:18px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}.summary td:first-child{width:40%;color:#5f6b7a}
p.note{color:#5f6b7a;margin:4px 0}@media print{body{margin:0}h2{break-after:avoid}tr{break-inside:avoid}}</style></head><body>
<h1>${html(document.title)}</h1><ul>${document.subtitle.map(line => `<li>${html(line)}</li>`).join('')}</ul>
<table class="summary"><tbody>${document.summary.map(([label, value]) => `<tr><td>${html(label)}</td><td>${html(value)}</td></tr>`).join('')}</tbody></table>
${document.sections.map(section => `<h2>${html(section.title)}</h2>${section.note ? `<p class="note">${html(section.note)}</p>` : ''}${section.rows.length ? table(section.header, section.rows) : '<p class="note">—</p>'}`).join('\n')}
${document.notes.length ? `<hr><ul>${document.notes.map(note => `<li>${html(note)}</li>`).join('')}</ul>` : ''}
</body></html>`;
}

/** User-initiated file download generated in the browser (nothing is stored or sent). */
export function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
