import type * as vscode from 'vscode';

import { RuntimeLaunchError } from '../runtime/errors';
import { readRuntimeSelector } from '../runtime/selector';
import { validateParameters } from './parameters';
import type { FerretParameters } from './types';

export interface RunOptions {
  readonly runtimeName?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly workingDirectory?: string;
}

export function readRunOptions(
  options: unknown,
  settings: Pick<vscode.WorkspaceConfiguration, 'get'>,
): RunOptions & { readonly parameters: FerretParameters } {
  const input = (name: string, fallback: unknown): unknown => {
    if (options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, name)) {
      return Reflect.get(options, name);
    }
    return settings.get<unknown>(name, fallback);
  };
  const runtimeName = readRuntimeSelector(options);
  const workingDirectory = input('workingDirectory', '');
  if (typeof workingDirectory !== 'string') throw new RuntimeLaunchError('Set the Run working directory to a string.');
  return { runtimeName, workingDirectory, parameters: validateParameters(input('parameters', {})) };
}
