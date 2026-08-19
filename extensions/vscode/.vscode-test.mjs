import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const profileRoot = mkdtempSync(join(tmpdir(), 'ferret-vscode-test-'));
const testWorkspace = fileURLToPath(
  new URL('./test/fixtures/multi-root.code-workspace', import.meta.url),
);
const vscodeVersion = '1.95.0';

process.on('exit', () => {
  rmSync(profileRoot, { recursive: true, force: true });
});

const launchArgs = [
  `--user-data-dir=${join(profileRoot, 'user-data')}`,
  `--extensions-dir=${join(profileRoot, 'extensions')}`,
  '--disable-workspace-trust',
  testWorkspace,
];

export default defineConfig([
  {
    label: 'unit',
    files: 'out/test/**/*.test.js',
    version: vscodeVersion,
    launchArgs,
    mocha: {
      ui: 'tdd',
      timeout: 20_000,
    },
  },
  {
    label: 'integration',
    files: 'out/integration/**/*.test.js',
    version: vscodeVersion,
    launchArgs,
    mocha: {
      ui: 'tdd',
      timeout: 60_000,
    },
  },
]);
