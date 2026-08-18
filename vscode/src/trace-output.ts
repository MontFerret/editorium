import * as vscode from 'vscode';

import { languageId, readTraceSetting } from './config';

// vscode-languageclient 10 uses a LogOutputChannel's level as the trace
// enablement switch and ferret.trace.server as the trace verbosity. This
// adapter keeps the conventional setting authoritative while leaving all
// protocol rendering and filtering to the language client.
export class ConfiguredTraceOutputChannel
  implements vscode.LogOutputChannel
{
  private readonly levelEmitter =
    new vscode.EventEmitter<vscode.LogLevel>();
  private readonly configurationListener: vscode.Disposable;
  private level = configuredTraceLogLevel();

  public constructor(private readonly output: vscode.LogOutputChannel) {
    this.configurationListener =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${languageId}.trace.server`)) {
          return;
        }

        const next = configuredTraceLogLevel();
        if (next === this.level) {
          return;
        }

        this.level = next;
        this.levelEmitter.fire(next);
      });
  }

  public get name(): string {
    return this.output.name;
  }

  public get logLevel(): vscode.LogLevel {
    return this.level;
  }

  public get onDidChangeLogLevel(): vscode.Event<vscode.LogLevel> {
    return this.levelEmitter.event;
  }

  public append(value: string): void {
    this.output.append(value);
  }

  public appendLine(value: string): void {
    this.output.appendLine(value);
  }

  public replace(value: string): void {
    this.output.replace(value);
  }

  public clear(): void {
    this.output.clear();
  }

  public show(
    columnOrPreserveFocus?: vscode.ViewColumn | boolean,
    preserveFocus?: boolean,
  ): void {
    if (
      columnOrPreserveFocus === undefined ||
      typeof columnOrPreserveFocus === 'boolean'
    ) {
      this.output.show(columnOrPreserveFocus);

      return;
    }

    this.output.show(columnOrPreserveFocus, preserveFocus);
  }

  public hide(): void {
    this.output.hide();
  }

  public trace(message: string, ...args: unknown[]): void {
    if (this.level === vscode.LogLevel.Trace) {
      this.output.appendLine(formatLogMessage(message, args));
    }
  }

  public debug(message: string, ...args: unknown[]): void {
    this.output.debug(message, ...args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.output.info(message, ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.output.warn(message, ...args);
  }

  public error(error: string | Error, ...args: unknown[]): void {
    this.output.error(error, ...args);
  }

  public dispose(): void {
    this.configurationListener.dispose();
    this.levelEmitter.dispose();
  }
}

function configuredTraceLogLevel(): vscode.LogLevel {
  return readTraceSetting() === 'off'
    ? vscode.LogLevel.Info
    : vscode.LogLevel.Trace;
}

function formatLogMessage(
  message: string,
  args: readonly unknown[],
): string {
  if (args.length === 0) {
    return message;
  }

  return `${message} ${args.map(formatLogValue).join(' ')}`;
}

function formatLogValue(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
