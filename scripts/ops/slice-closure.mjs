#!/usr/bin/env node
// Lists the local import closure and the external packages of the given TypeScript entry files, so a small part of this
// repository can be copied out on its own. Read-only; it reads source files and prints. Usage:
//   node scripts/ops/slice-closure.mjs packages/worker-protocol/cli-contract.ts apps/worker/src/cli-runtime.ts
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const root = process.cwd(), entries = process.argv.slice(2);
if (entries.length === 0) { console.error('Usage: node scripts/ops/slice-closure.mjs <entry.ts> [...]'); process.exit(2); }
const files = new Set(), external = new Set();
function local(from, spec) {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(candidate => /\.tsx?$/.test(candidate) && existsSync(candidate));
}
function visit(file) {
  if (files.has(file)) return;
  files.add(file);
  for (const match of readFileSync(file, 'utf8').matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)) {
    const spec = match[1] ?? match[2];
    if (spec.startsWith('.')) { const found = local(file, spec); if (found) visit(found); else console.error(`unresolved: ${spec} in ${relative(root, file)}`); }
    else external.add(spec.startsWith('node:') ? spec : spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
  }
}
for (const entry of entries) visit(resolve(root, entry));
const lines = file => readFileSync(file, 'utf8').split('\n').length;
console.log([...files].map(file => `${String(lines(file)).padStart(5)}  ${relative(root, file)}`).sort((a, b) => a.slice(7).localeCompare(b.slice(7))).join('\n'));
console.log(`\n${files.size} files, ${[...files].reduce((sum, file) => sum + lines(file), 0)} lines`);
console.log(`external packages: ${[...external].filter(name => !name.startsWith('node:')).sort().join(', ') || '(none)'}`);
console.log(`node built-ins:    ${[...external].filter(name => name.startsWith('node:')).sort().join(', ') || '(none)'}`);
