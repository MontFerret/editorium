import { RuntimeCoordinator } from '../runtime/coordinator';
import type { DaemonConnection } from '../daemon/types';
import * as assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';
import { FerretServerController } from '../controller';

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

  public async prepareWorkspaces(): Promise<void> {}

  public requireConnection() {
    return { signal: this.generation.signal, apiVersion: { major: 1, minor: 3 } };
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
  public executionGate?: Promise<void>;
  public startGate?: Promise<void>;
  public closeExecutionGate?: Promise<void>;
  public createSessionGate: Promise<void> | undefined;
  public createSessionError: Error | undefined;
  public rejectCleanup = false;
  public closeSessionGate?: Promise<void>;
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
      runtimeName: '',
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
    await this.executionGate;
    const id = `execution-${++this.executionCount}`;
    this.executionSessions.set(id, sessionId);

    return execution(id, sessionId, 'created');
  }

  public async runExecution(executionId: string): Promise<FerretExecution> {
    this.calls.push('run-execution');
    await this.startGate;
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

    this.watches.get(executionId)?.send(executionEvent(executionId, this.requireSession(executionId), 'cancelled'));
    return execution(
      executionId,
      this.requireSession(executionId),
      'cancelled',
    );
  }

  public async closeExecution(executionId: string): Promise<void> {
    this.calls.push(`close-execution:${executionId}`);
    this.closeExecutionIds.push(executionId);
    await this.closeExecutionGate;
    if (this.rejectCleanup) {
      throw new Error('close execution unavailable');
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    await this.closeSessionGate;
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
  readonly runtime: RuntimeCoordinator;
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
        { parameters },
      );
      const afterStart = performance.now();

      assert.deepStrictEqual(fixture.client.calls.slice(0, 4), [
        'create-session',
        'create-execution',
        'watch-execution',
        'run-execution',
      ]);
      assert.deepStrictEqual(fixture.client.executionParameters[0], parameters);
      assert.strictEqual(first.execution.status, 'running');
      assert.ok(first.startedAt >= beforeStart);
      assert.ok(first.startedAt <= afterStart);
      assert.strictEqual(fixture.manager.getActive(document.uri), first);
      assert.strictEqual(fixture.manager.activeCount, 1);
      assert.deepStrictEqual(changes.map(event => event.kind), ['preparing', 'runtime-resolved', 'started', 'preparation-ended']);

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

  test('holds admission through late acquisition, cancellation, and delayed close', async () => {
    const fixture = createFixture();
    const document = asTextDocument(ferretDocument('/workspace/pending.fql'));
    const acquire = deferred();
    const close = deferred();
    fixture.client.createSessionGate = acquire.promise;
    fixture.client.closeSessionGate = close.promise;
    const run = fixture.manager.run(document);
    await settle();
    await assert.rejects(fixture.runtime.reload(), /finish/);
    const cancel = fixture.manager.cancel(document.uri);
    acquire.resolve();
    await settle();
    await assert.rejects(fixture.runtime.reload(), /finish/);
    const rejected = assert.rejects(run, /cancelled/);
    close.resolve();
    await Promise.all([rejected, cancel]);
    assert.deepEqual(fixture.client.closeSessionIds, ['session-1']);
    assert.ok(!fixture.client.calls.includes('create-execution'));
    await fixture.runtime.reload();
    await disposeFixture(fixture);
  });

  for (const hung of [true, false]) {
    test(`deactivation settles ${hung ? 'an acquisition blocked until daemon abort' : 'a session arriving during graceful cleanup'}`, async () => {
      const fixture = createFixture();
      const entered = deferred(), acquire = deferred(), debug = deferred();
      const signal = fixture.daemon.requireConnection().signal;
      const create = fixture.client.createSession.bind(fixture.client);
      fixture.client.createSession = async (...args) => {
        entered.resolve();
        if (hung) {
          await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } else {
          await acquire.promise;
        }
        return create(...args);
      };
      const controller = new FerretServerController({
        start: async () => {}, stop: async () => {}, restart: async () => {},
      }, { restartExecutable: async () => {}, shutdown: () => fixture.runtime.shutdown() }, () => 'ferretd');
      const run = assert.rejects(fixture.manager.run(asTextDocument(ferretDocument('/workspace/late.fql'))));
      await entered.promise;
      fixture.runtime.closeAdmissions();
      const stopped = controller.stop(fixture.manager.dispose(), debug.promise, hung ? 0 : 1500);
      assert.throws(() => fixture.runtime.admitDebug(), /shutting down/);
      acquire.resolve();
      await run;
      debug.resolve();
      await stopped;
      assert.equal(signal.aborted, true);
      assert.deepEqual(fixture.client.closeSessionIds, hung ? [] : ['session-1']);
      assert.ok(!fixture.client.calls.includes('create-execution'));
      fixture.documents.dispose();
    });
  }

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

  test('keeps the admitted snapshot when the file is edited before the start acknowledgment', async () => {
    const fixture = createFixture(), start = deferred();
    const document = ferretDocument('/workspace/query.fql');
    fixture.client.startGate = start.promise;
    try {
      const running = fixture.manager.run(asTextDocument(document));
      await settle();
      assert.ok(fixture.client.calls.includes('run-execution'));
      document.version++;
      document.isDirty = true;
      start.resolve();
      const handle = await running;
      fixture.client.send(handle.id, 'completed');
      await settle();
      assert.deepEqual(fixture.client.cancelExecutionIds, []);
    } finally { start.resolve(); await disposeFixture(fixture); }
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
      assert.deepStrictEqual(changes.map(event => event.kind), ['preparing', 'runtime-resolved', 'start-failed', 'preparation-ended']);
      const change = changes[2];
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

  test('cancelling a discovery waiter preserves its sibling and snapshots caller-owned parameters', async () => {
    const entered = deferred(), release = deferred();
    let discoveries = 0;
    const fixture = createFixture(async () => {
      discoveries++;
      entered.resolve();
      await release.promise;
      return { defaultRuntime: 'App', runtimes: [{ name: 'App', label: 'App', provider: 'wire' }] };
    });
    const a = asTextDocument(ferretDocument('/workspace/a.fql')), b = asTextDocument(ferretDocument('/workspace/b.fql'));
    try {
      const first = assert.rejects(fixture.manager.run(a), /cancelled/);
      const value = { typed: [null, true, 42] };
      const second = fixture.manager.run(b, { parameters: { value } });
      await entered.promise;
      await fixture.manager.cancel(a.uri);
      await first;
      assert.equal(fixture.client.sessionRequests.length, 0);
      value.typed.length = 0;
      release.resolve();
      const handle = await second;
      assert.equal(discoveries, 1);
      assert.deepEqual(fixture.client.executionParameters, [{ value: { typed: [null, true, 42] } }]);
      fixture.client.send(handle.id, 'completed');
      await settle();
      assert.deepEqual(fixture.client.closeSessionIds, [handle.sessionId]);
    } finally { release.resolve(); await disposeFixture(fixture); }
  });

  for (const stage of ['create-execution', 'run-execution'] as const) {
    test(`stops during ${stage} and holds Wire admission through ordered cleanup`, async () => {
      const fixture = createFixture(), gate = deferred(), close = deferred();
      const document = asTextDocument(ferretDocument('/workspace/query.fql'));
      if (stage === 'create-execution') fixture.client.executionGate = gate.promise;
      else fixture.client.startGate = gate.promise;
      fixture.client.closeSessionGate = close.promise;
      try {
        const run = assert.rejects(fixture.manager.run(document, { runtimeName: 'App' }), /cancelled/);
        await settle();
        assert.ok(fixture.client.calls.includes(stage));
        const stop = fixture.manager.cancel(document.uri);
        gate.resolve();
        await settle();
        assert.deepEqual(fixture.client.closeExecutionIds, ['execution-1']);
        assert.deepEqual(fixture.client.cancelExecutionIds, ['execution-1']);
        await assert.rejects(fixture.runtime.reload(), /finish/);
        close.resolve();
        await Promise.all([stop, run]);
        assert.deepEqual(fixture.client.closeSessionIds, ['session-1']);
        await fixture.runtime.reload();
      } finally { gate.resolve(); close.resolve(); await disposeFixture(fixture); }
    });
  }

  test('failed Wire setup releases the compiled plan and retains the acquisition failure', async () => {
    const fixture = createFixture();
    const document = asTextDocument(ferretDocument('/workspace/setup.fql'));
    const failure = new Error('execution rejected');
    fixture.client.runError = failure;
    fixture.client.rejectCleanup = true;
    try {
      await assert.rejects(fixture.manager.run(document, { runtimeName: 'App' }), error => error === failure);
      assert.deepEqual(fixture.client.closeExecutionIds, ['execution-1']);
      assert.deepEqual(fixture.client.closeSessionIds, ['session-1']);
      const cleanup = fixture.output.errors.map(({ error }) => String(error)).join(' ');
      assert.match(cleanup, /close execution unavailable/);
      assert.match(cleanup, /close session unavailable/);
      await fixture.runtime.reload();
    } finally { await disposeFixture(fixture); }
  });

  test('binding loss fails one Wire Run, releases its Session, and allows a fresh explicit Run', async () => {
    const fixture = createFixture(), close = deferred();
    const document = asTextDocument(ferretDocument('/workspace/a.fql'));
    try {
      const first = await fixture.manager.run(document, { runtimeName: 'App' });
      fixture.client.closeExecutionGate = close.promise;
      fixture.client.failWatch(first.id, new Error('binding lost'));
      await settle();
      assert.equal(fixture.client.sessionRequests.length, 1);
      assert.deepEqual(fixture.client.closeSessionIds, []);
      await assert.rejects(fixture.runtime.reload(), /finish/);
      close.resolve();
      await settle();
      assert.deepEqual(fixture.client.closeSessionIds, [first.sessionId]);
      const second = await fixture.manager.run(document, { runtimeName: 'App' });
      assert.notEqual(first.sessionId, second.sessionId);
      await second.cancel();
      assert.deepEqual(fixture.client.closeSessionIds, [first.sessionId, second.sessionId]);
    } finally { close.resolve(); await disposeFixture(fixture); }
  });

  test('old cleanup cannot send colliding IDs to a replacement daemon', async () => {
    const fresh = new FakeExecutionClient(), close = deferred();
    let replaced = false;
    const fixture = createFixture(undefined, (_signal, original) => replaced ? fresh : original);
    const document = asTextDocument(ferretDocument('/workspace/a.fql'));
    try {
      const first = await fixture.manager.run(document, { runtimeName: 'App' });
      fixture.client.closeExecutionGate = close.promise;
      fixture.client.send(first.id, 'completed');
      await settle();
      fixture.daemon.replace();
      replaced = true;
      const second = await fixture.manager.run(document, { runtimeName: 'App' });
      assert.equal(first.id, second.id);
      assert.equal(first.sessionId, second.sessionId);
      close.resolve();
      await settle();
      assert.deepEqual(fresh.closeExecutionIds, []);
      assert.deepEqual(fresh.closeSessionIds, []);
      assert.ok(fixture.output.errors.some(({ error }) => String(error).includes('unconfirmed')));
      await second.cancel();
      assert.deepEqual(fresh.closeSessionIds, [second.sessionId]);
    } finally { close.resolve(); await disposeFixture(fixture); }
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
      assert.strictEqual(fixture.manager.isRunning(documents[2]!.uri), false);

      fixture.client.send(handles[0]!.id, 'completed');
      fixture.client.send(handles[1]!.id, 'failed');
      fixture.client.send(handles[2]!.id, 'cancelled');
      await settle();
      assert.ok(documents.every(({ uri }) => !fixture.manager.isRunning(uri)));
      assert.deepStrictEqual(
        finished.map((change) =>
          change.kind === 'finished' ? change.event.kind : undefined,
        ),
        ['cancelled', 'completed', 'failed'],
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
          message.includes('Cleaning up Ferret Run'),
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
      assert.deepStrictEqual(fixture.client.closeExecutionIds, [old.id]);

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
    const failures = fixture.output.errors.map(({ error }) => String(error)).join(' ');
    for (const message of ['cancel unavailable', 'close execution unavailable', 'close session unavailable']) {
      assert.ok(failures.includes(message));
    }

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

function createFixture(
  discover = async () => ({
    defaultRuntime: 'local',
    runtimes: [
      { name: 'local', label: 'Local', provider: 'native' },
      { name: 'App', label: 'App', provider: 'wire' },
    ],
  }),
  clientFor?: (generation: AbortSignal, initial: FakeExecutionClient) => FakeExecutionClient,
): Fixture {
  const client = new FakeExecutionClient();
  const daemon = new FakeDaemon();
  const documents = new vscode.EventEmitter<vscode.TextDocument>();
  const output = new FakeOutput();
  const registry = new FerretWorkspaceRegistry();
  registry.set({ id: 'workspace-1', root: '/workspace' });
  const runtime = new RuntimeCoordinator({
    start: async () => {}, stop: async () => { daemon.replace(); },
    requireConnection: () => daemon.requireConnection() as DaemonConnection,
  }, { entered: '' }, () => '', discover);
  const manager = new FerretExecutionManager(
    daemon,
    connection => clientFor?.(connection.signal, client) ?? client,
    registry,
    output,
    runtime,
    { onDidSaveTextDocument: documents.event },
  );

  return { runtime, client, daemon, documents, manager, output, registry };
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
