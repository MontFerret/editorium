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
      configuration: string;
    }>;
    grammars: Array<{
      language: string;
      scopeName: string;
      path: string;
    }>;
  };
}

interface FerretLanguageConfiguration {
  comments: {
    lineComment: string;
    blockComment: [string, string];
  };
  brackets: Array<[string, string]>;
  autoClosingPairs: Array<{
    open: string;
    close: string;
    notIn: string[];
  }>;
  surroundingPairs: Array<[string, string]>;
  indentationRules: {
    increaseIndentPattern: string;
    decreaseIndentPattern: string;
  };
}

function getExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.getExtension(extensionId);

  assert.ok(extension, `Expected VS Code to load ${extensionId}`);

  return extension;
}

suite('Ferret declarative language support', () => {
  test('contributes the Ferret language, configuration, and grammar', () => {
    const manifest = getExtension().packageJSON as FerretManifest;

    assert.strictEqual('activationEvents' in manifest, false);
    assert.deepStrictEqual(Object.keys(manifest.contributes), [
      'languages',
      'grammars',
    ]);
    assert.deepStrictEqual(manifest.contributes.languages, [
      {
        id: 'ferret',
        aliases: ['Ferret', 'ferret'],
        extensions: ['.fql'],
        configuration: './language-configuration.json',
      },
    ]);
    assert.deepStrictEqual(manifest.contributes.grammars, [
      {
        language: 'ferret',
        scopeName: 'source.ferret',
        path: './syntaxes/ferret.tmLanguage.json',
      },
    ]);
  });

  test('declares comments, pairs, and conservative brace indentation', async () => {
    const extension = getExtension();
    const uri = vscode.Uri.joinPath(
      extension.extensionUri,
      'language-configuration.json',
    );
    const bytes = await vscode.workspace.fs.readFile(uri);
    const configuration = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as FerretLanguageConfiguration;

    assert.deepStrictEqual(configuration.comments, {
      lineComment: '//',
      blockComment: ['/*', '*/'],
    });
    assert.deepStrictEqual(configuration.brackets, [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ]);
    assert.deepStrictEqual(
      configuration.autoClosingPairs.map(({ open, close }) => [open, close]),
      [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
        ['"', '"'],
        ["'", "'"],
        ['`', '`'],
        ['´', '´'],
      ],
    );
    assert.ok(
      configuration.autoClosingPairs.every(({ notIn }) =>
        notIn.includes('string') && notIn.includes('comment'),
      ),
    );
    assert.deepStrictEqual(configuration.surroundingPairs, [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['"', '"'],
      ["'", "'"],
      ['`', '`'],
      ['´', '´'],
    ]);
    assert.deepStrictEqual(configuration.indentationRules, {
      increaseIndentPattern: '^.*\\{\\s*(?://.*)?$',
      decreaseIndentPattern: '^\\s*\\}',
    });
  });

  test('uses the configured line and block comment commands', async () => {
    const original = 'return 1\nreturn 2';
    const document = await vscode.workspace.openTextDocument({
      language: 'ferret',
      content: original,
    });
    const editor = await vscode.window.showTextDocument(document);

    editor.selection = new vscode.Selection(0, 0, 1, 'return 2'.length);
    await vscode.commands.executeCommand('editor.action.commentLine');

    assert.match(document.getText(), /^\/\/\s?return 1\n\/\/\s?return 2$/u);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);

    editor.selection = new vscode.Selection(0, 0, 0, 'return 1'.length);
    await vscode.commands.executeCommand('editor.action.blockComment');

    assert.match(document.getText(), /^\/\*\s?return 1\s?\*\/\nreturn 2$/u);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('auto-closes braces and indents their contents', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'ferret',
      content: '',
    });

    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('type', {
      text: 'for item in items ',
    });
    await vscode.commands.executeCommand('type', { text: '{' });

    assert.strictEqual(document.getText(), 'for item in items {}');

    await vscode.commands.executeCommand('type', { text: '\n' });
    await vscode.commands.executeCommand('type', { text: 'return item' });

    assert.strictEqual(
      document.getText(),
      'for item in items {\n    return item\n}',
    );
  });

  test('recognizes .fql files and activates successfully', async () => {
    const extension = getExtension();
    const fixture = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'language-basics.fql',
    );
    const document = await vscode.workspace.openTextDocument(fixture);

    assert.strictEqual(document.languageId, 'ferret');

    await vscode.window.showTextDocument(document);
    await extension.activate();

    assert.strictEqual(extension.isActive, true);
  });
});
