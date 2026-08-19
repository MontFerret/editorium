import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  Metadata,
  status,
  type Channel,
  type ClientUnaryCall,
  type ServiceError,
} from '@grpc/grpc-js';

import type { ServerConfiguration } from '../config';
import { DaemonError } from '../daemon/errors';
import { Status } from '../daemon/gen/google/rpc/status.pb';
import { ApiCompatibilityError } from '../daemon/gen/ferretd/daemon/v1/daemon.pb';
import {
  DaemonController,
  type DaemonProcess,
  type DaemonTiming,
} from '../daemon/manager';
import type { DaemonEndpoint } from '../daemon/endpoint';
import type {
  DaemonConnection,
  DaemonGeneratedClient,
  WorkspaceGeneratedClient,
} from '../daemon/types';
import type { ServerOutput } from '../server';

const timing: DaemonTiming = {
  startupTimeout: 30,
  shutdownTimeout: 10,
  readinessAttemptTimeout: 5,
  readinessDelay: 1,
};

class FakeOutput implements ServerOutput {
  public readonly errors: string[] = [];
  public readonly infos: string[] = [];

  public error(message: string): void {
    this.errors.push(message);
  }

  public info(message: string): void {
    this.infos.push(message);
  }

  public show(): void {}
}

class FakeProcess extends EventEmitter implements DaemonProcess {
  public readonly stderr = new PassThrough();
  public readonly killSignals: (NodeJS.Signals | undefined)[] = [];
  public killCalls = 0;
  public exited = false;

  public kill(signal?: NodeJS.Signals): boolean {
    this.killCalls += 1;
    this.killSignals.push(signal);
    this.exit(null, 'SIGTERM');

    return true;
  }

  public exit(
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ): void {
    if (!this.exited) {
      this.exited = true;
      this.emit('exit', code, signal);
    }
  }
}

interface FakeRpcState {
  readonly closeWorkspaceIds: string[];
  readonly openRoots: string[];
  channelCloseCalls: number;
  getInfoCalls: number;
  shutdownCalls: number;
}

