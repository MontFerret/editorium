import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
  cancelExecutionCommand,
  runFileCommand,
} from '../execution/commands';

const extensionId = 'ferretlang.fql';

interface FerretManifest {
  activationEvents?: unknown;
  extensionKind: string[];
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
    commands: Array<{
      command: string;
      title: string;
      category: string;
      enablement?: string;
      icon?: string;
    }>;
    menus: {
      'editor/title': Array<{
        command: string;
        group: string;
        when: string;
      }>;
    };
    configuration: {
      title: string;
      properties: Record<
        string,
        {
          type: string;
          default: unknown;
          scope: string;
          markdownDescription?: string;
          items?: { type: string };
          enum?: string[];
        }
      >;
    };
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
  test('contributes language support and thin-client configuration', () => {
    const manifest = getExtension().packageJSON as FerretManifest;

    assert.strictEqual('activationEvents' in manifest, false);
    assert.deepStrictEqual(manifest.extensionKind, ['workspace']);
    assert.deepStrictEqual(Object.keys(manifest.contributes), [
      'languages',
      'grammars',
      'commands',
      'menus',
      'configuration',
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
    assert.deepStrictEqual(manifest.contributes.commands, [
      {
        command: 'ferret.restartLanguageServer',
        title: 'Restart Language Server',
        category: 'Ferret',
      },
      {
        command: runFileCommand,
        title: 'Run File',
        category: 'Ferret',
        icon: '$(play)',
        enablement:
          'editorLangId == ferret && resourceScheme == file && !ferret.executionRunning',
      },
      {
        command: cancelExecutionCommand,
        title: 'Cancel Execution',
        category: 'Ferret',
        icon: '$(debug-stop)',
        enablement:
          'editorLangId == ferret && resourceScheme == file && ferret.executionRunning',
      },
    ]);
    assert.deepStrictEqual(manifest.contributes.menus, {
      'editor/title': [
        {
          command: runFileCommand,
          when:
            'resourceLangId == ferret && resourceScheme == file && !ferret.executionRunning',
          group: 'navigation@1',
        },
        {
          command: cancelExecutionCommand,
          when:
            'resourceLangId == ferret && resourceScheme == file && ferret.executionRunning',
          group: 'navigation@1',
        },
      ],
    });

    const properties = manifest.contributes.configuration.properties;
    assert.deepStrictEqual(
      {
        type: properties['ferret.server.path']?.type,
        default: properties['ferret.server.path']?.default,
        scope: properties['ferret.server.path']?.scope,
      },
      { type: 'string', default: '', scope: 'window' },
    );
    assert.match(
      properties['ferret.server.path']?.markdownDescription ?? '',
      /Overrides the `ferretd` binary bundled with the Ferret extension/u,
    );
    assert.match(
      properties['ferret.server.path']?.markdownDescription ?? '',
      /will not fall back to the bundled daemon/u,
    );
    assert.deepStrictEqual(
      {
        type: properties['ferret.server.args']?.type,
        items: properties['ferret.server.args']?.items,
        default: properties['ferret.server.args']?.default,
        scope: properties['ferret.server.args']?.scope,
      },
      {
        type: 'array',
        items: { type: 'string' },
        default: [],
        scope: 'window',
      },
    );
    assert.deepStrictEqual(
      {
        type: properties['ferret.trace.server']?.type,
        values: properties['ferret.trace.server']?.enum,
        default: properties['ferret.trace.server']?.default,
        scope: properties['ferret.trace.server']?.scope,
      },
      {
        type: 'string',
        values: ['off', 'messages', 'verbose'],
        default: 'off',
        scope: 'window',
      },
    );
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
    await waitForActivation(extension);

    assert.strictEqual(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(runFileCommand));
    assert.ok(commands.includes(cancelExecutionCommand));
  });
});

async function waitForActivation(
  extension: vscode.Extension<unknown>,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!extension.isActive && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
