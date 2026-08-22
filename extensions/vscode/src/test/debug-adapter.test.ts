import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  type DebugAdapterRegistrationHost,
  FerretDebugAdapterDescriptorFactory,
  ferretDebugType,
  registerFerretDebugAdapter,
} from '../debug/adapter';
import type { FerretdExecutable } from '../ferretd';
import type { ServerOutput } from '../server';

class FakeOutput implements ServerOutput {
  public readonly errors: Array<{
    readonly args: readonly unknown[];
    readonly message: string;
  }> = [];
  public readonly infos: string[] = [];

  public error(message: string, ...args: unknown[]): void {
    this.errors.push({ args, message });
  }

  public info(message: string): void {
    this.infos.push(message);
  }

  public show(): void {}
}

class FakeRegistrationHost implements DebugAdapterRegistrationHost {
  public debugType: string | undefined;
  public disposed = false;
  public factory: vscode.DebugAdapterDescriptorFactory | undefined;

  public registerDebugAdapterDescriptorFactory(
    debugType: string,
    factory: vscode.DebugAdapterDescriptorFactory,
  ): vscode.Disposable {
    assert.strictEqual(this.factory, undefined);
    this.debugType = debugType;
    this.factory = factory;

    return {
      dispose: () => {
        this.disposed = true;
        this.factory = undefined;
      },
    };
  }
}

suite('Ferret debug adapter registration', () => {
  test('resolves a fresh executable descriptor for every session', async () => {
    const output = new FakeOutput();
    const selection = configuredExecutable();
    let resolveCalls = 0;
    const factory = new FerretDebugAdapterDescriptorFactory(
      async () => {
        resolveCalls += 1;
        return selection;
      },
      output,
    );

    const first = await factory.createDebugAdapterDescriptor();
    const second = await factory.createDebugAdapterDescriptor();

    assert.ok(first instanceof vscode.DebugAdapterExecutable);
    assert.ok(second instanceof vscode.DebugAdapterExecutable);
    assert.notStrictEqual(first, second);
    assert.strictEqual(resolveCalls, 2);
    assert.strictEqual(first.command, selection.executable);
    assert.deepStrictEqual(first.args, ['dap']);
    assert.strictEqual(first.options, undefined);
    assert.strictEqual(second.command, selection.executable);
    assert.deepStrictEqual(second.args, ['dap']);
    assert.deepStrictEqual(output.errors, []);
    assert.ok(
      output.infos.includes(
        'Ferret debug adapter source: configured override',
      ),
    );
    assert.ok(
      output.infos.includes('Ferret debug adapter arguments: ["dap"]'),
    );
  });

  test('logs and preserves actionable resolution failures', async () => {
    const output = new FakeOutput();
    const failure = new Error(
      'Correct ferret.server.path before starting Ferret debugging.',
    );
    const factory = new FerretDebugAdapterDescriptorFactory(
      async () => {
        throw failure;
      },
      output,
    );

    await assert.rejects(
      factory.createDebugAdapterDescriptor(),
      (error: unknown) => error === failure,
    );
    assert.deepStrictEqual(output.errors, [
      {
        message: 'Starting Ferret debug adapter failed',
        args: [failure],
      },
    ]);
  });

  test('registers the ferret factory and releases the registration', () => {
    const output = new FakeOutput();
    const host = new FakeRegistrationHost();
    const registration = registerFerretDebugAdapter(
      async () => configuredExecutable(),
      output,
      host,
    );

    assert.strictEqual(host.debugType, ferretDebugType);
    assert.ok(
      host.factory instanceof FerretDebugAdapterDescriptorFactory,
    );
    assert.strictEqual(host.disposed, false);

    registration.dispose();
    assert.strictEqual(host.disposed, true);
    assert.strictEqual(host.factory, undefined);
  });
});

function configuredExecutable(): FerretdExecutable {
  return {
    executable: '/opt/ferret/bin/ferretd',
    source: 'configured',
  };
}
