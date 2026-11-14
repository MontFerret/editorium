import * as vscode from 'vscode';

import type { DaemonController } from '../daemon/manager';
import type { DaemonConnection } from '../daemon/types';
import type { ListRuntimesResponse } from '../daemon/gen/ferretd/daemon/v1/daemon.pb';
import type { RuntimeConfiguration } from './configuration';
import { fingerprintFile } from '../file-fingerprint';
import { listRuntimes, supportsAcquisitionCancellation, supportsRuntimeSelection } from './catalog';
import { RuntimeLaunchError, UnsupportedDiscovery } from './errors';

export interface PreparedRuntime {
  readonly connection: DaemonConnection;
  readonly selector: string;
  readonly name: string;
  readonly provider: 'native' | 'wire';
}

export interface RunReservation {
  prepareRun(): Promise<PreparedRuntime>;
  verifyConfiguration(): Promise<void>;
  release(): void;
}

export interface CatalogView {
  readonly status: 'unloaded' | 'loading' | 'ready' | 'failed' | 'unsupported' | 'reload-required';
  readonly catalog?: ListRuntimesResponse;
  readonly message?: string;
}

interface Revision {
  readonly config: RuntimeConfiguration;
  digest?: string;
  changed?: boolean;
}

interface Generation {
  readonly revision: Revision;
  retired: Promise<void>;
  startup?: Promise<DaemonConnection>;
  readonly executable?: string;
  executableReplacement?: Promise<void>;
  reloading?: boolean;
  connection?: DaemonConnection;
  discovery?: Promise<void>;
  catalog?: ListRuntimesResponse;
  failure?: Error;
}

const reloadMessage = 'Use Ferret: Reload Runtimes to adopt the saved runtime configuration.';

export class RuntimeCoordinator {
  private readonly changes = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changes.event;
  private current?: Generation;
  private generationRequiresReload = false;
  private readonly ownedWork = new Set<Promise<unknown>>();
  private replacing = false;
  private usedDaemon = false;
  private activities = 0;
  private disposed = false;
  private result: CatalogView = { status: 'unloaded' };

  public constructor(
    private readonly daemon: Pick<DaemonController, 'start' | 'stop' | 'requireConnection'>,
    private saved: RuntimeConfiguration,
    private readonly selection: () => string,
    private readonly discover = listRuntimes,
  ) {}

  private get pending(): boolean {
    return this.generationRequiresReload || (this.current !== undefined && this.current.revision.config !== this.saved);
  }

  public get view(): CatalogView {
    if (!this.pending || this.result.status === 'reload-required') return this.result;
    return { status: 'reload-required', message: reloadMessage };
  }

  public save(config: RuntimeConfiguration): void {
    if (this.saved.entered === config.entered && this.saved.path === config.path && this.saved.problem === config.problem) return;
    // Each changed save has its own identity, even if it restores an earlier path.
    this.saved = { ...config };
    if (this.current) this.changes.fire();
  }

  private checkAdmission(): void {
    if (this.disposed) throw new RuntimeLaunchError('Ferret is shutting down.');
    if (this.pending) throw new RuntimeLaunchError(this.view.message ?? reloadMessage);
    if (this.replacing) {
      throw new RuntimeLaunchError('Runtime reload is incomplete. Complete discovery or reload runtimes before launching.');
    }
    if (this.saved.problem) throw new RuntimeLaunchError(this.saved.problem);
  }

  public checkDebug(selector?: unknown): void {
    this.checkAdmission();
    if (this.saved.entered !== '' || this.selection() !== '' || (selector !== undefined && selector !== '')) {
      throw new RuntimeLaunchError('Debug currently requires an empty ferret.runtime.configPath and Daemon default. Clear any launch runtimeName and reload runtimes if required.');
    }
  }

  public admitDebug(selector?: unknown): { release(): void } {
    this.checkDebug(selector);
    this.adopt();
    return { release: this.reserve() };
  }

