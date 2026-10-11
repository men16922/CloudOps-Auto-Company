import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, sep } from 'node:path';

// Shared by the original builds and the independent company source candidate.
export const excludedCompanyInput = /(?:^|\/)(?:modules\/(?:gcp|onprem|azure|aws\/(?:personal|local-trial)|registry)|platform\/firebase|apps\/(?:demo|personal)|src\/(?:App|main|store)\.|src\/data\/|server\/(?:service|index|http|cloud-index)\.|(?:firebase[^/]*|@firebase|@google-cloud|@aws-sdk|google-auth-library)(?:\/|$)|\.data(?:\/|$)|\.env(?:\.|$)|mobile\/)/;

/** Which source folders each artifact may contain. A web import of host/worker code (or a worker import of host code) fails the build. */
export const artifactSources = {
  web: ['apps/web/', 'packages/contracts/', 'packages/assessment/'],
  host: ['apps/host/', 'packages/contracts/', 'packages/assessment/', 'packages/worker-protocol/'],
  worker: ['apps/worker/', 'packages/contracts/', 'packages/worker-protocol/'],
};

export function companyInputs(inputs, root = process.cwd(), allowed) {
  const modules = realpathSync(join(root, 'node_modules'));
  const paths = [...new Set(inputs.filter(id => !id.startsWith('\0')).map(id => {
    const path = resolve(root, id.split('?')[0]);
    return (path.startsWith(`${modules}${sep}`) ? `node_modules/${relative(modules, path)}` : relative(root, path)).replaceAll('\\', '/');
  }))].sort();
  for (const path of paths) {
    if (!path || path.startsWith('../') || isAbsolute(path) || excludedCompanyInput.test(path)) {
      throw new Error(`Excluded company build input: ${path}`);
    }
    if (allowed && !path.startsWith('node_modules/') && !allowed.some(prefix => path.startsWith(prefix))) {
      throw new Error(`Build input outside this artifact's layers (${allowed.join(', ')}): ${path}`);
    }
  }
  return paths;
}

export function companyWebBoundary() {
  return {
    name: 'company-source-boundary',
    generateBundle() {
      const inputs = companyInputs([...this.getModuleIds()], process.cwd(), artifactSources.web);
      this.emitFile({ type: 'asset', fileName: 'module-inputs.json', source: `${JSON.stringify(inputs, null, 2)}\n` });
    },
  };
}
