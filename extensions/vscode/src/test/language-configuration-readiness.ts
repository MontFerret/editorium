import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function discardTestDocument(document: vscode.TextDocument): Promise<void> {
  if (document.isClosed) {
    return;
  }

  await vscode.window.showTextDocument(document, { preview: false });
  assert.strictEqual(vscode.window.activeTextEditor?.document, document);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

export async function waitForFerretLanguageConfiguration(): Promise<void> {
  const original = 'return 1';
  const expected = /^\/\/\s?return 1$/u;
  const document = await vscode.workspace.openTextDocument({
    language: 'ferret',
    content: original,
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let changes: vscode.Disposable | undefined;
  let attempts = 0;

  try {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const originalVersion = document.version;
    editor.selection = new vscode.Selection(0, 0, 0, original.length);

    // VS Code loads declarative rules asynchronously, independently of activation.
    const unavailable = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error(
        `Ferret language configuration was not ready within 5000ms after ${attempts} probes: `
        + `language=${document.languageId}, version=${document.version}, `
        + `closed=${document.isClosed}, text=${JSON.stringify(document.getText())}`,
      )), 5_000);
      changes = vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && event.contentChanges.length > 0
          && !expected.test(document.getText())) {
          reject(new Error(
            `Unexpected Ferret language-configuration probe edit: ${JSON.stringify(document.getText())}`,
          ));
        }
      });
    });

    while (true) {
      if (expected.test(document.getText())) {
        return;
      }
      assert.strictEqual(vscode.window.activeTextEditor?.document, document);
      assert.strictEqual(document.getText(), original, 'Probe document changed between attempts');
      assert.strictEqual(document.version, originalVersion, 'Probe document was edited between attempts');
      attempts += 1;

      // Force-add is idempotent; never overlap probes or retry a tested toggle command.
      await Promise.race([
        vscode.commands.executeCommand('editor.action.addCommentLine'),
        unavailable,
      ]);
      if (expected.test(document.getText())) {
        return;
      }

      assert.strictEqual(document.getText(), original, 'Unexpected probe result');
      assert.strictEqual(document.version, originalVersion, 'Only unchanged no-op probes may be retried');
      await Promise.race([
        new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 10); }),
        unavailable,
      ]);
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    changes?.dispose();
    await discardTestDocument(document);
  }
}
