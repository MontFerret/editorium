import * as assert from 'node:assert/strict';

import {
  bundledExecutableName,
  createServerConfiguration,
} from '../config';

suite('Ferret language server configuration', () => {
  test('uses the bundled ferretd by default', () => {
    const configuration = createServerConfiguration(
      '',
      [],
      '/extension/bin/ferretd',
      '2.0.0-alpha.2',
    );

    assert.deepStrictEqual(configuration, {
      executable: '/extension/bin/ferretd',
      extraArguments: [],
      source: 'bundled',
      bundledVersion: '2.0.0-alpha.2',
    });
  });

  test('preserves an explicit executable and appends extra arguments', () => {
    const configuredArguments = ['--log-level', 'debug'];
    const configuration = createServerConfiguration(
      '/opt/ferret/bin/ferretd',
      configuredArguments,
      '/extension/bin/ferretd',
      '2.0.0-alpha.2',
    );
    configuredArguments.push('--unexpected');

    assert.strictEqual(configuration.source, 'configured');
    assert.deepStrictEqual(configuration.extraArguments, [
      '--log-level',
      'debug',
    ]);
  });

  test('uses the Windows executable name only on Windows', () => {
    assert.strictEqual(bundledExecutableName('win32'), 'ferretd.exe');
    assert.strictEqual(bundledExecutableName('darwin'), 'ferretd');
    assert.strictEqual(bundledExecutableName('linux'), 'ferretd');
  });
});
