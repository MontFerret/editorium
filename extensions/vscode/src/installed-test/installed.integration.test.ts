import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { extensionId } from '../test/extension-identity';

suite('installed Ferret VSIX', () => {
  test('starts its bundled daemon and publishes diagnostics', async () => {
    const fixturePath = process.env.FERRET_INSTALLED_FIXTURE;
    assert.ok(fixturePath, 'FERRET_INSTALLED_FIXTURE must be configured');

    const configuration = vscode.workspace.getConfiguration('ferret');
    await configuration.update(
      'server.path',
      undefined,
      vscode.ConfigurationTarget.Global,
    );

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected VS Code to install ${extensionId}`);
    assert.ok(
      extension.extensionPath.includes('extensions'),
      `Expected an installed extension, got ${extension.extensionPath}`,
    );

    const executable = vscode.Uri.joinPath(
      extension.extensionUri,
      'bin',
      process.platform === 'win32' ? 'ferretd.exe' : 'ferretd',
    );
    const executableStat = await vscode.workspace.fs.stat(executable);
    assert.strictEqual(
      executableStat.type,
      vscode.FileType.File,
      'Expected the installed VSIX to contain ferretd',
    );

    const fixture = vscode.Uri.file(fixturePath);
    const document = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(document);

    try {
      const diagnostics = await waitForDiagnostics(fixture);
      assert.ok(
        diagnostics.length > 0,
        'Expected diagnostics from the bundled ferretd process',
      );
    } finally {
      await vscode.commands.executeCommand(
        'workbench.action.closeActiveEditor',
      );
    }
  });
});

async function waitForDiagnostics(
  uri: vscode.Uri,
): Promise<readonly vscode.Diagnostic[]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (diagnostics.length > 0) {
      return diagnostics;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  return vscode.languages.getDiagnostics(uri);
}
