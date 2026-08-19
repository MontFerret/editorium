import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import type { FerretWorkspaceInvalidation } from '../daemon/workspaces';
import type { ResolvedFerretDocument } from '../daemon/types';
import { isFerretDocument } from '../language-client';
import {
  ExecutionManagerError,
  FerretExecutionClientError,
} from './errors';
import type {
  FerretExecution,
  FerretExecutionEvent,
  FerretExecutionFailure,
  FerretSession,
} from './types';

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
  requireConnection(): { readonly signal: AbortSignal };
}

export interface ExecutionClient {
  createSession(
    workspaceId: string,
    relativePath: string,
  ): Promise<FerretSession>;
  createExecution(
    sessionId: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<FerretExecution>;
  runExecution(executionId: string): Promise<FerretExecution>;
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

interface CachedSession {
  readonly documentKey: string;
  readonly documentUri: vscode.Uri;
  readonly generation: AbortSignal;
  readonly relativePath: string;
  readonly session: FerretSession;
  readonly workspaceId: string;
}

interface PendingRun {
  readonly documentKey: string;
  readonly documentVersion: number;
  executionId?: string;
  generation?: AbortSignal;
  invalidated?: 'daemon-generation' | 'workspace';
  relativePath?: string;
  sessionId?: string;
  watchAbort?: AbortController;
  workspaceId?: string;
}

class ManagedExecutionHandle implements ManagedExecution {
  public constructor(
    private readonly manager: FerretExecutionManager,
    public readonly documentUri: vscode.Uri,
    public readonly startedAt: number,
    public readonly workspaceId: string,
    public readonly relativePath: string,
    initial: FerretExecution,
    public readonly watchAbort: AbortController,
  ) {
    this.current = initial;
  }

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
      statusRank(execution.status) >= statusRank(this.current.status)
    ) {
      this.current = execution;
    }
  }
}

export class FerretExecutionManager {
  private readonly active =
    new Map<string, ManagedExecutionHandle>();
  private readonly cache = new Map<string, CachedSession>();
  private readonly changeEmitter =
    new vscode.EventEmitter<ManagedExecutionChange>();
  private readonly cleanupTasks = new Set<Promise<void>>();
  private readonly closingExecutions = new Map<string, Promise<void>>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private currentGeneration: AbortSignal | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly documentSaveListener: vscode.Disposable;
  private readonly pending = new Map<string, PendingRun>();
  private readonly retiredSessions = new Map<string, CachedSession>();
  private readonly workspaceListener: vscode.Disposable;

  public readonly onDidChangeExecution = this.changeEmitter.event;

  public constructor(
    private readonly daemon: ExecutionDaemon,
    private readonly client: ExecutionClient,
    private readonly workspaces: ExecutionWorkspaceResolver,
    private readonly output: ExecutionManagerOutput,
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
    return this.active.has(documentIdentity(documentUri));
  }

  public get activeCount(): number {
    return this.active.size;
  }

  public getActive(
    documentUri: vscode.Uri,
  ): ManagedExecution | undefined {
    return this.active.get(documentIdentity(documentUri));
  }

