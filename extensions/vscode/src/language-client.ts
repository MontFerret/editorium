import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  RevealOutputChannelOn,
  type DocumentSelector,
  type Executable,
  type InitializeResult,
  type LanguageClientOptions,
} from 'vscode-languageclient/node';

import { languageId, type ServerConfiguration } from './config';

const clientConnectionFailureMessage =
  "Ferret client: couldn't create connection to server.";

export const ferretDocumentSelector: DocumentSelector = [
  // ferretd currently resolves every opened document URI to a local path and
  // rejects non-file schemes, including untitled documents.
  { scheme: 'file', language: languageId },
];

export function isFerretDocument(
  document: Pick<
    vscode.TextDocument,
    'isUntitled' | 'languageId' | 'uri'
  >,
): boolean {
  return (
    !document.isUntitled &&
    document.uri.scheme === 'file' &&
    document.languageId === languageId
  );
}

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

export function createServerOptions(
  configuration: ServerConfiguration,
): Executable {
  // Command executables use stdio when transport is omitted. Setting
  // TransportKind.stdio explicitly would make vscode-languageclient append a
  // --stdio argument, but ferretd expects the exact `lsp` subcommand contract.
  return {
    command: configuration.executable,
    args: ['lsp', ...configuration.extraArguments],
    options: { detached: false },
  };
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
