#!/usr/bin/env node
// Wrapper for sphere-cli that uses tsx to run TypeScript directly
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, 'index.ts');

try {
  execFileSync('npx', ['tsx', cliPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
  });
} catch (err) {
  process.exit(err.status || 1);
}
