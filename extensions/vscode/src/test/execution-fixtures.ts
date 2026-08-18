import {
  DiagnosticSeverity,
  ExecutionState,
  FailureCategory,
  type Diagnostic,
  type Execution,
  type Session,
  type SourceSnapshot,
  type WatchExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';

export function sourceSnapshot(
  revision = 1,
): SourceSnapshot {
  return {
    workspaceId: { value: 'workspace-1' },
    relativePath: 'queries/example.fql',
    uri: 'file:///workspace/queries/example.fql',
    revision,
  };
}

export function session(): Session {
  return {
    id: { value: 'session-1' },
    source: sourceSnapshot(),
    parameters: ['value', 'nested'],
  };
}

export function diagnostic(): Diagnostic {
  return {
    uri: 'file:///workspace/queries/example.fql',
    range: {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 7 },
    },
    severity: DiagnosticSeverity.DIAGNOSTIC_SEVERITY_ERROR,
    code: 'FQL1001',
    source: 'ferret',
    message: 'invalid expression',
    relatedInformation: [
      {
        uri: 'file:///workspace/queries/other.fql',
        range: {
          start: { line: 3, character: 1 },
          end: { line: 3, character: 4 },
        },
        message: 'related source',
      },
    ],
  };
}

export function execution(
  state: ExecutionState = ExecutionState.EXECUTION_STATE_CREATED,
  overrides: Partial<Execution> = {},
): Execution {
  return {
    id: { value: 'execution-1' },
    sessionId: { value: 'session-1' },
    state,
    parameters: {
      value: 42,
      nested: { enabled: true, values: [null, 'ok'] },
    },
    options: { outputContentType: 'application/json' },
    ...overrides,
  };
}

export function completedExecution(): Execution {
  return execution(ExecutionState.EXECUTION_STATE_COMPLETED, {
    output: {
      contentType: 'application/json',
      data: Buffer.from('{"ok":true}'),
    },
  });
}

export function failedExecution(): Execution {
  return execution(ExecutionState.EXECUTION_STATE_FAILED, {
    failure: {
      category: FailureCategory.FAILURE_CATEGORY_RUNTIME,
      message: 'runtime failed',
      diagnostics: [diagnostic()],
    },
  });
}

export function executionEvent(
  kind: 'created' | 'started' | 'completed' | 'failed' | 'cancelled',
  sequence: number,
  provided?: Execution,
): WatchExecutionResponse {
  const value = provided ?? eventExecution(kind);
  switch (kind) {
    case 'created':
      return {
        executionId: value.id,
        sequence,
        payload: { $case: kind, created: { execution: value } },
      };
    case 'started':
      return {
        executionId: value.id,
        sequence,
        payload: { $case: kind, started: { execution: value } },
      };
    case 'completed':
      return {
        executionId: value.id,
        sequence,
        payload: { $case: kind, completed: { execution: value } },
      };
    case 'failed':
      return {
        executionId: value.id,
        sequence,
        payload: { $case: kind, failed: { execution: value } },
      };
    case 'cancelled':
      return {
        executionId: value.id,
        sequence,
        payload: { $case: kind, cancelled: { execution: value } },
      };
  }
}

function eventExecution(
  kind: 'created' | 'started' | 'completed' | 'failed' | 'cancelled',
): Execution {
  switch (kind) {
    case 'created':
      return execution(ExecutionState.EXECUTION_STATE_CREATED);
    case 'started':
      return execution(ExecutionState.EXECUTION_STATE_RUNNING);
    case 'completed':
      return completedExecution();
    case 'failed':
      return failedExecution();
    case 'cancelled':
      return execution(ExecutionState.EXECUTION_STATE_CANCELLED);
  }
}
