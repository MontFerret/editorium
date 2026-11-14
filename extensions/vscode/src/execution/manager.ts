import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import type { FerretWorkspaceInvalidation } from '../daemon/workspaces';
import type { DaemonConnection, ResolvedFerretDocument } from '../daemon/types';
import type { PreparedRuntime, RunReservation, RuntimeCoordinator } from '../runtime/coordinator';
import { RuntimeLaunchError } from '../runtime/errors';
import { isFerretDocument } from '../language-client';
import {
  managerError,
  FerretExecutionClientError,
} from './errors';
import type {
  FerretExecution,
  FerretExecutionEvent,
  FerretExecutionFailure,
  FerretSession,
} from './types';
import { ManagedExecutionHandle } from './managed-execution';
import { waitForPreparation } from './preparation';
import { RunResources } from './run-resources';
import type { RunOptions } from './run-options';
import { RunSession } from './session';
import { validateParameters } from './parameters';
import { resolveWorkingDirectory } from './working-directory';

export interface ManagedExecution {
  readonly id: string;
  readonly sessionId: string;
  readonly documentUri: vscode.Uri;
  /** Local monotonic milliseconds at which execution start was observed. */
  readonly startedAt: number;
  readonly execution: FerretExecution;

  cancel(): Promise<void>;
}

export type ManagedExecutionChange =
  | { readonly kind: 'runtime-resolved'; readonly documentUri: vscode.Uri; readonly runtime: string; readonly provider: string }
  | { readonly kind: 'cleanup-failed'; readonly documentUri: vscode.Uri; readonly error: unknown }
  | { readonly kind: 'preparation-cancelled'; readonly documentUri: vscode.Uri; readonly startedAt: number }
  | { readonly kind: 'preparing' | 'preparation-ended'; readonly documentUri: vscode.Uri }
  | {
      readonly kind: 'started';
      readonly execution: ManagedExecution;
    }
  | {
      readonly kind: 'start-failed';
      readonly documentUri: vscode.Uri;
      /** Local monotonic milliseconds at which the run attempt began. */
      readonly startedAt: number;
      readonly failure: FerretExecutionFailure;
    }
  | {
      readonly kind: 'changed';
      readonly execution: ManagedExecution;
      readonly event: FerretExecutionEvent;
    }
  | {
      readonly kind: 'finished';
      readonly execution: ManagedExecution;
      readonly event: FerretExecutionEvent;
    }
  | {
      readonly kind: 'watch-failed';
      readonly execution: ManagedExecution;
      readonly error: unknown;
    }
  | {
      readonly kind: 'invalidated';
      readonly execution: ManagedExecution;
      readonly reason: 'daemon-generation' | 'workspace';
      readonly cause?: unknown;
    };

export interface ExecutionDaemon {
  prepareWorkspaces(signal: AbortSignal): Promise<void>;
}

