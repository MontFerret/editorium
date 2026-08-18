import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const extensionId = 'ferretlang.fql';
const restartCommand = 'ferret.restartLanguageServer';

suite('ferretd LSP integration', () => {
  test('publishes diagnostics from a real ferretd process', async function () {
    const executable = process.env.FERRETD_TEST_PATH;
    if (executable === undefined) {
      this.skip();
    }

    assert.deepStrictEqual(
      vscode.workspace.workspaceFolders?.map((folder) => folder.name),
      ['primary', 'secondary'],
      'Expected the language server to initialize in a multi-root workspace',
    );

    await vscode.workspace
      .getConfiguration('ferret')
      .update(
        'server.path',
        executable,
        vscode.ConfigurationTarget.Global,
      );
    await vscode.commands.executeCommand(restartCommand);

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected VS Code to load ${extensionId}`);
    const fixture = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'incomplete.fql',
    );
    const document = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(document);

    try {
      const diagnostics = await waitForDiagnostics(fixture);
      assert.ok(
        diagnostics.length > 0,
        'Expected ferretd to publish at least one diagnostic',
      );
    } finally {
      await vscode.commands.executeCommand(
        'workbench.action.closeActiveEditor',
      );
    }
  });

  test('exposes capabilities advertised by ferretd', async function () {
    const executable = process.env.FERRETD_TEST_PATH;
    if (executable === undefined) {
      this.skip();
    }

    await vscode.workspace
      .getConfiguration('ferret')
      .update(
        'server.path',
        executable,
        vscode.ConfigurationTarget.Global,
      );
    await vscode.commands.executeCommand(restartCommand);

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected VS Code to load ${extensionId}`);
    const fixture = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'lsp-capabilities.fql',
    );
    const document = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(document);

    try {
      const completion = await vscode.commands.executeCommand<
        vscode.CompletionList
      >(
        'vscode.executeCompletionItemProvider',
        fixture,
        new vscode.Position(2, 7),
      );
      assert.ok(
        completion.items.some((item) => completionLabel(item) === 'value'),
        'Expected completion from ferretd',
      );

      const hovers = await vscode.commands.executeCommand<
        vscode.Hover[]
      >(
        'vscode.executeHoverProvider',
        fixture,
        new vscode.Position(2, 8),
      );
      assert.ok(hovers.length > 0, 'Expected hover information');

      const signature = await vscode.commands.executeCommand<
        vscode.SignatureHelp
      >(
        'vscode.executeSignatureHelpProvider',
        fixture,
        new vscode.Position(2, 17),
        '(',
      );
      assert.match(
        signature.signatures[0]?.label ?? '',
        /^add\(left, right\)$/u,
      );

      const symbols = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation>
      >('vscode.executeDocumentSymbolProvider', fixture);
      assert.ok(symbols.length > 0, 'Expected document symbols');

      const definitions = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink>
      >(
        'vscode.executeDefinitionProvider',
        fixture,
        new vscode.Position(2, 11),
      );
      assert.ok(definitions.length > 0, 'Expected definition navigation');

      const semanticTokens = await vscode.commands.executeCommand<
        vscode.SemanticTokens
      >('vscode.provideDocumentSemanticTokens', fixture);
      assert.ok(
        semanticTokens.data.length > 0,
        'Expected semantic tokens over the TextMate fallback',
      );

      const edits = await vscode.commands.executeCommand<
        vscode.TextEdit[]
      >(
        'vscode.executeFormatDocumentProvider',
        fixture,
        { tabSize: 2, insertSpaces: true },
      );
      assert.ok(edits.length > 0, 'Expected document formatting edits');
    } finally {
      await vscode.commands.executeCommand(
        'workbench.action.closeActiveEditor',
      );
    }
  });
});

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

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
