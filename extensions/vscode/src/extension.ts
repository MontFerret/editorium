import * as vscode from 'vscode';

import {
  languageId,
  readServerConfiguration,
  restartLanguageServerCommand,
} from './config';
import { FerretServerController } from './controller';
import { DaemonController } from './daemon/manager';
import { FerretDebugAdapterDescriptorFactory, ferretDebugType } from './debug/adapter';
import { registerFerretDebugCommand } from './debug/commands';
import { registerFerretDebugConfigurationProvider } from './debug/configuration';
import { FerretExecutionClient } from './execution/client';
import {
  registerExecutionCommands,
} from './execution/commands';
import {
  registerExecutionFeedback,
} from './execution/feedback';
import { FerretExecutionManager } from './execution/manager';
import {
  readFerretdExecutable,
  requireFerretdExecutable,
} from './ferretd';
import { createLanguageClient } from './language-client';
import { RuntimeCoordinator } from './runtime/coordinator';
import { readRuntimeConfiguration, registerRuntimeCommands } from './runtime/commands';
import { runtimeNameKey } from './runtime/picker';

import { LanguageServerController, showOutputAction } from './server';
import { ConfiguredTraceOutputChannel } from './trace-output';

let shutdown: (() => Promise<void>) | undefined;

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
  const runtimes = new RuntimeCoordinator(
    daemon, readRuntimeConfiguration(), () => context.workspaceState.get(runtimeNameKey, ''),
  );
  const activeController = new FerretServerController(languageServer, runtimes, () => readExecutable().executable);
  const activeExecutionManager = new FerretExecutionManager(
    daemon,
    connection => new FerretExecutionClient(connection),
    daemon.workspaceRegistry,
    output,
    runtimes,
  );
  const activeExecutionCommands = registerExecutionCommands(
    activeExecutionManager,
    output,
  );
  const activeExecutionFeedback = registerExecutionFeedback(
    activeExecutionManager,
    output,
  );
  const factory = new FerretDebugAdapterDescriptorFactory(
    () => requireFerretdExecutable(readExecutable()),
    output,
    runtimes,
  );
  const debugConfigurationRegistration =
    registerFerretDebugConfigurationProvider(selector => runtimes.checkDebug(selector));
  const debugCommandRegistration = registerFerretDebugCommand();

  shutdown = async () => {
    runtimes.closeAdmissions();
    activeExecutionFeedback.dispose();
    activeExecutionCommands.dispose();
    try {
      await activeController.stop(activeExecutionManager.dispose(), factory.shutdown());
    } finally {
      traceOutput.dispose();
      output.dispose();
    }
  };
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
    serverConfigurationListener,
    activeExecutionCommands,
    activeExecutionFeedback,
    registerRuntimeCommands(runtimes, context.workspaceState),
    vscode.debug.registerDebugAdapterDescriptorFactory(ferretDebugType, factory),
    debugConfigurationRegistration,
    debugCommandRegistration,
    vscode.commands.registerCommand(
      restartLanguageServerCommand,
      () => activeController.restartLanguageServer(),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void daemon
        .updateWorkspaceFolders(workspaceRoots())
        .catch((error: unknown) => {
          output.error(
            `Updating Ferret daemon workspaces failed: ${formatError(error)}`,
          );
        });
    }),
  );

  await daemon.updateWorkspaceFolders(workspaceRoots());
  await activeController.start();
}

export async function deactivate(): Promise<void> {
  const stop = shutdown;
  shutdown = undefined;
  await stop?.();
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
