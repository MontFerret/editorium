import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const profileRoot = mkdtempSync(join(tmpdir(), 'ferret-vscode-test-'));
const testWorkspace = fileURLToPath(
  new URL('./test/fixtures/multi-root.code-workspace', import.meta.url),
);

process.on('exit', () => {
  rmSync(profileRoot, { recursive: true, force: true });
});

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: 'stable',
  launchArgs: [
    `--user-data-dir=${join(profileRoot, 'user-data')}`,
    `--extensions-dir=${join(profileRoot, 'extensions')}`,
    '--disable-workspace-trust',
    testWorkspace,
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20_000,
  },
});
