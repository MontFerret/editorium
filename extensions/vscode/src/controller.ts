import type { RuntimeCoordinator } from './runtime/coordinator';
import type { LanguageServerController } from './server';

/** Coordinates binary override changes across the two independent services. */
export class FerretServerController {
  public constructor(
    private readonly language: Pick<LanguageServerController, 'start' | 'restart' | 'stop'>,
    private readonly runtimes: Pick<RuntimeCoordinator, 'restartExecutable' | 'shutdown'>,
    private readonly readExecutable: () => string,
  ) {}

  public start(): Promise<void> {
    return this.language.start();
  }

  public restartLanguageServer(): Promise<void> {
    return this.language.restart();
  }

  public restart(): Promise<void> {
    return Promise.allSettled([
      this.language.restart(), this.runtimes.restartExecutable(this.readExecutable()),
    ]).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  }

  public async stop(runCleanup: Promise<void>, debugCleanup: Promise<void>, graceMs = 1500): Promise<void> {
    // Retiring the generation cancels RPCs that could otherwise keep Run cleanup
    // waiting forever. Give late session acquisition time to close gracefully.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); });
    const stopRuntime = Promise.race([runCleanup, deadline]).finally(() => {
      clearTimeout(timer);
      return this.runtimes.shutdown();
    });
    const results = await Promise.allSettled([stopRuntime, this.language.stop(), runCleanup, debugCleanup]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
