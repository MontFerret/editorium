import type { RuntimeCoordinator } from './runtime/coordinator';
import type { LanguageServerController } from './server';

/** Coordinates binary override changes across the two independent services. */
export class FerretServerController {
  public constructor(
    private readonly language: Pick<LanguageServerController, 'start' | 'restart' | 'stop'>,
    private readonly runtimes: Pick<RuntimeCoordinator, 'restartExecutable' | 'shutdown'>,
  ) {}

  public start(): Promise<void> {
    return this.language.start();
  }

  public restartLanguageServer(): Promise<void> {
    return this.language.restart();
  }

  public restart(): Promise<void> {
    return Promise.allSettled([
      this.language.restart(), this.runtimes.restartExecutable(),
    ]).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  }

  public async stop(): Promise<void> {
    const results = await Promise.allSettled([this.runtimes.shutdown(), this.language.stop()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
