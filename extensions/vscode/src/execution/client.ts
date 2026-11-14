import { validateIdentifier, validateRelativePath } from './request-validation';
import { ExecutionWatch } from './watch';

import { Metadata } from '@grpc/grpc-js';
import type {
  ClientUnaryCall,
  ServiceError,
} from '@grpc/grpc-js';

import type {
  CancelExecutionResponse,
  CloseExecutionResponse,
  CloseSessionResponse,
  CreateExecutionResponse,
  CreateSessionResponse,
  RunExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import { unary } from '../daemon/rpc';
import type {
  DaemonConnection,
  ExecutionGeneratedClient,
} from '../daemon/types';
import {
  FerretExecutionClientError,
  type FerretExecutionOperation,
  normalizeExecutionError,
} from './errors';
import {
  mapExecution,
  mapSession,
  ProtocolMappingError,
} from './mapping';
import { supportsRuntimeSelection } from '../runtime/catalog';
import type { PreparedRuntime } from '../runtime/coordinator';
import { validateParameters } from './parameters';
import type {
  FerretExecution,
  FerretExecutionEvent,
  FerretSession,
} from './types';

const cleanupDeadlineMs = 5000;
const sessionDeadlineMs = 30_000;
const jsonContentType = 'application/json';

export class FerretExecutionClient {
  public constructor(
    private readonly connection: DaemonConnection,
  ) {}

  public async createSession(
    workspaceId: string,
    relativePath: string,
    runtime: Pick<PreparedRuntime, 'selector' | 'name'>,
    signal?: AbortSignal,
  ): Promise<FerretSession> {
    validateIdentifier('workspace ID', workspaceId, 'create-session');
    validateRelativePath(relativePath);

    const selectionSupported = supportsRuntimeSelection(this.connection);
    if (runtime.selector !== '' && !selectionSupported) {
      throw new FerretExecutionClientError({
        code: 'incompatible-daemon', operation: 'create-session',
        message: 'Runtime selection requires ferretd API 1.3 or later in major 1.',
      });
    }
    const response = await this.invoke<CreateSessionResponse, CreateSessionResponse>(
      'create-session',
      (client, callback) => client.createSession({
        workspaceId: { value: workspaceId }, relativePath, runtimeName: runtime.selector,
      }, new Metadata(), { deadline: Date.now() + sessionDeadlineMs }, callback),
      value => value, signal,
    );
    try {
      const session = mapSession(response?.session);
      if (session.source.workspaceId !== workspaceId || session.source.relativePath !== relativePath) {
        throw new ProtocolMappingError('Session acknowledged a different workspace source.');
      }
      if ((selectionSupported || session.runtimeName !== '') && session.runtimeName !== runtime.name) {
        throw new ProtocolMappingError(`Expected runtime "${runtime.name}", but ferretd acknowledged "${session.runtimeName}".`);
      }
      signal?.throwIfAborted();
      return session;
    } catch (error) {
      return this.rejectCreation('create-session', error, response?.session?.id?.value, id => this.closeSession(id));
    }
  }

  public async createExecution(
    sessionId: string,
    parameters: Readonly<Record<string, unknown>> = {},
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<FerretExecution> {
    validateIdentifier('session ID', sessionId, 'create-execution');
    let validated;
    try {
      validated = validateParameters(parameters);
    } catch (error) {
      throw normalizeExecutionError(error, 'create-execution');
    }

    const response = await this.invoke<CreateExecutionResponse, CreateExecutionResponse>(
      'create-execution',
      (client, callback) => client.createExecution({
        sessionId: { value: sessionId }, parameters: validated,
        options: { outputContentType: jsonContentType, ...(workingDirectory === undefined ? {} : { workingDirectory }) },
      }, new Metadata(), {}, callback),
      value => value, signal,
    );
    try {
      const execution = mapExecution(response?.execution);
      if (execution.sessionId !== sessionId) throw new ProtocolMappingError('Execution acknowledged a different Session.');
      signal?.throwIfAborted();
      return execution;
    } catch (error) {
      return this.rejectCreation('create-execution', error, response?.execution?.id?.value, id => this.closeExecution(id));
    }
  }

  private async rejectCreation(
    operation: FerretExecutionOperation, error: unknown, id: string | undefined, close: (id: string) => Promise<void>,
  ): Promise<never> {
    const primary = normalizeExecutionError(error, operation, this.connection.signal);
    if (id) {
      try {
        await close(id);
      } catch (cleanup) {
        throw new FerretExecutionClientError({
          ...primary, message: `${primary.message}. Cleanup of "${id}" failed: ${String(cleanup)}`,
          cause: new AggregateError([primary, cleanup]),
        });
      }
    }
    throw primary;
  }

  public async runExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<FerretExecution> {
    validateIdentifier('execution ID', executionId, 'run-execution');

    return this.invoke(
      'run-execution',
      (client, callback) =>
        client.runExecution(
          { id: { value: executionId } }, new Metadata(), {},
          callback,
        ),
      (response: RunExecutionResponse) =>
        mapExecution(response.execution), signal,
    );
  }

  public watchExecution(
    executionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<FerretExecutionEvent> {
    validateIdentifier('execution ID', executionId, 'watch-execution');
    if (signal?.aborted === true) {
      return { async *[Symbol.asyncIterator]() { return; } };
    }

    const connection = this.connection;
    try {
      connection.signal.throwIfAborted();
      const stream = connection.executions.watchExecution({
        id: { value: executionId },
      });

      return new ExecutionWatch(stream, connection.signal, signal);
    } catch (error) {
      throw normalizeExecutionError(
        error,
        'watch-execution',
        connection.signal,
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
          { id: { value: executionId } }, new Metadata(), { deadline: Date.now() + cleanupDeadlineMs },
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
          { id: { value: executionId } }, new Metadata(), { deadline: Date.now() + cleanupDeadlineMs },
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
          { id: { value: sessionId } }, new Metadata(), { deadline: Date.now() + cleanupDeadlineMs },
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
    signal?: AbortSignal,
  ): Promise<Result> {
    const connection = this.connection;
    try {
      const response = await unary<Response>(
        (callback) =>
          invoke(connection.executions, callback),
        signal ? AbortSignal.any([connection.signal, signal]) : connection.signal,
        operation === 'create-session' || operation === 'create-execution',
      );

      return convert(response);
    } catch (error) {
      throw normalizeExecutionError(
        error,
        operation,
        connection.signal,
      );
    }
  }
}
