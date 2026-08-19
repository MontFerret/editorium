import * as assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createDaemonEndpoint } from '../daemon/endpoint';
import { FerretWorkspaceRegistry } from '../daemon/workspaces';

suite('Ferret daemon endpoints and workspaces', () => {
  test('creates private unique Unix socket directories', async () => {
    const first = await createDaemonEndpoint('darwin');
    const second = await createDaemonEndpoint('linux');

    try {
      assert.notStrictEqual(first.cli, second.cli);
      assert.match(first.cli, /^unix:\/\//u);
      assert.match(first.grpc, /^unix:\/\//u);
      const directory = dirname(
        first.grpc.slice('unix://'.length),
      );
      const info = await stat(directory);
      assert.strictEqual(info.mode & 0o777, 0o700);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  test('creates UUID-named Windows pipes without TCP', async () => {
    const first = await createDaemonEndpoint('win32');
    const second = await createDaemonEndpoint('win32');

    assert.notStrictEqual(first.cli, second.cli);
    assert.ok(
      first.cli.startsWith(
        'npipe:////./pipe/ferretd-vscode-',
      ),
    );
    assert.match(first.cli.slice(first.cli.lastIndexOf('-') + 1), /^[0-9a-f]+$/u);
    assert.match(first.grpc, /^unix:\\\\.\\pipe\\ferretd-vscode-/u);
  });

  test('deduplicates roots and resolves the deepest workspace', () => {
    const registry = new FerretWorkspaceRegistry();
    registry.set({ id: 'outer', root: '/workspace' });
    registry.set({ id: 'outer-replaced', root: '/workspace/' });
    registry.set({ id: 'nested', root: '/workspace/packages/app' });

    assert.strictEqual(registry.workspaces.length, 2);
    assert.deepStrictEqual(
      registry.resolveDocument(
        '/workspace/packages/app/queries/main.fql',
      ),
      {
        workspaceId: 'nested',
        relativePath: 'queries/main.fql',
      },
    );
    assert.deepStrictEqual(
      registry.resolveDocument('/workspace/shared/main.fql'),
      {
        workspaceId: 'outer-replaced',
        relativePath: 'shared/main.fql',
      },
    );
    assert.strictEqual(
      registry.resolveDocument('/elsewhere/main.fql'),
      undefined,
    );
    assert.strictEqual(
      registry.resolveDocument('relative/main.fql'),
      undefined,
    );
  });

  test('reports only workspace identities that become invalid', () => {
    const registry = new FerretWorkspaceRegistry();
    const invalidated: string[][] = [];
    const listener = registry.onDidInvalidateWorkspaces((event) => {
      invalidated.push([...event.workspaceIds]);
    });

    try {
      registry.set({ id: 'first', root: '/workspace' });
      registry.set({ id: 'first', root: '/workspace/' });
      registry.set({ id: 'second', root: '/workspace' });
      registry.set({ id: 'nested', root: '/workspace/nested' });
      registry.delete('/workspace/nested');
      registry.clear();

      assert.deepStrictEqual(invalidated, [
        ['first'],
        ['nested'],
        ['second'],
      ]);
    } finally {
      listener.dispose();
    }
  });
});