  public async run(
    document: vscode.TextDocument,
    parameters: Readonly<Record<string, unknown>> = {},
  ): Promise<ManagedExecution> {
    this.ensureUsable();
    this.validateDocument(document);

    const documentKey = documentIdentity(document.uri);
    if (this.active.has(documentKey) || this.pending.has(documentKey)) {
      throw managerError(
        'execution-already-running',
        'This document already has an active Ferret execution.',
        document.uri,
      );
    }

    const pending: PendingRun = {
      documentKey,
      documentVersion: document.version,
    };
    const startedAt = performance.now();
    this.pending.set(documentKey, pending);

    try {
      const generation = this.resolveGeneration();
      pending.generation = generation;
      const target = this.resolveTarget(document.uri);
      pending.workspaceId = target.workspaceId;
      pending.relativePath = target.relativePath;

      let cached = this.cache.get(documentKey);
      if (
        cached !== undefined &&
        (cached.generation !== generation ||
          cached.workspaceId !== target.workspaceId ||
          cached.relativePath !== target.relativePath)
      ) {
        this.retireSession(cached);
        cached = undefined;
      }

      let session = cached?.session;
      if (session === undefined) {
        session = await this.client.createSession(
          target.workspaceId,
          target.relativePath,
        );
        pending.sessionId = session.id;
        try {
          this.assertCanStart(document, pending, target);
        } catch (error) {
          if (this.canCleanUp(pending)) {
            this.scheduleSessionClose(session.id);
          }
          throw error;
        }

        cached = {
          documentKey,
          documentUri: document.uri,
          generation,
          relativePath: target.relativePath,
          session,
          workspaceId: target.workspaceId,
        };
        this.cache.set(documentKey, cached);
      } else {
        pending.sessionId = session.id;
      }

      let execution: FerretExecution;
      try {
        execution = await this.client.createExecution(
          session.id,
          parameters,
        );
        pending.executionId = execution.id;
        this.assertCanStart(document, pending, target);
      } catch (error) {
        if (
          pending.executionId !== undefined &&
          this.canCleanUp(pending)
        ) {
          this.scheduleExecutionClose(pending.executionId);
        }
        throw error;
      }

      const watchAbort = new AbortController();
      pending.watchAbort = watchAbort;
      let watch: AsyncIterable<FerretExecutionEvent>;
      try {
        watch = this.client.watchExecution(
          execution.id,
          watchAbort.signal,
        );
      } catch (error) {
        if (this.canCleanUp(pending)) {
          this.scheduleExecutionClose(execution.id);
        }
        throw error;
      }

      let started: FerretExecution;
      try {
        started = await this.client.runExecution(execution.id);
      } catch (error) {
        watchAbort.abort();
        if (this.canCleanUp(pending)) {
          this.scheduleExecutionClose(execution.id);
        }
        throw error;
      }

      this.assertGenerationStillUsable(pending, document.uri);
      const handle = new ManagedExecutionHandle(
        this,
        document.uri,
        performance.now(),
        target.workspaceId,
        target.relativePath,
        execution,
        watchAbort,
      );
      handle.update(started);
      this.active.set(documentKey, handle);
      this.changeEmitter.fire({ kind: 'started', execution: handle });
      void this.observeExecution(documentKey, handle, watch);

      return handle;
    } catch (error) {
      this.reportStartFailure(document.uri, startedAt, error);
      throw error;
    } finally {
      if (this.pending.get(documentKey) === pending) {
        this.pending.delete(documentKey);
      }
      if (pending.sessionId !== undefined) {
        this.releaseRetiredSession(pending.sessionId);
      }
    }
  }

  private reportStartFailure(
    documentUri: vscode.Uri,
    startedAt: number,
    error: unknown,
  ): void {
    if (
      !(error instanceof FerretExecutionClientError) ||
      error.code !== 'compilation-failed'
    ) {
      return;
    }

    this.changeEmitter.fire({
      kind: 'start-failed',
      documentUri,
      startedAt,
      failure: {
        category: 'session-creation',
        message: error.message,
        diagnostics: error.diagnostics ?? [],
      },
    });
  }

  public async cancel(documentUri: vscode.Uri): Promise<void> {
    const handle = this.active.get(documentIdentity(documentUri));
    if (handle !== undefined) {
      await this.client.cancelExecution(handle.id);
    }
  }

  public cancelHandle(handle: ManagedExecutionHandle): Promise<void> {
    const current = this.active.get(documentIdentity(handle.documentUri));
    if (current !== handle) {
      return Promise.resolve();
    }

    return this.client.cancelExecution(handle.id).then(() => undefined);
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeNow();

    return this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true;
    this.documentSaveListener.dispose();
    this.workspaceListener.dispose();
    this.detachGeneration();

    const active = [...this.active.values()];
    this.active.clear();
    for (const handle of active) {
      handle.watchAbort.abort();
    }
    const pending = [...this.pending.values()];
    for (const run of pending) {
      run.invalidated = 'daemon-generation';
      run.watchAbort?.abort();
    }
    this.pending.clear();

    const sessions = unique([
      ...this.cache.values(),
      ...this.retiredSessions.values(),
    ]);
    this.cache.clear();
    this.retiredSessions.clear();

    const executionIds = new Set([
      ...active.map(({ id }) => id),
      ...pending.flatMap(({ executionId }) =>
        executionId === undefined ? [] : [executionId],
      ),
    ]);
    await Promise.allSettled(
      [...executionIds].map(async (executionId) => {
        try {
          await this.client.cancelExecution(executionId);
        } catch (error) {
          this.output.error(
            `Cancelling Ferret execution "${executionId}" during disposal failed`,
            error,
          );
        }
        try {
          await this.client.closeExecution(executionId);
        } catch (error) {
          this.output.error(
            `Closing Ferret execution "${executionId}" during disposal failed`,
            error,
          );
        }
      }),
    );
    await Promise.allSettled(
      sessions.map(async ({ session }) => {
        try {
          await this.client.closeSession(session.id);
        } catch (error) {
          this.output.error(
            `Closing Ferret Session "${session.id}" during disposal failed`,
            error,
          );
        }
      }),
    );
    await this.waitForCleanups();

    this.changeEmitter.dispose();
  }

