import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  debugFileCommand,
  type FerretDebugCommandHost,
  registerFerretDebugCommand,
} from '../debug/commands';

class FakeDebugCommandHost implements FerretDebugCommandHost {
  private handler: (() => Thenable<boolean>) | undefined;

  public command: string | undefined;
  public disposed = false;
  public readonly startCalls: Array<{
    readonly configuration: vscode.DebugConfiguration;
    readonly folder: vscode.WorkspaceFolder | undefined;
  }> = [];

  public registerCommand(
    command: string,
    handler: () => Thenable<boolean>,
  ): vscode.Disposable {
    assert.strictEqual(this.handler, undefined);
    this.command = command;
    this.handler = handler;

    return new vscode.Disposable(() => {
      this.disposed = true;
      this.handler = undefined;
    });
  }

  public async startDebugging(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Promise<boolean> {
    this.startCalls.push({ configuration, folder });

    return true;
  }

  public async invoke(): Promise<boolean> {
    assert.ok(this.handler, 'Expected the debug command to be registered');

    return this.handler();
  }
}

suite('Ferret debug command', () => {
  test('registers and starts the standard Ferret debug path', async () => {
    const host = new FakeDebugCommandHost();
    const registration = registerFerretDebugCommand(host);

    try {
      assert.strictEqual(host.command, debugFileCommand);
      assert.strictEqual(await host.invoke(), true);
      assert.deepStrictEqual(host.startCalls, [
        {
          folder: undefined,
          configuration: { type: 'ferret' },
        },
      ]);
    } finally {
      registration.dispose();
    }

    assert.strictEqual(host.disposed, true);
    await assert.rejects(host.invoke(), /registered/u);
  });
});
