import type { ServerConfiguration } from './config';
import type {
  LanguageClientFactory,
  LanguageClientHandle,
} from './language-client';

export const showOutputAction = 'Show Output';

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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
