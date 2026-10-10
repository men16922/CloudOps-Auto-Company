import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { webConfigurationSchema, type WebConfiguration, type WebScope } from './web-config';
import type { WebIdentityClient } from './web-identity';

/** Resolves null when this build has no client for the configured identity method (stays unconfigured). */
export type WebIdentityFactory = (configuration: Extract<WebConfiguration, { configured: true }>['identity']) => Promise<WebIdentityClient | null>;
const FactoryContext = createContext<WebIdentityFactory | undefined>(undefined);
export const useWebIdentityFactory = () => useContext(FactoryContext);
export function WebIdentityFactoryProvider({ factory, children }: { factory: WebIdentityFactory; children: ReactNode }) {
  return <FactoryContext.Provider value={factory}>{children}</FactoryContext.Provider>;
}
type Access = { state: 'loading' | 'unconfigured' | 'failed' } | { state: 'ready'; client: WebIdentityClient; scope: WebScope };
const AccessContext = createContext<Access>({ state: 'unconfigured' });
export const OrganizationAccessProvider = AccessContext.Provider;
export const useOrganizationAccess = () => useContext(AccessContext);

export default function OrganizationAccess({ children }: { children: ReactNode }) {
  const factory = useContext(FactoryContext), [access, setAccess] = useState<Access>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController(); let client: WebIdentityClient | undefined;
    const timer = window.setTimeout(() => { if (!controller.signal.aborted) { setAccess({ state: 'failed' }); controller.abort(); } }, 15_000);
    void (async () => {
      try {
        const response = await fetch('/api/organizations/config', { signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (response.status === 404) { if (!controller.signal.aborted) setAccess({ state: 'unconfigured' }); return; }
        if (!response.ok) throw new Error('configuration_unavailable');
        const text = await response.text(); if (text.length > 16_384) throw new Error('configuration_limit');
        const config = webConfigurationSchema.parse(JSON.parse(text));
        if (controller.signal.aborted) return;
        if (!config.configured || !factory) { setAccess({ state: 'unconfigured' }); return; }
        const created = await factory(config.identity);
        if (!created) { if (!controller.signal.aborted) setAccess({ state: 'unconfigured' }); return; }
        client = created;
        if (controller.signal.aborted) { await client.close(); return; }
        setAccess({ state: 'ready', client, scope: config.scope });
      } catch { if (!controller.signal.aborted) setAccess({ state: 'failed' }); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { window.clearTimeout(timer); controller.abort(); void client?.close().catch(() => undefined); };
  }, [factory]);
  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}