  private resolveGeneration(): AbortSignal {
    const generation = this.daemon.requireConnection().signal;
    if (generation.aborted) {
      throw managerError(
        'workspace-unavailable',
        'The Ferret daemon is unavailable for execution.',
      );
    }

    if (this.currentGeneration !== generation) {
      if (this.currentGeneration !== undefined) {
        this.invalidateGeneration(
          this.currentGeneration.reason,
        );
      }
      this.detachGeneration();
      this.currentGeneration = generation;
      generation.addEventListener('abort', this.onGenerationAbort, {
        once: true,
      });
    }

    return generation;
  }

  private readonly onGenerationAbort = (): void => {
    const generation = this.currentGeneration;
    if (generation !== undefined) {
      this.currentGeneration = undefined;
      this.invalidateGeneration(generation.reason);
    }
  };

  private detachGeneration(): void {
    this.currentGeneration?.removeEventListener(
      'abort',
      this.onGenerationAbort,
    );
    this.currentGeneration = undefined;
  }

  private invalidateGeneration(cause: unknown): void {
    this.cache.clear();
    this.retiredSessions.clear();
    for (const pending of this.pending.values()) {
      pending.invalidated = 'daemon-generation';
      pending.watchAbort?.abort();
    }
    this.pending.clear();

    for (const [key, handle] of this.active) {
      this.active.delete(key);
      handle.watchAbort.abort();
      this.changeEmitter.fire({
        kind: 'invalidated',
        execution: handle,
        reason: 'daemon-generation',
        cause,
      });
    }
  }

  private invalidateWorkspaces(
    event: FerretWorkspaceInvalidation,
  ): void {
    const invalid = new Set(event.workspaceIds);
    for (const [key, cached] of this.cache) {
      if (invalid.has(cached.workspaceId)) {
        this.cache.delete(key);
      }
    }
    for (const [id, cached] of this.retiredSessions) {
      if (invalid.has(cached.workspaceId)) {
        this.retiredSessions.delete(id);
      }
    }
    for (const [key, pending] of this.pending) {
      if (
        pending.workspaceId !== undefined &&
        invalid.has(pending.workspaceId)
      ) {
        pending.invalidated = 'workspace';
        pending.watchAbort?.abort();
        this.pending.delete(key);
      }
    }
    for (const [key, handle] of this.active) {
      if (invalid.has(handle.workspaceId)) {
        this.active.delete(key);
        handle.watchAbort.abort();
        this.changeEmitter.fire({
          kind: 'invalidated',
          execution: handle,
          reason: 'workspace',
        });
      }
    }
  }

