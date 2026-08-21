import * as vscode from 'vscode';

import {
  languageId,
  readServerConfiguration,
  restartLanguageServerCommand,
} from './config';
import { FerretServerController } from './controller';
import { DaemonController } from './daemon/manager';
import { registerFerretDebugAdapter } from './debug/adapter';
import { registerFerretLaunchConfigurationTracker } from './debug/configuration';
import {
  registerExecutionCommands,
  type ExecutionCommandController,
} from './execution/commands';
import {
  type ExecutionFeedbackController,
  registerExecutionFeedback,
} from './execution/feedback';
import { FerretExecutionManager } from './execution/manager';
import {
  readFerretdExecutable,
  requireFerretdExecutable,
} from './ferretd';
import { createLanguageClient } from './language-client';
import { LanguageServerController, showOutputAction } from './server';
import { ConfiguredTraceOutputChannel } from './trace-output';

let controller: FerretServerController | undefined;
let executionCommands: ExecutionCommandController | undefined;
let executionFeedback: ExecutionFeedbackController | undefined;
let executionManager: FerretExecutionManager | undefined;

interface ServerLifecycleController {
  restart(): Promise<void>;
  restartLanguageServer(): Promise<void>;
}

export function restartForServerConfigurationChange(
  event: vscode.ConfigurationChangeEvent,
  activeController: ServerLifecycleController,
): Promise<void> | undefined {
  if (event.affectsConfiguration(`${languageId}.server.path`)) {
    return activeController.restart();
  }
  if (event.affectsConfiguration(`${languageId}.server.args`)) {
    return activeController.restartLanguageServer();
  }

  return undefined;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel('Ferret', { log: true });
  const traceOutput = new ConfiguredTraceOutputChannel(output);
  const readExecutable = () =>
    readFerretdExecutable(
      context,
      __BUNDLED_FERRETD_VERSION__,
    );
  const readConfiguration = () =>
    readServerConfiguration(readExecutable());
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
  const daemon = new DaemonController(readExecutable, output);
  const activeController = new FerretServerController(
    languageServer,
    daemon,
    output,
  );
  const activeExecutionManager = new FerretExecutionManager(
    daemon,
    activeController.executions,
    daemon.workspaceRegistry,
    output,
  );
  const activeExecutionCommands = registerExecutionCommands(
    activeExecutionManager,
    output,
  );
  const activeExecutionFeedback = registerExecutionFeedback(
    activeExecutionManager,
    output,
  );
  const debugAdapterRegistration = registerFerretDebugAdapter(
    () => requireFerretdExecutable(readExecutable()),
    output,
  );
  const debugConfigurationRegistration =
    registerFerretLaunchConfigurationTracker();

  controller = activeController;
  executionCommands = activeExecutionCommands;
  executionFeedback = activeExecutionFeedback;
  executionManager = activeExecutionManager;
  await activeController.updateWorkspaceFolders(workspaceRoots());
  const serverConfigurationListener =
    vscode.workspace.onDidChangeConfiguration((event) => {
      const restart = restartForServerConfigurationChange(
        event,
        activeController,
      );
      if (restart === undefined) {
        return;
      }

      void restart.catch((error: unknown) => {
        output.error(
          `Applying Ferret server configuration failed: ${formatError(error)}`,
        );
      });
    });
  context.subscriptions.push(
    output,
    traceOutput,
    serverConfigurationListener,
    activeExecutionCommands,
    activeExecutionFeedback,
    debugAdapterRegistration,
    debugConfigurationRegistration,
    vscode.commands.registerCommand(
      restartLanguageServerCommand,
      () => activeController.restartLanguageServer(),
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
  const activeExecutionCommands = executionCommands;
  const activeExecutionFeedback = executionFeedback;
  const activeExecutionManager = executionManager;
  controller = undefined;
  executionCommands = undefined;
  executionFeedback = undefined;
  executionManager = undefined;

  activeExecutionFeedback?.dispose();
  activeExecutionCommands?.dispose();
  await activeExecutionManager?.dispose();
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
