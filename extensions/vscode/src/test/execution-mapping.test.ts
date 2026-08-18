import * as assert from 'node:assert/strict';

import {
  DiagnosticSeverity,
  ExecutionState,
  FailureCategory,
  SourceSnapshot,
  WatchExecutionResponse,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import {
  mapExecution,
  mapExecutionEvent,
  mapSession,
  ProtocolMappingError,
} from '../execution/mapping';
import {
  completedExecution,
  execution,
  executionEvent,
  failedExecution,
  session,
  sourceSnapshot,
} from './execution-fixtures';

suite('Ferret execution protocol mapping', () => {
  test('maps complete sessions, parameters, output, and failures', () => {
    assert.deepStrictEqual(mapSession(session()), {
      id: 'session-1',
      source: {
        workspaceId: 'workspace-1',
        relativePath: 'queries/example.fql',
        uri: 'file:///workspace/queries/example.fql',
        revision: 1,
      },
      parameters: ['value', 'nested'],
    });

    const completed = mapExecution(completedExecution());
    assert.strictEqual(completed.status, 'completed');
    assert.deepStrictEqual(completed.parameters, {
      value: 42,
      nested: { enabled: true, values: [null, 'ok'] },
    });
    assert.deepStrictEqual(
      completed.output?.data,
      new Uint8Array(Buffer.from('{"ok":true}')),
    );

    const failed = mapExecution(failedExecution());
    assert.strictEqual(failed.failure?.category, 'runtime');
    assert.strictEqual(
      failed.failure?.diagnostics[0]?.relatedInformation[0]?.message,
      'related source',
    );
  });

  test('maps all current statuses and event kinds', () => {
    const statuses = [
      [ExecutionState.EXECUTION_STATE_CREATED, 'created'],
      [ExecutionState.EXECUTION_STATE_RUNNING, 'running'],
      [ExecutionState.EXECUTION_STATE_COMPLETED, 'completed'],
      [ExecutionState.EXECUTION_STATE_FAILED, 'failed'],
      [ExecutionState.EXECUTION_STATE_CANCELLED, 'cancelled'],
    ] as const;
    for (const [wire, domain] of statuses) {
      const value =
        wire === ExecutionState.EXECUTION_STATE_COMPLETED
          ? completedExecution()
          : wire === ExecutionState.EXECUTION_STATE_FAILED
            ? failedExecution()
            : execution(wire);
      assert.strictEqual(mapExecution(value).status, domain);
    }

    const kinds = [
      'created',
      'started',
      'completed',
      'failed',
      'cancelled',
    ] as const;
    kinds.forEach((kind, index) => {
      const mapped = mapExecutionEvent(
        executionEvent(kind, index + 1),
      );
      assert.strictEqual(mapped.kind, kind);
      assert.strictEqual(mapped.sequence, index + 1);
    });
  });

  test('rejects unspecified, unknown, and malformed protocol values', () => {
    for (const state of [
      ExecutionState.EXECUTION_STATE_UNSPECIFIED,
      ExecutionState.UNRECOGNIZED,
      99 as ExecutionState,
    ]) {
      assert.throws(
        () => mapExecution(execution(state)),
        ProtocolMappingError,
      );
    }

    assert.throws(
      () =>
        mapExecution(
          failedExecutionWith(
            FailureCategory.FAILURE_CATEGORY_UNSPECIFIED,
          ),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapSession({
          ...session(),
          parameters: ['value', 'value'],
        }),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapSession({
          ...session(),
          source: { ...sourceSnapshot(), relativePath: '../query.fql' },
        }),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecution(
          failedExecutionWith(
            FailureCategory.FAILURE_CATEGORY_RUNTIME,
            DiagnosticSeverity.DIAGNOSTIC_SEVERITY_UNSPECIFIED,
          ),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecution(
          execution(ExecutionState.EXECUTION_STATE_CREATED, {
            state: undefined as unknown as ExecutionState,
          }),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecution(
          execution(ExecutionState.EXECUTION_STATE_CREATED, {
            parameters: { bad: Number.NaN },
          }),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecution(
          execution(ExecutionState.EXECUTION_STATE_COMPLETED),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () => mapExecution(execution(ExecutionState.EXECUTION_STATE_FAILED)),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecutionEvent({
          ...executionEvent('created', 1),
          payload: { $case: 'future' },
        } as unknown as WatchExecutionResponse),
      ProtocolMappingError,
    );
  });

  test('rejects unsafe revisions, sequences, and mismatched events', () => {
    assert.throws(
      () => mapSession({ ...session(), source: sourceSnapshot(0) }),
      ProtocolMappingError,
    );
    assert.throws(() =>
      SourceSnapshot.decode(
        SourceSnapshot.encode(
          sourceSnapshot(Number.MAX_SAFE_INTEGER + 1),
        ).finish(),
      ),
    );
    assert.throws(() =>
      WatchExecutionResponse.decode(
        WatchExecutionResponse.encode(
          executionEvent('created', Number.MAX_SAFE_INTEGER + 1),
        ).finish(),
      ),
    );
    assert.throws(
      () =>
        mapSession({
          ...session(),
          source: sourceSnapshot(Number.MAX_SAFE_INTEGER + 1),
        }),
      ProtocolMappingError,
    );
    assert.throws(
      () => mapExecutionEvent(executionEvent('created', 0)),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecutionEvent(
          executionEvent('created', Number.MAX_SAFE_INTEGER + 1),
        ),
      ProtocolMappingError,
    );
    assert.throws(
      () =>
        mapExecutionEvent({
          ...executionEvent('created', 1),
          executionId: { value: 'different' },
        }),
      ProtocolMappingError,
    );
  });
});

function failedExecutionWith(
  category: FailureCategory,
  severity: DiagnosticSeverity = DiagnosticSeverity.DIAGNOSTIC_SEVERITY_ERROR,
) {
  const value = failedExecution();

  return {
    ...value,
    failure: {
      ...value.failure!,
      category,
      diagnostics: value.failure!.diagnostics.map((item) => ({
        ...item,
        severity,
      })),
    },
  };
}
