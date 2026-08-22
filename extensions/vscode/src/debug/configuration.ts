import { dirname, extname } from 'node:path';

import * as vscode from 'vscode';

import { languageId } from '../config';
import { ferretDebugType } from './adapter';

const noActiveDocumentMessage =
  'Open a Ferret (.fql) file before starting a debug session.';
const wrongActiveDocumentMessage =
  'The active file is not a Ferret (.fql) file.';
const unsavedActiveDocumentMessage =
  'Save the Ferret file before starting a debug session.';
const missingProgramMessage =
  'Set "program" to the Ferret (.fql) file to debug.';
const unsuitableProgramMessage =
  'The debug "program" must point to a Ferret (.fql) file.';

export interface FerretDebugConfigurationHost {
  getActiveDocument(): vscode.TextDocument | undefined;
  getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
  showErrorMessage(message: string): Thenable<unknown>;
}

export interface DebugConfigurationRegistrationHost {
  registerDebugConfigurationProvider(
    debugType: string,
    provider: vscode.DebugConfigurationProvider,
    triggerKind?: vscode.DebugConfigurationProviderTriggerKind,
  ): vscode.Disposable;
}

const vscodeFerretDebugConfigurationHost: FerretDebugConfigurationHost = {
  getActiveDocument: () => vscode.window.activeTextEditor?.document,
  getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
  showErrorMessage: (message) => vscode.window.showErrorMessage(message),
};

export class FerretDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  public constructor(
    private readonly host: FerretDebugConfigurationHost =
      vscodeFerretDebugConfigurationHost,
  ) {}

  public provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      {
        type: ferretDebugType,
        request: 'launch',
        name: 'Debug Ferret',
        program: '${file}',
        cwd: '${workspaceFolder}',
      },
    ];
  }

  public async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (isZeroConfiguration(debugConfiguration)) {
      return this.resolveCurrentFileConfiguration(debugConfiguration);
    }

    if (!isUsableProgram(debugConfiguration.program)) {
      return this.reject(missingProgramMessage);
    }

    return {
      ...debugConfiguration,
      stopOnEntry:
        debugConfiguration.stopOnEntry === undefined
          ? false
          : debugConfiguration.stopOnEntry,
    };
  }

  public async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (
      !isUsableProgram(debugConfiguration.program) ||
      extname(debugConfiguration.program.trim()) !== '.fql'
    ) {
      return this.reject(unsuitableProgramMessage);
    }

    return debugConfiguration;
  }

  private async resolveCurrentFileConfiguration(
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const document = this.host.getActiveDocument();
    if (document === undefined) {
      return this.reject(noActiveDocumentMessage);
    }
    if (document.languageId !== languageId) {
      return this.reject(wrongActiveDocumentMessage);
    }
    if (document.isUntitled || document.uri.scheme !== 'file') {
      return this.reject(unsavedActiveDocumentMessage);
    }

    const workspaceFolder = this.host.getWorkspaceFolder(document.uri);

    return {
      ...debugConfiguration,
      type: ferretDebugType,
      request: 'launch',
      name: 'Debug Current Ferret File',
      program: '${file}',
      cwd: workspaceFolder?.uri.fsPath ?? dirname(document.uri.fsPath),
      stopOnEntry: false,
    };
  }

  private async reject(
    message: string,
  ): Promise<vscode.DebugConfiguration | undefined> {
    await this.host.showErrorMessage(message);

    return undefined;
  }
}

export function registerFerretDebugConfigurationProvider(
  registrationHost: DebugConfigurationRegistrationHost = vscode.debug,
  configurationHost: FerretDebugConfigurationHost =
    vscodeFerretDebugConfigurationHost,
): vscode.Disposable {
  return registrationHost.registerDebugConfigurationProvider(
    ferretDebugType,
    new FerretDebugConfigurationProvider(configurationHost),
    vscode.DebugConfigurationProviderTriggerKind.Initial,
  );
}

function isZeroConfiguration(
  configuration: vscode.DebugConfiguration,
): boolean {
  return (
    configuration.type === undefined &&
    configuration.request === undefined &&
    configuration.name === undefined
  );
}

function isUsableProgram(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
