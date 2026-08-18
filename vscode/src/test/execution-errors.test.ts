import * as assert from 'node:assert/strict';

import {
  Metadata,
  status,
  type ServiceError,
} from '@grpc/grpc-js';

import {
  DaemonDisposedError,
  DaemonError,
} from '../daemon/errors';
import { Any } from '../daemon/gen/google/protobuf/any.pb';
import { Status } from '../daemon/gen/google/rpc/status.pb';
import {
  CompilationFailure,
  ResourceCondition,
  ResourceErrorDetail,
  ResourceKind,
} from '../daemon/gen/ferretd/execution/v1/execution.pb';
import {
  FerretExecutionClientError,
  normalizeExecutionError,
  type FerretExecutionErrorCode,
  type FerretExecutionResource,
} from '../execution/errors';
import { diagnostic, sourceSnapshot } from './execution-fixtures';

suite('Ferret execution error normalization', () => {
  test('decodes structured compilation diagnostics', () => {
    const cause = detailedServiceError(
      status.INVALID_ARGUMENT,
      anyDetail(
        'ferretd.execution.v1.CompilationFailure',
        CompilationFailure.encode({
          source: sourceSnapshot(7),
          diagnostics: [diagnostic()],
        }).finish(),
      ),
    );

    const error = normalizeExecutionError(cause, 'create-session');

    assert.strictEqual(error.code, 'compilation-failed');
    assert.strictEqual(error.operation, 'create-session');
    assert.strictEqual(error.resource, 'source');
    assert.strictEqual(error.source?.revision, 7);
    assert.strictEqual(error.diagnostics?.[0]?.code, 'FQL1001');
    assert.strictEqual(error.cause, cause);
  });

  test('classifies every resource detail condition', () => {
    const cases: readonly [
      ResourceKind,
      ResourceCondition,
      FerretExecutionResource,
      FerretExecutionErrorCode,
    ][] = [
      [
        ResourceKind.RESOURCE_KIND_WORKSPACE,
        ResourceCondition.RESOURCE_CONDITION_NOT_FOUND,
        'workspace',
        'not-found',
      ],
      [
        ResourceKind.RESOURCE_KIND_SOURCE,
        ResourceCondition.RESOURCE_CONDITION_CLOSED,
        'source',
        'closed',
      ],
      [
        ResourceKind.RESOURCE_KIND_SESSION,
        ResourceCondition.RESOURCE_CONDITION_CLOSED,
        'session',
        'closed',
      ],
      [
        ResourceKind.RESOURCE_KIND_EXECUTION,
        ResourceCondition.RESOURCE_CONDITION_INVALID_PARAMETERS,
        'execution',
        'invalid-parameters',
      ],
      [
        ResourceKind.RESOURCE_KIND_WATCHER,
        ResourceCondition.RESOURCE_CONDITION_LAGGED,
        'watcher',
        'watch-lagged',
      ],
    ];

    for (const [resource, condition, expectedResource, expectedCode] of cases) {
      const cause = resourceServiceError(resource, condition);
      const error = normalizeExecutionError(cause, 'watch-execution');
      assert.strictEqual(error.code, expectedCode);
      assert.strictEqual(error.resource, expectedResource);
      assert.strictEqual(error.cause, cause);
    }
  });

  test('normalizes daemon, local cancellation, and rejection failures', () => {
    const incompatible = normalizeExecutionError(
      new DaemonError('incompatible-daemon', 'wrong API'),
      'create-session',
    );
    assert.strictEqual(incompatible.code, 'incompatible-daemon');

    const unavailable = normalizeExecutionError(
      new DaemonError('unavailable', 'gone'),
      'run-execution',
    );
    assert.strictEqual(unavailable.code, 'daemon-unavailable');

    const disposed = normalizeExecutionError(
      new DaemonDisposedError(),
      'close-session',
    );
    assert.strictEqual(disposed.code, 'cancelled');

    const cancelledCause = serviceError(status.CANCELLED, 'cancelled');
    const cancelled = normalizeExecutionError(
      cancelledCause,
      'cancel-execution',
    );
    assert.strictEqual(cancelled.code, 'cancelled');
    assert.strictEqual(cancelled.operation, 'cancel-execution');

    const rejected = normalizeExecutionError(
      serviceError(status.PERMISSION_DENIED, 'denied'),
      'run-execution',
    );
    assert.strictEqual(rejected.code, 'execution-rejected');
  });

  test('uses structured invalid state for cancellation-operation failures', () => {
    const error = normalizeExecutionError(
      resourceServiceError(
        ResourceKind.RESOURCE_KIND_EXECUTION,
        ResourceCondition.RESOURCE_CONDITION_INVALID_STATE,
      ),
      'cancel-execution',
    );

    assert.strictEqual(error.code, 'invalid-state');
    assert.strictEqual(error.operation, 'cancel-execution');
    assert.strictEqual(error.resource, 'execution');
  });

  test('rejects unknown and malformed structured details as protocol errors', () => {
    for (const cause of [
      resourceServiceError(
        99 as ResourceKind,
        ResourceCondition.RESOURCE_CONDITION_NOT_FOUND,
      ),
      resourceServiceError(
        ResourceKind.RESOURCE_KIND_EXECUTION,
        99 as ResourceCondition,
      ),
      resourceServiceError(
        ResourceKind.RESOURCE_KIND_SESSION,
        ResourceCondition.RESOURCE_CONDITION_INVALID_PARAMETERS,
      ),
      detailedServiceError(
        status.INVALID_ARGUMENT,
        anyDetail(
          'ferretd.execution.v1.ResourceErrorDetail',
          Buffer.from([0xff]),
        ),
      ),
      malformedStatusError(),
    ]) {
      const error = normalizeExecutionError(cause, 'create-execution');
      assert.ok(error instanceof FerretExecutionClientError);
      assert.strictEqual(error.code, 'protocol');
      assert.strictEqual(error.cause, cause);
    }
  });
});

function resourceServiceError(
  resource: ResourceKind,
  condition: ResourceCondition,
): ServiceError {
  return detailedServiceError(
    status.FAILED_PRECONDITION,
    anyDetail(
      'ferretd.execution.v1.ResourceErrorDetail',
      ResourceErrorDetail.encode({ resource, condition }).finish(),
    ),
  );
}

function anyDetail(type: string, value: Uint8Array): Any {
  return {
    typeUrl: `type.googleapis.com/${type}`,
    value: Buffer.from(value),
  };
}

function detailedServiceError(
  code: status,
  ...details: Any[]
): ServiceError {
  const error = serviceError(code, 'structured failure');
  error.metadata.set(
    'grpc-status-details-bin',
    Buffer.from(
      Status.encode({ code, message: error.details, details }).finish(),
    ),
  );

  return error;
}

function malformedStatusError(): ServiceError {
  const error = serviceError(status.INVALID_ARGUMENT, 'malformed');
  error.metadata.set(
    'grpc-status-details-bin',
    Buffer.from([0xff]),
  );

  return error;
}

function serviceError(code: status, details: string): ServiceError {
  return Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  });
}
