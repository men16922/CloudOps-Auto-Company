import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Language = 'ko' | 'en';
const storageKey = 'cloudops.language';
function storedLanguage(): Language {
  try { return localStorage.getItem(storageKey) === 'en' ? 'en' : 'ko'; } catch { return 'ko'; }
}
const LanguageContext = createContext<{ language: Language; locale: string; setLanguage: (value: Language) => void; t: (ko: string, en: string) => string } | null>(null);

/** Language is presentation only; it never selects an owner, AWS profile or authorization. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, update] = useState<Language>(storedLanguage);
  const setLanguage = useCallback((value: Language) => {
    update(value);
    try { localStorage.setItem(storageKey, value); } catch { /* Storage may be disabled; this session still changes language. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey) update(event.newValue === 'en' ? 'en' : 'ko'); };
    window.addEventListener('storage', onStorage); return () => window.removeEventListener('storage', onStorage);
  }, []);
  const value = useMemo(() => ({ language, locale: language === 'ko' ? 'ko-KR' : 'en-US', setLanguage, t: (ko: string, en: string) => language === 'ko' ? ko : en }), [language, setLanguage]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('LanguageProvider is required.');
  return value;
}
export function LanguageSelector() {
  const { language, setLanguage } = useLanguage();
  return <select className="language-selector" aria-label="Language / 언어" value={language} onChange={event => setLanguage(event.target.value === 'en' ? 'en' : 'ko')}>
    <option value="ko" lang="ko">한국어</option><option value="en" lang="en">English</option>
  </select>;
}
