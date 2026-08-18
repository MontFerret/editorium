import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import type { InitializeResult } from 'vscode-languageclient/node';

import type { ServerConfiguration } from '../config';
import {
  ConfiguredTraceOutputChannel,
  LanguageServerController,
  type ClientFailureHandler,
  type LanguageClientHandle,
  type ServerOutput,
} from '../server';

class FakeClient implements LanguageClientHandle {
  public readonly initializeResult: InitializeResult | undefined;
  public disposeCalls = 0;
  public running = false;
  public startCalls = 0;
  public stopCalls = 0;
  public startError: Error | undefined;
  public startErrorBeforeRunning = false;
  public reportBeforeStartFailure = false;

  public constructor(
    private readonly reportFailure: ClientFailureHandler,
    private readonly operation?: OperationTracker,
  ) {}

  public needsStop(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    await this.runOperation(async () => {
      this.startCalls += 1;
      this.running = !this.startErrorBeforeRunning;

      if (this.startError !== undefined) {
        if (this.reportBeforeStartFailure) {
          await this.reportFailure(this.startError);
        }

        throw this.startError;
      }
    });
  }

  public async stop(): Promise<void> {
    await this.runOperation(async () => {
      this.stopCalls += 1;
      this.running = false;
    });
  }

  public async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.running = false;
  }

  public fail(error: Error): Promise<void> {
    return this.reportFailure(error);
  }

  private runOperation(operation: () => Promise<void>): Promise<void> {
    return this.operation?.run(operation) ?? operation();
  }
}

class FakeOutput implements ServerOutput {
  public readonly errors: string[] = [];
  public readonly infos: string[] = [];
  public showCalls = 0;

  public error(message: string): void {
    this.errors.push(message);
  }

  public info(message: string): void {
    this.infos.push(message);
  }

  public show(): void {
    this.showCalls += 1;
  }
}

class OperationTracker {
  public active = 0;
  public maximum = 0;

  public async run(operation: () => Promise<void>): Promise<void> {
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await operation();
    } finally {
      this.active -= 1;
    }
  }
}

function serverConfiguration(
  executable: string,
  source: 'bundled' | 'configured' = 'configured',
): ServerConfiguration {
  if (source === 'bundled') {
    return {
      executable,
      extraArguments: [],
      source,
      bundledVersion: '2.0.0-alpha.2',
    };
  }

  return { executable, extraArguments: [], source };
}

