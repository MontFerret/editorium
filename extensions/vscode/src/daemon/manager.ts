import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';

import { Metadata, status } from '@grpc/grpc-js';

import type { FerretdExecutable } from '../ferretd';
import type { ServerOutput } from '../server';
import {
  DaemonDisposedError,
  DaemonError,
  unavailableDaemon,
} from './errors';
import {
  ApiCompatibilityError,
  type GetInfoResponse,
} from './gen/ferretd/daemon/v1/daemon.pb';
import type { OpenResponse } from './gen/ferretd/workspace/v1/workspace.pb';
import {
  createDaemonEndpoint,
  type DaemonEndpoint,
} from './endpoint';
import { createConnection, unary } from './rpc';
import {
  decodeStatusDetails,
  detailType,
  isServiceError,
} from './status-details';
import type {
  DaemonConnection,
  DaemonConnectionProvider,
} from './types';
import { FerretWorkspaceRegistry } from './workspaces';

const apiMajor = 1;
const apiMinor = 1;
const defaultTiming: DaemonTiming = {
  startupTimeout: 10_000,
  shutdownTimeout: 5_000,
  readinessAttemptTimeout: 500,
  readinessDelay: 50,
};

export interface DaemonProcess {
  readonly stderr: Readable | null;

  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: 'error',
    listener: (error: Error) => void,
  ): this;
  once(
    event: 'exit',
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
}

export type DaemonProcessFactory = (
  executable: string,
  args: readonly string[],
) => DaemonProcess;

export type DaemonConnectionFactory = (
  target: string,
  signal: AbortSignal,
) => DaemonConnection;

export interface DaemonTiming {
  readonly startupTimeout: number;
  readonly shutdownTimeout: number;
  readonly readinessAttemptTimeout: number;
  readonly readinessDelay: number;
}

interface ProcessExit {
  readonly code: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
}

interface ActiveDaemon {
  readonly abort: AbortController;
  readonly connection: DaemonConnection;
  readonly endpoint: DaemonEndpoint;
  readonly exited: Promise<ProcessExit>;
  readonly process: DaemonProcess;
  cleanup?: Promise<void>;
  logReader?: Interface;
  ready: boolean;
  stopping: boolean;
}

export class DaemonController implements DaemonConnectionProvider {
  private active: ActiveDaemon | undefined;
  private desiredRoots = new Set<string>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private lastError: DaemonError | undefined;
  private pending: Promise<void> = Promise.resolve();

  public readonly workspaceRegistry = new FerretWorkspaceRegistry();

  public constructor(
    private readonly readExecutable: () => FerretdExecutable,
    private readonly output: ServerOutput,
    private readonly createProcess: DaemonProcessFactory = spawnDaemon,
    private readonly createEndpoint: () => Promise<DaemonEndpoint> =
      createDaemonEndpoint,
    private readonly connect: DaemonConnectionFactory = createConnection,
    private readonly timing: DaemonTiming = defaultTiming,
  ) {}

  public requireConnection(): DaemonConnection {
    if (this.active?.ready === true) {
      return this.active.connection;
    }

    throw this.lastError ?? unavailableDaemon();
  }

  public start(): Promise<void> {
    return this.enqueue(() => this.startNow());
  }

  public stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  public updateWorkspaceFolders(
    roots: readonly string[],
  ): Promise<void> {
    this.desiredRoots = new Set(roots.map((root) => resolve(root)));

    return this.enqueue(() => this.reconcileWorkspaces());
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

    const selection = this.readExecutable();
    let endpoint: DaemonEndpoint | undefined;
    let active: ActiveDaemon | undefined;

    try {
      endpoint = await this.createEndpoint();
      const args = ['serve', '--endpoint', endpoint.cli];
      this.output.info('Starting Ferret daemon');
      this.output.info(`Ferret daemon arguments: ${JSON.stringify(args)}`);

      const process = this.createProcess(
        selection.executable,
        args,
      );
      const abort = new AbortController();
      const exited = observeExit(process);
      active = {
        abort,
        connection: this.connect(endpoint.grpc, abort.signal),
        endpoint,
        exited,
        process,
        ready: false,
        stopping: false,
      };
      active.logReader = logDaemonOutput(process.stderr, this.output);
      this.active = active;

      const info = await this.waitUntilReady(active);
      active.ready = true;
      this.lastError = undefined;
      this.output.info(
        `Ferret daemon started: ${info.serverInfo?.version ?? 'unknown version'}`,
      );
      void active.exited.then((result) =>
        this.handleUnexpectedExit(active!, result),
      );

      await this.reconcileWorkspaces();
    } catch (error) {
      const mapped = mapStartupError(error);
      this.lastError = mapped;

      if (active !== undefined) {
        if (this.active === active) {
          this.active = undefined;
        }

        await this.cleanup(active, false, mapped);
      } else {
        try {
          await endpoint?.dispose();
        } catch (cleanupError) {
          this.output.error(
            `Cleaning up Ferret daemon endpoint failed: ${formatError(cleanupError)}`,
          );
        }
      }

      throw mapped;
    }
  }

