import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import '../../src/styles.css';
import { LanguageProvider } from '../../src/i18n';
import { OrganizationAccessProvider } from '../../src/platform/OrganizationAccess';
import type { WebIdentity, WebIdentityClient } from '../../src/platform/web-identity';
import AccountDashboard from '../../src/modules/aws/organization/AccountDashboard';

// Compiled only by the offline browser contract test into an owned temporary directory.
const listeners = new Set<(identity: WebIdentity | null) => void>();
let identity: WebIdentity | null = null;
const emit = (key: string | null) => { identity = key ? { key, label: key } : null; listeners.forEach(listener => listener(identity)); };
const client: WebIdentityClient = {
  subscribe(listener) { listeners.add(listener); listener(identity); return () => { listeners.delete(listener); }; },
  async signIn() { emit('user-a'); }, async signOut() { emit(null); }, async close() { listeners.clear(); },
  async tokenFor(key) { if (identity?.key !== key) throw new Error('identity_changed'); return `synthetic-${key}`; },
};
const scope = { organizationId: 'synthetic-org', workspaceId: 'synthetic-workspace', label: 'Synthetic organization' };
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider>
  <button data-testid="switch-user" onClick={() => emit('user-b')}>Synthetic user B</button>
  <OrganizationAccessProvider value={{ state: 'ready', client, scope }}><AccountDashboard /></OrganizationAccessProvider>
</LanguageProvider></React.StrictMode>);