suite('Ferret language server lifecycle', () => {
  test('maps the conventional trace setting to language-client tracing', async () => {
    const configuration = vscode.workspace.getConfiguration('ferret');
    const output = vscode.window.createOutputChannel(
      `Ferret trace test ${Date.now()}`,
      { log: true },
    );

    await configuration.update(
      'trace.server',
      'off',
      vscode.ConfigurationTarget.Global,
    );
    const traceOutput = new ConfiguredTraceOutputChannel(output);

    try {
      assert.strictEqual(traceOutput.logLevel, vscode.LogLevel.Info);

      await configuration.update(
        'trace.server',
        'messages',
        vscode.ConfigurationTarget.Global,
      );
      await waitForTraceLevel(traceOutput, vscode.LogLevel.Trace);

      await configuration.update(
        'trace.server',
        'off',
        vscode.ConfigurationTarget.Global,
      );
      await waitForTraceLevel(traceOutput, vscode.LogLevel.Info);
    } finally {
      traceOutput.dispose();
      output.dispose();
      await configuration.update(
        'trace.server',
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
  });

  test('starts and stops idempotently', async () => {
    const output = new FakeOutput();
    const clients: FakeClient[] = [];
    const controller = new LanguageServerController(
      () => serverConfiguration('ferretd'),
      (_configuration, reportFailure) => {
        const client = new FakeClient(reportFailure);
        clients.push(client);

        return client;
      },
      output,
      async () => false,
    );

    await controller.start();
    await controller.start();
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0]?.startCalls, 1);

    await controller.stop();
    await controller.stop();
    assert.strictEqual(clients[0]?.stopCalls, 1);
    assert.ok(
      output.infos.includes('Ferret language server started'),
    );
    assert.ok(
      output.infos.includes('Ferret language server stopped'),
    );
    assert.ok(
      output.infos.includes(
        'Ferret language server source: configured override',
      ),
    );
    assert.ok(output.infos.includes('Executable: ferretd'));
  });

  test('restart stops the old client and reloads configuration', async () => {
    const output = new FakeOutput();
    const configurations = [
      {
        executable: '/first/ferretd',
        extraArguments: ['--first'],
        source: 'configured' as const,
      },
      {
        executable: '/second/ferretd',
        extraArguments: ['--second'],
        source: 'configured' as const,
      },
    ];
    const created: Array<{
      client: FakeClient;
      configuration: ServerConfiguration;
    }> = [];
    let readIndex = 0;
    const controller = new LanguageServerController(
      () => configurations[readIndex++] ?? configurations[1]!,
      (configuration, reportFailure) => {
        const client = new FakeClient(reportFailure);
        created.push({ client, configuration });

        return client;
      },
      output,
      async () => false,
    );

    await controller.start();
    await controller.restart();

    assert.deepStrictEqual(
      created.map(({ configuration }) => configuration),
      configurations,
    );
    assert.strictEqual(created[0]?.client.stopCalls, 1);
    assert.strictEqual(created[1]?.client.startCalls, 1);
  });

  test('coalesces and serializes concurrent restart requests', async () => {
    const output = new FakeOutput();
    const operation = new OperationTracker();
    const clients: FakeClient[] = [];
    const controller = new LanguageServerController(
      () => serverConfiguration('ferretd'),
      (_configuration, reportFailure) => {
        const client = new FakeClient(reportFailure, operation);
        clients.push(client);

        return client;
      },
      output,
      async () => false,
    );

    await controller.start();
    await Promise.all([controller.restart(), controller.restart()]);

    assert.strictEqual(operation.maximum, 1);
    assert.strictEqual(clients.length, 2);
    assert.strictEqual(clients[0]?.stopCalls, 1);
    assert.strictEqual(clients[1]?.startCalls, 1);
  });

  test('cleans up a partially started client', async () => {
    const output = new FakeOutput();
    let client: FakeClient | undefined;
    const controller = new LanguageServerController(
      () => serverConfiguration('/broken/ferretd'),
      (_configuration, reportFailure) => {
        client = new FakeClient(reportFailure);
        client.startError = new Error('initialization failed');
        client.startErrorBeforeRunning = true;

        return client;
      },
      output,
      async () => false,
    );

    await controller.start();

    assert.strictEqual(client?.disposeCalls, 1);
    assert.strictEqual(client?.running, false);
    assert.match(output.errors[0] ?? '', /initialization failed/u);
  });

  test('logs bundled source and version without its installation path', async () => {
    const output = new FakeOutput();
    const controller = new LanguageServerController(
      () => serverConfiguration('/extension/bin/ferretd', 'bundled'),
      (_configuration, reportFailure) =>
        new FakeClient(reportFailure),
      output,
      async () => false,
    );

    await controller.start();

    assert.ok(
      output.infos.includes('Ferret language server source: bundled'),
    );
    assert.ok(output.infos.includes('Bundled ferretd: 2.0.0-alpha.2'));
    assert.ok(
      !output.infos.some((message) => message.includes('/extension/bin')),
    );
  });

  test('reports one actionable failure per client generation', async () => {
    const output = new FakeOutput();
    const notifications: string[] = [];
    let client: FakeClient | undefined;
    const controller = new LanguageServerController(
      () => serverConfiguration('/missing/ferretd'),
      (_configuration, reportFailure) => {
        client = new FakeClient(reportFailure);
        client.startError = new Error('spawn ENOENT');
        client.reportBeforeStartFailure = true;

        return client;
      },
      output,
      async (message) => {
        notifications.push(message);

        return true;
      },
    );

    await controller.start();
    await client?.fail(new Error('connection closed'));

    assert.strictEqual(output.errors.length, 1);
    assert.strictEqual(notifications.length, 1);
    assert.match(notifications[0] ?? '', /\/missing\/ferretd/u);
    assert.match(notifications[0] ?? '', /ferret\.server\.path/u);
    assert.strictEqual(output.showCalls, 1);
  });

  test('reports a bundled failure without override guidance', async () => {
    const output = new FakeOutput();
    const notifications: string[] = [];
    const controller = new LanguageServerController(
      () => serverConfiguration('/extension/bin/ferretd', 'bundled'),
      (_configuration, reportFailure) => {
        const client = new FakeClient(reportFailure);
        client.startError = new Error('spawn EACCES');

        return client;
      },
      output,
      async (message) => {
        notifications.push(message);

        return false;
      },
    );

    await controller.start();

    assert.match(notifications[0] ?? '', /bundled with the Ferret/u);
    assert.doesNotMatch(
      notifications[0] ?? '',
      /Correct ferret\.server\.path/u,
    );
  });

  test('does not block startup on the failure notification choice', async () => {
    const output = new FakeOutput();
    let resolveNotification: ((showOutput: boolean) => void) | undefined;
    const notification = new Promise<boolean>((resolve) => {
      resolveNotification = resolve;
    });
    const controller = new LanguageServerController(
      () => serverConfiguration('/missing/ferretd'),
      (_configuration, reportFailure) => {
        const client = new FakeClient(reportFailure);
        client.startError = new Error('spawn ENOENT');

        return client;
      },
      output,
      () => notification,
    );

    await controller.start();
    assert.strictEqual(output.errors.length, 1);

    resolveNotification?.(false);
  });
});

async function waitForTraceLevel(
  output: ConfiguredTraceOutputChannel,
  expected: vscode.LogLevel,
): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (output.logLevel !== expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  assert.strictEqual(output.logLevel, expected);
}
