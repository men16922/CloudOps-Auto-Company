import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown, { type ButtonDropdownProps } from '@cloudscape-design/components/button-dropdown';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import { useLanguage } from '../../../i18n';
import type { SavedView } from '../domain/saved-views';

type Props = { views: SavedView[]; current: string; pageTitle: (page: SavedView['view']['page']) => string;
  onApply: (view: SavedView) => void; onSave: (name: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean> };

/** Saved views are this user's server-side settings (page, scope, search conditions); applying one only changes what is shown. */
export default function SavedViews({ views, current, pageTitle, onApply, onSave, onDelete }: Props) {
  const { t, locale } = useLanguage();
  const [mode, setMode] = useState<'save' | 'manage'>(), [name, setName] = useState(''), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const describe = (view: SavedView) => { const value = view.view, conditions = Object.values(value.queries).reduce((sum, query) => sum + query.tokens.length, 0);
    return t(`${pageTitle(value.page)} · 계정 ${value.accounts.length || '전체'} · 리전 ${value.regions.length || '전체'} · 조건 ${conditions}`, `${pageTitle(value.page)} · ${value.accounts.length || 'all'} accounts · ${value.regions.length || 'all'} regions · ${conditions} conditions`); };
  const trimmed = name.trim(), replaces = views.some(view => view.view.name === trimmed);
  const close = () => { setMode(undefined); setFailed(false); setName(''); };
  const save = async () => { setPending(true); setFailed(false); const ok = await onSave(trimmed); setPending(false); if (ok) close(); else setFailed(true); };
  const remove = async (id: string) => { setPending(true); setFailed(false); const ok = await onDelete(id); setPending(false); if (!ok) setFailed(true); };
  const items: ButtonDropdownProps.Items = [
    ...(views.length ? [{ id: 'views', text: t('저장된 보기', 'Saved views'), items: views.map(view => ({ id: `apply:${view.id}`, text: view.view.name, secondaryText: describe(view) })) }] : []),
    { id: 'actions', text: t('관리', 'Manage'), items: [{ id: 'save', text: t('현재 보기 저장…', 'Save current view…'), iconName: 'add-plus' as const }, { id: 'manage', text: t('저장된 보기 관리', 'Manage saved views'), disabled: !views.length }] },
  ];
  return <>
    <ButtonDropdown items={items} onItemClick={({ detail }) => {
      if (detail.id === 'save') setMode('save'); else if (detail.id === 'manage') setMode('manage');
      else { const view = views.find(item => `apply:${item.id}` === detail.id); if (view) onApply(view); }
    }}>{views.length ? t(`저장된 보기 (${views.length})`, `Saved views (${views.length})`) : t('저장된 보기', 'Saved views')}</ButtonDropdown>
    <Modal visible={mode === 'save'} onDismiss={close} header={t('현재 보기 저장', 'Save current view')}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={close}>{t('취소', 'Cancel')}</Button>
        <Button variant="primary" loading={pending} disabled={!trimmed || trimmed.length > 60} onClick={() => void save()}>{replaces ? t('덮어쓰기', 'Replace') : t('저장', 'Save')}</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <FormField label={t('이름', 'Name')} constraintText={replaces ? t('같은 이름의 보기를 덮어씁니다.', 'Replaces the view with the same name.') : t('최대 60자', 'Up to 60 characters')}
          errorText={trimmed.length > 60 ? t('60자 이하로 입력하세요.', 'Use 60 characters or fewer.') : undefined}>
          <Input value={name} onChange={({ detail }) => setName(detail.value)} placeholder={t('예: 운영 계정 EKS 확장 지원', 'e.g. Production EKS extended support')} ariaLabel={t('보기 이름', 'View name')} />
        </FormField>
        <Box color="text-body-secondary" fontSize="body-s">{t(`저장 내용: ${current}. 조회 결과는 저장하지 않으며 서버의 사용자 설정에만 보관합니다.`, `Saves: ${current}. Results are not saved; only your settings are kept on the server.`)}</Box>
        {failed ? <Alert type="error">{t('저장하지 못했습니다. 잠시 후 다시 시도하세요.', 'The view could not be saved. Try again shortly.')}</Alert> : null}
      </SpaceBetween>
    </Modal>
    <Modal visible={mode === 'manage'} onDismiss={close} size="large" header={t('저장된 보기 관리', 'Manage saved views')} footer={<Box float="right"><Button onClick={close}>{t('닫기', 'Close')}</Button></Box>}>
      <SpaceBetween size="m">
        {failed ? <Alert type="error">{t('삭제하지 못했습니다. 잠시 후 다시 시도하세요.', 'The view could not be deleted. Try again shortly.')}</Alert> : null}
        <Table items={views} trackBy="id" variant="embedded" wrapLines empty={<Box textAlign="center" color="text-body-secondary">{t('저장된 보기가 없습니다.', 'No saved views.')}</Box>} columnDefinitions={[
          { id: 'name', header: t('이름', 'Name'), cell: view => <Button variant="inline-link" onClick={() => { onApply(view); close(); }}>{view.view.name}</Button> },
          { id: 'content', header: t('내용', 'Content'), cell: describe },
          { id: 'updated', header: t('저장 시각', 'Saved'), cell: view => new Date(view.updatedAt).toLocaleString(locale) },
          { id: 'actions', header: t('작업', 'Actions'), cell: view => <Button variant="inline-link" disabled={pending} ariaLabel={t(`${view.view.name} 삭제`, `Delete ${view.view.name}`)} onClick={() => void remove(view.id)}>{t('삭제', 'Delete')}</Button> },
        ]} />
      </SpaceBetween>
    </Modal>
  </>;
}
