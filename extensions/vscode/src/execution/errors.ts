import { status } from '@grpc/grpc-js';

import {
  DaemonDisposedError,
  DaemonError,
} from '../daemon/errors';
import {
  CompilationFailure,
  ResourceCondition,
  ResourceErrorDetail,
  ResourceKind,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import {
  decodeStatusDetails,
  detailType,
  isServiceError,
} from '../daemon/status-details';
import {
  mapDiagnostics,
  mapSourceSnapshot,
  ProtocolMappingError,
} from './mapping';
import { InvalidParametersError } from './parameters';
import type {
  FerretDiagnostic,
  FerretSourceSnapshot,
} from './types';

export type FerretExecutionOperation =
  | 'create-session'
  | 'create-execution'
  | 'run-execution'
  | 'watch-execution'
  | 'cancel-execution'
  | 'close-execution'
  | 'close-session';

export type FerretExecutionResource =
  | 'workspace'
  | 'source'
  | 'session'
  | 'execution'
  | 'watcher';

export type FerretExecutionErrorCode =
  | 'daemon-unavailable'
  | 'incompatible-daemon'
  | 'cancelled'
  | 'not-found'
  | 'closed'
  | 'compilation-failed'
  | 'invalid-parameters'
  | 'invalid-state'
  | 'watch-lagged'
  | 'execution-rejected'
  | 'protocol';

export interface FerretExecutionClientErrorOptions {
  readonly code: FerretExecutionErrorCode;
  readonly operation: FerretExecutionOperation;
  readonly message: string;
  readonly resource?: FerretExecutionResource;
  readonly source?: FerretSourceSnapshot;
  readonly diagnostics?: readonly FerretDiagnostic[];
  readonly cause?: unknown;
}

export class FerretExecutionClientError extends Error {
  public readonly cause?: unknown;
  public readonly code: FerretExecutionErrorCode;
  public readonly diagnostics?: readonly FerretDiagnostic[];
  public readonly operation: FerretExecutionOperation;
  public readonly resource?: FerretExecutionResource;
  public readonly source?: FerretSourceSnapshot;

  public constructor(options: FerretExecutionClientErrorOptions) {
    super(options.message);
    this.name = 'FerretExecutionClientError';
    this.cause = options.cause;
    this.code = options.code;
    this.operation = options.operation;
    this.resource = options.resource;
    this.source = options.source;
    this.diagnostics = options.diagnostics;
  }
}

export type ExecutionManagerErrorCode =
  | 'unsupported-document'
  | 'document-dirty'
  | 'document-changed'
  | 'workspace-unavailable'
  | 'execution-already-running'
  | 'disposed';

export class ExecutionManagerError extends Error {
  public constructor(
    public readonly code: ExecutionManagerErrorCode,
    message: string,
    public readonly documentUri?: string,
  ) {
    super(message);
    this.name = 'ExecutionManagerError';
  }
}

export function normalizeExecutionError(
  error: unknown,
  operation: FerretExecutionOperation,
  connectionSignal?: AbortSignal,
): FerretExecutionClientError {
  if (error instanceof FerretExecutionClientError) {
    return error;
  }

  if (error instanceof InvalidParametersError) {
    return clientError(
      'invalid-parameters',
      operation,
      error.message,
      error,
      'execution',
    );
  }

  if (error instanceof ProtocolMappingError) {
    return clientError(
      'protocol',
      operation,
      error.message,
      error,
    );
  }

  if (error instanceof DaemonDisposedError) {
    return clientError(
      'cancelled',
      operation,
      `${operation} was cancelled by local disposal`,
      error,
    );
  }

  if (error instanceof DaemonError) {
    const code =
      error.code === 'incompatible-daemon'
        ? 'incompatible-daemon'
        : error.code === 'protocol'
          ? 'protocol'
          : 'daemon-unavailable';

    return clientError(code, operation, error.message, error);
  }

  if (connectionSignal?.aborted === true) {
    return normalizeExecutionError(
      connectionSignal.reason,
      operation,
    );
  }

  if (!isServiceError(error)) {
    return clientError(
      'execution-rejected',
      operation,
      `${operation} failed: ${formatError(error)}`,
      error,
    );
  }

  const detailed = detailedError(error, operation);
  if (detailed !== undefined) {
    return detailed;
  }

  switch (error.code) {
    case status.CANCELLED:
      return clientError(
        'cancelled',
        operation,
        `${operation} was cancelled`,
        error,
      );
    case status.UNAVAILABLE:
    case status.DEADLINE_EXCEEDED:
      return clientError(
        'daemon-unavailable',
        operation,
        `Ferret daemon is unavailable during ${operation}`,
        error,
      );
    case status.INVALID_ARGUMENT:
    case status.NOT_FOUND:
    case status.FAILED_PRECONDITION:
    case status.RESOURCE_EXHAUSTED:
      return clientError(
        'protocol',
        operation,
        `Ferret daemon returned ${error.code} without recognized execution details`,
        error,
      );
    default:
      return clientError(
        'execution-rejected',
        operation,
        `${operation} was rejected: ${error.details}`,
        error,
      );
  }
}

function detailedError(
  error: Parameters<typeof decodeStatusDetails>[0],
  operation: FerretExecutionOperation,
): FerretExecutionClientError | undefined {
  const statusDetails = decodeStatusDetails(error);
  if (statusDetails === undefined) {
    return undefined;
  }

  for (const detail of statusDetails.details) {
    try {
      switch (detailType(detail.typeUrl)) {
        case 'ferretd.execution.v1.CompilationFailure': {
          const compilation = CompilationFailure.decode(detail.value);

          return new FerretExecutionClientError({
            code: 'compilation-failed',
            operation,
            message: 'Ferret session compilation failed',
            resource: 'source',
            source: mapSourceSnapshot(compilation.source),
            diagnostics: mapDiagnostics(compilation.diagnostics),
            cause: error,
          });
        }
        case 'ferretd.execution.v1.ResourceErrorDetail':
          return resourceError(
            ResourceErrorDetail.decode(detail.value),
            operation,
            error,
          );
      }
    } catch {
      return clientError(
        'protocol',
        operation,
        'Ferret daemon returned malformed execution error details',
        error,
      );
    }
  }

  return undefined;
}

function resourceError(
  detail: ResourceErrorDetail,
  operation: FerretExecutionOperation,
  cause: unknown,
): FerretExecutionClientError {
  const resource = mapResource(detail.resource);
  if (!isKnownResourceCondition(detail.resource, detail.condition)) {
    return clientError(
      'protocol',
      operation,
      `invalid ${resource} condition ${String(detail.condition)}`,
      cause,
      resource,
    );
  }

  switch (detail.condition) {
    case ResourceCondition.RESOURCE_CONDITION_NOT_FOUND:
      return clientError(
        'not-found',
        operation,
        `${resource} was not found`,
        cause,
        resource,
      );
    case ResourceCondition.RESOURCE_CONDITION_CLOSED:
      return clientError(
        'closed',
        operation,
        `${resource} is closed`,
        cause,
        resource,
      );
    case ResourceCondition.RESOURCE_CONDITION_INVALID_STATE:
      return clientError(
        'invalid-state',
        operation,
        `${resource} is in an invalid state`,
        cause,
        resource,
      );
    case ResourceCondition.RESOURCE_CONDITION_INVALID_PARAMETERS:
      return clientError(
        'invalid-parameters',
        operation,
        'execution parameters are invalid',
        cause,
        resource,
      );
    case ResourceCondition.RESOURCE_CONDITION_LAGGED:
      return clientError(
        'watch-lagged',
        operation,
        'execution watch lagged behind retained events',
        cause,
        resource,
      );
    case ResourceCondition.RESOURCE_CONDITION_UNSPECIFIED:
    case ResourceCondition.UNRECOGNIZED:
    default:
      return clientError(
        'protocol',
        operation,
        `unknown execution resource condition ${String(detail.condition)}`,
        cause,
        resource,
      );
  }
}

function isKnownResourceCondition(
  resource: ResourceKind,
  condition: ResourceCondition,
): boolean {
  switch (resource) {
    case ResourceKind.RESOURCE_KIND_WORKSPACE:
    case ResourceKind.RESOURCE_KIND_SOURCE:
    case ResourceKind.RESOURCE_KIND_SESSION:
      return (
        condition === ResourceCondition.RESOURCE_CONDITION_NOT_FOUND ||
        condition === ResourceCondition.RESOURCE_CONDITION_CLOSED
      );
    case ResourceKind.RESOURCE_KIND_EXECUTION:
      return (
        condition === ResourceCondition.RESOURCE_CONDITION_NOT_FOUND ||
        condition === ResourceCondition.RESOURCE_CONDITION_CLOSED ||
        condition === ResourceCondition.RESOURCE_CONDITION_INVALID_STATE ||
        condition ===
          ResourceCondition.RESOURCE_CONDITION_INVALID_PARAMETERS
      );
    case ResourceKind.RESOURCE_KIND_WATCHER:
      return condition === ResourceCondition.RESOURCE_CONDITION_LAGGED;
    case ResourceKind.RESOURCE_KIND_UNSPECIFIED:
    case ResourceKind.UNRECOGNIZED:
    default:
      return false;
  }
}

function mapResource(value: ResourceKind): FerretExecutionResource {
  switch (value) {
    case ResourceKind.RESOURCE_KIND_WORKSPACE:
      return 'workspace';
    case ResourceKind.RESOURCE_KIND_SOURCE:
      return 'source';
    case ResourceKind.RESOURCE_KIND_SESSION:
      return 'session';
    case ResourceKind.RESOURCE_KIND_EXECUTION:
      return 'execution';
    case ResourceKind.RESOURCE_KIND_WATCHER:
      return 'watcher';
    case ResourceKind.RESOURCE_KIND_UNSPECIFIED:
    case ResourceKind.UNRECOGNIZED:
    default:
      throw new ProtocolMappingError(
        `unknown execution resource ${String(value)}`,
      );
  }
}

function clientError(
  code: FerretExecutionErrorCode,
  operation: FerretExecutionOperation,
  message: string,
  cause: unknown,
  resource?: FerretExecutionResource,
): FerretExecutionClientError {
  return new FerretExecutionClientError({
    code,
    operation,
    message,
    cause,
    ...(resource === undefined ? {} : { resource }),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
