import type { RunSession } from './session';

// All IDs on this invocation belong to the client captured by its Session.
export class RunResources {
  public executionId?: string;
  private cancellation?: Promise<void>;
  private closing?: Promise<void>;

  public constructor(private readonly session: RunSession) {
    session.retain();
  }

  public cancel(): Promise<void> {
    const id = this.executionId;
    if (!id || this.session.generation.aborted) return Promise.resolve();
    return this.cancellation ??= this.session.client.cancelExecution(id).then(() => undefined);
  }

  public close(cancel: boolean): Promise<void> {
    return this.closing ??= this.closeOwned(cancel);
  }

  private async closeOwned(cancel: boolean): Promise<void> {
    const failures: unknown[] = [];
    const id = this.executionId;
    if (id && !this.session.generation.aborted) {
      if (cancel || this.cancellation) {
        try { await this.cancel(); } catch (error) { failures.push(error); }
      }
      try { await this.session.client.closeExecution(id); } catch (error) { failures.push(error); }
    }
    try { await this.session.release(); } catch (error) { failures.push(error); }
    if (this.session.generation.aborted) failures.push(new Error('The daemon connection was lost. Remote release is unconfirmed.'));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join('\n'));
  }
}
