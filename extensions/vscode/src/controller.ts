import { DaemonController } from './daemon/manager';
import type { FerretWorkspaceRegistry } from './daemon/workspaces';
import { FerretExecutionClient } from './execution/client';
import { LanguageServerController, type ServerOutput } from './server';

/** Coordinates the independent LSP and private daemon process generations. */
export class FerretServerController {
  private pending: Promise<void> = Promise.resolve();
  private restarting: Promise<void> | undefined;

  public readonly executions: FerretExecutionClient;

  public constructor(
    private readonly languageServer: LanguageServerController,
    private readonly daemon: DaemonController,
    private readonly output: ServerOutput,
  ) {
    this.executions = new FerretExecutionClient(daemon);
  }

  public get workspaces(): FerretWorkspaceRegistry {
    return this.daemon.workspaceRegistry;
  }

  public start(): Promise<void> {
    return this.enqueue(() => this.startBoth());
  }

  public restartLanguageServer(): Promise<void> {
    return this.enqueue(() => this.languageServer.restart());
  }

  public restartDaemon(): Promise<void> {
    return this.enqueue(async () => {
      this.output.info('Ferret daemon restart requested');
      try {
        await this.daemon.stop();
      } catch (error) {
        this.output.error(
          `Stopping Ferret daemon failed: ${formatError(error)}`,
        );
      }
      await this.startDaemon();
    });
  }

  public restart(): Promise<void> {
    if (this.restarting !== undefined) {
      return this.restarting;
    }

    const restart = this.enqueue(async () => {
      this.output.info('Ferret server restart requested');
      await this.stopBoth();
      await this.startBoth();
    });
    this.restarting = restart.finally(() => {
      this.restarting = undefined;
    });

    return this.restarting;
  }

  public stop(): Promise<void> {
    return this.enqueue(() => this.stopBoth());
  }

  public updateWorkspaceFolders(
    roots: readonly string[],
  ): Promise<void> {
    return this.daemon.updateWorkspaceFolders(roots);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);

    return next;
  }

  private async startBoth(): Promise<void> {
    const [language, daemon] = await Promise.allSettled([
      this.languageServer.start(),
      this.daemon.start(),
    ]);
    if (daemon.status === 'rejected') {
      this.reportDaemonStartFailure(daemon.reason);
    }
    if (language.status === 'rejected') {
      throw language.reason;
    }
  }

  private async startDaemon(): Promise<void> {
    try {
      await this.daemon.start();
    } catch (error) {
      this.reportDaemonStartFailure(error);
    }
  }

  private reportDaemonStartFailure(error: unknown): void {
    this.output.error(
      `Starting Ferret daemon failed: ${formatError(error)}`,
    );
  }

  private async stopBoth(): Promise<void> {
    const [language, daemon] = await Promise.allSettled([
      this.languageServer.stop(),
      this.daemon.stop(),
    ]);
    if (language.status === 'rejected') {
      this.output.error(
        `Stopping Ferret language server failed: ${formatError(language.reason)}`,
      );
    }
    if (daemon.status === 'rejected') {
      this.output.error(
        `Stopping Ferret daemon failed: ${formatError(daemon.reason)}`,
      );
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
