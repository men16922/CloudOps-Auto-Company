import TopNavigation, { type TopNavigationProps } from '@cloudscape-design/components/top-navigation';
import { LanguageSelector, useLanguage } from '../i18n';

/** A fixed brand region avoids TopNavigation's responsive title truncation. */
export default function ConsoleHeader({ id, href, utilities, provider }: { id: string; href: string; utilities: TopNavigationProps['utilities']; provider?: { name: string; icon: string } }) {
  const { t } = useLanguage();
  return <div id={id} className="console-topbar">
    <nav className="console-brand-group" aria-label={t('제품 홈', 'Product home')}>
    <a href={href} className="console-brand" aria-label={t('CloudOps Auto 홈', 'CloudOps Auto home')}><img src="/cloudops-mark.svg" alt="" /><span>CloudOps Auto</span></a>
    {provider ? <span className="console-provider" title={provider.name}><img src={provider.icon} alt={provider.name} /></span> : null}
    </nav>
    <div className="console-utilities"><TopNavigation visualContext="top-navigation" utilities={utilities} i18nStrings={{ overflowMenuTriggerText: t('메뉴', 'Menu'), overflowMenuTitleText: t('콘솔 도구', 'Console tools'), overflowMenuDismissIconAriaLabel: t('콘솔 도구 닫기', 'Close console tools') }} /></div>
    {/* Module pages may portal their current context (e.g. the signed-in payer) here, left of the language selector. */}
    <div id="console-context-slot" className="console-context-slot" />
    <form className="console-language" aria-label={t('표시 언어 설정', 'Display language settings')} onSubmit={event => event.preventDefault()}><LanguageSelector /></form>
  </div>;
}
