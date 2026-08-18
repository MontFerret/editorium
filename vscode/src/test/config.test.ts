import * as assert from 'node:assert/strict';

import {
  bundledExecutableName,
  createServerConfiguration,
  createServerOptions,
  ferretDocumentSelector,
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
    assert.deepStrictEqual(createServerOptions(configuration), {
      command: '/extension/bin/ferretd',
      args: ['lsp'],
      options: { detached: false },
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

    const options = createServerOptions(configuration);
    assert.deepStrictEqual(options, {
      command: '/opt/ferret/bin/ferretd',
      args: ['lsp', '--log-level', 'debug'],
      options: { detached: false },
    });
    assert.strictEqual('transport' in options, false);
    assert.strictEqual(configuration.source, 'configured');
  });

  test('uses the Windows executable name only on Windows', () => {
    assert.strictEqual(bundledExecutableName('win32'), 'ferretd.exe');
    assert.strictEqual(bundledExecutableName('darwin'), 'ferretd');
    assert.strictEqual(bundledExecutableName('linux'), 'ferretd');
  });

  test('selects file-backed Ferret documents by language identity', () => {
    assert.deepStrictEqual(ferretDocumentSelector, [
      { scheme: 'file', language: 'ferret' },
    ]);
  });
});
