import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import './styles.css';
import { LanguageProvider } from './i18n';
import AccountDashboard from './dashboard/AccountDashboard';
import OrganizationAccess, { WebIdentityFactoryProvider, type WebIdentityFactory } from './identity/OrganizationAccess';
import { OidcWebIdentityClient, browserOidcDependencies } from './identity/oidc-client';

// Independent company candidate. No multi-cloud registry, personal startup or demo application.
// Only the company method with server-provided OIDC settings gets a client; anything else stays unconfigured.
const identityFactory: WebIdentityFactory = async identity => identity.oidc ? new OidcWebIdentityClient(identity.oidc, browserOidcDependencies()) : null;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider><WebIdentityFactoryProvider factory={identityFactory}><OrganizationAccess><AccountDashboard /></OrganizationAccess></WebIdentityFactoryProvider></LanguageProvider></React.StrictMode>);
