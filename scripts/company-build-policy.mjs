import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, sep } from 'node:path';

// Shared by the original builds and the independent company source candidate.
export const excludedCompanyInput = /(?:^|\/)(?:modules\/(?:gcp|onprem|azure|aws\/(?:personal|local-trial)|registry)|platform\/firebase|apps\/(?:demo|personal)|src\/(?:App|main|store)\.|src\/data\/|server\/(?:service|index|http|cloud-index)\.|(?:firebase[^/]*|@firebase|@google-cloud|@aws-sdk|google-auth-library)(?:\/|$)|\.data(?:\/|$)|\.env(?:\.|$)|mobile\/)/;

export function companyInputs(inputs, root = process.cwd()) {
  const modules = realpathSync(join(root, 'node_modules'));
  const paths = [...new Set(inputs.filter(id => !id.startsWith('\0')).map(id => {
    const path = resolve(root, id.split('?')[0]);
    return (path.startsWith(`${modules}${sep}`) ? `node_modules/${relative(modules, path)}` : relative(root, path)).replaceAll('\\', '/');
  }))].sort();
  for (const path of paths) {
    if (!path || path.startsWith('../') || isAbsolute(path) || excludedCompanyInput.test(path)) {
      throw new Error(`Excluded company build input: ${path}`);
    }
  }
  return paths;
}

export function companyWebBoundary() {
  return {
    name: 'company-source-boundary',
    generateBundle() {
      const inputs = companyInputs([...this.getModuleIds()]);
      this.emitFile({ type: 'asset', fileName: 'module-inputs.json', source: `${JSON.stringify(inputs, null, 2)}\n` });
    },
  };
}
