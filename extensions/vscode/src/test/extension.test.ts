import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { debugFileCommand } from '../debug/commands';
import {
  cancelExecutionCommand,
  runFileCommand,
} from '../execution/commands';
import { showExecutionOutputCommand } from '../execution/feedback';
import { restartForServerConfigurationChange } from '../extension';
import { extensionId } from './extension-identity';

class FakeServerLifecycleController {
  public restarts = 0;
  public languageServerRestarts = 0;

  public async restart(): Promise<void> {
    this.restarts += 1;
  }

  public async restartLanguageServer(): Promise<void> {
    this.languageServerRestarts += 1;
  }
}

interface FerretManifest {
  activationEvents: string[];
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
    breakpoints: Array<{
      language: string;
    }>;
    debuggers: Array<{
      type: string;
      label: string;
      languages: string[];
      configurationAttributes: Record<
        string,
        {
          required: string[];
          properties: Record<
            string,
            {
              type?: string;
              description?: string;
              default?: unknown;
              enum?: string[];
            }
          >;
        }
      >;
      initialConfigurations?: unknown;
      configurationSnippets?: unknown;
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

suite('Ferret server configuration lifecycle', () => {
  test('restarts both services when the executable path changes', async () => {
    const controller = new FakeServerLifecycleController();

    await restartForServerConfigurationChange(
      configurationChange('ferret.server.path'),
      controller,
    );

    assert.strictEqual(controller.restarts, 1);
    assert.strictEqual(controller.languageServerRestarts, 0);
  });

  test('restarts only the LSP when its arguments change', async () => {
    const controller = new FakeServerLifecycleController();

    await restartForServerConfigurationChange(
      configurationChange('ferret.server.args'),
      controller,
    );

    assert.strictEqual(controller.restarts, 0);
    assert.strictEqual(controller.languageServerRestarts, 1);
  });

  test('gives a path change precedence when both settings change', async () => {
    const controller = new FakeServerLifecycleController();

    await restartForServerConfigurationChange(
      configurationChange(
        'ferret.server.path',
        'ferret.server.args',
      ),
      controller,
    );

    assert.strictEqual(controller.restarts, 1);
    assert.strictEqual(controller.languageServerRestarts, 0);
  });
});

suite('Ferret declarative language support', () => {
  test('contributes language support and thin-client configuration', () => {
    const manifest = getExtension().packageJSON as FerretManifest;

    assert.deepStrictEqual(manifest.activationEvents, [
      'onDebugResolve:ferret',
    ]);
    assert.deepStrictEqual(manifest.extensionKind, ['workspace']);
    assert.deepStrictEqual(Object.keys(manifest.contributes), [
      'languages',
      'grammars',
      'breakpoints',
      'debuggers',
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
    assert.deepStrictEqual(manifest.contributes.breakpoints, [
      {
        language: manifest.contributes.languages[0]?.id,
      },
    ]);
    assert.strictEqual(manifest.contributes.debuggers.length, 1);
    const debuggerContribution = manifest.contributes.debuggers[0];
    assert.ok(debuggerContribution);
    assert.strictEqual(debuggerContribution.type, 'ferret');
    assert.strictEqual(debuggerContribution.label, 'Ferret');
    assert.deepStrictEqual(debuggerContribution.languages, ['ferret']);
    assert.strictEqual(
      'initialConfigurations' in debuggerContribution,
      false,
    );
    assert.strictEqual(
      'configurationSnippets' in debuggerContribution,
      false,
    );
    assert.deepStrictEqual(
      Object.keys(debuggerContribution.configurationAttributes),
      ['launch'],
    );
    const launch = debuggerContribution.configurationAttributes.launch;
    assert.ok(launch);
    assert.ok(launch.required.includes('program'));
    assert.deepStrictEqual(
      {
        type: launch.properties.program?.type,
        description: launch.properties.program?.description,
      },
      {
        type: 'string',
        description:
          'Path to the .fql Ferret program to debug. Required in launch.json; zero-configuration debugging uses the active file.',
      },
    );
    assert.deepStrictEqual(
      {
        type: launch.properties.cwd?.type,
        description: launch.properties.cwd?.description,
      },
      {
        type: 'string',
        description:
          "Working directory for the debugged Ferret program. Optional; zero-configuration debugging uses the containing workspace folder or the file's directory.",
      },
    );
    assert.deepStrictEqual(
      {
        type: launch.properties.parameters?.type,
        description: launch.properties.parameters?.description,
      },
      {
        type: 'object',
        description: 'Object containing FQL bind parameter values.',
      },
    );
    assert.deepStrictEqual(
      {
        type: launch.properties.stopOnEntry?.type,
        default: launch.properties.stopOnEntry?.default,
        description: launch.properties.stopOnEntry?.description,
      },
      {
        type: 'boolean',
        default: false,
        description: 'Pause before normal program execution begins.',
      },
    );
    assert.deepStrictEqual(manifest.contributes.commands, [
      {
        command: 'ferret.restartLanguageServer',
        title: 'Restart Language Server',
        category: 'Ferret',
      },
      {
        command: runFileCommand,
        title: 'Run Current File',
        category: 'Ferret',
        icon: '$(play)',
        enablement:
          'editorLangId == ferret && resourceScheme == file && !ferret.executionRunning',
      },
      {
        command: debugFileCommand,
        title: 'Debug Current File',
        category: 'Ferret',
        icon: '$(debug-alt)',
        enablement:
          'editorLangId == ferret && resourceScheme == file',
      },
      {
        command: cancelExecutionCommand,
        title: 'Cancel Execution',
        category: 'Ferret',
        icon: '$(debug-stop)',
        enablement:
          'editorLangId == ferret && resourceScheme == file && ferret.executionRunning',
      },
      {
        command: showExecutionOutputCommand,
        title: 'Show Output',
        category: 'Ferret',
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
        {
          command: debugFileCommand,
          when: 'resourceLangId == ferret && resourceScheme == file',
          group: 'navigation@2',
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
      /will not fall back to the bundled executable/u,
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
    assert.ok(commands.includes(debugFileCommand));
    assert.ok(commands.includes(cancelExecutionCommand));
    assert.ok(commands.includes(showExecutionOutputCommand));
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

function configurationChange(
  ...affected: readonly string[]
): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: (section: string) =>
      affected.includes(section),
  } as vscode.ConfigurationChangeEvent;
}
