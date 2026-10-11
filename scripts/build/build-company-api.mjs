import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { artifactSources, companyInputs } from './company-build-policy.mjs';

// CommonJS dependencies (SAML/XML) call require() for Node built-ins; ESM output needs a real require.
const banner = { js: "import { createRequire as __cloudopsCreateRequire } from 'node:module'; const require = __cloudopsCreateRequire(import.meta.url);" };
const common = { bundle: true, platform: 'node', target: 'node24', format: 'esm', metafile: true, sourcemap: false, logLevel: 'info', banner };
const library = await build({ ...common, entryPoints: ['apps/host/src/index.ts'], outfile: 'dist-company-api/organization.mjs' });
// Loopback verification host. It is not a production server composition.
const local = await build({ ...common, entryPoints: ['apps/host/src/local-main.ts'], outfile: 'dist-company-api/local.mjs' });
const inputs = companyInputs([...Object.keys(library.metafile.inputs), ...Object.keys(local.metafile.inputs)], process.cwd(), artifactSources.host);
await mkdir('dist-company-api', { recursive: true });
await writeFile('dist-company-api/module-inputs.json', JSON.stringify(inputs, null, 2));
