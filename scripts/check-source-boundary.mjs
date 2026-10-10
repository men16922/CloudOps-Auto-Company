import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve, delimiter, dirname } from 'node:path';
import { companyInputs } from './company-build-policy.mjs';

const root = realpathSync(process.cwd());
if (realpathSync(join(root, 'node_modules')) !== join(root, 'node_modules')) throw Error('Company dependencies must be local to this repository.');
const env = { ...process.env, PATH: [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(path => !path.includes('node_modules'))].join(delimiter) };
delete env.NODE_PATH; delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--listFilesOnly'], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (result.error || result.status !== 0) throw Error(`Cannot inspect company source dependencies: ${result.stderr}`);
const inputs = result.stdout.trim().split(/\r?\n/); companyInputs(inputs, root);
for (const input of inputs) if (realpathSync(input) !== resolve(input)) throw Error('Source or dependency symlink escapes the inspected company file.');
console.log('Company source boundary passed, including type-only imports and test support.');
