import * as vscode from 'vscode';

import { ferretDebugType } from './adapter';

export const debugFileCommand = 'ferret.debugFile';

export interface FerretDebugCommandHost {
  registerCommand(
    command: string,
    handler: () => Thenable<boolean>,
  ): vscode.Disposable;
  startDebugging(
    folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Thenable<boolean>;
}

export function registerFerretDebugCommand(
  host: FerretDebugCommandHost = vscodeFerretDebugCommandHost,
): vscode.Disposable {
  return host.registerCommand(debugFileCommand, () =>
    host.startDebugging(
      undefined,
      { type: ferretDebugType } as vscode.DebugConfiguration,
    ),
  );
}

const vscodeFerretDebugCommandHost: FerretDebugCommandHost = {
  registerCommand: (command, handler) =>
    vscode.commands.registerCommand(command, handler),
  startDebugging: (folder, configuration) =>
    vscode.debug.startDebugging(folder, configuration),
};
