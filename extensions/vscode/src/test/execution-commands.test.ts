import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { DaemonError } from '../daemon/errors';
import {
  cancelExecutionCommand,
  ExecutionCommandController,
  type ExecutionCommandHost,
  type ExecutionCommandManager,
  executionRunningContext,
  runFileCommand,
} from '../execution/commands';
import {
  ExecutionManagerError,
  FerretExecutionClientError,
} from '../execution/errors';
import type {
  ManagedExecution,
  ManagedExecutionChange,
} from '../execution/manager';
import type {
  FerretExecution,
  FerretExecutionEvent,
} from '../execution/types';

const saveAndRunAction = 'Save and Run';
const cancelRunAction = 'Cancel';

interface MutableDocument {
  isDirty: boolean;
  isUntitled: boolean;
  languageId: string;
  readonly saveCalls: number;
  uri: vscode.Uri;
  version: number;

  save(): Thenable<boolean>;
}

class FakeOutput {
  public readonly errors: Array<{
    readonly args: readonly unknown[];
    readonly message: string;
  }> = [];

  public error(message: string, ...args: unknown[]): void {
    this.errors.push({ args, message });
  }
}

class FakeManager implements ExecutionCommandManager {
  private readonly changeEmitter =
    new vscode.EventEmitter<ManagedExecutionChange>();
  private readonly running = new Set<string>();

  public readonly cancelCalls: vscode.Uri[] = [];
  public cancelError: unknown;
  public readonly onDidChangeExecution = this.changeEmitter.event;
  public onRun: (() => void) | undefined;
  public readonly runCalls: vscode.TextDocument[] = [];
  public runError: unknown;

  public async cancel(documentUri: vscode.Uri): Promise<void> {
    this.cancelCalls.push(documentUri);
    if (this.cancelError !== undefined) {
      throw this.cancelError;
    }
  }

  public isRunning(documentUri: vscode.Uri): boolean {
    return this.running.has(documentUri.toString());
  }

  public async run(document: vscode.TextDocument): Promise<unknown> {
    this.onRun?.();
    this.runCalls.push(document);
    if (this.runError !== undefined) {
      throw this.runError;
    }

    return {};
  }

  public started(documentUri: vscode.Uri): void {
    this.running.add(documentUri.toString());
    this.changeEmitter.fire({
      kind: 'started',
      execution: managedExecution(documentUri),
    });
  }

  public changed(documentUri: vscode.Uri): void {
    this.changeEmitter.fire({
      kind: 'changed',
      execution: managedExecution(documentUri),
      event: executionEvent('started'),
    });
  }

  public finished(documentUri: vscode.Uri): void {
    this.running.delete(documentUri.toString());
    this.changeEmitter.fire({
      kind: 'finished',
      execution: managedExecution(documentUri),
      event: executionEvent('completed'),
    });
  }

  public invalidated(documentUri: vscode.Uri): void {
    this.running.delete(documentUri.toString());
    this.changeEmitter.fire({
      kind: 'invalidated',
      execution: managedExecution(documentUri),
      reason: 'daemon-generation',
    });
  }