suite('Ferret daemon lifecycle', () => {
  test('spawns serve only, reconciles workspaces, and stops gracefully', async () => {
    const output = new FakeOutput();
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    let observedSignal: AbortSignal | undefined;
    let spawnArguments: readonly string[] | undefined;
    const controller = new DaemonController(
      configuration,
      output,
      (_executable, args) => {
        spawnArguments = args;
        return process;
      },
      async () => endpoint,
      (_target, signal) => {
        observedSignal = signal;
        return successfulConnection(process, signal, state);
      },
      timing,
    );

    await controller.updateWorkspaceFolders([
      '/workspace',
      '/workspace',
      '/workspace/packages/app',
    ]);
    await controller.start();
    process.stderr.write('daemon detail\n');
    await immediate();

    assert.deepStrictEqual(spawnArguments, [
      'serve',
      '--endpoint',
      endpoint.cli,
    ]);
    assert.deepStrictEqual(state.openRoots, [
      '/workspace',
      '/workspace/packages/app',
    ]);
    assert.strictEqual(controller.workspaceRegistry.workspaces.length, 2);
    assert.ok(output.infos.some((line) => line.includes('daemon detail')));

    await controller.updateWorkspaceFolders([
      '/workspace/packages/app',
      '/workspace/new',
    ]);
    assert.deepStrictEqual(state.closeWorkspaceIds, ['workspace:/workspace']);
    assert.deepStrictEqual(state.openRoots, [
      '/workspace',
      '/workspace/packages/app',
      '/workspace/new',
    ]);

    const invalidationOrder: string[] = [];
    observedSignal?.addEventListener(
      'abort',
      () => invalidationOrder.push('generation'),
      { once: true },
    );
    const workspaceListener =
      controller.workspaceRegistry.onDidInvalidateWorkspaces(() =>
        invalidationOrder.push('workspace'),
      );

    await Promise.all([controller.stop(), controller.stop()]);
    workspaceListener.dispose();
    assert.strictEqual(state.shutdownCalls, 1);
    assert.strictEqual(state.channelCloseCalls, 1);
    assert.strictEqual(endpoint.disposeCalls, 1);
    assert.strictEqual(process.killCalls, 0);
    assert.strictEqual(observedSignal?.aborted, true);
    assert.strictEqual(controller.workspaceRegistry.workspaces.length, 0);
    assert.deepStrictEqual(invalidationOrder, ['generation', 'workspace']);
  });

  test('marks unexpected exit unavailable without restarting', async () => {
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    let spawnCalls = 0;
    const controller = new DaemonController(
      configuration,
      new FakeOutput(),
      () => {
        spawnCalls += 1;
        return process;
      },
      async () => endpoint,
      (_target, signal) => successfulConnection(process, signal, state),
      timing,
    );

    await controller.updateWorkspaceFolders(['/workspace']);
    await controller.start();
    const invalidationOrder: string[] = [];
    const generation = controller.requireConnection().signal;
    generation.addEventListener(
      'abort',
      () => invalidationOrder.push('generation'),
      { once: true },
    );
    const workspaceListener =
      controller.workspaceRegistry.onDidInvalidateWorkspaces(() =>
        invalidationOrder.push('workspace'),
      );
    process.exit(2);
    await immediate();
    await immediate();

    assert.throws(
      () => controller.requireConnection(),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'unavailable',
    );
    assert.strictEqual(spawnCalls, 1);
    assert.strictEqual(state.channelCloseCalls, 1);
    assert.strictEqual(endpoint.disposeCalls, 1);
    assert.deepStrictEqual(invalidationOrder, ['generation', 'workspace']);
    workspaceListener.dispose();
  });

  test('cleans partial startup after incompatible API', async () => {
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    const controller = new DaemonController(
      configuration,
      new FakeOutput(),
      () => process,
      async () => endpoint,
      (_target, signal) =>
        connection(
          signal,
          state,
          process,
          (_request, _metadata, _options, callback) => {
            callback(null, {
              serverInfo: {
                version: '2.0.0-alpha.2',
                instanceId: 'daemon-1',
                apiVersion: { major: 1, minor: 0 },
              },
            });
            return fakeCall;
          },
        ),
      timing,
    );

    await assert.rejects(
      controller.start(),
      (error: unknown) =>
        error instanceof DaemonError &&
        error.code === 'incompatible-daemon',
    );

    assert.throws(
      () => controller.requireConnection(),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'incompatible-daemon',
    );
    assert.strictEqual(state.channelCloseCalls, 1);
    assert.strictEqual(endpoint.disposeCalls, 1);
    assert.strictEqual(process.killCalls, 1);
    assert.deepStrictEqual(process.killSignals, ['SIGKILL']);
  });

  test('decodes structured API incompatibility details', async () => {
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    const controller = new DaemonController(
      configuration,
      new FakeOutput(),
      () => process,
      async () => endpoint,
      (_target, signal) =>
        connection(
          signal,
          state,
          process,
          (_request, _metadata, _options, callback) => {
            callback(compatibilityError(), {
              serverInfo: undefined,
            });
            return fakeCall;
          },
        ),
      timing,
    );

    await assert.rejects(
      controller.start(),
      (error: unknown) =>
        error instanceof DaemonError &&
        error.code === 'incompatible-daemon',
    );

    assert.throws(
      () => controller.requireConnection(),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'incompatible-daemon',
    );
    assert.strictEqual(state.getInfoCalls, 1);
    assert.strictEqual(endpoint.disposeCalls, 1);
  });

  test('bounds readiness and force-terminates an unready daemon', async () => {
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    const output = new FakeOutput();
    const controller = new DaemonController(
      configuration,
      output,
      () => process,
      async () => endpoint,
      (_target, signal) =>
        connection(
          signal,
          state,
          process,
          (_request, _metadata, _options, callback) => {
            callback(serviceError(status.UNAVAILABLE, 'not ready'), {
              serverInfo: undefined,
            });
            return fakeCall;
          },
        ),
      timing,
    );

    await assert.rejects(
      controller.start(),
      (error: unknown) =>
        error instanceof DaemonError &&
        error.code === 'startup-failed' &&
        error.message.includes('did not become ready'),
    );

    assert.ok(state.getInfoCalls > 1);
    assert.strictEqual(process.killCalls, 1);
    assert.deepStrictEqual(process.killSignals, ['SIGKILL']);
    assert.strictEqual(endpoint.disposeCalls, 1);
    assert.deepStrictEqual(output.errors, []);
  });

  test('reports an immediate process startup failure without hanging', async () => {
    const process = new FakeProcess();
    const endpoint = fakeEndpoint();
    const state = rpcState();
    const output = new FakeOutput();
    const failure = new Error('spawn ENOENT');
    const controller = new DaemonController(
      configuration,
      output,
      () => {
        queueMicrotask(() => process.emit('error', failure));
        return process;
      },
      async () => endpoint,
      (_target, signal) =>
        connection(
          signal,
          state,
          process,
          (_request, _metadata, _options, callback) => {
            callback(serviceError(status.UNAVAILABLE, 'not ready'), {
              serverInfo: undefined,
            });
            return fakeCall;
          },
        ),
      timing,
    );

    await assert.rejects(
      controller.start(),
      (error: unknown) =>
        error instanceof DaemonError &&
        error.code === 'startup-failed' &&
        error.message.includes('spawn ENOENT'),
    );

    assert.throws(
      () => controller.requireConnection(),
      (error: unknown) =>
        error instanceof DaemonError &&
        error.code === 'startup-failed' &&
        error.message.includes('spawn ENOENT'),
    );
    assert.strictEqual(endpoint.disposeCalls, 1);
    assert.strictEqual(state.channelCloseCalls, 1);
    assert.strictEqual(process.killCalls, 0);
    assert.deepStrictEqual(output.errors, []);
  });
});

