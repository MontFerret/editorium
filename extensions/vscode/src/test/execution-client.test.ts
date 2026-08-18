import * as assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  Metadata,
  status,
  type Channel,
  type ClientReadableStream,
  type ClientUnaryCall,
  type ServiceError,
} from '@grpc/grpc-js';

import {
  DaemonDisposedError,
  unavailableDaemon,
} from '../daemon/errors';
import {
  ExecutionState,
  type CancelExecutionRequest,
  type CancelExecutionResponse,
  type CloseExecutionRequest,
  type CloseExecutionResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type CreateExecutionRequest,
  type CreateExecutionResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type RunExecutionRequest,
  type RunExecutionResponse,
  type WatchExecutionRequest,
  type WatchExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import type {
  DaemonConnection,
  DaemonConnectionProvider,
  ExecutionGeneratedClient,
} from '../daemon/types';
import { FerretExecutionClient } from '../execution/client';
import { FerretExecutionClientError } from '../execution/errors';
import {
  execution,
  executionEvent,
  session,
} from './execution-fixtures';

type UnaryCallback<Response> = (
  error: ServiceError | null,
  response: Response,
) => void;

class FakeStream extends Readable {
  public cancelCalls = 0;

  public constructor() {
    super({ objectMode: true });
  }

  public override _read(): void {}

  public cancel(): void {
    this.cancelCalls += 1;
    this.push(null);
  }

  public send(value: WatchExecutionResponse): void {
    this.push(value);
  }

  public finish(): void {
    this.push(null);
  }
}

class FakeExecutionService implements ExecutionGeneratedClient {
  public readonly stream = new FakeStream();
  public cancelCalls = 0;
  public closeExecutionCalls = 0;
  public closeSessionCalls = 0;
  public createExecutionRequest: CreateExecutionRequest | undefined;
  public createSessionRequest: CreateSessionRequest | undefined;
  public runCalls = 0;
  public watchCalls = 0;

  public createSession = (
    request: CreateSessionRequest,
    callback: UnaryCallback<CreateSessionResponse>,
  ): ClientUnaryCall => {
    this.createSessionRequest = request;
    callback(null, { session: session() });

    return fakeCall;
  };

  public createExecution = (
    request: CreateExecutionRequest,
    callback: UnaryCallback<CreateExecutionResponse>,
  ): ClientUnaryCall => {
    this.createExecutionRequest = request;
    callback(null, { execution: execution() });

    return fakeCall;
  };

  public runExecution = (
    _request: RunExecutionRequest,
    callback: UnaryCallback<RunExecutionResponse>,
  ): ClientUnaryCall => {
    this.runCalls += 1;
    callback(null, {
      execution: execution(ExecutionState.EXECUTION_STATE_RUNNING),
    });

    return fakeCall;
  };

  public cancelExecution = (
    _request: CancelExecutionRequest,
    callback: UnaryCallback<CancelExecutionResponse>,
  ): ClientUnaryCall => {
    this.cancelCalls += 1;
    callback(null, {
      execution: execution(ExecutionState.EXECUTION_STATE_CANCELLED),
    });

    return fakeCall;
  };

  public closeExecution = (
    _request: CloseExecutionRequest,
    callback: UnaryCallback<CloseExecutionResponse>,
  ): ClientUnaryCall => {
    this.closeExecutionCalls += 1;
    callback(null, {});

    return fakeCall;
  };

  public closeSession = (
    _request: CloseSessionRequest,
    callback: UnaryCallback<CloseSessionResponse>,
  ): ClientUnaryCall => {
    this.closeSessionCalls += 1;
    callback(null, {});

    return fakeCall;
  };

  public watchExecution(
    _request: WatchExecutionRequest,
  ): ClientReadableStream<WatchExecutionResponse> {
    this.watchCalls += 1;

    return this.stream as unknown as ClientReadableStream<WatchExecutionResponse>;
  }
}

const fakeCall = {
  cancel: () => undefined,
} as unknown as ClientUnaryCall;

suite('Ferret execution client', () => {
  test('maps unary resources and sends explicit nested parameters', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);

    const createdSession = await client.createSession(
      'workspace-1',
      'queries/example.fql',
    );
    const parameters = {
      value: 42,
      nested: { enabled: true, values: [null, 'ok'] },
    };
    const createdExecution = await client.createExecution(
      createdSession.id,
      parameters,
    );
    parameters.nested.enabled = false;

    assert.deepStrictEqual(service.createSessionRequest, {
      workspaceId: { value: 'workspace-1' },
      relativePath: 'queries/example.fql',
    });
    assert.deepStrictEqual(service.createExecutionRequest, {
      sessionId: { value: 'session-1' },
      parameters: {
        value: 42,
        nested: { enabled: true, values: [null, 'ok'] },
      },
      options: { outputContentType: '' },
    });
    assert.strictEqual(createdExecution.status, 'created');
    assert.strictEqual((await client.runExecution('execution-1')).status, 'running');
    assert.strictEqual(
      (await client.cancelExecution('execution-1')).status,
      'cancelled',
    );
    await client.closeExecution('execution-1');
    await client.closeSession('session-1');
    assert.strictEqual(service.runCalls, 1);
    assert.strictEqual(service.cancelCalls, 1);
    assert.strictEqual(service.closeExecutionCalls, 1);
    assert.strictEqual(service.closeSessionCalls, 1);
  });

  test('sends an explicit empty parameter object when omitted', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);

    await client.createExecution('session-1');

    assert.deepStrictEqual(service.createExecutionRequest?.parameters, {});
  });

  test('accepts only normalized workspace-relative session paths', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);

    for (const path of [
      '',
      '.',
      '../query.fql',
      '/query.fql',
      'queries\\query.fql',
      'queries//query.fql',
      'queries/../query.fql',
      'query\0.fql',
    ]) {
      await assert.rejects(
        client.createSession('workspace-1', path),
        (error: unknown) =>
          error instanceof FerretExecutionClientError &&
          error.code === 'protocol' &&
          error.operation === 'create-session',
      );
    }
    assert.strictEqual(service.createSessionRequest, undefined);
  });

  test('rejects unsupported, cyclic, and non-finite parameters', async () => {
    const { client } = testClient(new FakeExecutionService());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'value';
    const symbolKeyed = { value: 1 };
    Object.defineProperty(symbolKeyed, Symbol('hidden'), {
      enumerable: true,
      value: 2,
    });

    for (const parameters of [
      { value: undefined },
      { value: BigInt(1) },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: new Date() },
      { value: sparse },
      symbolKeyed,
      null,
      cyclic,
    ]) {
      await assert.rejects(
        client.createExecution(
          'session-1',
          parameters as unknown as Readonly<Record<string, unknown>>,
        ),
        (error: unknown) =>
          error instanceof FerretExecutionClientError &&
          error.code === 'invalid-parameters' &&
          error.operation === 'create-execution',
      );
    }
  });

  test('preserves JSON object keys that overlap object prototypes', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);
    const parameters: Record<string, unknown> = {};
    Object.defineProperty(parameters, '__proto__', {
      enumerable: true,
      value: { safe: true },
    });

    await client.createExecution('session-1', parameters);

    const sent = service.createExecutionRequest?.parameters;
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(sent, '__proto__'),
      true,
    );
    assert.deepStrictEqual(sent?.['__proto__'], { safe: true });
  });

  test('starts watches eagerly and preserves ordered terminal events', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);

    const watch = client.watchExecution('execution-1');
    assert.strictEqual(service.watchCalls, 1);
    service.stream.send(executionEvent('created', 1));
    service.stream.send(executionEvent('started', 2));
    service.stream.send(executionEvent('completed', 3));
    service.stream.finish();

    const events = await collect(watch);
    assert.deepStrictEqual(
      events.map(({ sequence, kind }) => [sequence, kind]),
      [
        [1, 'created'],
        [2, 'started'],
        [3, 'completed'],
      ],
    );
    assertNoWatchListeners(service.stream);
  });

  test('caller abort and loop disposal end cleanly without execution cancellation', async () => {
    const service = new FakeExecutionService();
    const { client } = testClient(service);
    const caller = new AbortController();
    const iterator = client
      .watchExecution('execution-1', caller.signal)
      [Symbol.asyncIterator]();
    const waiting = iterator.next();

    caller.abort();
    assert.deepStrictEqual(await waiting, {
      value: undefined,
      done: true,
    });
    await immediate();
    assert.strictEqual(service.stream.cancelCalls, 1);
    assert.strictEqual(service.cancelCalls, 0);
    assertNoWatchListeners(service.stream);

    const second = new FakeExecutionService();
    const secondClient = testClient(second).client;
    const watch = secondClient.watchExecution('execution-1');
    second.stream.send(executionEvent('created', 1));
    for await (const _event of watch) {
      break;
    }
    await immediate();
    assert.strictEqual(second.stream.cancelCalls, 1);
    assert.strictEqual(second.cancelCalls, 0);
    assertNoWatchListeners(second.stream);

    const unstarted = new FakeExecutionService();
    const unstartedIterator = testClient(unstarted).client
      .watchExecution('execution-1')
      [Symbol.asyncIterator]();
    await unstartedIterator.return?.();
    await immediate();
    assert.strictEqual(unstarted.stream.cancelCalls, 1);
    assertNoWatchListeners(unstarted.stream);
  });

  test('local generation disposal ends cleanly while disconnects throw', async () => {
    const local = new FakeExecutionService();
    const localState = testClient(local);
    const localIterator = localState.client
      .watchExecution('execution-1')
      [Symbol.asyncIterator]();
    const localNext = localIterator.next();
    localState.abort.abort(new DaemonDisposedError());
    assert.strictEqual((await localNext).done, true);

    const disconnected = new FakeExecutionService();
    const disconnectedState = testClient(disconnected);
    const disconnectedIterator = disconnectedState.client
      .watchExecution('execution-1')
      [Symbol.asyncIterator]();
    const disconnectedNext = disconnectedIterator.next();
    disconnectedState.abort.abort(unavailableDaemon());
    await assert.rejects(
      disconnectedNext,
      (error: unknown) =>
        error instanceof FerretExecutionClientError &&
        error.code === 'daemon-unavailable',
    );
  });

  test('stream failures throw and daemon cancellation remains an event', async () => {
    const failed = new FakeExecutionService();
    const failedIterator = testClient(failed).client
      .watchExecution('execution-1')
      [Symbol.asyncIterator]();
    const next = failedIterator.next();
    failed.stream.emit(
      'error',
      serviceError(status.UNAVAILABLE, 'connection lost'),
    );
    await assert.rejects(
      next,
      (error: unknown) =>
        error instanceof FerretExecutionClientError &&
        error.code === 'daemon-unavailable',
    );
    assertNoWatchListeners(failed.stream);

    const cancelled = new FakeExecutionService();
    const cancelledWatch = testClient(cancelled).client.watchExecution(
      'execution-1',
    );
    cancelled.stream.send(executionEvent('cancelled', 1));
    cancelled.stream.finish();
    const events = await collect(cancelledWatch);
    assert.strictEqual(events[0]?.kind, 'cancelled');
    assert.strictEqual(events[0]?.execution.status, 'cancelled');
  });

  test('treats a successful stream end before a terminal event as protocol failure', async () => {
    const service = new FakeExecutionService();
    const watch = testClient(service).client.watchExecution('execution-1');
    service.stream.send(executionEvent('created', 1));
    service.stream.finish();

    await assert.rejects(
      collect(watch),
      (error: unknown) =>
        error instanceof FerretExecutionClientError &&
        error.code === 'protocol',
    );
    assertNoWatchListeners(service.stream);
  });
});

function testClient(service: FakeExecutionService): {
  readonly abort: AbortController;
  readonly client: FerretExecutionClient;
} {
  const abort = new AbortController();
  const connection = {
    channel: {} as Channel,
    daemon: {},
    executions: service,
    signal: abort.signal,
    workspaces: {},
  } as unknown as DaemonConnection;
  const provider: DaemonConnectionProvider = {
    requireConnection: () => connection,
  };

  return { abort, client: new FerretExecutionClient(provider) };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }

  return result;
}

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  });
}

function assertNoWatchListeners(stream: FakeStream): void {
  for (const event of ['data', 'error', 'end', 'close']) {
    assert.strictEqual(stream.listenerCount(event), 0, event);
  }
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
