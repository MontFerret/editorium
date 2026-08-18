import { posix } from 'node:path';

import {
  DiagnosticSeverity,
  ExecutionState,
  FailureCategory,
  type Diagnostic,
  type Execution,
  type Position,
  type Range,
  type Session,
  type SourceSnapshot,
  type WatchExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import { validateProtocolParameters } from './parameters';
import { InvalidParametersError } from './parameters';
import type {
  FerretDiagnostic,
  FerretExecution,
  FerretExecutionEvent,
  FerretExecutionFailure,
  FerretExecutionFailureCategory,
  FerretExecutionStatus,
  FerretPosition,
  FerretRange,
  FerretSession,
  FerretSourceSnapshot,
} from './types';

export class ProtocolMappingError extends Error {
  public readonly cause?: unknown;

  public constructor(
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'ProtocolMappingError';
    this.cause = options?.cause;
  }
}

export function mapSession(value: Session | undefined): FerretSession {
  if (
    value?.id?.value === undefined ||
    value.id.value === '' ||
    value.parameters.some((name) => name === '') ||
    new Set(value.parameters).size !== value.parameters.length
  ) {
    throw new ProtocolMappingError(
      'daemon returned an incomplete session',
    );
  }

  return {
    id: value.id.value,
    source: mapSourceSnapshot(value.source),
    parameters: [...value.parameters],
  };
}

export function mapSourceSnapshot(
  value: SourceSnapshot | undefined,
): FerretSourceSnapshot {
  if (
    value?.workspaceId?.value === undefined ||
    value.workspaceId.value === '' ||
    !isNormalizedRelativePath(value.relativePath) ||
    value.uri === '' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new ProtocolMappingError(
      'daemon returned an incomplete source snapshot',
    );
  }

  return {
    workspaceId: value.workspaceId.value,
    relativePath: value.relativePath,
    uri: value.uri,
    revision: value.revision,
  };
}

export function mapExecution(
  value: Execution | undefined,
): FerretExecution {
  if (
    value?.id?.value === undefined ||
    value.id.value === '' ||
    value.sessionId?.value === undefined ||
    value.sessionId.value === '' ||
    value.options === undefined ||
    value.options.outputContentType === ''
  ) {
    throw new ProtocolMappingError(
      'daemon returned an incomplete execution',
    );
  }

  let parameters;
  try {
    parameters = validateProtocolParameters(value.parameters ?? {});
  } catch (error) {
    if (error instanceof InvalidParametersError) {
      throw new ProtocolMappingError(
        'daemon returned malformed execution parameters',
        { cause: error },
      );
    }

    throw error;
  }
  const status = mapStatus(value.state);
  if (status === 'completed' && value.output === undefined) {
    throw new ProtocolMappingError(
      'daemon returned a completed execution without output',
    );
  }
  if (
    (status === 'created' || status === 'running') &&
    value.output !== undefined
  ) {
    throw new ProtocolMappingError(
      `daemon returned output for ${status} execution`,
    );
  }
  if (value.output !== undefined && value.output.contentType === '') {
    throw new ProtocolMappingError(
      'daemon returned execution output without a content type',
    );
  }
  if (status === 'failed' && value.failure === undefined) {
    throw new ProtocolMappingError(
      'daemon returned a failed execution without failure details',
    );
  }
  if (status !== 'failed' && value.failure !== undefined) {
    throw new ProtocolMappingError(
      `daemon returned failure details for ${status} execution`,
    );
  }

  const result: FerretExecution = {
    id: value.id.value,
    sessionId: value.sessionId.value,
    status,
    parameters,
    options: {
      outputContentType: value.options.outputContentType,
    },
  };

  return {
    ...result,
    ...(value.output === undefined
      ? {}
      : {
          output: {
            contentType: value.output.contentType,
            data: new Uint8Array(value.output.data),
          },
        }),
    ...(value.failure === undefined
      ? {}
      : { failure: mapFailure(value.failure) }),
  };
}

export function mapExecutionEvent(
  value: WatchExecutionResponse,
): FerretExecutionEvent {
  if (
    value.executionId?.value === undefined ||
    value.executionId.value === '' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.payload === undefined
  ) {
    throw new ProtocolMappingError(
      'daemon returned an incomplete execution event',
    );
  }

  const payload = value.payload;
  let execution: FerretExecution;
  switch (payload.$case) {
    case 'created':
      execution = mapExecution(payload.created.execution);
      break;
    case 'started':
      execution = mapExecution(payload.started.execution);
      break;
    case 'completed':
      execution = mapExecution(payload.completed.execution);
      break;
    case 'failed':
      execution = mapExecution(payload.failed.execution);
      break;
    case 'cancelled':
      execution = mapExecution(payload.cancelled.execution);
      break;
    default:
      throw new ProtocolMappingError(
        `daemon returned unknown execution event kind ${String(
          (payload as { readonly $case?: unknown }).$case,
        )}`,
      );
  }
  if (execution.id !== value.executionId.value) {
    throw new ProtocolMappingError(
      'daemon returned an execution event with mismatched identity',
    );
  }
  const expectedStatus: FerretExecutionStatus =
    payload.$case === 'started' ? 'running' : payload.$case;
  if (execution.status !== expectedStatus) {
    throw new ProtocolMappingError(
      `daemon returned ${payload.$case} event with ${execution.status} execution`,
    );
  }

  return {
    executionId: value.executionId.value,
    sequence: value.sequence,
    kind: payload.$case,
    execution,
  };
}

export function mapDiagnostics(
  values: readonly Diagnostic[],
): readonly FerretDiagnostic[] {
  return values.map((value) => ({
    uri: value.uri,
    range: mapRange(value.range),
    severity: mapDiagnosticSeverity(value.severity),
    code: value.code,
    source: value.source,
    message: value.message,
    relatedInformation: value.relatedInformation.map((related) => ({
      uri: related.uri,
      range: mapRange(related.range),
      message: related.message,
    })),
  }));
}

function mapStatus(value: ExecutionState): FerretExecutionStatus {
  switch (value) {
    case ExecutionState.EXECUTION_STATE_CREATED:
      return 'created';
    case ExecutionState.EXECUTION_STATE_RUNNING:
      return 'running';
    case ExecutionState.EXECUTION_STATE_COMPLETED:
      return 'completed';
    case ExecutionState.EXECUTION_STATE_FAILED:
      return 'failed';
    case ExecutionState.EXECUTION_STATE_CANCELLED:
      return 'cancelled';
    case ExecutionState.EXECUTION_STATE_UNSPECIFIED:
    case ExecutionState.UNRECOGNIZED:
    default:
      throw new ProtocolMappingError(
        `daemon returned unknown execution state ${String(value)}`,
      );
  }
}

function mapFailure(value: {
  readonly category: FailureCategory;
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}): FerretExecutionFailure {
  return {
    category: mapFailureCategory(value.category),
    message: value.message,
    diagnostics: mapDiagnostics(value.diagnostics),
  };
}

function mapFailureCategory(
  value: FailureCategory,
): FerretExecutionFailureCategory {
  switch (value) {
    case FailureCategory.FAILURE_CATEGORY_SESSION_CREATION:
      return 'session-creation';
    case FailureCategory.FAILURE_CATEGORY_RUNTIME:
      return 'runtime';
    case FailureCategory.FAILURE_CATEGORY_CLEANUP:
      return 'cleanup';
    case FailureCategory.FAILURE_CATEGORY_UNSPECIFIED:
    case FailureCategory.UNRECOGNIZED:
    default:
      throw new ProtocolMappingError(
        `daemon returned unknown execution failure category ${String(value)}`,
      );
  }
}

function mapDiagnosticSeverity(value: DiagnosticSeverity): 'error' {
  switch (value) {
    case DiagnosticSeverity.DIAGNOSTIC_SEVERITY_ERROR:
      return 'error';
    case DiagnosticSeverity.DIAGNOSTIC_SEVERITY_UNSPECIFIED:
    case DiagnosticSeverity.UNRECOGNIZED:
    default:
      throw new ProtocolMappingError(
        `daemon returned unknown diagnostic severity ${String(value)}`,
      );
  }
}

function mapRange(value: Range | undefined): FerretRange {
  if (value === undefined) {
    throw new ProtocolMappingError(
      'daemon returned a diagnostic without a range',
    );
  }

  return {
    start: mapPosition(value.start),
    end: mapPosition(value.end),
  };
}

function mapPosition(value: Position | undefined): FerretPosition {
  if (
    value === undefined ||
    !Number.isSafeInteger(value.line) ||
    value.line < 0 ||
    !Number.isSafeInteger(value.character) ||
    value.character < 0
  ) {
    throw new ProtocolMappingError(
      'daemon returned a diagnostic without a position',
    );
  }

  return { line: value.line, character: value.character };
}

function isNormalizedRelativePath(value: string): boolean {
  return (
    value !== '' &&
    value !== '.' &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    value !== '..' &&
    !value.startsWith('../')
  );
}
