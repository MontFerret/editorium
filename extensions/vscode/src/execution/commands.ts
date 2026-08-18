import * as vscode from 'vscode';

import { DaemonError } from '../daemon/errors';
import { isFerretDocument } from '../language-client';
import {
  ExecutionManagerError,
  FerretExecutionClientError,
} from './errors';
import type { ManagedExecutionChange } from './manager';

export const runFileCommand = 'ferret.runFile';
export const cancelExecutionCommand = 'ferret.cancelExecution';
export const executionRunningContext = 'ferret.executionRunning';

const saveAndRunAction = 'Save and Run';
const cancelRunAction = 'Cancel';

const invalidTargetMessage =
  'The current editor cannot be executed by Ferret.';
const alreadyRunningMessage = 'This Ferret file is already running.';
const savePrompt = 'Save the document before running Ferret?';
const saveFailedMessage =
  'The Ferret file could not be saved, so it was not run.';
const documentChangedMessage =
  'This Ferret file changed before execution started. Save it and run again.';
const daemonUnavailableMessage = 'Ferret daemon is unavailable.';
const incompatibleDaemonMessage =
  'The Ferret daemon is incompatible with this extension.';
const runFailedMessage = 'Ferret could not run the current file.';
const cancelFailedMessage =
  'Ferret could not cancel the current execution.';
const executionInactiveMessage =
  'The Ferret execution is no longer active.';

export interface ExecutionCommandManager {
  readonly onDidChangeExecution: vscode.Event<ManagedExecutionChange>;

  cancel(documentUri: vscode.Uri): Promise<void>;
  isRunning(documentUri: vscode.Uri): boolean;
  run(document: vscode.TextDocument): Promise<unknown>;
}

export interface ExecutionCommandOutput {
  error(message: string, ...args: unknown[]): void;
}

export interface ExecutionCommandHost {
  getActiveDocument(): vscode.TextDocument | undefined;
  onDidChangeActiveEditor(listener: () => void): vscode.Disposable;
  registerCommand(
    command: string,
    handler: () => Promise<void>,
  ): vscode.Disposable;
  setContext(key: string, value: boolean): Thenable<unknown>;
  showErrorMessage(message: string): Thenable<unknown>;
  showInformationMessage(
    message: string,
    ...items: readonly string[]
  ): Thenable<string | undefined>;
}