export interface ExecutionClient {
  createSession(
    workspaceId: string,
    relativePath: string,
    runtime: PreparedRuntime,
    signal: AbortSignal,
  ): Promise<FerretSession>;
  createExecution(
    sessionId: string,
    parameters: Readonly<Record<string, unknown>>,
    workingDirectory: string | undefined,
    signal: AbortSignal,
  ): Promise<FerretExecution>;
  runExecution(executionId: string, signal: AbortSignal): Promise<FerretExecution>;
  watchExecution(
    executionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<FerretExecutionEvent>;
  cancelExecution(executionId: string): Promise<FerretExecution>;
  closeExecution(executionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export interface ExecutionWorkspaceResolver {
  readonly onDidInvalidateWorkspaces: vscode.Event<FerretWorkspaceInvalidation>;

  resolveDocument(documentPath: string): ResolvedFerretDocument | undefined;
}

export interface ExecutionDocumentEvents {
  readonly onDidSaveTextDocument: vscode.Event<vscode.TextDocument>;
}

export interface ExecutionManagerOutput {
  error(message: string, ...args: unknown[]): void;
}

interface PendingRun {
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  readonly documentVersion: number;
  generation?: AbortSignal;
  workspaceId?: string;
}

export class FerretExecutionManager {
  private readonly active =
    new Map<string, ManagedExecutionHandle>();
  private readonly cache = new Map<string, RunSession>();
  private readonly changeEmitter =
    new vscode.EventEmitter<ManagedExecutionChange>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly documentSaveListener: vscode.Disposable;
  private readonly pending = new Map<string, PendingRun>();
  private readonly workspaceListener: vscode.Disposable;

  public readonly onDidChangeExecution = this.changeEmitter.event;

  public constructor(
    private readonly daemon: ExecutionDaemon,
    private readonly bindClient: (connection: DaemonConnection) => ExecutionClient,
    private readonly workspaces: ExecutionWorkspaceResolver,
    private readonly output: ExecutionManagerOutput,
    private readonly runtime: Pick<RuntimeCoordinator, 'admitRun' | 'holdCleanup'>,
    documents: ExecutionDocumentEvents = vscode.workspace,
  ) {
    this.documentSaveListener = documents.onDidSaveTextDocument(
      (document) => this.invalidateSavedDocument(document),
    );
    this.workspaceListener = workspaces.onDidInvalidateWorkspaces(
      (event) => this.invalidateWorkspaces(event),
    );
  }

  public isRunning(documentUri: vscode.Uri): boolean {
    const key = documentUri.toString();
    return this.active.has(key) || this.pending.has(key);
  }

  public get activeCount(): number {
    return this.active.size;
  }

  public getActive(
    documentUri: vscode.Uri,
  ): ManagedExecution | undefined {
    return this.active.get(documentUri.toString());
  }

  public async run(
    document: vscode.TextDocument,
    options: RunOptions = {},
  ): Promise<ManagedExecution> {
    this.ensureUsable();
    this.validateDocument(document);
    const documentKey = document.uri.toString();
    if (this.isRunning(document.uri)) {
      throw managerError('execution-already-running', 'This document already has an active Ferret execution.', document.uri);
    }
    const parameters = validateParameters(options.parameters === undefined ? {} : options.parameters);
    const directory = options.workingDirectory;
    let reservation: RunReservation;
    try {
      reservation = this.runtime.admitRun(options.runtimeName);
    } catch (error) {
      this.reportStartFailure(document.uri, performance.now(), error);
      throw error;
    }
    let finishSetup!: () => void;
    const pending: PendingRun = {
      abort: new AbortController(), settled: new Promise(resolve => { finishSetup = resolve; }),
      documentVersion: document.version,
    };
    const { signal } = pending.abort;
    this.pending.set(documentKey, pending);
    const startedAt = performance.now();
    let resources: RunResources | undefined;
    let observing = false;
    const watchAbort = new AbortController();
    try {
      this.changeEmitter.fire({ kind: 'preparing', documentUri: document.uri });
      signal.throwIfAborted();
      const runtime = await waitForPreparation(reservation.prepareRun(), signal);
      signal.throwIfAborted();
      const generation = runtime.connection.signal;
      generation.throwIfAborted();
      pending.generation = generation;
      this.changeEmitter.fire({ kind: 'runtime-resolved', documentUri: document.uri, runtime: runtime.name, provider: runtime.provider });
      await waitForPreparation(this.daemon.prepareWorkspaces(generation), signal);
      signal.throwIfAborted();
      const target = this.resolveTarget(document.uri);
      pending.workspaceId = target.workspaceId;
      const workingDirectory = await waitForPreparation(resolveWorkingDirectory(directory, target.root, runtime), signal);
      this.assertCanStart(document, pending, target);
      await waitForPreparation(reservation.verifyConfiguration(), signal);
      this.assertCanStart(document, pending, target);

      let session = runtime.provider === 'native' ? this.cache.get(documentKey) : undefined;
      if (session && (session.generation !== generation || session.runtimeName !== runtime.name ||
          session.snapshot.source.workspaceId !== target.workspaceId || session.snapshot.source.relativePath !== target.relativePath)) {
        this.retire(documentKey, session);
        session = undefined;
      }
      if (!session) {
        const client = this.bindClient(runtime.connection);
        const created = await client.createSession(target.workspaceId, target.relativePath, runtime, signal);
        session = new RunSession(client, generation, created, runtime.name);
        resources = new RunResources(session);
        this.assertCanStart(document, pending, target);
        if (runtime.provider === 'native') {
          session.cache();
          this.cache.set(documentKey, session);
        }
      } else {
        resources = new RunResources(session);
      }
      const execution = await session.client.createExecution(session.snapshot.id, parameters, workingDirectory, signal);
      resources.executionId = execution.id;
      this.assertCanStart(document, pending, target);
      const watch = session.client.watchExecution(execution.id, watchAbort.signal);
      const started = await session.client.runExecution(execution.id, signal);
      // RunExecution has admitted the immutable plan. A subsequent source edit
      // affects the next Run, even if the start acknowledgment was delayed.
      this.assertGeneration(pending, document.uri);
      const handle = new ManagedExecutionHandle(this, document.uri, performance.now(), target.workspaceId, resources, execution, watchAbort);
      handle.update(started);
      this.active.set(documentKey, handle);
      const lost = () => this.invalidateHandle(handle, 'daemon-generation', generation.reason);
      generation.addEventListener('abort', lost, { once: true });
      observing = true;
      handle.settled = this.observeExecution(documentKey, handle, watch).finally(() => {
        generation.removeEventListener('abort', lost);
        reservation.release();
      });
      this.trackCleanup(handle.settled);
      this.changeEmitter.fire({ kind: 'started', execution: handle });
      return handle;
    } catch (error) {
      watchAbort.abort();
      const primary: unknown = signal.aborted ? signal.reason : error;
      if (signal.aborted && primary instanceof RuntimeLaunchError) {
        this.changeEmitter.fire({ kind: 'preparation-cancelled', documentUri: document.uri, startedAt });
      } else {
        this.reportStartFailure(document.uri, startedAt, primary);
      }
      if (resources) await this.closeResources(resources, document.uri, true);
      // Invalid create responses can carry a second failure from their rollback.
      if (error !== primary && error instanceof FerretExecutionClientError && error.cause instanceof AggregateError) {
        this.reportCleanup(document.uri, error);
      }
      throw primary;
    } finally {
      this.pending.delete(documentKey);
      if (!observing) reservation.release();
      finishSetup();
      this.changeEmitter.fire({ kind: 'preparation-ended', documentUri: document.uri });
    }
  }

  private reportStartFailure(
    documentUri: vscode.Uri,
    startedAt: number,
    error: unknown,
  ): void {
    this.changeEmitter.fire({
      kind: 'start-failed',
      documentUri,
      startedAt,
      failure: {
        category: 'session-creation',
        message: error instanceof Error ? error.message : String(error),
        diagnostics: error instanceof FerretExecutionClientError ? error.diagnostics ?? [] : [],
      },
    });
  }

  public async cancel(documentUri: vscode.Uri): Promise<void> {
    const key = documentUri.toString();
    const handle = this.active.get(key);
    const pending = this.pending.get(key);
    if (!handle && pending) {
      pending.abort.abort(new RuntimeLaunchError('Starting the Ferret execution was cancelled.'));
      await pending.settled;
      return;
    }
    if (handle !== undefined) {
      await this.cancelHandle(handle);
    }
  }

  public cancelHandle(handle: ManagedExecutionHandle): Promise<void> {
    const current = this.active.get(handle.documentUri.toString());
    if (current !== handle) {
      return handle.settled ?? Promise.resolve();
    }

    return handle.stop ??= this.stopHandle(handle);
  }

  private async stopHandle(handle: ManagedExecutionHandle): Promise<void> {
    // Keep the watch until it supplies the terminal snapshot. A broken watch
    // must not indefinitely delay explicit close after Stop.
    try {
      await handle.resources.cancel();
    } catch (error) {
      handle.watchAbort.abort();
      await handle.settled;
      throw error;
    }
    const timer = setTimeout(() => handle.watchAbort.abort(), 5000);
    try { await handle.settled; } finally { clearTimeout(timer); }
  }

  public dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.disposeNow();
      this.runtime.holdCleanup(this.disposePromise);
    }

    return this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true;
    this.documentSaveListener.dispose();
    this.workspaceListener.dispose();
    const preparing = [...this.pending.values()];
    for (const run of preparing) run.abort.abort(new RuntimeLaunchError('Starting the Ferret execution was cancelled.'));
    await Promise.all(preparing.map(run => run.settled));
    for (const handle of this.active.values()) handle.watchAbort.abort();
    for (const [key, session] of this.cache) this.retire(key, session);
    while (this.cleanupTasks.size) await Promise.allSettled([...this.cleanupTasks]);
    this.changeEmitter.dispose();
  }

  private invalidateHandle(handle: ManagedExecutionHandle, reason: 'workspace' | 'daemon-generation', cause?: unknown): void {
    const key = handle.documentUri.toString();
    if (this.active.get(key) !== handle) return;
    this.active.delete(key);
    handle.watchAbort.abort();
    this.changeEmitter.fire({ kind: 'invalidated', execution: handle, reason, cause });
  }

  private invalidateWorkspaces(event: FerretWorkspaceInvalidation): void {
    const invalid = new Set(event.workspaceIds);
    for (const [key, session] of this.cache) {
      if (invalid.has(session.snapshot.source.workspaceId)) this.retire(key, session);
    }
    for (const pending of this.pending.values()) {
      if (pending.workspaceId && invalid.has(pending.workspaceId)) {
        pending.abort.abort(managerError('workspace-unavailable', 'The Ferret workspace changed during preparation.'));
      }
    }
    for (const handle of this.active.values()) {
      if (invalid.has(handle.workspaceId)) this.invalidateHandle(handle, 'workspace');
    }
  }

  private invalidateSavedDocument(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const session = this.cache.get(key);
    if (session) this.retire(key, session);
  }

  private retire(key: string, session: RunSession): void {
    this.cache.delete(key);
    const closed = session.retire().catch((error: unknown) => this.reportCleanup(vscode.Uri.parse(key), error));
    this.runtime.holdCleanup(closed);
    this.trackCleanup(closed);
  }

  private async observeExecution(
    documentKey: string,
    handle: ManagedExecutionHandle,
    watch: AsyncIterable<FerretExecutionEvent>,
  ): Promise<void> {
    let terminal = false;
    try {
      for await (const event of watch) {
        if (this.active.get(documentKey) !== handle) {
          return;
        }

        handle.update(event.execution);
        if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
          this.active.delete(documentKey);
          handle.watchAbort.abort();
          this.changeEmitter.fire({
            kind: 'finished',
            execution: handle,
            event,
          });
          terminal = true;
          return;
        }

        this.changeEmitter.fire({
          kind: 'changed',
          execution: handle,
          event,
        });
      }

      if (this.active.get(documentKey) === handle) {
        throw new Error(
          'Ferret execution watch ended without a terminal event.',
        );
      }
    } catch (error) {
      if (this.active.get(documentKey) !== handle) {
        return;
      }

      this.active.delete(documentKey);
      handle.watchAbort.abort();
      this.changeEmitter.fire({
        kind: 'watch-failed',
        execution: handle,
        error,
      });
    } finally {
      await this.closeResources(handle.resources, handle.documentUri, !terminal);
    }
  }

