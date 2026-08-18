import * as vscode from 'vscode';

import {
  readServerConfiguration,
  restartLanguageServerCommand,
} from './config';
import { FerretServerController } from './controller';
import { DaemonController } from './daemon/manager';
import { createLanguageClient } from './language-client';
import { LanguageServerController, showOutputAction } from './server';
import { ConfiguredTraceOutputChannel } from './trace-output';

let controller: FerretServerController | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel('Ferret', { log: true });
  const traceOutput = new ConfiguredTraceOutputChannel(output);
  const readConfiguration = () =>
    readServerConfiguration(
      context,
      __BUNDLED_FERRETD_VERSION__,
    );
  const languageServer = new LanguageServerController(
    readConfiguration,
    (configuration, reportFailure) =>
      createLanguageClient(
        configuration,
        output,
        traceOutput,
        reportFailure,
      ),
    output,
    async (message) => {
      const selected = await vscode.window.showErrorMessage(
        message,
        showOutputAction,
      );

      return selected === showOutputAction;
    },
  );
  const daemon = new DaemonController(readConfiguration, output);
  const activeController = new FerretServerController(
    languageServer,
    daemon,
    output,
  );

  controller = activeController;
  await activeController.updateWorkspaceFolders(workspaceRoots());
  context.subscriptions.push(
    output,
    traceOutput,
    vscode.commands.registerCommand(
      restartLanguageServerCommand,
      () => activeController.restart(),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void activeController
        .updateWorkspaceFolders(workspaceRoots())
        .catch((error: unknown) => {
          output.error(
            `Updating Ferret daemon workspaces failed: ${formatError(error)}`,
          );
        });
    }),
  );

  await activeController.start();
}

export async function deactivate(): Promise<void> {
  const activeController = controller;
  controller = undefined;

  await activeController?.stop();
}

function workspaceRoots(): readonly string[] {
  return (
    vscode.workspace.workspaceFolders?.map(
      (folder) => folder.uri.fsPath,
    ) ?? []
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
