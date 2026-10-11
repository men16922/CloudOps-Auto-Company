import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { companyWebBoundary } from './scripts/build/company-build-policy.mjs';

// The web app lives in apps/web; the build output stays at the repository root where the host and checks expect it.
export default defineConfig({
  root: 'apps/web',
  plugins: [react(), companyWebBoundary()],
  build: { outDir: '../../dist-company', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
});
