import { RuntimeLaunchError } from './errors';

/** Go's JSON decoder matches launch argument field names case-insensitively. */
export function readRuntimeSelector(options: unknown): string | undefined {
  if (options === null || typeof options !== 'object') return undefined;
  const fields = Object.keys(options).filter(key => /^runtimeName$/i.test(key));
  if (fields.length === 0) return undefined;
  if (fields.length > 1) throw new RuntimeLaunchError('Specify runtimeName only once in the launch options.');
  const value: unknown = Reflect.get(options, fields[0]!);
  if (typeof value !== 'string') throw new RuntimeLaunchError('Set runtimeName to a string or omit it for Daemon default.');
  return value;
}
