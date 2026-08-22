import * as assert from 'node:assert/strict';
import { constants } from 'node:fs';

import {
  bundledExecutableName,
  createFerretdExecutable,
  FerretdExecutableUnavailableError,
  requireFerretdExecutable,
  type FerretdExecutable,
} from '../ferretd';

suite('ferretd executable selection', () => {
  test('uses the bundled executable by default', () => {
    assert.deepStrictEqual(
      createFerretdExecutable(
        '',
        '/extension/bin/ferretd',
        '2.0.0-alpha.5',
      ),
      {
        executable: '/extension/bin/ferretd',
        source: 'bundled',
        bundledVersion: '2.0.0-alpha.5',
      },
    );
  });

  test('keeps the configured override authoritative', () => {
    assert.deepStrictEqual(
      createFerretdExecutable(
        '/opt/ferret/bin/ferretd',
        '/extension/bin/ferretd',
        '2.0.0-alpha.5',
      ),
      {
        executable: '/opt/ferret/bin/ferretd',
        source: 'configured',
      },
    );
  });

  test('uses the Windows executable name only on Windows', () => {
    assert.strictEqual(bundledExecutableName('win32'), 'ferretd.exe');
    assert.strictEqual(bundledExecutableName('darwin'), 'ferretd');
    assert.strictEqual(bundledExecutableName('linux'), 'ferretd');
  });

  test('checks the selected executable using the host access mode', async () => {
    const selection = configuredExecutable();
    let checkedPath: string | undefined;
    let checkedMode: number | undefined;

    const resolved = await requireFerretdExecutable(
      selection,
      async (path, mode) => {
        checkedPath = path;
        checkedMode = mode;
      },
    );

    assert.strictEqual(resolved, selection);
    assert.strictEqual(checkedPath, selection.executable);
    assert.strictEqual(
      checkedMode,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
  });

  test('maps configured override failures without falling back', async () => {
    const selection = configuredExecutable();
    const cause = new Error('access EACCES');

    await assert.rejects(
      requireFerretdExecutable(selection, async () => {
        throw cause;
      }),
      (error: unknown) => {
        assert.ok(error instanceof FerretdExecutableUnavailableError);
        assert.strictEqual(error.selection, selection);
        assert.strictEqual(error.cause, cause);
        assert.match(error.message, /ferret\.server\.path/u);
        assert.match(error.message, /will not fall back/u);
        assert.doesNotMatch(error.message, /ENOENT/u);
        return true;
      },
    );
  });

  test('maps missing bundled executable failures to reinstall guidance', async () => {
    const selection: FerretdExecutable = {
      executable: '/extension/bin/ferretd',
      source: 'bundled',
      bundledVersion: '2.0.0-alpha.5',
    };

    await assert.rejects(
      requireFerretdExecutable(selection, async () => {
        throw new Error('access ENOENT');
      }),
      (error: unknown) => {
        assert.ok(error instanceof FerretdExecutableUnavailableError);
        assert.match(error.message, /Reinstall the extension package/u);
        assert.doesNotMatch(error.message, /ENOENT/u);
        return true;
      },
    );
  });
});

function configuredExecutable(): FerretdExecutable {
  return {
    executable: '/opt/ferret/bin/ferretd',
    source: 'configured',
  };
}
