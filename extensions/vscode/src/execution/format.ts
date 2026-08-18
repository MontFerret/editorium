import type { FerretExecutionOutput } from './types';

const jsonContentType = 'application/json';
const indent = '  ';

export class ExecutionResultRenderError extends Error {
  public readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ExecutionResultRenderError';
    this.cause = cause;
  }
}

export function renderExecutionOutput(
  output: FerretExecutionOutput,
): string {
  const contentType = output.contentType
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== jsonContentType) {
    throw new ExecutionResultRenderError(
      `unsupported execution result content type ${JSON.stringify(output.contentType)}`,
    );
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(
      output.data,
    );
  } catch (error) {
    throw new ExecutionResultRenderError(
      'execution result is not valid UTF-8',
      error,
    );
  }

  try {
    JSON.parse(source);
  } catch (error) {
    throw new ExecutionResultRenderError(
      'execution result is not valid JSON',
      error,
    );
  }

  return prettyPrintJson(source);
}

export function formatDuration(milliseconds: number): string {
  const elapsed = Number.isFinite(milliseconds)
    ? Math.max(0, milliseconds)
    : 0;
  if (elapsed < 1_000) {
    const rounded = Math.round(elapsed);
    if (rounded < 1_000) {
      return `${rounded} ms`;
    }
  }

  const tenths = Math.round(elapsed / 100);
  if (tenths < 600) {
    const seconds = tenths / 10;
    const value = Number.isInteger(seconds)
      ? seconds.toFixed(0)
      : seconds.toFixed(1);
    return `${value} s`;
  }

  const totalSeconds = Math.round(elapsed / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatTimestamp(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function prettyPrintJson(source: string): string {
  const value = source.trim();
  const stack: boolean[] = [];
  let depth = 0;
  let escaped = false;
  let inString = false;
  let result = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (isJsonWhitespace(character)) {
      continue;
    }

    switch (character) {
      case '"':
        inString = true;
        result += character;
        break;
      case '{':
      case '[': {
        const closing = character === '{' ? '}' : ']';
        const empty = nextSignificantCharacter(value, index + 1) === closing;
        stack.push(empty);
        result += character;
        if (!empty) {
          depth += 1;
          result += `\n${indent.repeat(depth)}`;
        }
        break;
      }
      case '}':
      case ']': {
        const empty = stack.pop() ?? false;
        if (!empty) {
          depth -= 1;
          result += `\n${indent.repeat(depth)}`;
        }
        result += character;
        break;
      }
      case ',':
        result += `,\n${indent.repeat(depth)}`;
        break;
      case ':':
        result += ': ';
        break;
      default:
        result += character;
        break;
    }
  }

  return result;
}

function nextSignificantCharacter(
  value: string,
  start: number,
): string | undefined {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (!isJsonWhitespace(character)) {
      return character;
    }
  }

  return undefined;
}

function isJsonWhitespace(value: string): boolean {
  return (
    value === ' ' ||
    value === '\n' ||
    value === '\r' ||
    value === '\t'
  );
}
