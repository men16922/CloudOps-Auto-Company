import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { companyInputs } from './company-build-policy.mjs';

const result = await build({ entryPoints: ['server/modules/aws/organization/organization-cli-main.ts'], outfile: 'dist-worker/worker.mjs', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', sourcemap: false, metafile: true, logLevel: 'info' });
await writeFile('dist-worker/module-inputs.json', `${JSON.stringify(companyInputs(Object.keys(result.metafile.inputs)), null, 2)}\n`);
