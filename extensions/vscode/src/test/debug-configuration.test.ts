import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import {
  type DebugAdapterTrackerRegistrationHost,
  normalizeFerretLaunchArguments,
  normalizeFerretLaunchRequest,
  registerFerretLaunchConfigurationTracker,
} from '../debug/configuration';

class FakeTrackerRegistrationHost
  implements DebugAdapterTrackerRegistrationHost
{
  public debugType: string | undefined;
  public disposed = false;
  public factory: vscode.DebugAdapterTrackerFactory | undefined;

  public registerDebugAdapterTrackerFactory(
    debugType: string,
    factory: vscode.DebugAdapterTrackerFactory,
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

suite('Ferret debug launch configuration', () => {
  test('removes VS Code metadata and preserves Ferret arguments', () => {
    const parameters = {
      url: 'https://example.com',
      nested: { enabled: true },
    };
    const configuration = {
      type: 'ferret',
      request: 'launch',
      name: 'Debug Ferret',
      __configurationTarget: 5,
      __sessionId: 'session-1',
      program: '/workspace/example.fql',
      cwd: '/workspace',
      parameters,
      stopOnEntry: true,
      futureFerretArgument: 'preserved',
    };

    const normalized = normalizeFerretLaunchArguments(configuration);

    assert.notStrictEqual(normalized, configuration);
    assert.deepStrictEqual(normalized, {
      program: '/workspace/example.fql',
      cwd: '/workspace',
      parameters,
      stopOnEntry: true,
      futureFerretArgument: 'preserved',
    });
    assert.deepStrictEqual(configuration, {
      type: 'ferret',
      request: 'launch',
      name: 'Debug Ferret',
      __configurationTarget: 5,
      __sessionId: 'session-1',
      program: '/workspace/example.fql',
      cwd: '/workspace',
      parameters,
      stopOnEntry: true,
      futureFerretArgument: 'preserved',
    });
    assert.strictEqual(normalized.parameters, parameters);
  });

  test('normalizes only outbound launch requests', () => {
    const launch = {
      seq: 2,
      type: 'request',
      command: 'launch',
      arguments: {
        type: 'ferret',
        request: 'launch',
        name: 'Debug Ferret',
        program: '/workspace/example.fql',
      },
    };
    const initialize = {
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: { type: 'client metadata' },
    };
    const launchResponse = {
      seq: 3,
      type: 'response',
      command: 'launch',
      arguments: { type: 'adapter metadata' },
    };

    normalizeFerretLaunchRequest(launch);
    normalizeFerretLaunchRequest(initialize);
    normalizeFerretLaunchRequest(launchResponse);

    assert.deepStrictEqual(launch.arguments, {
      program: '/workspace/example.fql',
    });
    assert.deepStrictEqual(initialize.arguments, {
      type: 'client metadata',
    });
    assert.deepStrictEqual(launchResponse.arguments, {
      type: 'adapter metadata',
    });
  });

  test('registers and disposes the launch tracker', async () => {
    const host = new FakeTrackerRegistrationHost();
    const registration = registerFerretLaunchConfigurationTracker(host);

    assert.strictEqual(host.debugType, 'ferret');
    assert.ok(host.factory);
    assert.strictEqual(host.disposed, false);

    const tracker = await Promise.resolve(
      host.factory.createDebugAdapterTracker(
        {} as vscode.DebugSession,
      ),
    );
    assert.ok(tracker);
    const message = {
      seq: 1,
      type: 'request',
      command: 'launch',
      arguments: {
        type: 'ferret',
        request: 'launch',
        name: 'Debug Ferret',
        program: '/workspace/example.fql',
      },
    };
    tracker.onWillReceiveMessage?.(message);
    assert.deepStrictEqual(message.arguments, {
      program: '/workspace/example.fql',
    });

    registration.dispose();
    assert.strictEqual(host.disposed, true);
    assert.strictEqual(host.factory, undefined);
  });
});
