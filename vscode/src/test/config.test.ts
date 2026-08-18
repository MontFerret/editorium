import * as assert from 'node:assert/strict';

import {
  createServerConfiguration,
  createServerOptions,
  ferretDocumentSelector,
} from '../config';

suite('Ferret language server configuration', () => {
  test('uses ferretd from PATH by default', () => {
    const configuration = createServerConfiguration('', []);

    assert.deepStrictEqual(configuration, {
      executable: 'ferretd',
      extraArguments: [],
    });
    assert.deepStrictEqual(createServerOptions(configuration), {
      command: 'ferretd',
      args: ['lsp'],
      options: { detached: false },
    });
  });

  test('preserves an explicit executable and appends extra arguments', () => {
    const configuredArguments = ['--log-level', 'debug'];
    const configuration = createServerConfiguration(
      '/opt/ferret/bin/ferretd',
      configuredArguments,
    );
    configuredArguments.push('--unexpected');

    const options = createServerOptions(configuration);
    assert.deepStrictEqual(options, {
      command: '/opt/ferret/bin/ferretd',
      args: ['lsp', '--log-level', 'debug'],
      options: { detached: false },
    });
    assert.strictEqual('transport' in options, false);
  });

  test('selects file-backed Ferret documents by language identity', () => {
    assert.deepStrictEqual(ferretDocumentSelector, [
      { scheme: 'file', language: 'ferret' },
    ]);
  });
});
