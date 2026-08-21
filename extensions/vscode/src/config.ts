import * as vscode from 'vscode';

import type { FerretdExecutable } from './ferretd';

export const languageId = 'ferret';
export const restartLanguageServerCommand =
  'ferret.restartLanguageServer';

export type TraceSetting = 'off' | 'messages' | 'verbose';

export type ServerConfiguration = FerretdExecutable & {
  readonly extraArguments: readonly string[];
};

export function createServerConfiguration(
  selection: FerretdExecutable,
  configuredArguments: readonly string[],
): ServerConfiguration {
  return {
    ...selection,
    extraArguments: [...configuredArguments],
  };
}

export function readServerConfiguration(
  selection: FerretdExecutable,
): ServerConfiguration {
  const configuration = vscode.workspace.getConfiguration(languageId);

  return createServerConfiguration(
    selection,
    configuration.get<readonly string[]>('server.args', []),
  );
}

export function readTraceSetting(): TraceSetting {
  return vscode.workspace
    .getConfiguration(languageId)
    .get<TraceSetting>('trace.server', 'off');
}
