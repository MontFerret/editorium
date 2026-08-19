import type { ServiceError } from '@grpc/grpc-js';

import { Status } from './gen/google/rpc/status.pb';

const statusDetailsKey = 'grpc-status-details-bin';

export function decodeStatusDetails(
  error: unknown,
): Status | undefined {
  if (!isServiceError(error)) {
    return undefined;
  }

  const values = error.metadata.get(statusDetailsKey);
  const encoded = values.find((value): value is Buffer =>
    Buffer.isBuffer(value),
  );
  if (encoded === undefined) {
    return undefined;
  }

  try {
    return Status.decode(encoded);
  } catch {
    return undefined;
  }
}

export function detailType(typeUrl: string): string {
  const separator = typeUrl.lastIndexOf('/');

  return separator < 0 ? typeUrl : typeUrl.slice(separator + 1);
}

export function isServiceError(
  error: unknown,
): error is ServiceError {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'number' &&
    'metadata' in error &&
    error.metadata !== null &&
    typeof error.metadata === 'object' &&
    'get' in error.metadata &&
    typeof error.metadata.get === 'function'
  );
}