function configuration(): ServerConfiguration {
  return {
    executable: '/configured/ferretd',
    extraArguments: ['--lsp-only'],
    source: 'configured',
  };
}

function successfulConnection(
  process: FakeProcess,
  signal: AbortSignal,
  state: FakeRpcState,
): DaemonConnection {
  return connection(
    signal,
    state,
    process,
    (_request, _metadata, _options, callback) => {
      callback(null, {
        serverInfo: {
          version: '2.0.0-alpha.2',
          instanceId: 'daemon-1',
          apiVersion: { major: 1, minor: 1 },
        },
      });
      return fakeCall;
    },
  );
}

function connection(
  signal: AbortSignal,
  state: FakeRpcState,
  process: FakeProcess,
  getInfo: DaemonGeneratedClient['getInfo'],
): DaemonConnection {
  const daemon: DaemonGeneratedClient = {
    getInfo: (request, metadata, options, callback) => {
      state.getInfoCalls += 1;
      return getInfo(request, metadata, options, callback);
    },
    shutdown: (_request, _metadata, _options, callback) => {
      state.shutdownCalls += 1;
      callback(null, {});
      process.exit(0);
      return fakeCall;
    },
  };
  const workspaces: WorkspaceGeneratedClient = {
    open: (request, callback) => {
      state.openRoots.push(request.root);
      callback(null, {
        workspace: {
          id: { value: `workspace:${request.root}` },
          root: request.root,
        },
      });
      return fakeCall;
    },
    close: (request, callback) => {
      state.closeWorkspaceIds.push(request.id?.value ?? '');
      callback(null, {});
      return fakeCall;
    },
  };

  return {
    channel: {
      close: () => {
        state.channelCloseCalls += 1;
      },
    } as unknown as Channel,
    daemon,
    executions: {} as DaemonConnection['executions'],
    signal,
    workspaces,
  };
}

function fakeEndpoint(): DaemonEndpoint & { disposeCalls: number } {
  return {
    cli: 'unix:///private/ferret.sock',
    grpc: 'unix:///private/ferret.sock',
    disposeCalls: 0,
    async dispose(): Promise<void> {
      this.disposeCalls += 1;
    },
  };
}

function rpcState(): FakeRpcState {
  return {
    closeWorkspaceIds: [],
    openRoots: [],
    channelCloseCalls: 0,
    getInfoCalls: 0,
    shutdownCalls: 0,
  };
}

const fakeCall = {
  cancel: () => undefined,
} as unknown as ClientUnaryCall;

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  });
}

function compatibilityError(): ServiceError {
  const error = serviceError(
    status.FAILED_PRECONDITION,
    'incompatible API',
  );
  error.metadata.set(
    'grpc-status-details-bin',
    Buffer.from(
      Status.encode({
        code: status.FAILED_PRECONDITION,
        message: error.details,
        details: [
          {
            typeUrl:
              'type.googleapis.com/ferretd.daemon.v1.ApiCompatibilityError',
            value: Buffer.from(
              ApiCompatibilityError.encode({
                clientApi: { major: 1, minor: 1 },
                serverApi: { major: 1, minor: 0 },
              }).finish(),
            ),
          },
        ],
      }).finish(),
    ),
  );

  return error;
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
