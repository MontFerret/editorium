import * as vscode from 'vscode';

import {
  readServerConfiguration,
  restartLanguageServerCommand,
} from './config';
import {
  ConfiguredTraceOutputChannel,
  LanguageServerController,
  createLanguageClient,
  showOutputAction,
} from './server';

let controller: LanguageServerController | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel('Ferret', { log: true });
  const traceOutput = new ConfiguredTraceOutputChannel(output);
  const activeController = new LanguageServerController(
    () =>
      readServerConfiguration(
        context,
        __BUNDLED_FERRETD_VERSION__,
      ),
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

  controller = activeController;
  context.subscriptions.push(
    output,
    traceOutput,
    vscode.commands.registerCommand(
      restartLanguageServerCommand,
      () => activeController.restart(),
    ),
  );

  await activeController.start();
}

export async function deactivate(): Promise<void> {
  const activeController = controller;
  controller = undefined;

  await activeController?.stop();
}