  private invalidateSavedDocument(document: vscode.TextDocument): void {
    const key = documentIdentity(document.uri);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.retireSession(cached);
    }
  }

  private retireSession(cached: CachedSession): void {
    if (this.cache.get(cached.documentKey) === cached) {
      this.cache.delete(cached.documentKey);
    }

    if (this.isSessionInUse(cached.session.id)) {
      this.retiredSessions.set(cached.session.id, cached);
    } else {
      this.scheduleSessionClose(cached.session.id);
    }
  }

  private isSessionInUse(sessionId: string): boolean {
    return (
      [...this.active.values()].some(
        (handle) => handle.sessionId === sessionId,
      ) ||
      [...this.pending.values()].some(
        (pending) => pending.sessionId === sessionId,
      )
    );
  }

  private releaseRetiredSession(
    sessionId: string,
    after?: Promise<void>,
  ): void {
    if (after !== undefined) {
      void after.then(() => this.releaseRetiredSession(sessionId));
      return;
    }

    if (
      this.retiredSessions.has(sessionId) &&
      !this.isSessionInUse(sessionId)
    ) {
      this.retiredSessions.delete(sessionId);
      this.scheduleSessionClose(sessionId);
    }
  }

  private async observeExecution(
    documentKey: string,
    handle: ManagedExecutionHandle,
    watch: AsyncIterable<FerretExecutionEvent>,
  ): Promise<void> {
    try {
      for await (const event of watch) {
        if (this.active.get(documentKey) !== handle) {
          return;
        }

        handle.update(event.execution);
        if (isTerminal(event)) {
          this.active.delete(documentKey);
          handle.watchAbort.abort();
          this.changeEmitter.fire({
            kind: 'finished',
            execution: handle,
            event,
          });
          const executionClose = this.scheduleExecutionClose(handle.id);
          this.releaseRetiredSession(
            handle.sessionId,
            executionClose,
          );
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
      const executionClose = this.scheduleExecutionClose(handle.id);
      this.releaseRetiredSession(handle.sessionId, executionClose);
    }
  }

  private scheduleExecutionClose(executionId: string): Promise<void> {
    const existing = this.closingExecutions.get(executionId);
    if (existing !== undefined) {
      return existing;
    }

    const cleanup = this.trackCleanup(
      Promise.resolve().then(() =>
        this.client.closeExecution(executionId),
      ),
      `Closing Ferret execution "${executionId}" failed`,
    );
    this.closingExecutions.set(executionId, cleanup);
    void cleanup.finally(() => {
      if (this.closingExecutions.get(executionId) === cleanup) {
        this.closingExecutions.delete(executionId);
      }
    });

    return cleanup;
  }

  private scheduleSessionClose(sessionId: string): Promise<void> {
    const existing = this.closingSessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }

    const cleanup = this.trackCleanup(
      Promise.resolve().then(() => this.client.closeSession(sessionId)),
      `Closing Ferret Session "${sessionId}" failed`,
    );
    this.closingSessions.set(sessionId, cleanup);
    void cleanup.finally(() => {
      if (this.closingSessions.get(sessionId) === cleanup) {
        this.closingSessions.delete(sessionId);
      }
    });

    return cleanup;
  }

  private trackCleanup(
    task: Promise<void>,
    failureMessage: string,
  ): Promise<void> {
    const settled = task.catch((error: unknown) => {
      this.output.error(failureMessage, error);
    });
    this.cleanupTasks.add(settled);
    void settled.finally(() => this.cleanupTasks.delete(settled));

    return settled;
  }

  private async waitForCleanups(): Promise<void> {
    while (this.cleanupTasks.size > 0) {
      await Promise.allSettled([...this.cleanupTasks]);
    }
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
    this.assertGenerationStillUsable(pending, document.uri);
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

  private assertGenerationStillUsable(
    pending: PendingRun,
    documentUri: vscode.Uri,
  ): void {
    if (this.disposed) {
      throw managerError(
        'disposed',
        'The Ferret execution manager has been disposed.',
        documentUri,
      );
    }
    if (
      pending.invalidated !== undefined ||
      pending.generation?.aborted === true ||
      pending.generation !== this.currentGeneration
    ) {
      throw managerError(
        'workspace-unavailable',
        'The Ferret daemon or document workspace changed while execution was starting.',
        documentUri,
      );
    }
  }

  private canCleanUp(pending: PendingRun): boolean {
    return (
      pending.invalidated === undefined &&
      pending.generation !== undefined &&
      !pending.generation.aborted &&
      pending.generation === this.currentGeneration
    );
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

function documentIdentity(uri: vscode.Uri): string {
  return uri.toString();
}

function isTerminal(event: FerretExecutionEvent): boolean {
  return (
    event.kind === 'completed' ||
    event.kind === 'failed' ||
    event.kind === 'cancelled'
  );
}

function statusRank(status: FerretExecution['status']): number {
  switch (status) {
    case 'created':
      return 0;
    case 'running':
      return 1;
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 2;
  }
}

function managerError(
  code: ConstructorParameters<typeof ExecutionManagerError>[0],
  message: string,
  documentUri?: vscode.Uri,
): ExecutionManagerError {
  return new ExecutionManagerError(
    code,
    message,
    documentUri?.toString(),
  );
}

function unique(sessions: readonly CachedSession[]): readonly CachedSession[] {
  return [
    ...new Map(
      sessions.map((session) => [session.session.id, session]),
    ).values(),
  ];
}
