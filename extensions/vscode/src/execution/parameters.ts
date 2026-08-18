import type {
  FerretJsonValue,
  FerretParameters,
} from './types';

export class InvalidParametersError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidParametersError';
  }
}

export function validateParameters(
  parameters: Readonly<Record<string, unknown>>,
): FerretParameters {
  return validateParameterObject(parameters);
}

export function validateProtocolParameters(
  parameters: unknown,
): FerretParameters {
  return validateParameterObject(parameters);
}

/*
 * Clone instead of serializing so valid numeric and structural values cross
 * the protobuf Struct boundary without text conversion.
 */
function validateParameterObject(parameters: unknown): FerretParameters {
  try {
    if (!isRecord(parameters)) {
      throw new InvalidParametersError(
        'execution parameters must be a JSON object',
      );
    }

    return cloneObject(parameters, new Set<object>(), '$');
  } catch (error) {
    if (error instanceof InvalidParametersError) {
      throw error;
    }

    throw new InvalidParametersError(
      `execution parameters cannot be inspected: ${formatError(error)}`,
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneValue(
  value: unknown,
  ancestors: Set<object>,
  path: string,
): FerretJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidParametersError(
        `${path} must contain a finite JSON number`,
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    return cloneArray(value, ancestors, path);
  }

  if (isRecord(value)) {
    return cloneObject(value, ancestors, path);
  }

  throw new InvalidParametersError(
    `${path} contains a value that JSON cannot represent`,
  );
}

function cloneObject(
  value: Readonly<Record<string, unknown>>,
  ancestors: Set<object>,
  path: string,
): FerretParameters {
  return withAncestor(value, ancestors, path, () => {
    const result: Record<string, FerretJsonValue> = {};

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new InvalidParametersError(
          `${path} contains a symbol-keyed property`,
        );
      }
      if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
        throw new InvalidParametersError(
          `${propertyPath(path, key)} is not an enumerable JSON property`,
        );
      }

      const item = cloneValue(
        value[key],
        ancestors,
        propertyPath(path, key),
      );
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });
    }

    return result;
  });
}

function cloneArray(
  value: readonly unknown[],
  ancestors: Set<object>,
  path: string,
): readonly FerretJsonValue[] {
  return withAncestor(value, ancestors, path, () => {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new InvalidParametersError(
          `${path} contains a symbol-keyed array property`,
        );
      }
      if (key !== 'length' && !isArrayIndex(key, value.length)) {
        throw new InvalidParametersError(
          `${propertyPath(path, key)} is not a JSON array element`,
        );
      }
    }

    return Array.from({ length: value.length }, (_unused, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new InvalidParametersError(
          `${path}[${String(index)}] is a sparse array element`,
        );
      }

      return cloneValue(
        value[index],
        ancestors,
        `${path}[${String(index)}]`,
      );
    });
  });
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);

  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function withAncestor<Result>(
  value: object,
  ancestors: Set<object>,
  path: string,
  operation: () => Result,
): Result {
  if (ancestors.has(value)) {
    throw new InvalidParametersError(
      `${path} contains a cyclic JSON value`,
    );
  }

  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}