export class ExecutionCommandController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  private contextUpdates: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(
    private readonly manager: ExecutionCommandManager,
    private readonly output: ExecutionCommandOutput,
    private readonly host: ExecutionCommandHost = vscodeExecutionCommandHost,
  ) {
    this.disposables = [
      this.host.registerCommand(runFileCommand, () => this.runFile()),
      this.host.registerCommand(cancelExecutionCommand, () =>
        this.cancelExecution(),
      ),
      this.host.onDidChangeActiveEditor(() =>
        this.refreshExecutionContext(),
      ),
      this.manager.onDidChangeExecution(() =>
        this.handleExecutionChange(),
      ),
    ];
    this.refreshExecutionContext();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const disposable of this.disposables.splice(0).reverse()) {
      disposable.dispose();
    }
    this.queueContextUpdate(false);
  }

  private async runFile(): Promise<void> {
    const document = this.host.getActiveDocument();
    if (document === undefined || !isFerretDocument(document)) {
      await this.showError(invalidTargetMessage);
      return;
    }

    if (document.isDirty) {
      const selection = await this.showInformation(
        savePrompt,
        saveAndRunAction,
        cancelRunAction,
      );
      if (selection !== saveAndRunAction) {
        return;
      }

      let saved: boolean;
      try {
        saved = await document.save();
      } catch (error) {
        this.output.error(
          'Saving the Ferret file before execution failed',
          error,
        );
        await this.showError(saveFailedMessage);
        return;
      }

      if (!saved || document.isDirty) {
        await this.showError(saveFailedMessage);
        return;
      }
    }

    try {
      await this.manager.run(document);
    } catch (error) {
      await this.reportRunError(error);
    }
  }

  private async cancelExecution(): Promise<void> {
    const document = this.host.getActiveDocument();
    if (document === undefined || !isFerretDocument(document)) {
      return;
    }

    try {
      await this.manager.cancel(document.uri);
    } catch (error) {
      await this.reportCancelError(error);
    }
  }

  private handleExecutionChange(): void {
    this.refreshExecutionContext();
  }

  private refreshExecutionContext(): void {
    if (this.disposed) {
      return;
    }

    const document = this.host.getActiveDocument();
    this.queueContextUpdate(
      document !== undefined && this.manager.isRunning(document.uri),
    );
  }

  private queueContextUpdate(running: boolean): void {
    this.contextUpdates = this.contextUpdates
      .then(() => this.host.setContext(executionRunningContext, running))
      .then(
        () => undefined,
        (error: unknown) => {
          this.output.error(
            'Updating Ferret execution command state failed',
            error,
          );
        },
      );
  }

  private async reportRunError(error: unknown): Promise<void> {
    if (error instanceof ExecutionManagerError) {
      switch (error.code) {
        case 'unsupported-document':
          await this.showError(invalidTargetMessage);
          return;
        case 'document-dirty':
        case 'document-changed':
          await this.showError(documentChangedMessage);
          return;
        case 'execution-already-running':
          await this.showInformation(alreadyRunningMessage);
          return;
        case 'workspace-unavailable':
          this.output.error('Running the Ferret file failed', error);
          await this.showError(error.message);
          return;
        case 'disposed':
          this.output.error('Running the Ferret file failed', error);
          await this.showError(daemonUnavailableMessage);
          return;
      }
    }

    this.output.error('Running the Ferret file failed', error);
    if (error instanceof DaemonError) {
      await this.showError(daemonErrorMessage(error, runFailedMessage));
      return;
    }
    if (error instanceof FerretExecutionClientError) {
      if (error.code === 'compilation-failed') {
        return;
      }
      await this.showError(executionClientErrorMessage(error));
      return;
    }

    await this.showError(runFailedMessage);
  }

  private async reportCancelError(error: unknown): Promise<void> {
    this.output.error('Cancelling the Ferret execution failed', error);
    if (error instanceof DaemonError) {
      await this.showError(daemonErrorMessage(error, cancelFailedMessage));
      return;
    }
    if (error instanceof FerretExecutionClientError) {
      switch (error.code) {
        case 'not-found':
        case 'closed':
        case 'invalid-state':
          await this.showInformation(executionInactiveMessage);
          return;
        case 'daemon-unavailable':
          await this.showError(daemonUnavailableMessage);
          return;
        case 'incompatible-daemon':
          await this.showError(incompatibleDaemonMessage);
          return;
        default:
          await this.showError(cancelFailedMessage);
          return;
      }
    }

    await this.showError(cancelFailedMessage);
  }

  private async showError(message: string): Promise<void> {
    try {
      await this.host.showErrorMessage(message);
    } catch (error) {
      this.output.error(
        'Showing a Ferret execution error notification failed',
        error,
      );
    }
  }

  private async showInformation(
    message: string,
    ...items: readonly string[]
  ): Promise<string | undefined> {
    try {
      return await this.host.showInformationMessage(message, ...items);
    } catch (error) {
      this.output.error(
        'Showing a Ferret execution notification failed',
        error,
      );
      return undefined;
    }
  }
}

export function registerExecutionCommands(
  manager: ExecutionCommandManager,
  output: ExecutionCommandOutput,
): ExecutionCommandController {
  return new ExecutionCommandController(manager, output);
}

function daemonErrorMessage(error: DaemonError, fallback: string): string {
  switch (error.code) {
    case 'unavailable':
    case 'startup-failed':
      return daemonUnavailableMessage;
    case 'incompatible-daemon':
      return incompatibleDaemonMessage;
    case 'protocol':
      return fallback;
  }
}

function executionClientErrorMessage(
  error: FerretExecutionClientError,
): string {
  switch (error.code) {
    case 'daemon-unavailable':
      return daemonUnavailableMessage;
    case 'incompatible-daemon':
      return incompatibleDaemonMessage;
    case 'compilation-failed':
      return error.message;
    case 'cancelled':
      return 'Starting the Ferret execution was cancelled.';
    case 'not-found':
    case 'closed':
    case 'invalid-parameters':
    case 'invalid-state':
    case 'watch-lagged':
    case 'execution-rejected':
    case 'protocol':
      return runFailedMessage;
  }
}

const vscodeExecutionCommandHost: ExecutionCommandHost = {
  getActiveDocument: () => vscode.window.activeTextEditor?.document,
  onDidChangeActiveEditor: (listener) =>
    vscode.window.onDidChangeActiveTextEditor(listener),
  registerCommand: (command, handler) =>
    vscode.commands.registerCommand(command, handler),
  setContext: (key, value) =>
    vscode.commands.executeCommand('setContext', key, value),
  showErrorMessage: (message) =>
    vscode.window.showErrorMessage(message),
  showInformationMessage: (message, ...items) =>
    vscode.window.showInformationMessage(message, ...items),
};
