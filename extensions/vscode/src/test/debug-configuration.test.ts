import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  type DebugConfigurationRegistrationHost,
  type FerretDebugConfigurationHost,
  FerretDebugConfigurationProvider,
  registerFerretDebugConfigurationProvider,
} from '../debug/configuration';

class FakeConfigurationHost implements FerretDebugConfigurationHost {
  public activeDocument: vscode.TextDocument | undefined;
  public errors: string[] = [];
  public workspaceFolder: vscode.WorkspaceFolder | undefined;
  public workspaceFolderRequests: vscode.Uri[] = [];

  public getActiveDocument(): vscode.TextDocument | undefined {
    return this.activeDocument;
  }

  public getWorkspaceFolder(
    uri: vscode.Uri,
  ): vscode.WorkspaceFolder | undefined {
    this.workspaceFolderRequests.push(uri);

    return this.workspaceFolder;
  }

  public async showErrorMessage(message: string): Promise<void> {
    this.errors.push(message);
  }
}

class FakeRegistrationHost implements DebugConfigurationRegistrationHost {
  public debugType: string | undefined;
  public disposed = false;
  public provider: vscode.DebugConfigurationProvider | undefined;
  public triggerKind:
    | vscode.DebugConfigurationProviderTriggerKind
    | undefined;

  public registerDebugConfigurationProvider(
    debugType: string,
    provider: vscode.DebugConfigurationProvider,
    triggerKind?: vscode.DebugConfigurationProviderTriggerKind,
  ): vscode.Disposable {
    assert.strictEqual(this.provider, undefined);
    this.debugType = debugType;
    this.provider = provider;
    this.triggerKind = triggerKind;

    return {
      dispose: () => {
        this.disposed = true;
        this.provider = undefined;
      },
    };
  }
}

