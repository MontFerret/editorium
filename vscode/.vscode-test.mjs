import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profileRoot = mkdtempSync(join(tmpdir(), 'ferret-vscode-test-'));

process.on('exit', () => {
  rmSync(profileRoot, { recursive: true, force: true });
});

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: 'stable',
  launchArgs: [
    `--user-data-dir=${join(profileRoot, 'user-data')}`,
    `--extensions-dir=${join(profileRoot, 'extensions')}`,
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20_000,
  },
});
