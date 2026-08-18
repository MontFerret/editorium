import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const extensionId = 'ferretlang.fql';

interface FerretManifest {
  activationEvents?: unknown;
  contributes: {
    languages: Array<{
      id: string;
      aliases: string[];
      extensions: string[];
    }>;
    [key: string]: unknown;
  };
}

function getExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(extensionId);

  assert.ok(extension, `Expected VS Code to load ${extensionId}`);

  return extension;
}

suite('Ferret extension foundation', () => {
  test('contributes only the Ferret language', () => {
    const manifest = getExtension().packageJSON as FerretManifest;

    assert.strictEqual('activationEvents' in manifest, false);
    assert.deepStrictEqual(Object.keys(manifest.contributes), ['languages']);
    assert.deepStrictEqual(manifest.contributes.languages, [
      {
        id: 'ferret',
        aliases: ['Ferret', 'ferret'],
        extensions: ['.fql'],
      },
    ]);
  });

  test('recognizes .fql files and activates successfully', async () => {
    const extension = getExtension();
    const fixture = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'sample.fql',
    );
    const document = await vscode.workspace.openTextDocument(fixture);

    assert.strictEqual(document.languageId, 'ferret');

    await vscode.window.showTextDocument(document);
    await extension.activate();

    assert.strictEqual(extension.isActive, true);
  });
});
