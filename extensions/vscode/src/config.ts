import * as vscode from 'vscode';

export const languageId = 'ferret';
export const restartLanguageServerCommand =
  'ferret.restartLanguageServer';

export type TraceSetting = 'off' | 'messages' | 'verbose';

interface ServerConfigurationBase {
  readonly executable: string;
  readonly extraArguments: readonly string[];
}

export type ServerConfiguration =
  | (ServerConfigurationBase & {
      readonly source: 'bundled';
      readonly bundledVersion: string;
    })
  | (ServerConfigurationBase & {
      readonly source: 'configured';
    });

export function createServerConfiguration(
  configuredPath: string,
  configuredArguments: readonly string[],
  bundledExecutable: string,
  bundledVersion: string,
): ServerConfiguration {
  if (configuredPath !== '') {
    return {
      executable: configuredPath,
      extraArguments: [...configuredArguments],
      source: 'configured',
    };
  }

  return {
    executable: bundledExecutable,
    extraArguments: [...configuredArguments],
    source: 'bundled',
    bundledVersion,
  };
}

export function readServerConfiguration(
  context: vscode.ExtensionContext,
  bundledVersion: string,
): ServerConfiguration {
  const configuration = vscode.workspace.getConfiguration(languageId);

  return createServerConfiguration(
    configuration.get<string>('server.path', ''),
    configuration.get<readonly string[]>('server.args', []),
    context.asAbsolutePath(
      `bin/${bundledExecutableName(process.platform)}`,
    ),
    bundledVersion,
  );
}

export function bundledExecutableName(
  platform: NodeJS.Platform,
): 'ferretd' | 'ferretd.exe' {
  return platform === 'win32' ? 'ferretd.exe' : 'ferretd';
}

export function readTraceSetting(): TraceSetting {
  return vscode.workspace
    .getConfiguration(languageId)
    .get<TraceSetting>('trace.server', 'off');
}