  private async closeResources(resources: RunResources, uri: vscode.Uri, cancel: boolean): Promise<void> {
    try { await resources.close(cancel); } catch (error) { this.reportCleanup(uri, error); }
  }

  private reportCleanup(uri: vscode.Uri, error: unknown): void {
    this.output.error(`Cleaning up Ferret Run for ${uri.fsPath} failed`, error);
    this.changeEmitter.fire({ kind: 'cleanup-failed', documentUri: uri, error });
  }

  private trackCleanup(task: Promise<void>): void {
    this.cleanupTasks.add(task);
    void task.then(() => this.cleanupTasks.delete(task), () => this.cleanupTasks.delete(task));
  }

  private validateDocument(document: vscode.TextDocument): void {
    if (!isFerretDocument(document)) {
      throw managerError(
        'unsupported-document',
        'Only saved file-backed Ferret documents can be executed.',
        document.uri,
      );
    }
    if (document.isDirty) {
      throw managerError(
        'document-dirty',
        'The document must be saved before it can be executed.',
        document.uri,
      );
    }
  }

  private resolveTarget(documentUri: vscode.Uri): ResolvedFerretDocument {
    const target = this.workspaces.resolveDocument(documentUri.fsPath);
    if (target === undefined) {
      throw managerError(
        'workspace-unavailable',
        'The document does not belong to an open Ferret workspace.',
        documentUri,
      );
    }

    return target;
  }

  private assertCanStart(
    document: vscode.TextDocument,
    pending: PendingRun,
    expected: ResolvedFerretDocument,
  ): void {
    this.assertGeneration(pending, document.uri);
    if (document.isDirty) {
      throw managerError(
        'document-dirty',
        'The document changed while execution was starting and must be saved.',
        document.uri,
      );
    }
    if (document.version !== pending.documentVersion) {
      throw managerError(
        'document-changed',
        'The document changed while execution was starting; run it again.',
        document.uri,
      );
    }

    const current = this.resolveTarget(document.uri);
    if (
      current.workspaceId !== expected.workspaceId ||
      current.relativePath !== expected.relativePath
    ) {
      throw managerError(
        'workspace-unavailable',
        'The document workspace changed while execution was starting.',
        document.uri,
      );
    }
  }

  private assertGeneration(pending: PendingRun, uri: vscode.Uri): void {
    pending.abort.signal.throwIfAborted();
    if (pending.generation?.aborted) {
      throw managerError('workspace-unavailable', 'The Ferret daemon changed during preparation.', uri);
    }
  }

  private ensureUsable(): void {
    if (this.disposed) {
      throw managerError(
        'disposed',
        'The Ferret execution manager has been disposed.',
      );
    }
  }
}