suite('Ferret debug configuration provider', () => {
  test('provides one minimal initial launch configuration', () => {
    const provider = new FerretDebugConfigurationProvider(
      new FakeConfigurationHost(),
    );

    assert.deepStrictEqual(provider.provideDebugConfigurations(), [
      {
        type: 'ferret',
        request: 'launch',
        name: 'Debug Ferret',
        program: '${file}',
        cwd: '${workspaceFolder}',
      },
    ]);
  });

  test('resolves the active Ferret file in its containing workspace', async () => {
    const host = new FakeConfigurationHost();
    const document = ferretDocument(
      '/workspace/secondary/query.fql',
    );
    host.activeDocument = document;
    host.workspaceFolder = workspaceFolder(
      'secondary',
      '/workspace/secondary',
      1,
    );
    const provider = new FerretDebugConfigurationProvider(host);

    const resolved = await provider.resolveDebugConfiguration(
      undefined,
      zeroConfiguration({ __configurationTarget: 5 }),
    );

    assert.deepStrictEqual(resolved, {
      __configurationTarget: 5,
      type: 'ferret',
      request: 'launch',
      name: 'Debug Current Ferret File',
      program: '${file}',
      cwd: host.workspaceFolder.uri.fsPath,
      stopOnEntry: false,
    });
    assert.deepStrictEqual(host.workspaceFolderRequests, [document.uri]);
    assert.deepStrictEqual(host.errors, []);
  });

  test('uses the document directory for a standalone Ferret file', async () => {
    const host = new FakeConfigurationHost();
    host.activeDocument = ferretDocument('/standalone/query.fql');
    const provider = new FerretDebugConfigurationProvider(host);

    const resolved = await provider.resolveDebugConfiguration(
      undefined,
      zeroConfiguration(),
    );

    assert.strictEqual(resolved?.cwd, vscode.Uri.file('/standalone').fsPath);
    assert.strictEqual(resolved?.program, '${file}');
    assert.deepStrictEqual(host.errors, []);
  });

  test('preserves explicit Ferret values and future metadata', async () => {
    const host = new FakeConfigurationHost();
    const provider = new FerretDebugConfigurationProvider(host);
    const parameters = {
      baseUrl: 'https://example.com',
      nested: { enabled: true },
    };
    const configuration = {
      type: 'ferret',
      request: 'launch',
      name: 'Debug API scraper',
      program: '${workspaceFolder}/scripts/scrape.fql',
      cwd: '${workspaceFolder}',
      parameters,
      stopOnEntry: true,
      futureFerretOption: 'preserved',
    };

    const resolved = await provider.resolveDebugConfiguration(
      workspaceFolder('primary', '/workspace', 0),
      configuration,
    );

    assert.deepStrictEqual(resolved, configuration);
    assert.strictEqual(resolved?.parameters, parameters);
    assert.deepStrictEqual(host.workspaceFolderRequests, []);
    assert.deepStrictEqual(host.errors, []);
  });

  test('defaults only an absent stopOnEntry value', async () => {
    const provider = new FerretDebugConfigurationProvider(
      new FakeConfigurationHost(),
    );
    const configuration = {
      type: 'ferret',
      request: 'launch',
      name: 'Debug Ferret',
      program: '/workspace/query.fql',
    };

    const resolved = await provider.resolveDebugConfiguration(
      workspaceFolder('primary', '/workspace', 0),
      configuration,
    );
    const explicitNull = await provider.resolveDebugConfiguration(
      undefined,
      { ...configuration, stopOnEntry: null },
    );

    assert.deepStrictEqual(resolved, {
      ...configuration,
      stopOnEntry: false,
    });
    assert.strictEqual('cwd' in (resolved ?? {}), false);
    assert.strictEqual(explicitNull?.stopOnEntry, null);
  });

  test('rejects zero-configuration debugging without an active editor', async () => {
    const host = new FakeConfigurationHost();
    const provider = new FerretDebugConfigurationProvider(host);

    assert.strictEqual(
      await provider.resolveDebugConfiguration(
        undefined,
        zeroConfiguration(),
      ),
      undefined,
    );
    assert.deepStrictEqual(host.errors, [
      'Open a Ferret (.fql) file before starting a debug session.',
    ]);
  });

  test('rejects a non-Ferret active document', async () => {
    const host = new FakeConfigurationHost();
    host.activeDocument = ferretDocument('/workspace/query.fql', {
      languageId: 'plaintext',
    });
    const provider = new FerretDebugConfigurationProvider(host);

    assert.strictEqual(
      await provider.resolveDebugConfiguration(
        undefined,
        zeroConfiguration(),
      ),
      undefined,
    );
    assert.deepStrictEqual(host.errors, [
      'The active file is not a Ferret (.fql) file.',
    ]);
  });

  test('rejects untitled and non-file Ferret documents', async () => {
    for (const document of [
      ferretDocument('/workspace/query.fql', { isUntitled: true }),
      ferretDocument('/workspace/query.fql', {
        uri: vscode.Uri.parse(
          'vscode-remote://host/workspace/query.fql',
        ),
      }),
    ]) {
      const host = new FakeConfigurationHost();
      host.activeDocument = document;
      const provider = new FerretDebugConfigurationProvider(host);

      assert.strictEqual(
        await provider.resolveDebugConfiguration(
          undefined,
          zeroConfiguration(),
        ),
        undefined,
      );
      assert.deepStrictEqual(host.errors, [
        'Save the Ferret file before starting a debug session.',
      ]);
    }
  });

  test('rejects explicit configurations without a usable program', async () => {
    for (const program of [undefined, '', '   ', 42]) {
      const host = new FakeConfigurationHost();
      const provider = new FerretDebugConfigurationProvider(host);
      const configuration: vscode.DebugConfiguration = {
        type: 'ferret',
        request: 'launch',
        name: 'Debug Ferret',
      };
      if (program !== undefined) {
        configuration.program = program;
      }

      assert.strictEqual(
        await provider.resolveDebugConfiguration(
          undefined,
          configuration,
        ),
        undefined,
      );
      assert.deepStrictEqual(host.errors, [
        'Set "program" to the Ferret (.fql) file to debug.',
      ]);
    }
  });

  test('validates only the substituted program shape', async () => {
    const host = new FakeConfigurationHost();
    const provider = new FerretDebugConfigurationProvider(host);
    const configuration = {
      type: 'ferret',
      request: 'launch',
      name: 'Debug Ferret',
      program: '/workspace/query.fql',
      cwd: '/workspace',
      parameters: { input: true },
      stopOnEntry: false,
    };

    assert.strictEqual(
      await provider.resolveDebugConfigurationWithSubstitutedVariables(
        undefined,
        configuration,
      ),
      configuration,
    );
    assert.deepStrictEqual(host.errors, []);

    for (const program of [
      '',
      '/workspace/query.FQL',
      '/workspace',
      42,
    ]) {
      assert.strictEqual(
        await provider.resolveDebugConfigurationWithSubstitutedVariables(
          undefined,
          { ...configuration, program },
        ),
        undefined,
      );
    }
    assert.deepStrictEqual(host.errors, [
      'The debug "program" must point to a Ferret (.fql) file.',
      'The debug "program" must point to a Ferret (.fql) file.',
      'The debug "program" must point to a Ferret (.fql) file.',
      'The debug "program" must point to a Ferret (.fql) file.',
    ]);
  });

  test('registers one initial provider and releases it', () => {
    const registrationHost = new FakeRegistrationHost();
    const configurationHost = new FakeConfigurationHost();
    const registration = registerFerretDebugConfigurationProvider(
      registrationHost,
      configurationHost,
    );

    assert.strictEqual(registrationHost.debugType, 'ferret');
    assert.ok(
      registrationHost.provider instanceof
        FerretDebugConfigurationProvider,
    );
    assert.strictEqual(
      registrationHost.triggerKind,
      vscode.DebugConfigurationProviderTriggerKind.Initial,
    );
    assert.strictEqual(registrationHost.disposed, false);

    registration.dispose();
    assert.strictEqual(registrationHost.disposed, true);
    assert.strictEqual(registrationHost.provider, undefined);
  });
});

function ferretDocument(
  path: string,
  overrides: {
    readonly isUntitled?: boolean;
    readonly languageId?: string;
    readonly uri?: vscode.Uri;
  } = {},
): vscode.TextDocument {
  return {
    isUntitled: overrides.isUntitled ?? false,
    languageId: overrides.languageId ?? 'ferret',
    uri: overrides.uri ?? vscode.Uri.file(path),
  } as vscode.TextDocument;
}

function zeroConfiguration(
  values: Readonly<Record<string, unknown>> = {},
): vscode.DebugConfiguration {
  return { ...values } as vscode.DebugConfiguration;
}

function workspaceFolder(
  name: string,
  path: string,
  index: number,
): vscode.WorkspaceFolder {
  return {
    index,
    name,
    uri: vscode.Uri.file(path),
  };
}
