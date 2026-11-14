import type { ExecutionClient } from './manager';
import type { FerretSession } from './types';

// A retired native Session can still have an Execution closing on the daemon.
export class RunSession {
  private users = 0;
  private reusable = false;
  private closing?: Promise<void>;

  public constructor(
    public readonly client: ExecutionClient,
    public readonly generation: AbortSignal,
    public readonly snapshot: FerretSession,
    public readonly runtimeName: string,
    public readonly sourceDigest: string | undefined,
  ) {}

  public retain(): void { this.users++; }

  public cache(): void { this.reusable = true; }

  public retire(): Promise<void> {
    this.reusable = false;
    return this.closeIfIdle();
  }

  public release(): Promise<void> {
    this.users--;
    return this.closeIfIdle();
  }

  private closeIfIdle(): Promise<void> {
    if (this.reusable || this.users || this.generation.aborted) return Promise.resolve();
    return this.closing ??= this.client.closeSession(this.snapshot.id);
  }
}