  private async stopNow(): Promise<void> {
    const active = this.active;
    this.active = undefined;

    if (active === undefined) {
      this.workspaceRegistry.clear();
      await this.waitForCleanups();
      return;
    }

    const cleanup = this.cleanup(
      active,
      active.ready,
      new DaemonDisposedError(),
    );
    // Abort the connection generation before publishing workspace loss. All
    // daemon-owned identifiers belong to that generation, so consumers must
    // invalidate them for the generation reason exactly once.
    this.workspaceRegistry.clear();
    await cleanup;
    await this.waitForCleanups();
    this.output.info('Ferret daemon stopped');
  }

  private async waitUntilReady(
    active: ActiveDaemon,
  ): Promise<GetInfoResponse> {
    const deadline = Date.now() + this.timing.startupTimeout;
    let lastError: unknown;

    while (Date.now() < deadline) {
      const attemptDeadline = Math.min(
        deadline,
        Date.now() + this.timing.readinessAttemptTimeout,
      );

      try {
        const response = await unary<GetInfoResponse>((callback) =>
          active.connection.daemon.getInfo(
            { clientApi: { major: apiMajor, minor: apiMinor } },
            new Metadata(),
            { deadline: attemptDeadline },
            callback,
          ),
          active.abort.signal,
        );
        validateServerInfo(response);

        return response;
      } catch (error) {
        if (
          error instanceof DaemonError &&
          (error.code === 'incompatible-daemon' ||
            error.code === 'protocol')
        ) {
          throw error;
        }

        const incompatible = incompatibleDaemonError(error);
        if (incompatible !== undefined) {
          throw incompatible;
        }

        lastError = error;
        const exited = await hasExited(active.exited);
        if (exited !== undefined) {
          throw processExitError(exited);
        }

        await delay(this.timing.readinessDelay);
      }
    }

    throw new DaemonError(
      'startup-failed',
      `Ferret daemon did not become ready within ${this.timing.startupTimeout}ms`,
      lastError === undefined ? undefined : { cause: lastError },
    );
  }

  private async reconcileWorkspaces(): Promise<void> {
    const active = this.active;
    if (active?.ready !== true || active.abort.signal.aborted) {
      return;
    }

    for (const workspace of this.workspaceRegistry.workspaces) {
      if (this.desiredRoots.has(workspace.root)) {
        continue;
      }

      try {
        await unary(
          (callback) =>
            active.connection.workspaces.close(
              { id: { value: workspace.id } },
              callback,
            ),
          active.abort.signal,
        );
        this.workspaceRegistry.delete(workspace.root);
      } catch (error) {
        if (!active.abort.signal.aborted) {
          this.output.error(
            `Closing Ferret workspace failed: ${formatError(error)}`,
          );
        }
      }
    }

    for (const root of [...this.desiredRoots].sort()) {
      if (this.workspaceRegistry.get(root) !== undefined) {
        continue;
      }

      try {
        const response = await unary<OpenResponse>(
          (callback) =>
            active.connection.workspaces.open({ root }, callback),
          active.abort.signal,
        );
        const workspace = response.workspace;
        if (
          workspace?.id?.value === undefined ||
          workspace.id.value === '' ||
          workspace.root === '' ||
          !isAbsolute(workspace.root)
        ) {
          throw new DaemonError(
            'protocol',
            'Ferret daemon returned an incomplete workspace',
          );
        }

        this.workspaceRegistry.set({
          id: workspace.id.value,
          root: workspace.root,
        });
      } catch (error) {
        if (!active.abort.signal.aborted) {
          this.output.error(
            `Opening Ferret workspace "${root}" failed: ${formatError(error)}`,
          );
        }
      }
    }
  }

  private async handleUnexpectedExit(
    active: ActiveDaemon,
    result: ProcessExit,
  ): Promise<void> {
    if (active.stopping || this.active !== active) {
      return;
    }

    const exitError = processExitError(result);
    const error = unavailableDaemon(exitError);
    this.active = undefined;
    this.lastError = error;
    this.output.error(`Ferret daemon disconnected: ${exitError.message}`);
    const cleanup = this.cleanup(active, false, error);
    this.workspaceRegistry.clear();
    await cleanup;
  }

  private cleanup(
    active: ActiveDaemon,
    requestShutdown: boolean,
    reason: unknown,
  ): Promise<void> {
    if (active.cleanup === undefined) {
      const cleanup = this.cleanupNow(
        active,
        requestShutdown,
        reason,
      );
      active.cleanup = cleanup;
      this.cleanupTasks.add(cleanup);
      void cleanup.then(
        () => this.cleanupTasks.delete(cleanup),
        () => this.cleanupTasks.delete(cleanup),
      );
    }

    return active.cleanup;
  }

