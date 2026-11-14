import { posix } from 'node:path';
import { normalizeExecutionError, type FerretExecutionOperation } from './errors';
import { ProtocolMappingError } from './mapping';

export function validateIdentifier(
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

export function validateRelativePath(value: string): void {
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
