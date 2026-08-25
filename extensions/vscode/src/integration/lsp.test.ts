import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { extensionId } from '../test/extension-identity';

const restartCommand = 'ferret.restartLanguageServer';

suite('ferretd LSP integration', () => {
  test('publishes diagnostics from a real ferretd process', async () => {
    const executable = requireFerretdPath();

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

  test('exposes capabilities advertised by ferretd', async () => {
    const executable = requireFerretdPath();

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
    } finally {
      await vscode.commands.executeCommand(
        'workbench.action.closeActiveEditor',
      );
    }
  });

  test('formats unsaved documents and formats on save through ferretd', async () => {
    const executable = requireFerretdPath();

    await vscode.workspace
      .getConfiguration('ferret')
      .update(
        'server.path',
        executable,
        vscode.ConfigurationTarget.Global,
      );
    await vscode.commands.executeCommand(restartCommand);

    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'ferret-formatting-integration-'),
    );
    const path = join(temporaryRoot, 'formatting.fql');
    const uri = vscode.Uri.file(path);
    const savedSource = 'return "saved"';

    let document: vscode.TextDocument | undefined;
    let editorConfiguration: vscode.WorkspaceConfiguration | undefined;
    let originalDefaultFormatter: string | undefined;
    let originalFormatOnSave: boolean | undefined;

    try {
      await writeFile(path, savedSource);
      document = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(document.languageId, 'ferret');
      await vscode.window.showTextDocument(document);

      editorConfiguration = vscode.workspace.getConfiguration('editor', {
        uri,
        languageId: document.languageId,
      });
      originalDefaultFormatter = editorConfiguration.inspect<string>(
        'defaultFormatter',
      )?.globalLanguageValue;
      originalFormatOnSave = editorConfiguration.inspect<boolean>(
        'formatOnSave',
      )?.globalLanguageValue;
      await editorConfiguration.update(
        'defaultFormatter',
        extensionId,
        vscode.ConfigurationTarget.Global,
        true,
      );
      await editorConfiguration.update(
        'formatOnSave',
        false,
        vscode.ConfigurationTarget.Global,
        true,
      );

      await replaceDocument(
        document,
        'LET value=1\nRETURN {value:value}',
      );
      await vscode.commands.executeCommand('editor.action.formatDocument');

      assert.strictEqual(
        document.getText(),
        'let value = 1\nreturn { value: value }',
      );
      assert.strictEqual(document.isDirty, true);
      assert.strictEqual(await readFile(path, 'utf8'), savedSource);

      await replaceDocument(
        document,
        'LET result={first:1,second:2}\nRETURN result',
      );
      await vscode.commands.executeCommand('editor.action.formatDocument');

      assert.strictEqual(
        document.getText(),
        'let result = { first: 1, second: 2 }\nreturn result',
      );
      assert.strictEqual(document.isDirty, true);
      assert.strictEqual(await readFile(path, 'utf8'), savedSource);

      await editorConfiguration.update(
        'formatOnSave',
        true,
        vscode.ConfigurationTarget.Global,
        true,
      );
      await replaceDocument(document, 'RETURN {outer:{inner:1}}');

      assert.strictEqual(document.isDirty, true);
      assert.strictEqual(await document.save(), true);
      assert.strictEqual(
        document.getText(),
        'return { outer: { inner: 1 } }',
      );
      assert.strictEqual(document.isDirty, false);
      assert.strictEqual(
        await readFile(path, 'utf8'),
        'return { outer: { inner: 1 } }',
      );
    } finally {
      try {
        if (editorConfiguration !== undefined) {
          try {
            await editorConfiguration.update(
              'formatOnSave',
              originalFormatOnSave,
              vscode.ConfigurationTarget.Global,
              true,
            );
          } finally {
            await editorConfiguration.update(
              'defaultFormatter',
              originalDefaultFormatter,
              vscode.ConfigurationTarget.Global,
              true,
            );
          }
        }
      } finally {
        try {
          if (document !== undefined && !document.isClosed) {
            await vscode.window.showTextDocument(document);
            if (document.isDirty) {
              await vscode.commands.executeCommand(
                'workbench.action.files.revert',
              );
            }
            await vscode.commands.executeCommand(
              'workbench.action.closeActiveEditor',
            );
          }
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
    }
  });
});

function requireFerretdPath(): string {
  const executable = process.env.FERRETD_TEST_PATH;
  assert.ok(
    executable,
    'FERRETD_TEST_PATH must point to the pinned ferretd executable',
  );

  return executable;
}

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

async function replaceDocument(
  document: vscode.TextDocument,
  source: string,
): Promise<void> {
  const last = document.lineAt(document.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(0, 0, last.lineNumber, last.range.end.character),
    source,
  );
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
}

async function waitForDiagnostics(
  uri: vscode.Uri,
): Promise<readonly vscode.Diagnostic[]> {
  const current = vscode.languages.getDiagnostics(uri);
  if (current.length > 0) {
    return current;
  }

  return new Promise((resolveDiagnostics, rejectDiagnostics) => {
    // Assigned after listener creation because its callback closes over it.
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      if (
        !event.uris.some(
          (changed) => changed.toString() === uri.toString(),
        )
      ) {
        return;
      }

      const diagnostics = vscode.languages.getDiagnostics(uri);
      if (diagnostics.length > 0) {
        listener.dispose();
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolveDiagnostics(diagnostics);
      }
    });
    timer = setTimeout(() => {
      listener.dispose();
      rejectDiagnostics(
        new Error(`Timed out waiting for diagnostics for ${uri.toString()}`),
      );
    }, 10_000);
  });
}
