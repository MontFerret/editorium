import * as assert from 'node:assert/strict';

import { createServerConfiguration } from '../config';
import { createFerretdExecutable } from '../ferretd';

suite('Ferret language server configuration', () => {
  test('uses the bundled ferretd by default', () => {
    const configuration = createServerConfiguration(
      createFerretdExecutable(
        '',
        '/extension/bin/ferretd',
        '2.0.0-alpha.2',
      ),
      [],
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
      createFerretdExecutable(
        '/opt/ferret/bin/ferretd',
        '/extension/bin/ferretd',
        '2.0.0-alpha.2',
      ),
      configuredArguments,
    );
    configuredArguments.push('--unexpected');

    assert.strictEqual(configuration.source, 'configured');
    assert.deepStrictEqual(configuration.extraArguments, [
      '--log-level',
      'debug',
    ]);
  });
});
