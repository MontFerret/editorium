import { posix } from 'node:path';

import type {
  ClientReadableStream,
  ClientUnaryCall,
  ServiceError,
} from '@grpc/grpc-js';

import { DaemonDisposedError } from '../daemon/errors';
import type {
  CancelExecutionResponse,
  CloseExecutionResponse,
  CloseSessionResponse,
  CreateExecutionResponse,
  CreateSessionResponse,
  RunExecutionResponse,
  WatchExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import { unary } from '../daemon/rpc';
import type {
  DaemonConnection,
  DaemonConnectionProvider,
  ExecutionGeneratedClient,
} from '../daemon/types';
import {
  FerretExecutionClientError,
  type FerretExecutionOperation,
  normalizeExecutionError,
} from './errors';
import {
  mapExecution,
  mapExecutionEvent,
  mapSession,
  ProtocolMappingError,
} from './mapping';
import { validateParameters } from './parameters';
import type {
  FerretExecution,
  FerretExecutionEvent,
  FerretSession,
} from './types';

export class FerretExecutionClient {
  public constructor(
    private readonly connections: DaemonConnectionProvider,
  ) {}

  public async createSession(
    workspaceId: string,
    relativePath: string,
  ): Promise<FerretSession> {
    validateIdentifier('workspace ID', workspaceId, 'create-session');
    validateRelativePath(relativePath);

    return this.invoke(
      'create-session',
      (client, callback) =>
        client.createSession(
          {
            workspaceId: { value: workspaceId },
            relativePath,
          },
          callback,
        ),
      (response: CreateSessionResponse) =>
        mapSession(response.session),
    );
  }

  public async createExecution(
    sessionId: string,
    parameters: Readonly<Record<string, unknown>> = {},
  ): Promise<FerretExecution> {
    validateIdentifier('session ID', sessionId, 'create-execution');
    let validated;
    try {
      validated = validateParameters(parameters);
    } catch (error) {
      throw normalizeExecutionError(error, 'create-execution');
    }

    return this.invoke(
      'create-execution',
      (client, callback) =>
        client.createExecution(
          {
            sessionId: { value: sessionId },
            parameters: validated,
            options: { outputContentType: '' },
          },
          callback,
        ),
      (response: CreateExecutionResponse) =>
        mapExecution(response.execution),
    );
  }

  public async runExecution(
    executionId: string,
  ): Promise<FerretExecution> {
    validateIdentifier('execution ID', executionId, 'run-execution');

    return this.invoke(
      'run-execution',
      (client, callback) =>
        client.runExecution(
          { id: { value: executionId } },
          callback,
        ),
      (response: RunExecutionResponse) =>
        mapExecution(response.execution),
    );
  }

  public watchExecution(
    executionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<FerretExecutionEvent> {
    validateIdentifier('execution ID', executionId, 'watch-execution');
    if (signal?.aborted === true) {
      return emptyEvents();
    }

    let connection: DaemonConnection | undefined;
    try {
      connection = this.connections.requireConnection();
      const stream = connection.executions.watchExecution({
        id: { value: executionId },
      });

      return new ExecutionWatch(stream, connection.signal, signal);
    } catch (error) {
      throw normalizeExecutionError(
        error,
        'watch-execution',
        connection?.signal,
      );
    }
  }

  public async cancelExecution(
    executionId: string,
  ): Promise<FerretExecution> {
    validateIdentifier('execution ID', executionId, 'cancel-execution');

    return this.invoke(
      'cancel-execution',
      (client, callback) =>
        client.cancelExecution(
          { id: { value: executionId } },
          callback,
        ),
      (response: CancelExecutionResponse) =>
        mapExecution(response.execution),
    );
  }

  public async closeExecution(executionId: string): Promise<void> {
    validateIdentifier('execution ID', executionId, 'close-execution');

    await this.invoke(
      'close-execution',
      (client, callback) =>
        client.closeExecution(
          { id: { value: executionId } },
          callback,
        ),
      (_response: CloseExecutionResponse) => undefined,
    );
  }

  public async closeSession(sessionId: string): Promise<void> {
    validateIdentifier('session ID', sessionId, 'close-session');

    await this.invoke(
      'close-session',
      (client, callback) =>
        client.closeSession(
          { id: { value: sessionId } },
          callback,
        ),
      (_response: CloseSessionResponse) => undefined,
    );
  }

  private async invoke<Response, Result>(
    operation: FerretExecutionOperation,
    invoke: (
      client: ExecutionGeneratedClient,
      callback: (
        error: ServiceError | null,
        response: Response,
      ) => void,
    ) => ClientUnaryCall,
    convert: (response: Response) => Result,
  ): Promise<Result> {
    let connection: DaemonConnection | undefined;

    try {
      connection = this.connections.requireConnection();
      const response = await unary<Response>(
        (callback) =>
          invoke(connection!.executions, callback),
        connection.signal,
      );

      return convert(response);
    } catch (error) {
      throw normalizeExecutionError(
        error,
        operation,
        connection?.signal,
      );
    }
  }
}

class ExecutionWatch implements AsyncIterable<FerretExecutionEvent> {
  private readonly queue: WatchExecutionResponse[] = [];
  private consumed = false;
  private done = false;
  private failure: unknown;
  private terminalSeen = false;
  private wake: (() => void) | undefined;

  public constructor(
    private readonly stream: ClientReadableStream<WatchExecutionResponse>,
    private readonly connectionSignal: AbortSignal,
    private readonly callerSignal?: AbortSignal,
  ) {
    stream.on('data', this.onData);
    stream.on('error', this.onError);
    stream.on('end', this.onEnd);
    stream.on('close', this.onEnd);
    connectionSignal.addEventListener(
      'abort',
      this.onConnectionAbort,
      { once: true },
    );
    callerSignal?.addEventListener('abort', this.onCallerAbort, {
      once: true,
    });
    if (connectionSignal.aborted) {
      this.onConnectionAbort();
    } else if (callerSignal?.aborted === true) {
      this.onCallerAbort();
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<FerretExecutionEvent> {
    if (this.consumed) {
      return failedIterator(
        new FerretExecutionClientError({
          code: 'protocol',
          operation: 'watch-execution',
          message: 'an execution watch can only be consumed once',
        }),
      );
    }

    this.consumed = true;

    const generator = this.iterate();

    return {
      next: () => generator.next(),
      return: () => {
        this.finishLocally();
        return generator.return(undefined);
      },
    };
  }

  private readonly onData = (value: WatchExecutionResponse): void => {
    if (!this.done) {
      if (this.terminalSeen) {
        this.failure = new ProtocolMappingError(
          'execution watch returned an event after its terminal event',
        );
        this.done = true;
        this.detachSignals();
        this.stream.cancel();
        this.notify();
        return;
      }

      this.queue.push(value);
      this.terminalSeen =
        value.payload?.$case === 'completed' ||
        value.payload?.$case === 'failed' ||
        value.payload?.$case === 'cancelled';
      this.notify();
    }
  };

  private readonly onError = (error: unknown): void => {
    if (!this.done) {
      this.failure = error;
      this.done = true;
    }

    this.detachStream();
    this.detachSignals();
    this.notify();
  };

  private readonly onEnd = (): void => {
    if (!this.done && !this.terminalSeen) {
      this.failure = new ProtocolMappingError(
        'execution watch ended before a terminal event',
      );
    }
    this.done = true;
    this.detachStream();
    this.detachSignals();
    this.notify();
  };

  private readonly onCallerAbort = (): void => {
    this.finishLocally();
  };

  private readonly onConnectionAbort = (): void => {
    if (this.connectionSignal.reason instanceof DaemonDisposedError) {
      this.finishLocally();
      return;
    }

    this.failure = this.connectionSignal.reason;
    this.done = true;
    this.detachSignals();
    this.stream.cancel();
    this.notify();
  };

  private async *iterate(): AsyncGenerator<FerretExecutionEvent> {
    try {
      while (true) {
        const next = this.queue.shift();
        if (next !== undefined) {
          try {
            yield mapExecutionEvent(next);
          } catch (error) {
            throw normalizeExecutionError(
              error,
              'watch-execution',
              this.connectionSignal,
            );
          }

          continue;
        }

        if (this.failure !== undefined) {
          throw normalizeExecutionError(
            this.failure,
            'watch-execution',
            this.connectionSignal,
          );
        }

        if (this.done) {
          return;
        }

        await this.wait();
      }
    } finally {
      if (!this.done) {
        this.finishLocally();
      }
    }
  }

  private finishLocally(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.queue.length = 0;
    this.detachSignals();
    this.stream.cancel();
    this.notify();
  }

  private detachSignals(): void {
    this.connectionSignal.removeEventListener(
      'abort',
      this.onConnectionAbort,
    );
    this.callerSignal?.removeEventListener(
      'abort',
      this.onCallerAbort,
    );
  }

  private detachStream(): void {
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('error', this.onError);
    this.stream.removeListener('end', this.onEnd);
    this.stream.removeListener('close', this.onEnd);
  }

  private wait(): Promise<void> {
    return new Promise((resolveWait) => {
      this.wake = resolveWait;
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

function validateIdentifier(
  name: string,
  value: string,
  operation: FerretExecutionOperation,
): void {
  if (value === '') {
    throw normalizeExecutionError(
      new ProtocolMappingError(`${name} must not be empty`),
      operation,
    );
  }
}

function validateRelativePath(value: string): void {
  const normalized = posix.normalize(value);
  if (
    value === '' ||
    value === '.' ||
    value.includes('\0') ||
    value.includes('\\') ||
    posix.isAbsolute(value) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== value
  ) {
    throw normalizeExecutionError(
      new ProtocolMappingError(
        'session source path must be a normalized workspace-relative path',
      ),
      'create-session',
    );
  }
}

function emptyEvents(): AsyncIterable<FerretExecutionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
  };
}

function failedIterator(
  error: Error,
): AsyncIterator<FerretExecutionEvent> {
  return {
    next: () => Promise.reject(error),
  };
}