  public watchFailed(documentUri: vscode.Uri, error: unknown): void {
    this.running.delete(documentUri.toString());
    this.changeEmitter.fire({
      kind: 'watch-failed',
      execution: managedExecution(documentUri),
      error,
    });
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

class FakeHost implements ExecutionCommandHost {
  private readonly activeEditorEmitter = new vscode.EventEmitter<void>();
  private readonly handlers = new Map<string, () => Promise<void>>();

  public activeDocument: vscode.TextDocument | undefined;
  public readonly context = new Map<string, boolean>();
  public readonly contextUpdates: Array<{
    readonly key: string;
    readonly value: boolean;
  }> = [];
  public readonly errorMessages: string[] = [];
  public informationError: unknown;
  public readonly informationMessages: Array<{
    readonly items: readonly string[];
    readonly message: string;
  }> = [];
  public nextInformationSelection: string | undefined;

  public getActiveDocument(): vscode.TextDocument | undefined {
    return this.activeDocument;
  }

  public onDidChangeActiveEditor(listener: () => void): vscode.Disposable {
    return this.activeEditorEmitter.event(listener);
  }

  public registerCommand(
    command: string,
    handler: () => Promise<void>,
  ): vscode.Disposable {
    assert.strictEqual(this.handlers.has(command), false);
    this.handlers.set(command, handler);

    return new vscode.Disposable(() => this.handlers.delete(command));
  }

  public setContext(key: string, value: boolean): Thenable<unknown> {
    this.context.set(key, value);
    this.contextUpdates.push({ key, value });
    return Promise.resolve();
  }

  public showErrorMessage(message: string): Thenable<unknown> {
    this.errorMessages.push(message);
    return Promise.resolve(undefined);
  }

  public showInformationMessage(
    message: string,
    ...items: readonly string[]
  ): Thenable<string | undefined> {
    this.informationMessages.push({ items, message });
    if (this.informationError !== undefined) {
      return Promise.reject(this.informationError);
    }

    return Promise.resolve(this.nextInformationSelection);
  }

  public async invoke(command: string): Promise<void> {
    const handler = this.handlers.get(command);
    assert.ok(handler, `Expected ${command} to be registered`);
    await handler();
  }

  public setActiveDocument(document: vscode.TextDocument | undefined): void {
    this.activeDocument = document;
    this.activeEditorEmitter.fire();
  }

  public hasCommand(command: string): boolean {
    return this.handlers.has(command);
  }

  public dispose(): void {
    this.activeEditorEmitter.dispose();
  }
}

interface Fixture {
  readonly controller: ExecutionCommandController;
  readonly host: FakeHost;
  readonly manager: FakeManager;
  readonly output: FakeOutput;
}

suite('Ferret execution commands', () => {
  test('runs a saved Ferret document exactly once', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);

    try {
      await fixture.host.invoke(runFileCommand);

      assert.deepStrictEqual(fixture.manager.runCalls, [document]);
      assert.strictEqual(document.saveCalls, 0);
      assert.deepStrictEqual(fixture.host.errorMessages, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('rejects missing and unsupported active documents before the manager', async () => {
    const fixture = createFixture();
    const documents = [
      ferretDocument('/workspace/plain.fql', { languageId: 'plaintext' }),
      ferretDocument('/workspace/untitled.fql', { isUntitled: true }),
      ferretDocument('/workspace/remote.fql', {
        uri: vscode.Uri.parse('untitled:remote.fql'),
      }),
    ];

    try {
      await fixture.host.invoke(runFileCommand);
      for (const document of documents) {
        fixture.host.setActiveDocument(asTextDocument(document));
        await fixture.host.invoke(runFileCommand);
      }

      assert.deepStrictEqual(fixture.manager.runCalls, []);
      assert.deepStrictEqual(
        fixture.host.errorMessages,
        Array.from(
          { length: documents.length + 1 },
          () => 'The current editor cannot be executed by Ferret.',
        ),
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('saves a dirty document before running it', async () => {
    const events: string[] = [];
    const saveGate = deferred();
    const document = ferretDocument('/workspace/query.fql', {
      events,
      isDirty: true,
      saveGate: saveGate.promise,
    });
    const fixture = createFixture(document);
    fixture.host.nextInformationSelection = saveAndRunAction;
    fixture.manager.onRun = () => events.push('run');

    try {
      const running = fixture.host.invoke(runFileCommand);
      await settle();
      assert.deepStrictEqual(events, ['save']);
      assert.deepStrictEqual(fixture.manager.runCalls, []);

      saveGate.resolve();
      await running;
      assert.deepStrictEqual(events, ['save', 'run']);
      assert.deepStrictEqual(fixture.manager.runCalls, [document]);
      assert.deepStrictEqual(fixture.host.informationMessages, [
        {
          message: 'Save the document before running Ferret?',
          items: [saveAndRunAction, cancelRunAction],
        },
      ]);
    } finally {
      saveGate.resolve();
      disposeFixture(fixture);
    }
  });

  test('does not save or run when Save and Run is cancelled or dismissed', async () => {
    const document = ferretDocument('/workspace/query.fql', {
      isDirty: true,
    });
    const fixture = createFixture(document);

    try {
      fixture.host.nextInformationSelection = cancelRunAction;
      await fixture.host.invoke(runFileCommand);
      fixture.host.nextInformationSelection = undefined;
      await fixture.host.invoke(runFileCommand);

      assert.strictEqual(document.saveCalls, 0);
      assert.deepStrictEqual(fixture.manager.runCalls, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('does not run after a failed, rejected, or incomplete save', async () => {
    const fixture = createFixture();
    fixture.host.nextInformationSelection = saveAndRunAction;
    const saveError = new Error('raw save failure');
    const documents = [
      ferretDocument('/workspace/false.fql', {
        isDirty: true,
        saveResult: false,
      }),
      ferretDocument('/workspace/rejected.fql', {
        isDirty: true,
        saveError,
      }),
      ferretDocument('/workspace/still-dirty.fql', {
        isDirty: true,
        remainDirty: true,
      }),
    ];

    try {
      for (const document of documents) {
        fixture.host.setActiveDocument(asTextDocument(document));
        await fixture.host.invoke(runFileCommand);
      }

      assert.deepStrictEqual(fixture.manager.runCalls, []);
      assert.deepStrictEqual(
        fixture.host.errorMessages,
        documents.map(
          () => 'The Ferret file could not be saved, so it was not run.',
        ),
      );
      assert.ok(
        fixture.output.errors.some(({ args }) => args.includes(saveError)),
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('maps duplicate runs to a concise informational message', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);
    fixture.manager.runError = new ExecutionManagerError(
      'execution-already-running',
      'raw manager duplicate detail',
      document.uri.toString(),
    );

    try {
      await fixture.host.invoke(runFileCommand);

      assert.strictEqual(fixture.manager.runCalls.length, 1);
      assert.deepStrictEqual(fixture.host.informationMessages, [
        {
          message: 'This Ferret file is already running.',
          items: [],
        },
      ]);
      assert.deepStrictEqual(fixture.host.errorMessages, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('maps manager document races and workspace failures safely', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);

    try {
      fixture.manager.runError = new ExecutionManagerError(
        'document-dirty',
        'raw dirty detail',
        document.uri.toString(),
      );
      await fixture.host.invoke(runFileCommand);
      assert.strictEqual(
        fixture.host.errorMessages.at(-1),
        'This Ferret file changed before execution started. Save it and run again.',
      );

      const workspaceFailure = new ExecutionManagerError(
        'workspace-unavailable',
        'The document does not belong to an open Ferret workspace.',
        document.uri.toString(),
      );
      fixture.manager.runError = workspaceFailure;
      await fixture.host.invoke(runFileCommand);
      assert.strictEqual(
        fixture.host.errorMessages.at(-1),
        workspaceFailure.message,
      );
      assert.ok(
        fixture.output.errors.some(({ args }) =>
          args.includes(workspaceFailure),
        ),
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('sanitizes execution failures while logging the complete error', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);
    const rawTransport = { details: 'raw gRPC dump' };
    const failure = new FerretExecutionClientError({
      code: 'execution-rejected',
      operation: 'run-execution',
      message: 'raw transport-shaped message',
      cause: rawTransport,
    });
    fixture.manager.runError = failure;

    try {
      await fixture.host.invoke(runFileCommand);

      assert.deepStrictEqual(fixture.host.errorMessages, [
        'Ferret could not run the current file.',
      ]);
      assert.strictEqual(
        fixture.host.errorMessages.some((message) =>
          message.includes(rawTransport.details),
        ),
        false,
      );
      assert.ok(
        fixture.output.errors.some(({ args }) => args.includes(failure)),
      );

      const compilationFailure = new FerretExecutionClientError({
        code: 'compilation-failed',
        operation: 'create-session',
        message: 'Ferret session compilation failed',
      });
      fixture.manager.runError = compilationFailure;
      const notificationCount = fixture.host.errorMessages.length;
      await fixture.host.invoke(runFileCommand);
      assert.strictEqual(
        fixture.host.errorMessages.length,
        notificationCount,
      );
      assert.ok(
        fixture.output.errors.some(({ args }) =>
          args.includes(compilationFailure),
        ),
      );

      fixture.manager.runError = new DaemonError(
        'unavailable',
        'raw daemon failure',
      );
      await fixture.host.invoke(runFileCommand);
      assert.strictEqual(
        fixture.host.errorMessages.at(-1),
        'Ferret daemon is unavailable.',
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('delegates active and inactive cancellation quietly to the manager', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);

    try {
      fixture.manager.started(document.uri);
      await fixture.host.invoke(cancelExecutionCommand);
      fixture.manager.finished(document.uri);
      await fixture.host.invoke(cancelExecutionCommand);

      assert.deepStrictEqual(fixture.manager.cancelCalls, [
        document.uri,
        document.uri,
      ]);
      assert.deepStrictEqual(fixture.host.errorMessages, []);
      assert.deepStrictEqual(fixture.host.informationMessages, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('sanitizes cancellation failures', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);
    const failure = new FerretExecutionClientError({
      code: 'protocol',
      operation: 'cancel-execution',
      message: 'raw protocol error',
    });
    fixture.manager.cancelError = failure;

    try {
      await fixture.host.invoke(cancelExecutionCommand);

      assert.deepStrictEqual(fixture.host.errorMessages, [
        'Ferret could not cancel the current execution.',
      ]);
      assert.ok(
        fixture.output.errors.some(({ args }) => args.includes(failure)),
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('tracks execution state only for the active document', async () => {
    const first = ferretDocument('/workspace/first.fql');
    const second = ferretDocument('/workspace/second.fql');
    const fixture = createFixture(first);

    try {
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        false,
      );

      fixture.manager.started(second.uri);
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        false,
      );

      fixture.host.setActiveDocument(asTextDocument(second));
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        true,
      );

      fixture.manager.changed(second.uri);
      fixture.manager.finished(second.uri);
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        false,
      );

      fixture.host.setActiveDocument(asTextDocument(first));
      fixture.manager.started(first.uri);
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        true,
      );

      fixture.manager.invalidated(first.uri);
      await settle();
      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        false,
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('returns to idle and leaves watch feedback to the feedback controller', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);
    const failure = new Error('raw watch failure');

    try {
      fixture.manager.started(document.uri);
      fixture.manager.watchFailed(document.uri, failure);
      await settle();

      assert.strictEqual(
        fixture.host.context.get(executionRunningContext),
        false,
      );
      assert.deepStrictEqual(fixture.host.errorMessages, []);
      assert.deepStrictEqual(fixture.output.errors, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('registers both commands and disposes commands and subscriptions', async () => {
    const document = ferretDocument('/workspace/query.fql');
    const fixture = createFixture(document);

    assert.strictEqual(fixture.host.hasCommand(runFileCommand), true);
    assert.strictEqual(fixture.host.hasCommand(cancelExecutionCommand), true);
    fixture.controller.dispose();
    fixture.controller.dispose();
    await settle();
    assert.strictEqual(fixture.host.hasCommand(runFileCommand), false);
    assert.strictEqual(fixture.host.hasCommand(cancelExecutionCommand), false);
    assert.strictEqual(
      fixture.host.context.get(executionRunningContext),
      false,
    );

    const updateCount = fixture.host.contextUpdates.length;
    const notificationCount = fixture.host.errorMessages.length;
    fixture.host.setActiveDocument(undefined);
    fixture.manager.watchFailed(document.uri, new Error('after disposal'));
    await settle();
    assert.strictEqual(fixture.host.contextUpdates.length, updateCount);
    assert.strictEqual(fixture.host.errorMessages.length, notificationCount);

    disposeFixture(fixture);
  });
});

function createFixture(document?: MutableDocument): Fixture {
  const host = new FakeHost();
  host.activeDocument =
    document === undefined ? undefined : asTextDocument(document);
  const manager = new FakeManager();
  const output = new FakeOutput();
  const controller = new ExecutionCommandController(manager, output, host);

  return { controller, host, manager, output };
}

function disposeFixture(fixture: Fixture): void {
  fixture.controller.dispose();
  fixture.host.dispose();
  fixture.manager.dispose();
}

function ferretDocument(
  path: string,
  overrides: {
    readonly events?: string[];
    readonly isDirty?: boolean;
    readonly isUntitled?: boolean;
    readonly languageId?: string;
    readonly remainDirty?: boolean;
    readonly saveError?: unknown;
    readonly saveGate?: Promise<void>;
    readonly saveResult?: boolean;
    readonly uri?: vscode.Uri;
  } = {},
): MutableDocument {
  let saveCalls = 0;
  const document: MutableDocument = {
    isDirty: overrides.isDirty ?? false,
    isUntitled: overrides.isUntitled ?? false,
    languageId: overrides.languageId ?? 'ferret',
    get saveCalls() {
      return saveCalls;
    },
    uri: overrides.uri ?? vscode.Uri.file(path),
    version: 1,
    async save() {
      saveCalls += 1;
      overrides.events?.push('save');
      await overrides.saveGate;
      if (overrides.saveError !== undefined) {
        throw overrides.saveError;
      }

      const saved = overrides.saveResult ?? true;
      if (saved && overrides.remainDirty !== true) {
        document.isDirty = false;
      }
      return saved;
    },
  };

  return document;
}

function asTextDocument(document: MutableDocument): vscode.TextDocument {
  return document as unknown as vscode.TextDocument;
}

function managedExecution(documentUri: vscode.Uri): ManagedExecution {
  return {
    id: 'execution-1',
    sessionId: 'session-1',
    documentUri,
    startedAt: 1,
    execution: execution('running'),
    cancel: () => Promise.resolve(),
  };
}

function executionEvent(
  kind: FerretExecutionEvent['kind'],
): FerretExecutionEvent {
  return {
    executionId: 'execution-1',
    sequence: 1,
    kind,
    execution: execution(kind === 'started' ? 'running' : kind),
  };
}

function execution(
  status: FerretExecution['status'],
): FerretExecution {
  return {
    id: 'execution-1',
    sessionId: 'session-1',
    status,
    parameters: {},
    options: { outputContentType: 'application/json' },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
