import type * as vscode from 'vscode';
import type { FerretExecution } from './types';
import type { FerretExecutionManager, ManagedExecution } from './manager';
import type { RunResources } from './run-resources';

const statusRank = { created: 0, running: 1, completed: 2, failed: 2, cancelled: 2 } as const;

export class ManagedExecutionHandle implements ManagedExecution {
  public constructor(
    private readonly manager: FerretExecutionManager,
    public readonly documentUri: vscode.Uri,
    public readonly startedAt: number,
    public readonly workspaceId: string,
    public readonly resources: RunResources,
    initial: FerretExecution,
    public readonly watchAbort: AbortController,
  ) {
    this.current = initial;
  }

  public announced = false;
  public startFailed = false;
  public terminal = false;
  public settled?: Promise<void>;
  public stop?: Promise<void>;
  private current: FerretExecution;

  public get id(): string {
    return this.current.id;
  }

  public get sessionId(): string {
    return this.current.sessionId;
  }

  public get execution(): FerretExecution {
    return this.current;
  }

  public cancel(): Promise<void> {
    return this.manager.cancelHandle(this);
  }

  public update(execution: FerretExecution): void {
    if (
      execution.id === this.current.id &&
      execution.sessionId === this.current.sessionId &&
      statusRank[execution.status] >= statusRank[this.current.status]
    ) {
      this.current = execution;
    }
  }
}
