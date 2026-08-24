import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function main() {
  const vsixPath = process.env.FERRET_VSIX_PATH;
  if (vsixPath === undefined || vsixPath === '') {
    throw new Error(
      'FERRET_VSIX_PATH is required; run this helper through the Go distribution adapter',
    );
  }
  const profileRoot = await mkdtemp(
    join(shortTemporaryRoot(), 'fv-'),
  );

  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
    const [cli, ...cliArguments] =
      resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    await execFileAsync(
      cli,
      [
        ...cliArguments,
        '--user-data-dir',
        join(profileRoot, 'user-data'),
        '--extensions-dir',
        join(profileRoot, 'extensions'),
        '--install-extension',
        vsixPath,
        '--force',
      ],
      { shell: process.platform === 'win32' },
    );

    const exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: join(
        packageRoot,
        'test',
        'installed-harness',
      ),
      extensionTestsPath: join(
        packageRoot,
        'node_modules',
        '@vscode',
        'test-cli',
        'out',
        'runner.cjs',
      ),
      extensionTestsEnv: {
        VSCODE_TEST_OPTIONS: JSON.stringify({
          mochaOpts: { ui: 'tdd', timeout: 20_000 },
          colorDefault: false,
          preload: [],
          files: [
            join(
              packageRoot,
              'out',
              'installed-test',
              'installed.integration.test.js',
            ),
          ],
        }),
        FERRET_INSTALLED_FIXTURE: join(
          packageRoot,
          'test',
          'fixtures',
          'incomplete.fql',
        ),
      },
      launchArgs: [
        join(packageRoot, 'test', 'fixtures', 'multi-root.code-workspace'),
        '--user-data-dir',
        join(profileRoot, 'user-data'),
        '--extensions-dir',
        join(profileRoot, 'extensions'),
        '--disable-workspace-trust',
      ],
    });
    if (exitCode !== 0) {
      throw new Error(`Installed VSIX test failed with exit code ${exitCode}`);
    }
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

function shortTemporaryRoot() {
  return process.env.RUNNER_TEMP ??
    (process.platform === 'win32' ? tmpdir() : '/tmp');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
