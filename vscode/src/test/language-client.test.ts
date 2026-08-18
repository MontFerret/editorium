import * as assert from 'node:assert/strict';

import type { ServerConfiguration } from '../config';
import {
  createServerOptions,
  ferretDocumentSelector,
} from '../language-client';

suite('Ferret language client construction', () => {
  test('uses the required lsp subcommand with implicit stdio', () => {
    const bundled: ServerConfiguration = {
      executable: '/extension/bin/ferretd',
      extraArguments: [],
      source: 'bundled',
      bundledVersion: '2.0.0-alpha.2',
    };
    const configured: ServerConfiguration = {
      executable: '/opt/ferret/bin/ferretd',
      extraArguments: ['--log-level', 'debug'],
      source: 'configured',
    };

    assert.deepStrictEqual(createServerOptions(bundled), {
      command: '/extension/bin/ferretd',
      args: ['lsp'],
      options: { detached: false },
    });

    const options = createServerOptions(configured);
    assert.deepStrictEqual(options, {
      command: '/opt/ferret/bin/ferretd',
      args: ['lsp', '--log-level', 'debug'],
      options: { detached: false },
    });
    assert.strictEqual('transport' in options, false);
  });

  test('selects only file-backed Ferret documents', () => {
    assert.deepStrictEqual(ferretDocumentSelector, [
      { scheme: 'file', language: 'ferret' },
    ]);
  });
});
