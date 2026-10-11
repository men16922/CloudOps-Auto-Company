import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Pagination from '@cloudscape-design/components/pagination';
import PropertyFilter, { type PropertyFilterProps } from '@cloudscape-design/components/property-filter';
import Table, { type TableProps } from '@cloudscape-design/components/table';
import { useLanguage } from '../i18n';

export type FilterField<T> = { key: string; label: string; value: (item: T) => string | undefined };
const pageSize = 50;

/** PropertyFilter i18n shared by every resource table. */
export function usePropertyFilterStrings(): PropertyFilterProps.I18nStrings {
  const { t } = useLanguage();
  return { filteringAriaLabel: t('검색 조건', 'Search conditions'), filteringPlaceholder: t('검색 조건 추가 (예: 계정 = …, 리전 = …, 상태 = …)', 'Add a condition (e.g. account = …, region = …, state = …)'),
    dismissAriaLabel: t('닫기', 'Dismiss'), groupValuesText: t('값', 'Values'), groupPropertiesText: t('속성', 'Properties'), operatorsText: t('연산자', 'Operators'),
    operationAndText: t('그리고', 'and'), operationOrText: t('또는', 'or'), operatorEqualsText: t('같음', 'Equals'), operatorDoesNotEqualText: t('같지 않음', 'Does not equal'),
    operatorContainsText: t('포함', 'Contains'), operatorDoesNotContainText: t('포함하지 않음', 'Does not contain'), clearFiltersText: t('조건 지우기', 'Clear conditions'),
    applyActionText: t('적용', 'Apply'), cancelActionText: t('취소', 'Cancel'), editTokenHeader: t('조건 편집', 'Edit condition'), propertyText: t('속성', 'Property'),
    operatorText: t('연산자', 'Operator'), valueText: t('값', 'Value'), allPropertiesLabel: t('모든 속성', 'All properties'), tokenLimitShowMore: t('더 보기', 'Show more'),
    tokenLimitShowFewer: t('접기', 'Show fewer'), enteredTextLabel: text => t(`"${text}" 사용`, `Use: "${text}"`), removeTokenButtonAriaLabel: token => t(`조건 제거 ${token.propertyKey ?? ''} ${token.value}`, `Remove condition ${token.propertyKey ?? ''} ${token.value}`) };
}

/** Applies PropertyFilter tokens: property tokens compare one field, free text matches any field (case-insensitive). */
export function matches<T>(item: T, query: PropertyFilterProps.Query, fields: FilterField<T>[]) {
  if (!query.tokens.length) return true;
  const test = (token: PropertyFilterProps.Token) => {
    const wanted = String(token.value ?? '').toLowerCase(), values = (token.propertyKey ? fields.filter(field => field.key === token.propertyKey) : fields).map(field => (field.value(item) ?? '').toLowerCase());
    switch (token.operator) {
      case '=': return values.some(value => value === wanted);
      case '!=': return values.every(value => value !== wanted);
      case '!:': return values.every(value => !value.includes(wanted));
      default: return values.some(value => value.includes(wanted));
    }
  };
  return query.operation === 'or' ? query.tokens.some(test) : query.tokens.every(test);
}

/** CSV of the rows currently matching the search conditions (user action; generated in the browser, nothing is stored). */
export function downloadCsv<T>(name: string, rows: T[], fields: FilterField<T>[]) {
  const cell = (value: string | undefined) => { const text = (value ?? '').replace(/"/g, '""'); return /^[=+\-@\t\r]/.test(text) ? `"'${text}"` : `"${text}"`; };
  const csv = [fields.map(field => cell(field.label)).join(','), ...rows.map(row => fields.map(field => cell(field.value(row))).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })), link = document.createElement('a');
  link.href = url; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const emptyQuery: PropertyFilterProps.Query = { tokens: [], operation: 'and' };
/** A searchable, paged table of located resources (account and region columns are part of every caller's columns).
 * `query`/`onQueryChange` make the search conditions controlled (saved views); otherwise the table keeps them itself. */
export default function ResourceTable<T>({ title, description, counter, actions, items, columns, fields, trackBy, empty, header, exportName, query: controlled, onQueryChange }: {
  title: string; description?: string; counter?: string; actions?: ReactNode; items: T[]; columns: TableProps.ColumnDefinition<T>[]; fields: FilterField<T>[];
  trackBy: (item: T) => string; empty: ReactNode; header?: ReactNode; exportName?: string; query?: PropertyFilterProps.Query; onQueryChange?: (query: PropertyFilterProps.Query) => void;
}) {
  const { t } = useLanguage(), strings = usePropertyFilterStrings();
  const [own, setOwn] = useState<PropertyFilterProps.Query>(emptyQuery);
  const query = controlled ?? own, setQuery = onQueryChange ?? setOwn;
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => items.filter(item => matches(item, query, fields)), [items, query, fields]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  useEffect(() => { setPage(1); }, [query, items]);
  const options = useMemo(() => fields.flatMap(field => [...new Set(items.map(field.value).filter((value): value is string => Boolean(value)))].slice(0, 200).map(value => ({ propertyKey: field.key, value }))), [items, fields]);
  return <Table variant="container" wrapLines items={filtered.slice((page - 1) * pageSize, page * pageSize)} trackBy={trackBy} columnDefinitions={columns} empty={empty}
    header={<Header variant="h2" counter={counter ?? `(${items.length})`} description={description} actions={<>{actions}{exportName ? <Button iconName="download" disabled={!filtered.length} onClick={() => downloadCsv(exportName, filtered, fields)}>{t('CSV 내보내기', 'Export CSV')}</Button> : null}</>}>{title}</Header>}
    filter={<div>{header}<PropertyFilter query={query} onChange={({ detail }) => setQuery(detail)} i18nStrings={strings} expandToViewport
      filteringProperties={fields.map(field => ({ key: field.key, propertyLabel: field.label, groupValuesLabel: t(`${field.label} 값`, `${field.label} values`), operators: ['=', '!=', ':', '!:'] }))}
      filteringOptions={options} countText={t(`${filtered.length}개 일치`, `${filtered.length} matches`)} /></div>}
    pagination={<Pagination currentPageIndex={page} pagesCount={pages} onChange={({ detail }) => setPage(detail.currentPageIndex)}
      ariaLabels={{ nextPageLabel: t('다음 페이지', 'Next page'), previousPageLabel: t('이전 페이지', 'Previous page'), pageLabel: number => t(`${number} 페이지`, `Page ${number}`) }} />} />;
}
