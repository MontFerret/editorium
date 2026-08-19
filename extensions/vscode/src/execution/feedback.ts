import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import { FerretExecutionClientError } from './errors';
import {
  formatDuration,
  formatTimestamp,
  renderExecutionOutput,
} from './format';
import type {
  ManagedExecution,
  ManagedExecutionChange,
} from './manager';
import type {
  FerretDiagnostic,
  FerretExecutionFailure,
  FerretRelatedInformation,
} from './types';

export const showExecutionOutputCommand = 'ferret.showOutput';
export const executionOutputChannelName = 'Ferret Execution';
export const terminalStatusDuration = 3_000;

const renderFailureFallback = '<result could not be rendered>';

type TerminalStatus = 'completed' | 'failed' | 'cancelled' | 'unknown';
type TimerHandle = ReturnType<typeof setTimeout>;

export interface ExecutionFeedbackManager {
  readonly activeCount: number;
  readonly onDidChangeExecution: vscode.Event<ManagedExecutionChange>;
}

export interface ExecutionDiagnosticOutput {
  error(message: string, ...args: unknown[]): void;
}

export interface ExecutionFeedbackHost {
  clearTimer(handle: TimerHandle): void;
  createOutputChannel(name: string): vscode.OutputChannel;
  createStatusBarItem(): vscode.StatusBarItem;
  displayPath(uri: vscode.Uri): string;
  monotonicNow(): number;
  registerCommand(command: string, handler: () => void): vscode.Disposable;
  setTimer(handler: () => void, delay: number): TimerHandle;
  wallNow(): Date;
}

export class ExecutionFeedbackController implements vscode.Disposable {
  private readonly command: vscode.Disposable;
  private disposed = false;
  private hasOutput = false;
  private readonly output: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private timer: TimerHandle | undefined;
  private timerGeneration = 0;

