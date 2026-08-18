import * as vscode from 'vscode';
import type {
  DocumentSelector,
  Executable,
} from 'vscode-languageclient/node';

export const languageId = 'ferret';
export const restartLanguageServerCommand =
  'ferret.restartLanguageServer';

export const ferretDocumentSelector: DocumentSelector = [
  { scheme: 'file', language: languageId },
];

export type TraceSetting = 'off' | 'messages' | 'verbose';

export interface ServerConfiguration {
  readonly executable: string;
  readonly extraArguments: readonly string[];
}

export function createServerConfiguration(
  configuredPath: string,
  configuredArguments: readonly string[],
): ServerConfiguration {
  return {
    executable: configuredPath === '' ? 'ferretd' : configuredPath,
    extraArguments: [...configuredArguments],
  };
}

export function readServerConfiguration(): ServerConfiguration {
  const configuration = vscode.workspace.getConfiguration(languageId);

  return createServerConfiguration(
    configuration.get<string>('server.path', ''),
    configuration.get<readonly string[]>('server.args', []),
  );
}

export function readTraceSetting(): TraceSetting {
  return vscode.workspace
    .getConfiguration(languageId)
    .get<TraceSetting>('trace.server', 'off');
}

export function createServerOptions(
  configuration: ServerConfiguration,
): Executable {
  // Command executables use stdio when transport is omitted. Setting
  // TransportKind.stdio explicitly would make vscode-languageclient append a
  // --stdio argument, but ferretd expects the exact `lsp` subcommand contract.
  return {
    command: configuration.executable,
    args: ['lsp', ...configuration.extraArguments],
    options: { detached: false },
  };
}