  private async cleanupNow(
    active: ActiveDaemon,
    requestShutdown: boolean,
    reason: unknown,
  ): Promise<void> {
    active.stopping = true;
    active.abort.abort(reason);

    if (requestShutdown) {
      try {
        await unary(
          (callback) =>
            active.connection.daemon.shutdown(
              {},
              new Metadata(),
              { deadline: Date.now() + this.timing.shutdownTimeout },
              callback,
            ),
        );
      } catch (error) {
        const exited = await hasExited(active.exited);
        if (exited === undefined) {
          this.output.error(
            `Requesting Ferret daemon shutdown failed: ${formatError(error)}`,
          );
        }
      }
    }

    try {
      active.connection.channel.close();
    } catch (error) {
      this.output.error(
        `Closing Ferret daemon channel failed: ${formatError(error)}`,
      );
    }
    if (!(await waitForExit(active.exited, this.timing.shutdownTimeout))) {
      try {
        active.process.kill('SIGKILL');
      } catch (error) {
        this.output.error(
          `Terminating Ferret daemon failed: ${formatError(error)}`,
        );
      }
      if (!(await waitForExit(active.exited, this.timing.shutdownTimeout))) {
        this.output.error('Ferret daemon did not exit after termination');
      }
    }

    try {
      active.logReader?.close();
    } catch (error) {
      this.output.error(
        `Closing Ferret daemon log failed: ${formatError(error)}`,
      );
    }
    try {
      await active.endpoint.dispose();
    } catch (error) {
      this.output.error(
        `Cleaning up Ferret daemon endpoint failed: ${formatError(error)}`,
      );
    }
  }

  private async waitForCleanups(): Promise<void> {
    await Promise.all([...this.cleanupTasks]);
  }
}

function spawnDaemon(
  executable: string,
  args: readonly string[],
): DaemonProcess {
  return spawn(executable, [...args], {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
}

function observeExit(process: DaemonProcess): Promise<ProcessExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (result: ProcessExit): void => {
      if (!settled) {
        settled = true;
        resolveExit(result);
      }
    };

    process.once('error', (error) =>
      finish({ code: null, error, signal: null }),
    );
    process.once('exit', (code, signal) =>
      finish({ code, signal }),
    );
  });
}

function logDaemonOutput(
  stderr: Readable | null,
  output: ServerOutput,
): Interface | undefined {
  if (stderr === null) {
    return undefined;
  }

  const reader = createInterface({ input: stderr });
  reader.on('line', (line) => output.info(`Ferret daemon: ${line}`));

  return reader;
}

function validateServerInfo(response: GetInfoResponse): void {
  const info = response.serverInfo;
  if (
    info === undefined ||
    info.instanceId === '' ||
    info.apiVersion === undefined
  ) {
    throw new DaemonError(
      'protocol',
      'Ferret daemon returned incomplete server information',
    );
  }

  if (
    info.apiVersion.major !== apiMajor ||
    info.apiVersion.minor < apiMinor
  ) {
    throw new DaemonError(
      'incompatible-daemon',
      `Incompatible Ferret daemon API: client ${apiMajor}.${apiMinor}, server ${info.apiVersion.major}.${info.apiVersion.minor}`,
    );
  }
}

function incompatibleDaemonError(
  error: unknown,
): DaemonError | undefined {
  if (!isServiceError(error) || error.code !== status.FAILED_PRECONDITION) {
    return undefined;
  }

  const details = decodeStatusDetails(error);
  const compatibility = details?.details.find(
    (detail) =>
      detailType(detail.typeUrl) ===
      'ferretd.daemon.v1.ApiCompatibilityError',
  );
  if (compatibility === undefined) {
    return undefined;
  }

  try {
    const value = ApiCompatibilityError.decode(compatibility.value);

    return new DaemonError(
      'incompatible-daemon',
      `Incompatible Ferret daemon API: client ${value.clientApi?.major ?? apiMajor}.${value.clientApi?.minor ?? apiMinor}, server ${value.serverApi?.major ?? 0}.${value.serverApi?.minor ?? 0}`,
      { cause: error },
    );
  } catch {
    return new DaemonError(
      'protocol',
      'Ferret daemon returned malformed compatibility details',
      { cause: error },
    );
  }
}

function mapStartupError(error: unknown): DaemonError {
  if (error instanceof DaemonError) {
    return error;
  }

  return new DaemonError(
    'startup-failed',
    `Ferret daemon startup failed: ${formatError(error)}`,
    { cause: error },
  );
}

function processExitError(result: ProcessExit): Error {
  if (result.error !== undefined) {
    return result.error;
  }

  return new Error(
    result.signal === null
      ? `daemon exited with code ${String(result.code)}`
      : `daemon exited with signal ${result.signal}`,
  );
}

async function hasExited(
  exited: Promise<ProcessExit>,
): Promise<ProcessExit | undefined> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    exited,
    Promise.resolve(pending),
  ]);

  return result === pending ? undefined : result;
}

async function waitForExit(
  exited: Promise<ProcessExit>,
  timeout: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeout);
  });
  const result = await Promise.race([
    exited.then(() => true),
    timedOut,
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) =>
    setTimeout(resolveDelay, milliseconds),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
