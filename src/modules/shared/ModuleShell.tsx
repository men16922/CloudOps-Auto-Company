import { useEffect, useState, type ReactNode } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ConsoleHeader from '../../components/ConsoleHeader';
import { useLanguage } from '../../i18n';
import type { Edition } from '../contracts';

export default function ModuleShell({ name, icon, edition, href, children, company = false, home }: { name: string; icon: string; edition: Edition; href: string; children: ReactNode; company?: boolean; home?: { href: string; label: string } }) {
  const { t } = useLanguage();
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 688px)').matches);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(true);
  useEffect(() => { const media = window.matchMedia('(max-width: 688px)'); const update = () => { setMobile(media.matches); setMenuOpen(false); }; media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const space = edition === 'organization' ? t('조직용', 'Organization') : t('개인용', 'Personal');
  const homeLink = home ?? { href: `#/${edition}`, label: t('모듈 선택', 'Choose module') };
  const navigation = <SideNavigation header={{ text: name, href, logo: { svg: <img className="provider-nav-icon" src={icon} alt="" /> } }} activeHref={href} onFollow={() => setMenuOpen(false)} items={[{ type: 'link', text: t('개요', 'Overview'), href }, ...(!company ? [{ type: 'divider' as const }, { type: 'link' as const, text: homeLink.label, href: homeLink.href }] : [])]} />;
  return <><ConsoleHeader id="module-header" href={href} provider={{ name, icon }} utilities={[{ type: 'button', text: `${name} · ${space}`, iconName: 'share' },
    ...(!company ? [{ type: 'button' as const, text: homeLink.label, href: homeLink.href }] : [])]} />
    <AppLayout headerSelector="#module-header" navigationHide={mobile} toolsHide contentType="dashboard" maxContentWidth={1500}
      navigationOpen={!mobile && navigationOpen} onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
      ariaLabels={{ navigation: t('모듈 탐색', 'Module navigation'), navigationToggle: t('탐색 열기', 'Open navigation'), navigationClose: t('탐색 닫기', 'Close navigation') }}
      navigation={navigation}
      breadcrumbs={<BreadcrumbGroup ariaLabel={t('현재 위치', 'Breadcrumbs')} items={[{ text: 'CloudOps Auto', href: company ? href : homeLink.href }, { text: name, href }]} />}
      content={<div className="module-content"><SpaceBetween size="m">{mobile ? <Button iconName="menu" onClick={() => setMenuOpen(true)}>{t('탐색 열기', 'Open navigation')}</Button> : null}{children}</SpaceBetween></div>} />
    <Modal visible={mobile && menuOpen} onDismiss={() => setMenuOpen(false)} header={t('모듈 탐색', 'Module navigation')} closeAriaLabel={t('탐색 닫기', 'Close navigation')}>{navigation}</Modal>
  </>;
}
