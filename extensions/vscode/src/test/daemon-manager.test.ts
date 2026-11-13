import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
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
import { listRuntimes } from '../runtime/catalog';
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
        return successfulConnection(process, signal, state, { major: 1, minor: 3 });
      },
      timing,
    );

    const root = resolve('workspace');
    const app = join(root, 'packages', 'app');
    const added = join(root, 'new');
    await controller.updateWorkspaceFolders([root, root, app]);
    await controller.start();
    assert.deepEqual(state.openRoots, []);
    await controller.prepareWorkspaces(controller.requireConnection().signal);
    process.stderr.write('daemon detail\n');
    await immediate();

    assert.deepStrictEqual(spawnArguments, [
      'serve',
      '--endpoint',
      endpoint.cli,
    ]);
    assert.deepStrictEqual(state.openRoots, [root, app]);
    assert.strictEqual(controller.workspaceRegistry.workspaces.length, 2);
    assert.ok(output.infos.some((line) => line.includes('daemon detail')));

    await controller.updateWorkspaceFolders([app, added]);
    assert.deepStrictEqual(state.closeWorkspaceIds, [`workspace:${root}`]);
    assert.deepStrictEqual(state.openRoots, [root, app, added]);

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

  test('catalog discovery completes while workspace opening for concurrent Runs is held', async () => {
    const process = new FakeProcess();
    const state = rpcState();
    const root = resolve('workspace');
    let opened!: () => void, completeOpen!: () => void;
    const opening = new Promise<void>(resolve => { opened = resolve; });
    const controller = new DaemonController(configuration, new FakeOutput(), () => process, async () => fakeEndpoint(),
      (_target, signal) => {
        const live = successfulConnection(process, signal, state, { major: 1, minor: 3 });
        live.daemon.listRuntimes = (_request, _metadata, _options, callback) => {
          callback(null, { defaultRuntime: 'local', runtimes: [{ name: 'local', label: 'Local', provider: 'native' }] });
          return fakeCall;
        };
        const open = live.workspaces.open;
        live.workspaces.open = (request, callback) => {
          opened();
          completeOpen = () => open(request, callback);
          return fakeCall;
        };
        return live;
      }, timing);
    try {
      await controller.updateWorkspaceFolders([root]);
      await controller.start();
      const live = controller.requireConnection();
      assert.equal((await listRuntimes(live)).defaultRuntime, 'local');
      assert.ok(!controller.workspaceRegistry.workspaces.length);
      const first = controller.prepareWorkspaces(live.signal);
      const second = controller.prepareWorkspaces(live.signal);
      await opening;
      assert.equal((await listRuntimes(live)).defaultRuntime, 'local');
      assert.equal(controller.workspaceRegistry.workspaces.length, 0);
      completeOpen();
      await Promise.all([first, second]);
      assert.deepEqual(state.openRoots, [root]);
    } finally {
      await controller.stop();
    }
  });

  test('an Open response delivered during daemon loss cannot repopulate the registry', async () => {
    const process = new FakeProcess();
    const state = rpcState();
    const controller = new DaemonController(configuration, new FakeOutput(), () => process, async () => fakeEndpoint(),
      (_target, signal) => {
        const live = successfulConnection(process, signal, state);
        const open = live.workspaces.open;
        live.workspaces.open = (request, callback) => {
          process.exit(1);
          return open(request, callback);
        };
        return live;
      }, timing);
    await controller.updateWorkspaceFolders([resolve('workspace')]);
    await controller.start();
    await assert.rejects(controller.prepareWorkspaces(controller.requireConnection().signal));
    assert.deepEqual(controller.workspaceRegistry.workspaces, []);
    await controller.stop();
  });

  test('supersedes startup during endpoint preparation without spawning the retired process', async () => {
    let preparing!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { preparing = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const endpoint = fakeEndpoint();
    let spawned = false;
    const controller = new DaemonController(configuration, new FakeOutput(), () => {
      spawned = true;
      return new FakeProcess();
    }, async () => { preparing(); await gate; return endpoint; });
    const rejected = assert.rejects(controller.start());
    await entered;
    const stopped = controller.stop();
    release();
    await Promise.all([rejected, stopped]);
    assert.equal(spawned, false);
    assert.equal(endpoint.disposeCalls, 1);
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
    await controller.prepareWorkspaces(controller.requireConnection().signal);
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

  for (const apiVersion of [{ major: 1, minor: 0 }, { major: 2, minor: 3 }]) {
    test(`cleans partial startup after incompatible API ${apiVersion.major}.${apiVersion.minor}`, async () => {
      const process = new FakeProcess();
      const endpoint = fakeEndpoint();
      const state = rpcState();
      const controller = new DaemonController(
        configuration,
        new FakeOutput(),
        () => process,
        async () => endpoint,
        (_target, signal) => successfulConnection(process, signal, state, apiVersion),
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
  }

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

  test('replaces a failed startup channel and retains the ready one', async () => {
    const process = new FakeProcess();
    const failed = rpcState();
    const ready = rpcState();
    const controller = new DaemonController(
      configuration,
      new FakeOutput(),
      () => process,
      async () => fakeEndpoint(),
      (_target, signal) => {
        if (failed.getInfoCalls > 0) {
          return successfulConnection(process, signal, ready);
        }
        return connection(signal, failed, process, (_request, _metadata, _options, callback) => {
          callback(serviceError(status.UNAVAILABLE, 'missing pipe'), { serverInfo: undefined });
          return fakeCall;
        });
      },
      timing,
    );

    try {
      await controller.start();
      await controller.updateWorkspaceFolders([resolve('workspace')]);
      await controller.prepareWorkspaces(controller.requireConnection().signal);
      assert.strictEqual(failed.channelCloseCalls, 1);
      assert.strictEqual(failed.getInfoCalls, 1);
      assert.deepStrictEqual(ready.openRoots, [resolve('workspace')]);
      assert.strictEqual(ready.channelCloseCalls, 0);
    } finally {
      await controller.stop();
    }
    assert.strictEqual(ready.channelCloseCalls, 1);
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
    assert.strictEqual(state.channelCloseCalls, state.getInfoCalls);
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
  apiVersion = { major: 1, minor: 1 },
): DaemonConnection {
  return connection(
    signal,
    state,
    process,
    (request, _metadata, _options, callback) => {
      assert.deepStrictEqual(request.clientApi, { major: 1, minor: 1 });
      callback(null, {
        serverInfo: {
          version: '2.0.0-alpha.2',
          instanceId: 'daemon-1',
          apiVersion,
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
    listRuntimes: () => { throw new Error('Unexpected discovery'); },
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
