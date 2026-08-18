import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  type InitializeResult,
  type LanguageClientOptions,
} from 'vscode-languageclient/node';

import {
  createServerOptions,
  ferretDocumentSelector,
  languageId,
  readTraceSetting,
  type ServerConfiguration,
} from './config';

export const showOutputAction = 'Show Output';
const clientConnectionFailureMessage =
  "Ferret client: couldn't create connection to server.";

export interface LanguageClientHandle {
  readonly initializeResult: InitializeResult | undefined;

  dispose(timeout?: number): Promise<void>;
  needsStop(): boolean;
  start(): Promise<void>;
  stop(timeout?: number): Promise<void>;
}

export type ClientFailureHandler = (error: unknown) => Promise<void>;
export type LanguageClientFactory = (
  configuration: ServerConfiguration,
  reportFailure: ClientFailureHandler,
) => LanguageClientHandle;

export interface ServerOutput {
  error(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  show(preserveFocus?: boolean): void;
}

export type FailureNotification = (message: string) => Promise<boolean>;

interface Generation {
  reportPromise?: Promise<void>;
  stopping: boolean;
}

interface ActiveClient {
  readonly client: LanguageClientHandle;
  readonly generation: Generation;
}

export class LanguageServerController {
  private active: ActiveClient | undefined;
  private pending: Promise<void> = Promise.resolve();
  private restarting: Promise<void> | undefined;

  public constructor(
    private readonly readConfiguration: () => ServerConfiguration,
    private readonly createClient: LanguageClientFactory,
    private readonly output: ServerOutput,
    private readonly notifyFailure: FailureNotification,
  ) {}

  public start(): Promise<void> {
    return this.enqueue(() => this.startNow());
  }

  public restart(): Promise<void> {
    if (this.restarting !== undefined) {
      return this.restarting;
    }

    const restart = this.enqueue(async () => {
      this.output.info('Ferret language server restart requested');
      await this.stopNow();
      await this.startNow();
    });
    this.restarting = restart.finally(() => {
      this.restarting = undefined;
    });

    return this.restarting;
  }

  public stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);

    return next;
  }

  private async startNow(): Promise<void> {
    if (this.active !== undefined) {
      return;
    }

    const configuration = this.readConfiguration();
    const generation: Generation = { stopping: false };
    const reportFailure = (error: unknown): Promise<void> => {
      if (generation.stopping) {
        return Promise.resolve();
      }

      generation.reportPromise ??= this.showFailure(
        configuration,
        error,
      );

      return generation.reportPromise;
    };

    this.output.info('Starting Ferret language server');
    if (configuration.source === 'bundled') {
      this.output.info('Ferret language server source: bundled');
      this.output.info(
        `Bundled ferretd: ${configuration.bundledVersion}`,
      );
    } else {
      this.output.info(
        'Ferret language server source: configured override',
      );
      this.output.info(`Executable: ${configuration.executable}`);
    }
    this.output.info(
      `Arguments: ${JSON.stringify([
        'lsp',
        ...configuration.extraArguments,
      ])}`,
    );

    let client: LanguageClientHandle | undefined;
    try {
      client = this.createClient(configuration, reportFailure);
      this.active = { client, generation };
      await client.start();

      this.output.info('Ferret language server started');
      const serverInfo = client.initializeResult?.serverInfo;
      if (serverInfo?.version !== undefined) {
        this.output.info(
          `Ferret language server: ${serverInfo.name} ${serverInfo.version}`,
        );
      }
    } catch (error) {
      if (this.active?.client === client) {
        this.active = undefined;
      }

      await reportFailure(error);
      generation.stopping = true;

      if (client !== undefined) {
        const reportCleanupFailure = client.needsStop();
        await this.disposeAfterFailure(client, reportCleanupFailure);
      }
    }
  }

  private async stopNow(): Promise<void> {
    const active = this.active;
    if (active === undefined) {
      return;
    }

    this.active = undefined;
    active.generation.stopping = true;

    try {
      if (active.client.needsStop()) {
        await active.client.stop();
      }

      this.output.info('Ferret language server stopped');
    } catch (error) {
      this.output.error(
        `Stopping Ferret language server failed: ${formatError(error)}`,
      );
      await this.disposeAfterFailure(active.client);
    }
  }

  private async disposeAfterFailure(
    client: LanguageClientHandle,
    reportCleanupFailure = true,
  ): Promise<void> {
    try {
      await client.dispose();
    } catch (error) {
      if (reportCleanupFailure) {
        this.output.error(
          `Cleaning up Ferret language server failed: ${formatError(error)}`,
        );
      }
    }
  }

  private showFailure(
    configuration: ServerConfiguration,
    error: unknown,
  ): Promise<void> {
    this.output.error(
      `Ferret language server failed: ${formatError(error)}`,
    );

    let message: string;
    if (configuration.source === 'configured') {
      message =
        'Ferret language server failed using the configured override ' +
        `"${configuration.executable}". Correct ferret.server.path or ` +
        'ferret.server.args, then use "Ferret: Restart Language Server" ' +
        'to retry. The configured override is authoritative and will not ' +
        'fall back to the bundled daemon.';
    } else {
      message =
        'The ferretd binary bundled with the Ferret extension failed to ' +
        'start. Reinstall the extension package for this extension host, ' +
        'check the Ferret output, and use "Ferret: Restart Language ' +
        'Server" to retry.';
    }
    void this.notifyFailure(message).then(
      (showOutput) => {
        if (showOutput) {
          this.output.show(true);
        }
      },
      (notificationError) => {
        this.output.error(
          `Showing Ferret language server failure failed: ${formatError(notificationError)}`,
        );
      },
    );

    // A notification remains interactive until the user dismisses it. Server
    // startup and extension activation must not wait for that choice.
    return Promise.resolve();
  }
}

export function createLanguageClient(
  configuration: ServerConfiguration,
  output: vscode.LogOutputChannel,
  traceOutput: vscode.LogOutputChannel,
  reportFailure: ClientFailureHandler,
): LanguageClient {
  const clientOptions: LanguageClientOptions = {
    diagnosticCollectionName: languageId,
    documentSelector: ferretDocumentSelector,
    errorHandler: {
      async error(error) {
        await reportFailure(error);

        return { action: ErrorAction.Shutdown, handled: true };
      },
      async closed() {
        await reportFailure(
          new Error('language server connection closed unexpectedly'),
        );

        return { action: CloseAction.DoNotRestart, handled: true };
      },
    },
    initializationFailedHandler: () => false,
    outputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    traceOutputChannel: traceOutput,
  };

  return new FerretLanguageClient(
    languageId,
    'Ferret',
    createServerOptions(configuration),
    clientOptions,
  );
}

class FerretLanguageClient extends LanguageClient {
  public override error(
    message: string,
    data?: unknown,
    showNotification?: boolean | 'force',
  ): void {
    const notification =
      message === clientConnectionFailureMessage &&
      showNotification === 'force'
        ? false
        : showNotification;

    super.error(message, data, notification);
  }
}

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

  return `${message} ${args.map((value) => formatError(value)).join(' ')}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