  public admitRun(selector?: string): RunReservation {
    this.checkAdmission();
    const requested = selector === undefined ? this.selection() : selector;
    if (typeof requested !== 'string') throw new RuntimeLaunchError('Set runtimeName to a string.');
    const generation = this.adopt();
    return {
      prepareRun: () => this.prepareRun(generation, requested),
      verifyConfiguration: () => this.verifyFile(generation),
      release: this.reserve(),
    };
  }

  private reserve(): () => void {
    this.activities++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activities--;
      }
    };
  }

  private async prepareRun(generation: Generation, selector: string): Promise<PreparedRuntime> {
    this.assertCurrent(generation);
    if (!generation.catalog && !generation.failure) await this.load(generation);
    this.assertCurrent(generation);
    const connection = generation.connection;
    const catalog = generation.catalog;
    const configured = !!generation.revision.config.path || selector !== '';
    if (connection && configured && !supportsRuntimeSelection(connection)) {
      throw new RuntimeLaunchError('Runtime selection requires ferretd API 1.3 or later in major 1.');
    }
    if (!catalog || !connection) {
      if (connection && !configured && generation.failure instanceof UnsupportedDiscovery) {
        return { connection, selector, name: 'local', provider: 'native' };
      }
      throw new RuntimeLaunchError(generation.failure?.message ?? 'Ferret runtime discovery failed.');
    }
    const name = selector === '' ? catalog.defaultRuntime : selector;
    const entry = catalog.runtimes.find(runtime => runtime.name === name);
    if (!entry) throw new RuntimeLaunchError(`Ferret runtime "${name}" is unavailable. Select a runtime or reload its configuration.`);
    const { provider } = entry;
    if (provider !== 'native' && provider !== 'wire') {
      throw new RuntimeLaunchError(`Unsupported provider "${provider}" for Ferret runtime "${name}".`);
    }
    if (provider === 'wire' && !supportsAcquisitionCancellation(connection)) {
      throw new RuntimeLaunchError(`Wire runtime "${name}" requires ferretd API 1.4 or later in major 1. Upgrade ferretd to run on this application.`);
    }
    return { connection, selector, name, provider };
  }

  public catalog(): Promise<void> {
    if (this.pending || this.disposed) return Promise.resolve();
    const generation = this.adopt();
    if (this.result.status !== 'unloaded') return generation.discovery ?? Promise.resolve();
    return this.load(generation);
  }

  public retry(): Promise<void> {
    if (this.disposed || this.pending) return Promise.reject(new Error(reloadMessage));
    const generation = this.adopt();
    if (generation.discovery) return generation.discovery;
    if (this.replacing && !generation.connection) return Promise.reject(new Error(reloadMessage));
    if (this.result.status === 'ready') return Promise.resolve();
    return this.load(generation);
  }

  public reload(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Ferret is shutting down.'));
    if (this.activities) return Promise.reject(new Error('Wait for Ferret Run and Debug launches to finish before reloading runtimes.'));
    if (!this.pending && this.current?.reloading && this.current.discovery) return this.current.discovery;
    this.replacing = true;
    this.generationRequiresReload = false;
    const generation = this.replace({ config: this.saved });
    generation.reloading = true;
    return this.load(generation);
  }

  public restartExecutable(executable: string): Promise<void> {
    if (!this.usedDaemon || !this.current || this.disposed) return Promise.resolve();
    if (this.current.executableReplacement && this.current.executable === executable) {
      return this.current.executableReplacement;
    }
    if (this.replacing) this.generationRequiresReload = true;
    const generation = this.replace(this.current.revision, executable);
    generation.executableReplacement = this.start(generation).then(() => undefined, (error: unknown) => {
      if (this.current === generation && !this.disposed) throw error;
    }).finally(() => {
      generation.executableReplacement = undefined;
    });
    this.publish({ status: 'unloaded' });
    return generation.executableReplacement;
  }

  public holdCleanup(task: Promise<void>): void {
    this.activities++;
    void this.track(task).then(() => this.activities--, () => this.activities--);
  }

  public closeAdmissions(): void {
    this.disposed = true;
  }

  public shutdown(): Promise<void> {
    this.disposed = true;
    this.current = undefined;
    this.changes.dispose();
    const stop = this.daemon.stop();
    return Promise.allSettled([...this.ownedWork, stop]).then(() => stop);
  }

  private adopt(): Generation {
    return this.current ??= { revision: { config: this.saved }, retired: Promise.resolve() };
  }

  private replace(revision: Revision, executable?: string): Generation {
    const generation: Generation = { revision, executable, retired: Promise.resolve() };
    this.current = generation;
    generation.retired = this.daemon.stop();
    return generation;
  }

  private assertCurrent(generation: Generation): void {
    if (this.current !== generation || this.disposed) throw new Error('Ferret runtime operation was superseded.');
  }

  private start(generation: Generation): Promise<DaemonConnection> {
    this.usedDaemon = true;
    if (!generation.startup) {
      generation.startup = this.track(this.startGeneration(generation)).catch((error: unknown) => {
        generation.startup = undefined;
        throw error;
      });
    }
    return generation.startup;
  }

  private async startGeneration(generation: Generation): Promise<DaemonConnection> {
    await generation.retired;
    this.assertCurrent(generation);
    const { config } = generation.revision;
    if (config.problem) throw new Error(config.problem);
    await this.verifyFile(generation);
    this.assertCurrent(generation);
    await this.daemon.start(config.path, generation.executable);
    this.assertCurrent(generation);
    const connection = this.daemon.requireConnection();
    generation.connection = connection;
    connection.signal.addEventListener('abort', () => {
      if (this.current !== generation) return;
      // A new identity also prevents an old catalog callback publishing after loss.
      this.current = { revision: generation.revision, retired: Promise.resolve() };
      if (this.replacing) this.generationRequiresReload = true;
      this.publish(this.replacing ? { status: 'reload-required', message: reloadMessage } : { status: 'unloaded' });
    }, { once: true });
    await this.verifyFile(generation);
    this.assertCurrent(generation);
    return connection;
  }

  private async verifyFile(generation: Generation): Promise<void> {
    const revision = generation.revision;
    if (!revision.config.path) return;
    let digest: string | undefined;
    try {
      digest = await fingerprintFile(revision.config.path);
    } catch (error) {
      if (revision.digest === undefined) throw error;
    }
    this.assertCurrent(generation);
    if (revision.changed || (revision.digest !== undefined && revision.digest !== digest)) {
      revision.changed = true;
      this.generationRequiresReload = true;
      const message = 'The runtime configuration file changed or became unreadable. Use Ferret: Reload Runtimes.';
      this.publish({ status: 'reload-required', message });
      throw new Error(message);
    }
    revision.digest = digest;
  }

  private load(generation: Generation): Promise<void> {
    if (generation.discovery) return generation.discovery;
    generation.failure = undefined;
    const discovery = this.track(this.loadCatalog(generation)).finally(() => {
      generation.discovery = undefined;
      generation.reloading = false;
    });
    generation.discovery = discovery;
    this.publish({ status: 'loading' });
    return discovery;
  }

  private async loadCatalog(generation: Generation): Promise<void> {
    try {
      const connection = await this.start(generation);
      this.assertCurrent(generation);
      const catalog = await this.discover(connection);
      await this.verifyFile(generation);
      this.assertCurrent(generation);
      generation.catalog = catalog;
      if (this.pending) return;
      this.replacing = false;
      this.publish({ status: 'ready', catalog });
    } catch (error) {
      generation.failure = error instanceof Error ? error : new Error(String(error));
      if (this.disposed || this.current !== generation || this.pending) return;
      if (this.replacing && !generation.connection) this.generationRequiresReload = true;
      const detail = error instanceof Error ? error.message : String(error);
      if (this.pending) {
        this.publish({ status: 'reload-required', message: detail + ' ' + reloadMessage });
      } else {
        const status = error instanceof UnsupportedDiscovery ? 'unsupported' : 'failed';
        if (status === 'unsupported' && generation.connection && generation.revision.config.entered === '') {
          this.replacing = false;
        }
        this.publish({ status, message: detail });
      }
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    // Superseded operations can still be unwinding when the window closes.
    this.ownedWork.add(work);
    return work.finally(() => { this.ownedWork.delete(work); });
  }

  private publish(result: CatalogView): void {
    this.result = result;
    this.changes.fire();
  }
}
