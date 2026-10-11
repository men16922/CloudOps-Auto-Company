import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { artifactSources, companyInputs } from './company-build-policy.mjs';

const result = await build({ entryPoints: ['apps/worker/src/worker-main.ts'], outfile: 'dist-worker/worker.mjs', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', sourcemap: false, metafile: true, logLevel: 'info' });
await writeFile('dist-worker/module-inputs.json', `${JSON.stringify(companyInputs(Object.keys(result.metafile.inputs), process.cwd(), artifactSources.worker), null, 2)}\n`);
