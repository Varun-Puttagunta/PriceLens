/**
 * CI guard: assets/js/data.js must be exactly what tools/generate-data.mjs
 * produces. A hand-edited dataset would let the published numbers drift away
 * from the generator that is supposed to explain them.
 */
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'assets/js/data.js');
const backup = join(root, 'assets/js/.data.backup.js');

copyFileSync(target, backup);
try {
  const before = readFileSync(backup, 'utf8');
  execFileSync(process.execPath, [join(root, 'tools/generate-data.mjs')], { stdio: 'pipe' });
  const after = readFileSync(target, 'utf8');
  if (before !== after) {
    writeFileSync(target, before);
    console.error('✗ assets/js/data.js is out of date. Run `npm run data` and commit the result.');
    process.exit(1);
  }
  console.log('✓ data.js matches its generator');
} finally {
  rmSync(backup, { force: true });
}
