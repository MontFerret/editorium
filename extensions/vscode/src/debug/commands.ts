import * as vscode from 'vscode';

import { readRuntimeSelector } from '../runtime/selector';
import { ferretDebugType } from './adapter';

export const debugFileCommand = 'ferret.debugFile';

export interface FerretDebugCommandHost {
  registerCommand(
    command: string,
    handler: (options?: unknown) => Thenable<boolean>,
  ): vscode.Disposable;
  startDebugging(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Thenable<boolean>;
}

export function registerFerretDebugCommand(
  host: FerretDebugCommandHost = vscodeFerretDebugCommandHost,
): vscode.Disposable {
  return host.registerCommand(debugFileCommand, options => {
    const runtimeName = readRuntimeSelector(options);
    return host.startDebugging(undefined, {
      type: ferretDebugType, ...(runtimeName === undefined ? {} : { runtimeName }),
    } as vscode.DebugConfiguration);
  });
}

const vscodeFerretDebugCommandHost: FerretDebugCommandHost = {
  registerCommand: (command, handler) =>
    vscode.commands.registerCommand(command, handler),
  startDebugging: (folder, configuration) =>
    vscode.debug.startDebugging(folder, configuration),
};
