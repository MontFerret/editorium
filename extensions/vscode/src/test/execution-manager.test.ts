import * as assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import { FerretWorkspaceRegistry } from '../daemon/workspaces';
import {
  ExecutionManagerError,
  FerretExecutionClientError,
} from '../execution/errors';
import {
  FerretExecutionManager,
  type ExecutionClient,
  type ExecutionDaemon,
  type ManagedExecutionChange,
} from '../execution/manager';
import type {
  FerretExecution,
  FerretExecutionEvent,
  FerretExecutionStatus,
  FerretSession,
} from '../execution/types';

class FakeDaemon implements ExecutionDaemon {
  private generation = new AbortController();

  public requireConnection(): { readonly signal: AbortSignal } {
    return { signal: this.generation.signal };
  }

  public replace(reason: unknown = new Error('daemon replaced')): void {
    this.generation.abort(reason);
    this.generation = new AbortController();
  }
}

class FakeWatch implements AsyncIterableIterator<FerretExecutionEvent> {
  private readonly queue: FerretExecutionEvent[] = [];
  private done = false;
  private failure: unknown;
  private wake: (() => void) | undefined;

  public constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () => this.finish(), {
      once: true,
    });
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<FerretExecutionEvent> {
    return this;
  }

  public async next(): Promise<IteratorResult<FerretExecutionEvent>> {
    while (true) {
      const event = this.queue.shift();
      if (event !== undefined) {
        return { done: false, value: event };
      }
      if (this.failure !== undefined) {
        throw this.failure;
      }
      if (this.done) {
        return { done: true, value: undefined };
      }

      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  public return(): Promise<IteratorResult<FerretExecutionEvent>> {
    this.finish();

    return Promise.resolve({ done: true, value: undefined });
  }

  public send(event: FerretExecutionEvent): void {
    if (!this.done && this.failure === undefined) {
      this.queue.push(event);
      this.notify();
    }
  }

  public fail(error: unknown): void {
    if (!this.done) {
      this.failure = error;
      this.notify();
    }
  }

  public finish(): void {
    if (!this.done) {
      this.done = true;
      this.notify();
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

class FakeExecutionClient implements ExecutionClient {
  public readonly calls: string[] = [];
  public readonly cancelExecutionIds: string[] = [];
  public readonly closeExecutionIds: string[] = [];
  public readonly closeSessionIds: string[] = [];
  public readonly executionParameters: Readonly<Record<string, unknown>>[] = [];
  public readonly sessionRequests: Array<{
    readonly workspaceId: string;
    readonly relativePath: string;
  }> = [];
  public createSessionGate: Promise<void> | undefined;
  public createSessionError: Error | undefined;
  public rejectCleanup = false;
  public runError: Error | undefined;

  private executionCount = 0;
  private sessionCount = 0;
  private readonly executionSessions = new Map<string, string>();
  private readonly watches = new Map<string, FakeWatch>();

  public async createSession(
    workspaceId: string,
    relativePath: string,
  ): Promise<FerretSession> {
    this.calls.push('create-session');
    this.sessionRequests.push({ workspaceId, relativePath });
    await this.createSessionGate;
    if (this.createSessionError !== undefined) {
      throw this.createSessionError;
    }
    const id = `session-${++this.sessionCount}`;

    return {
      id,
      source: {
        workspaceId,
        relativePath,
        uri: vscode.Uri.file(`/workspace/${relativePath}`).toString(),
        revision: this.sessionCount,
      },
      parameters: [],
    };
  }

  public async createExecution(
    sessionId: string,
    parameters: Readonly<Record<string, unknown>> = {},
  ): Promise<FerretExecution> {
    this.calls.push('create-execution');
    this.executionParameters.push(parameters);
    const id = `execution-${++this.executionCount}`;
    this.executionSessions.set(id, sessionId);

    return execution(id, sessionId, 'created');
  }

  public async runExecution(executionId: string): Promise<FerretExecution> {
    this.calls.push('run-execution');
    if (this.runError !== undefined) {
      throw this.runError;
    }

    return execution(
      executionId,
      this.requireSession(executionId),
      'running',
    );
  }

  public watchExecution(
    executionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<FerretExecutionEvent> {
    this.calls.push('watch-execution');
    const watch = new FakeWatch(signal);
    this.watches.set(executionId, watch);

    return watch;
  }

  public async cancelExecution(
    executionId: string,
  ): Promise<FerretExecution> {
    this.calls.push('cancel-execution');
    this.cancelExecutionIds.push(executionId);
    if (this.rejectCleanup) {
      throw new Error('cancel unavailable');
    }

    return execution(
      executionId,
      this.requireSession(executionId),
      'cancelled',
    );
  }

  public async closeExecution(executionId: string): Promise<void> {
    this.calls.push(`close-execution:${executionId}`);
    this.closeExecutionIds.push(executionId);
    if (this.rejectCleanup) {
      throw new Error('close execution unavailable');
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    this.calls.push(`close-session:${sessionId}`);
    this.closeSessionIds.push(sessionId);
    if (this.rejectCleanup) {
      throw new Error('close session unavailable');
    }
  }

  public send(executionId: string, kind: FerretExecutionEvent['kind']): void {
    this.requireWatch(executionId).send(
      executionEvent(
        executionId,
        this.requireSession(executionId),
        kind,
      ),
    );
  }

  public failWatch(executionId: string, error: unknown): void {
    this.requireWatch(executionId).fail(error);
  }

  private requireSession(executionId: string): string {
    const sessionId = this.executionSessions.get(executionId);
    assert.ok(sessionId, `Missing Session for ${executionId}`);

    return sessionId;
  }

  private requireWatch(executionId: string): FakeWatch {
    const watch = this.watches.get(executionId);
    assert.ok(watch, `Missing watch for ${executionId}`);

    return watch;
  }
}

interface MutableDocument {
  isDirty: boolean;
  isUntitled: boolean;
  languageId: string;
  uri: vscode.Uri;
  version: number;
}

interface Fixture {
  readonly client: FakeExecutionClient;
  readonly daemon: FakeDaemon;
  readonly documents: vscode.EventEmitter<vscode.TextDocument>;
  readonly manager: FerretExecutionManager;
  readonly output: FakeOutput;
  readonly registry: FerretWorkspaceRegistry;
}

class FakeOutput {
  public readonly errors: Array<{
    readonly message: string;
    readonly error: unknown;
  }> = [];

  public error(message: string, error: unknown): void {
    this.errors.push({ message, error });
  }
}

suite('Ferret execution manager', () => {
  test('creates, watches, and starts before reusing one cached Session', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const parameters = { limit: 3, nested: { enabled: true } };
    const changes: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) =>
      changes.push(change),
    );

    try {
      const beforeStart = performance.now();
      const first = await fixture.manager.run(
        asTextDocument(document),
        parameters,
      );
      const afterStart = performance.now();

      assert.deepStrictEqual(fixture.client.calls.slice(0, 4), [
        'create-session',
        'create-execution',
        'watch-execution',
        'run-execution',
      ]);
      assert.strictEqual(fixture.client.executionParameters[0], parameters);
      assert.strictEqual(first.execution.status, 'running');
      assert.ok(first.startedAt >= beforeStart);
      assert.ok(first.startedAt <= afterStart);
      assert.strictEqual(fixture.manager.getActive(document.uri), first);
      assert.strictEqual(fixture.manager.activeCount, 1);
      assert.strictEqual(changes[0]?.kind, 'started');

      fixture.client.send(first.id, 'created');
      await settle();
      assert.strictEqual(first.execution.status, 'running');
      fixture.client.send(first.id, 'started');
      await settle();
      assert.ok(changes.some(({ kind }) => kind === 'changed'));

      fixture.client.send(first.id, 'completed');
      await settle();
      assert.strictEqual(fixture.manager.isRunning(document.uri), false);
      assert.strictEqual(fixture.manager.activeCount, 0);
      assert.deepStrictEqual(fixture.client.closeExecutionIds, [first.id]);
      assert.strictEqual(changes.at(-1)?.kind, 'finished');

      const second = await fixture.manager.run(asTextDocument(document));
      assert.strictEqual(fixture.client.sessionRequests.length, 1);
      assert.notStrictEqual(second.id, first.id);
      fixture.client.send(second.id, 'completed');
      await settle();
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('rejects unsupported, dirty, and unresolved documents before RPCs', async () => {
    const fixture = createFixture();
    const cases: Array<{
      readonly document: MutableDocument;
      readonly code: ExecutionManagerError['code'];
    }> = [
      {
        document: ferretDocument('/workspace/dirty.fql', { isDirty: true }),
        code: 'document-dirty',
      },
      {
        document: ferretDocument('/workspace/plain.fql', {
          languageId: 'plaintext',
        }),
        code: 'unsupported-document',
      },
      {
        document: ferretDocument('/workspace/untitled.fql', {
          isUntitled: true,
        }),
        code: 'unsupported-document',
      },
      {
        document: ferretDocument('/workspace/remote.fql', {
          uri: vscode.Uri.parse('untitled:remote.fql'),
        }),
        code: 'unsupported-document',
      },
      {
        document: ferretDocument('/elsewhere/query.fql'),
        code: 'workspace-unavailable',
      },
    ];

    try {
      for (const { document, code } of cases) {
        await assert.rejects(
          fixture.manager.run(asTextDocument(document)),
          (error: unknown) =>
            error instanceof ExecutionManagerError && error.code === code,
        );
      }
      assert.deepStrictEqual(fixture.client.calls, []);
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('rejects a document changed while Session creation is pending', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const gate = deferred();
    fixture.client.createSessionGate = gate.promise;

    try {
      const running = fixture.manager.run(asTextDocument(document));
      await settle();
      document.version += 1;
      document.isDirty = true;
      gate.resolve();

      await assert.rejects(
        running,
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'document-dirty',
      );
      await settle();
      assert.strictEqual(
        fixture.client.calls.includes('create-execution'),
        false,
      );
      assert.deepStrictEqual(fixture.client.closeSessionIds, ['session-1']);
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('distinguishes a saved version change during startup', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const gate = deferred();
    fixture.client.createSessionGate = gate.promise;

    try {
      const running = fixture.manager.run(asTextDocument(document));
      await settle();
      document.version += 1;
      gate.resolve();

      await assert.rejects(
        running,
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'document-changed',
      );
      await settle();
      assert.deepStrictEqual(fixture.client.closeSessionIds, ['session-1']);
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('releases a created Execution when starting it fails', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const failure = new Error('run rejected');
    fixture.client.runError = failure;

    try {
      await assert.rejects(
        fixture.manager.run(asTextDocument(document)),
        (error: unknown) => error === failure,
      );
      await settle();
      assert.strictEqual(fixture.manager.isRunning(document.uri), false);
      assert.deepStrictEqual(fixture.client.closeExecutionIds, ['execution-1']);

      fixture.client.runError = undefined;
      const rerun = await fixture.manager.run(asTextDocument(document));
      assert.strictEqual(fixture.client.sessionRequests.length, 1);
      fixture.client.send(rerun.id, 'completed');
      await settle();
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('reports structured compilation failures before execution starts', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const failure = new FerretExecutionClientError({
      code: 'compilation-failed',
      operation: 'create-session',
      message: 'Ferret session compilation failed',
      diagnostics: [
        {
          uri: document.uri.toString(),
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 7 },
          },
          severity: 'error',
          code: 'FQL1001',
          source: 'ferret',
          message: 'invalid expression',
          relatedInformation: [],
        },
      ],
    });
    fixture.client.createSessionError = failure;
    const changes: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) =>
      changes.push(change),
    );

    try {
      await assert.rejects(
        fixture.manager.run(asTextDocument(document)),
        (error: unknown) => error === failure,
      );

      assert.strictEqual(fixture.manager.activeCount, 0);
      assert.strictEqual(changes.length, 1);
      const change = changes[0];
      assert.ok(change?.kind === 'start-failed');
      assert.strictEqual(
        change.documentUri.toString(),
        document.uri.toString(),
      );
      assert.ok(Number.isFinite(change.startedAt));
      assert.deepStrictEqual(
        change.failure.diagnostics,
        failure.diagnostics,
      );
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('reserves pending and active documents while allowing concurrency', async () => {
    const fixture = createFixture();
    const users = ferretDocument('/workspace/users.fql');
    const scrape = ferretDocument('/workspace/scrape.fql');
    const gate = deferred();
    fixture.client.createSessionGate = gate.promise;

    try {
      const pending = fixture.manager.run(asTextDocument(users));
      await settle();
      await assert.rejects(
        fixture.manager.run(asTextDocument(users)),
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'execution-already-running',
      );
      gate.resolve();
      fixture.client.createSessionGate = undefined;
      const first = await pending;
      const second = await fixture.manager.run(asTextDocument(scrape));
      assert.strictEqual(fixture.manager.isRunning(users.uri), true);
      assert.strictEqual(fixture.manager.isRunning(scrape.uri), true);
      assert.strictEqual(fixture.manager.activeCount, 2);

      await assert.rejects(
        fixture.manager.run(asTextDocument(users)),
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'execution-already-running',
      );
      fixture.client.send(first.id, 'completed');
      fixture.client.send(second.id, 'completed');
      await settle();
      assert.strictEqual(fixture.manager.activeCount, 0);
    } finally {
      gate.resolve();
      await disposeFixture(fixture);
    }
  });

  test('invalidates only the saved document Session', async () => {
    const fixture = createFixture();
    const firstDocument = ferretDocument('/workspace/a.fql');
    const secondDocument = ferretDocument('/workspace/b.fql');

    try {
      const first = await fixture.manager.run(asTextDocument(firstDocument));
      const second = await fixture.manager.run(asTextDocument(secondDocument));
      fixture.client.send(first.id, 'completed');
      fixture.client.send(second.id, 'completed');
      await settle();

      fixture.documents.fire(asTextDocument(firstDocument));
      await settle();
      assert.deepStrictEqual(fixture.client.closeSessionIds, [first.sessionId]);

      const rerunFirst = await fixture.manager.run(
        asTextDocument(firstDocument),
      );
      const rerunSecond = await fixture.manager.run(
        asTextDocument(secondDocument),
      );
      assert.strictEqual(fixture.client.sessionRequests.length, 3);
      assert.notStrictEqual(rerunFirst.sessionId, first.sessionId);
      assert.strictEqual(rerunSecond.sessionId, second.sessionId);
      fixture.client.send(rerunFirst.id, 'completed');
      fixture.client.send(rerunSecond.id, 'completed');
      await settle();
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('defers saved Session closure until its active Execution closes', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');

    try {
      const active = await fixture.manager.run(asTextDocument(document));
      fixture.documents.fire(asTextDocument(document));
      await settle();
      assert.deepStrictEqual(fixture.client.closeSessionIds, []);

      fixture.client.send(active.id, 'completed');
      await settle();
      assert.deepStrictEqual(fixture.client.closeExecutionIds, [active.id]);
      assert.deepStrictEqual(fixture.client.closeSessionIds, [active.sessionId]);
      assert.ok(
        fixture.client.calls.indexOf(`close-execution:${active.id}`) <
          fixture.client.calls.indexOf(`close-session:${active.sessionId}`),
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('cleans every terminal state and keeps cancellation daemon-side', async () => {
    const fixture = createFixture();
    const documents = [
      ferretDocument('/workspace/completed.fql'),
      ferretDocument('/workspace/failed.fql'),
      ferretDocument('/workspace/cancelled.fql'),
    ];
    const finished: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) => {
      if (change.kind === 'finished') {
        finished.push(change);
      }
    });

    try {
      const handles = await Promise.all(
        documents.map((document) =>
          fixture.manager.run(asTextDocument(document)),
        ),
      );
      await fixture.manager.cancel(vscode.Uri.file('/workspace/inactive.fql'));
      assert.deepStrictEqual(fixture.client.cancelExecutionIds, []);

      await handles[2]?.cancel();
      assert.deepStrictEqual(fixture.client.cancelExecutionIds, [handles[2]?.id]);
      assert.strictEqual(fixture.manager.isRunning(documents[2]!.uri), true);

      fixture.client.send(handles[0]!.id, 'completed');
      fixture.client.send(handles[1]!.id, 'failed');
      fixture.client.send(handles[2]!.id, 'cancelled');
      await settle();
      assert.ok(documents.every(({ uri }) => !fixture.manager.isRunning(uri)));
      assert.deepStrictEqual(
        finished.map((change) =>
          change.kind === 'finished' ? change.event.kind : undefined,
        ),
        ['completed', 'failed', 'cancelled'],
      );
      assert.deepStrictEqual(
        new Set(fixture.client.closeExecutionIds),
        new Set(handles.map(({ id }) => id)),
      );
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('makes watch failure observable and releases active state', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const changes: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) =>
      changes.push(change),
    );

    try {
      const active = await fixture.manager.run(asTextDocument(document));
      const failure = new Error('watch disconnected');
      fixture.client.failWatch(active.id, failure);
      await settle();

      assert.strictEqual(fixture.manager.isRunning(document.uri), false);
      assert.deepStrictEqual(fixture.client.closeExecutionIds, [active.id]);
      const observed = changes.find(({ kind }) => kind === 'watch-failed');
      assert.ok(observed?.kind === 'watch-failed');
      assert.strictEqual(observed.error, failure);
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('logs background cleanup failures without retaining active state', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');

    try {
      const active = await fixture.manager.run(asTextDocument(document));
      fixture.client.rejectCleanup = true;
      fixture.client.send(active.id, 'completed');
      await settle();

      assert.strictEqual(fixture.manager.activeCount, 0);
      assert.ok(
        fixture.output.errors.some(({ message }) =>
          message.includes(`Closing Ferret execution "${active.id}" failed`),
        ),
      );
    } finally {
      await disposeFixture(fixture);
    }
  });

  test('discards daemon generations and rebuilds from the new workspace ID', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const changes: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) =>
      changes.push(change),
    );

    try {
      const old = await fixture.manager.run(asTextDocument(document));
      fixture.daemon.replace();
      fixture.registry.set({ id: 'workspace-2', root: '/workspace' });
      await settle();

      assert.strictEqual(fixture.manager.isRunning(document.uri), false);
      assert.deepStrictEqual(fixture.client.closeExecutionIds, []);
      assert.deepStrictEqual(fixture.client.closeSessionIds, []);
      assert.ok(
        changes.some(
          (change) =>
            change.kind === 'invalidated' &&
            change.reason === 'daemon-generation',
        ),
      );

      const fresh = await fixture.manager.run(asTextDocument(document));
      assert.notStrictEqual(fresh.sessionId, old.sessionId);
      assert.deepStrictEqual(fixture.client.sessionRequests.at(-1), {
        workspaceId: 'workspace-2',
        relativePath: 'users.fql',
      });
      fixture.client.send(fresh.id, 'completed');
      await settle();
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('abandons in-flight setup when its daemon generation is replaced', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const gate = deferred();
    fixture.client.createSessionGate = gate.promise;

    try {
      const stale = fixture.manager.run(asTextDocument(document));
      await settle();
      fixture.daemon.replace();
      fixture.registry.set({ id: 'workspace-2', root: '/workspace' });
      gate.resolve();

      await assert.rejects(
        stale,
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'workspace-unavailable',
      );
      await settle();
      assert.strictEqual(
        fixture.client.calls.includes('create-execution'),
        false,
      );
      assert.deepStrictEqual(fixture.client.closeSessionIds, []);

      fixture.client.createSessionGate = undefined;
      const fresh = await fixture.manager.run(asTextDocument(document));
      assert.strictEqual(
        fixture.client.sessionRequests.at(-1)?.workspaceId,
        'workspace-2',
      );
      fixture.client.send(fresh.id, 'completed');
      await settle();
    } finally {
      gate.resolve();
      await disposeFixture(fixture);
    }
  });

  test('invalidates active and cached state on workspace replacement', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const changes: ManagedExecutionChange[] = [];
    const listener = fixture.manager.onDidChangeExecution((change) =>
      changes.push(change),
    );

    try {
      const old = await fixture.manager.run(asTextDocument(document));
      fixture.registry.set({ id: 'workspace-2', root: '/workspace' });
      await settle();

      assert.strictEqual(fixture.manager.isRunning(document.uri), false);
      assert.ok(
        changes.some(
          (change) =>
            change.kind === 'invalidated' && change.reason === 'workspace',
        ),
      );
      assert.deepStrictEqual(fixture.client.closeExecutionIds, []);

      const fresh = await fixture.manager.run(asTextDocument(document));
      assert.notStrictEqual(fresh.sessionId, old.sessionId);
      assert.strictEqual(
        fixture.client.sessionRequests.at(-1)?.workspaceId,
        'workspace-2',
      );
      fixture.client.send(fresh.id, 'completed');
      await settle();
    } finally {
      listener.dispose();
      await disposeFixture(fixture);
    }
  });

  test('disposes listeners and resources despite unavailable cleanup RPCs', async () => {
    const fixture = createFixture();
    const document = ferretDocument('/workspace/users.fql');
    const active = await fixture.manager.run(asTextDocument(document));
    fixture.client.rejectCleanup = true;

    const firstDispose = fixture.manager.dispose();
    assert.strictEqual(fixture.manager.dispose(), firstDispose);
    await firstDispose;
    assert.strictEqual(fixture.manager.isRunning(document.uri), false);
    assert.deepStrictEqual(fixture.client.cancelExecutionIds, [active.id]);
    assert.ok(fixture.client.closeExecutionIds.includes(active.id));
    assert.ok(fixture.client.closeSessionIds.includes(active.sessionId));
    assert.deepStrictEqual(
      fixture.output.errors.map(({ message }) => message),
      [
        `Cancelling Ferret execution "${active.id}" during disposal failed`,
        `Closing Ferret execution "${active.id}" during disposal failed`,
        `Closing Ferret Session "${active.sessionId}" during disposal failed`,
      ],
    );

    const calls = fixture.client.calls.length;
    fixture.documents.fire(asTextDocument(document));
    await settle();
    assert.strictEqual(fixture.client.calls.length, calls);
    await assert.rejects(
      fixture.manager.run(asTextDocument(document)),
      (error: unknown) =>
        error instanceof ExecutionManagerError && error.code === 'disposed',
    );
    fixture.documents.dispose();
  });
});

function createFixture(): Fixture {
  const client = new FakeExecutionClient();
  const daemon = new FakeDaemon();
  const documents = new vscode.EventEmitter<vscode.TextDocument>();
  const output = new FakeOutput();
  const registry = new FerretWorkspaceRegistry();
  registry.set({ id: 'workspace-1', root: '/workspace' });
  const manager = new FerretExecutionManager(
    daemon,
    client,
    registry,
    output,
    { onDidSaveTextDocument: documents.event },
  );

  return { client, daemon, documents, manager, output, registry };
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await fixture.manager.dispose();
  fixture.documents.dispose();
}

function ferretDocument(
  path: string,
  overrides: Partial<MutableDocument> = {},
): MutableDocument {
  return {
    isDirty: false,
    isUntitled: false,
    languageId: 'ferret',
    uri: vscode.Uri.file(path),
    version: 1,
    ...overrides,
  };
}

function asTextDocument(document: MutableDocument): vscode.TextDocument {
  return document as unknown as vscode.TextDocument;
}

function execution(
  id: string,
  sessionId: string,
  status: FerretExecutionStatus,
): FerretExecution {
  return {
    id,
    sessionId,
    status,
    parameters: {},
    options: { outputContentType: 'application/json' },
    ...(status === 'completed'
      ? {
          output: {
            contentType: 'application/json',
            data: new Uint8Array([49]),
          },
        }
      : {}),
    ...(status === 'failed'
      ? {
          failure: {
            category: 'runtime' as const,
            message: 'execution failed',
            diagnostics: [],
          },
        }
      : {}),
  };
}

function executionEvent(
  executionId: string,
  sessionId: string,
  kind: FerretExecutionEvent['kind'],
): FerretExecutionEvent {
  const status: FerretExecutionStatus =
    kind === 'started' ? 'running' : kind;

  return {
    executionId,
    sequence: eventSequence(kind),
    kind,
    execution: execution(executionId, sessionId, status),
  };
}

function eventSequence(kind: FerretExecutionEvent['kind']): number {
  switch (kind) {
    case 'created':
      return 1;
    case 'started':
      return 2;
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 3;
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve: () => resolve?.(),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