  public constructor(
    private readonly manager: ExecutionFeedbackManager,
    private readonly diagnosticOutput: ExecutionDiagnosticOutput,
    private readonly host: ExecutionFeedbackHost = vscodeExecutionFeedbackHost,
  ) {
    this.output = host.createOutputChannel(executionOutputChannelName);
    this.status = host.createStatusBarItem();
    this.status.name = 'Ferret execution';
    this.status.command = showExecutionOutputCommand;
    this.command = host.registerCommand(showExecutionOutputCommand, () =>
      this.output.show(),
    );
    this.subscription = manager.onDidChangeExecution((change) =>
      this.handleChange(change),
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelTransientStatus();
    this.subscription.dispose();
    this.command.dispose();
    this.status.hide();
    this.status.dispose();
    this.output.dispose();
  }

  private handleChange(change: ManagedExecutionChange): void {
    if (this.disposed) {
      return;
    }

    switch (change.kind) {
      case 'started':
        this.started(change.execution);
        return;
      case 'start-failed':
        this.startFailed(
          change.documentUri,
          change.startedAt,
          change.failure,
        );
        return;
      case 'changed':
        this.showRunningStatus();
        return;
      case 'finished':
        this.finished(change.execution);
        return;
      case 'watch-failed':
        this.watchFailed(change.execution, change.error);
        return;
      case 'invalidated':
        this.invalidated(change);
        return;
    }
  }

  private started(execution: ManagedExecution): void {
    this.startBlock();
    this.output.appendLine(
      `[${this.timestamp()}] Running ${this.path(execution.documentUri)}`,
    );
    this.showRunningStatus();
  }

  private startFailed(
    documentUri: vscode.Uri,
    startedAt: number,
    failure: FerretExecutionFailure,
  ): void {
    this.startBlock();
    this.appendFailure(documentUri, startedAt, failure);
    this.output.show(true);
    this.showTerminalStatus('failed');
  }

  private finished(execution: ManagedExecution): void {
    const status = execution.execution.status;
    switch (status) {
      case 'completed':
        this.completed(execution);
        return;
      case 'failed':
        this.appendFailure(
          execution.documentUri,
          execution.startedAt,
          execution.execution.failure ?? {
            category: 'runtime',
            message: 'Ferret execution failed.',
            diagnostics: [],
          },
        );
        this.output.show(true);
        this.showTerminalStatus('failed');
        return;
      case 'cancelled': {
        const header =
          `[${this.timestamp()}] Execution cancelled: ` +
          this.path(execution.documentUri);
        this.output.appendLine(
          [
            header,
            `Cancelled after ${this.elapsed(execution.startedAt)}`,
          ].join('\n'),
        );
        this.showTerminalStatus('cancelled');
        return;
      }
      case 'created':
      case 'running':
        this.observationFailed(
          execution,
          'Ferret execution ended without a terminal state.',
        );
        return;
    }
  }

  private completed(execution: ManagedExecution): void {
    let rendered = renderFailureFallback;
    const output = execution.execution.output;
    if (output === undefined) {
      this.diagnosticOutput.error(
        'Rendering the Ferret execution result failed',
        new Error('Completed execution did not contain output'),
      );
    } else {
      try {
        rendered = renderExecutionOutput(output);
      } catch (error) {
        this.diagnosticOutput.error(
          'Rendering the Ferret execution result failed',
          error,
        );
      }
    }

    this.output.appendLine(
      [
        rendered,
        `Completed ${this.path(execution.documentUri)} ` +
          `in ${this.elapsed(execution.startedAt)}`,
      ].join('\n'),
    );
    this.output.show(true);
    this.showTerminalStatus('completed');
  }

  private appendFailure(
    documentUri: vscode.Uri,
    startedAt: number,
    failure: FerretExecutionFailure,
  ): void {
    const lines = [
      `[${this.timestamp()}] Execution failed: ${this.path(documentUri)}`,
      ...this.failureLines(failure),
      `Failed in ${this.elapsed(startedAt)}`,
    ];
    this.output.appendLine(lines.join('\n'));
  }

  private failureLines(failure: FerretExecutionFailure): string[] {
    const lines: string[] = [];
    if (failure.message !== '') {
      lines.push(failure.message);
    }
    for (const diagnostic of failure.diagnostics) {
      lines.push(...this.diagnosticLines(diagnostic));
    }

    return lines.length > 0 ? lines : ['Ferret execution failed.'];
  }

  private diagnosticLines(diagnostic: FerretDiagnostic): string[] {
    const code = diagnostic.code === '' ? '' : ` [${diagnostic.code}]`;
    const lines = [
      `${this.location(diagnostic.uri, diagnostic.range.start)}${code}`,
      diagnostic.message,
    ];
    for (const related of diagnostic.relatedInformation) {
      lines.push(...this.relatedLines(related));
    }

    return lines;
  }

  private relatedLines(related: FerretRelatedInformation): string[] {
    return [
      `Related: ${this.location(related.uri, related.range.start)}`,
      related.message,
    ];
  }

  private watchFailed(execution: ManagedExecution, error: unknown): void {
    this.diagnosticOutput.error(
      'Observing the Ferret execution failed',
      error,
    );
    const message =
      error instanceof FerretExecutionClientError &&
      error.code === 'daemon-unavailable'
        ? 'Lost connection to the Ferret daemon while watching execution.'
        : 'Ferret execution status could no longer be observed.';
    this.observationFailed(execution, message);
  }

  private invalidated(
    change: Extract<ManagedExecutionChange, { readonly kind: 'invalidated' }>,
  ): void {
    if (change.cause !== undefined) {
      this.diagnosticOutput.error(
        'The Ferret execution was invalidated',
        change.cause,
      );
    }
    const message =
      change.reason === 'daemon-generation'
        ? 'The Ferret daemon connection changed before a terminal state was reported.'
        : 'The Ferret workspace changed before a terminal state was reported.';
    this.observationFailed(change.execution, message);
  }

  private observationFailed(
    execution: ManagedExecution,
    message: string,
  ): void {
    this.output.appendLine(
      [
        `[${this.timestamp()}] Execution status unknown: ` +
          this.path(execution.documentUri),
        message,
        `Status became unknown after ${this.elapsed(execution.startedAt)}`,
      ].join('\n'),
    );
    this.output.show(true);
    this.showTerminalStatus('unknown');
  }

  private showRunningStatus(): void {
    this.cancelTransientStatus();
    const count = this.manager.activeCount;
    if (count < 1) {
      this.status.hide();
      return;
    }

    this.status.text =
      count === 1 ? '$(sync~spin) Ferret' : `$(sync~spin) Ferret (${count})`;
    this.status.tooltip =
      count === 1
        ? 'Ferret execution is running'
        : `${count} Ferret executions are running`;
    this.status.show();
  }

  private showTerminalStatus(status: TerminalStatus): void {
    this.cancelTransientStatus();
    if (this.manager.activeCount > 0) {
      this.showRunningStatus();
      return;
    }

    switch (status) {
      case 'completed':
        this.status.text = '$(check) Ferret';
        this.status.tooltip = 'Ferret execution completed';
        break;
      case 'failed':
        this.status.text = '$(error) Ferret';
        this.status.tooltip = 'Ferret execution failed';
        break;
      case 'cancelled':
        this.status.text = '$(circle-slash) Ferret';
        this.status.tooltip = 'Ferret execution was cancelled';
        break;
      case 'unknown':
        this.status.text = '$(error) Ferret';
        this.status.tooltip = 'Ferret execution status is unknown';
        break;
    }
    this.status.show();

    const generation = this.timerGeneration;
    this.timer = this.host.setTimer(() => {
      if (this.disposed || generation !== this.timerGeneration) {
        return;
      }

      this.timer = undefined;
      if (this.manager.activeCount > 0) {
        this.showRunningStatus();
      } else {
        this.status.hide();
      }
    }, terminalStatusDuration);
  }

  private cancelTransientStatus(): void {
    this.timerGeneration += 1;
    if (this.timer !== undefined) {
      this.host.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private startBlock(): void {
    if (this.hasOutput) {
      this.output.appendLine('');
    } else {
      this.hasOutput = true;
    }
  }

  private timestamp(): string {
    return formatTimestamp(this.host.wallNow());
  }

  private elapsed(startedAt: number): string {
    return formatDuration(this.host.monotonicNow() - startedAt);
  }

  private path(uri: vscode.Uri): string {
    return this.host.displayPath(uri);
  }

  private location(
    uri: string,
    position: { readonly line: number; readonly character: number },
  ): string {
    let display = uri;
    try {
      display = this.path(vscode.Uri.parse(uri, true));
    } catch {
      // Keep the daemon-provided URI when it cannot be parsed by VS Code.
    }

    return `${display}:${position.line + 1}:${position.character + 1}`;
  }
}

export function registerExecutionFeedback(
  manager: ExecutionFeedbackManager,
  diagnosticOutput: ExecutionDiagnosticOutput,
): ExecutionFeedbackController {
  return new ExecutionFeedbackController(manager, diagnosticOutput);
}

export function displayExecutionPath(uri: vscode.Uri): string {
  const workspace = vscode.workspace.getWorkspaceFolder(uri);
  if (workspace !== undefined) {
    return vscode.workspace.asRelativePath(
      uri,
      (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    );
  }

  return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

const vscodeExecutionFeedbackHost: ExecutionFeedbackHost = {
  clearTimer: (handle) => clearTimeout(handle),
  createOutputChannel: (name) => vscode.window.createOutputChannel(name),
  createStatusBarItem: () =>
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left),
  displayPath: displayExecutionPath,
  monotonicNow: () => performance.now(),
  registerCommand: (command, handler) =>
    vscode.commands.registerCommand(command, handler),
  setTimer: (handler, delay) => setTimeout(handler, delay),
  wallNow: () => new Date(),
};
