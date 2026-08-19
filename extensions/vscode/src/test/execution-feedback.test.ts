import * as assert from 'node:assert/strict';
import { posix } from 'node:path';

import * as vscode from 'vscode';

import { FerretExecutionClientError } from '../execution/errors';
import {
  ExecutionFeedbackController,
  type ExecutionFeedbackHost,
  type ExecutionFeedbackManager,
  displayExecutionPath,
  executionOutputChannelName,
  showExecutionOutputCommand,
  terminalStatusDuration,
} from '../execution/feedback';
import type {
  ManagedExecution,
  ManagedExecutionChange,
} from '../execution/manager';
import type {
  FerretDiagnostic,
  FerretExecution,
  FerretExecutionFailure,
} from '../execution/types';

class FakeManager implements ExecutionFeedbackManager {
  private readonly emitter =
    new vscode.EventEmitter<ManagedExecutionChange>();

  public activeCount = 0;
  public readonly onDidChangeExecution = this.emitter.event;

  public fire(change: ManagedExecutionChange): void {
    this.emitter.fire(change);
  }

  public dispose(): void {
    this.emitter.dispose();
  }
}

class FakeDiagnosticOutput {
  public readonly errors: Array<{
    readonly args: readonly unknown[];
    readonly message: string;
  }> = [];

  public error(message: string, ...args: unknown[]): void {
    this.errors.push({ args, message });
  }
}

class FakeOutput {
  public disposed = false;
  public readonly lines: string[] = [];
  public readonly showCalls: Array<boolean | undefined> = [];

  public appendLine(value: string): void {
    this.lines.push(value);
  }

  public show(preserveFocus?: boolean): void {
    this.showCalls.push(preserveFocus);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class FakeStatus {
  public command: string | vscode.Command | undefined;
  public disposed = false;
  public hideCalls = 0;
  public name: string | undefined;
  public showCalls = 0;
  public text = '';
  public tooltip: string | vscode.MarkdownString | undefined;
  public visible = false;

  public hide(): void {
    this.hideCalls += 1;
    this.visible = false;
  }

  public show(): void {
    this.showCalls += 1;
    this.visible = true;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

interface FakeTimer {
  readonly callback: () => void;
  cleared: boolean;
  readonly delay: number;
  readonly handle: ReturnType<typeof setTimeout>;
}

class FakeHost implements ExecutionFeedbackHost {
  private readonly commands = new Map<string, () => void>();
  private nextTimer = 1;
  public monotonic = 1_000;
  public readonly output = new FakeOutput();
  public readonly status = new FakeStatus();
  public readonly timers: FakeTimer[] = [];
  public wall = new Date(2026, 7, 18, 16, 32, 8);

  public clearTimer(handle: ReturnType<typeof setTimeout>): void {
    const timer = this.timers.find((candidate) => candidate.handle === handle);
    assert.ok(timer, 'Expected timer to exist');
    timer.cleared = true;
  }

  public createOutputChannel(name: string): vscode.OutputChannel {
    assert.strictEqual(name, executionOutputChannelName);
    return this.output as unknown as vscode.OutputChannel;
  }

  public createStatusBarItem(): vscode.StatusBarItem {
    return this.status as unknown as vscode.StatusBarItem;
  }

  public displayPath(uri: vscode.Uri): string {
    if (uri.scheme === 'file' && uri.path.startsWith('/workspace/')) {
      return `root/${posix.basename(uri.path)}`;
    }

    return uri.toString(true);
  }

  public monotonicNow(): number {
    return this.monotonic;
  }

  public registerCommand(
    command: string,
    handler: () => void,
  ): vscode.Disposable {
    assert.strictEqual(this.commands.has(command), false);
    this.commands.set(command, handler);
    return new vscode.Disposable(() => this.commands.delete(command));
  }

  public setTimer(
    callback: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    const handle = { id: this.nextTimer++ } as unknown as ReturnType<
      typeof setTimeout
    >;
    this.timers.push({ callback, cleared: false, delay, handle });
    return handle;
  }

  public wallNow(): Date {
    return this.wall;
  }

  public invoke(command: string): void {
    const handler = this.commands.get(command);
    assert.ok(handler, `Expected ${command} to be registered`);
    handler();
  }

  public fire(timer: FakeTimer): void {
    timer.callback();
  }

  public hasCommand(command: string): boolean {
    return this.commands.has(command);
  }
}

interface Fixture {
  readonly controller: ExecutionFeedbackController;
  readonly diagnosticOutput: FakeDiagnosticOutput;
  readonly host: FakeHost;
  readonly manager: FakeManager;
}

suite('Ferret execution feedback', () => {
  test('includes workspace names in multi-root relative paths', () => {
    const primary = vscode.workspace.workspaceFolders?.find(
      ({ name }) => name === 'primary',
    );
    assert.ok(primary, 'Expected the primary test workspace');

    assert.strictEqual(
      displayExecutionPath(
        vscode.Uri.joinPath(primary.uri, 'sample.fql'),
      ).replace(/\\/gu, '/'),
      'primary/sample.fql',
    );
  });

  test('renders successful scalar output and reveals with preserved focus', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');
    const running = managedExecution(uri, execution('running'), 1_000);

    try {
      fixture.manager.activeCount = 1;
      fixture.manager.fire({ kind: 'started', execution: running });
      assert.deepStrictEqual(fixture.host.output.lines, [
        '[16:32:08] Running root/query.fql',
      ]);
      assert.strictEqual(fixture.host.status.text, '$(sync~spin) Ferret');
      assert.strictEqual(fixture.host.status.visible, true);

      fixture.manager.activeCount = 0;
      fixture.host.monotonic = 1_284;
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(uri, completed('42'), 1_000),
        event: event('completed', completed('42')),
      });
      assert.deepStrictEqual(fixture.host.output.lines, [
        '[16:32:08] Running root/query.fql',
        '42\nCompleted root/query.fql in 284 ms',
      ]);
      assert.deepStrictEqual(fixture.host.output.showCalls, [true]);
      assert.strictEqual(fixture.host.status.text, '$(check) Ferret');
      assert.strictEqual(fixture.host.timers[0]?.delay, terminalStatusDuration);

      fixture.host.invoke(showExecutionOutputCommand);
      assert.deepStrictEqual(fixture.host.output.showCalls, [true, undefined]);
      fixture.host.fire(fixture.host.timers[0]!);
      assert.strictEqual(fixture.host.status.visible, false);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('pretty-prints structured output and separates later runs', () => {
    const fixture = createFixture();
    const first = vscode.Uri.file('/workspace/first.fql');
    const second = vscode.Uri.file('/workspace/second.fql');

    try {
      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(first, execution('running')),
      });
      fixture.manager.activeCount = 2;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(second, execution('running')),
      });
      assert.strictEqual(
        fixture.host.status.text,
        '$(sync~spin) Ferret (2)',
      );
      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(
          first,
          completed('{"items":[1,2]}'),
        ),
        event: event('completed', completed('{"items":[1,2]}')),
      });

      assert.deepStrictEqual(fixture.host.output.lines, [
        '[16:32:08] Running root/first.fql',
        '',
        '[16:32:08] Running root/second.fql',
        [
          '{',
          '  "items": [',
          '    1,',
          '    2',
          '  ]',
          '}',
          'Completed root/first.fql in 1 s',
        ].join('\n'),
      ]);
      assert.deepStrictEqual(fixture.host.output.showCalls, [true]);
      assert.strictEqual(fixture.host.status.text, '$(sync~spin) Ferret');
      assert.deepStrictEqual(fixture.host.timers, []);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('renders diagnostics and related one-based locations then reveals', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');
    const failure: FerretExecutionFailure = {
      category: 'runtime',
      message: 'runtime failed',
      diagnostics: [diagnostic(uri)],
    };

    try {
      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(uri, execution('running'), 900),
      });
      fixture.manager.activeCount = 0;
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(uri, failed(failure), 900),
        event: event('failed', failed(failure)),
      });

      assert.strictEqual(
        fixture.host.output.lines[1],
        [
          '[16:32:08] Execution failed: root/query.fql',
          'runtime failed',
          'root/query.fql:3:5 [FQL1001]',
          'cannot query number',
          'Related: root/helper.fql:2:2',
          'value declared here',
          'Failed in 100 ms',
        ].join('\n'),
      );
      assert.deepStrictEqual(fixture.host.output.showCalls, [true]);
      assert.strictEqual(fixture.host.status.text, '$(error) Ferret');
      fixture.host.fire(fixture.host.timers[0]!);
      assert.strictEqual(fixture.host.status.visible, false);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('renders compilation failure before start without a running entry', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');

    try {
      fixture.manager.fire({
        kind: 'start-failed',
        documentUri: uri,
        startedAt: 980,
        failure: {
          category: 'session-creation',
          message: 'Ferret session compilation failed',
          diagnostics: [diagnostic(uri)],
        },
      });

      assert.match(
        fixture.host.output.lines[0] ?? '',
        /^\[16:32:08\] Execution failed: root\/query\.fql/u,
      );
      assert.match(
        fixture.host.output.lines[0] ?? '',
        /root\/query\.fql:3:5 \[FQL1001\]/u,
      );
      assert.deepStrictEqual(fixture.host.output.showCalls, [true]);
      assert.strictEqual(fixture.host.status.text, '$(error) Ferret');
    } finally {
      disposeFixture(fixture);
    }
  });

  test('renders cancellation without treating it as failure', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');

    try {
      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(uri, execution('running'), 0),
      });
      fixture.manager.activeCount = 0;
      fixture.host.monotonic = 2_100;
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(uri, execution('cancelled'), 0),
        event: event('cancelled', execution('cancelled')),
      });

      assert.strictEqual(
        fixture.host.output.lines[1],
        '[16:32:08] Execution cancelled: root/query.fql\nCancelled after 2.1 s',
      );
      assert.deepStrictEqual(fixture.host.output.showCalls, []);
      assert.strictEqual(
        fixture.host.status.text,
        '$(circle-slash) Ferret',
      );
    } finally {
      disposeFixture(fixture);
    }
  });

  test('distinguishes watch transport failure and workspace invalidation', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');
    const running = managedExecution(uri, execution('running'), 0);
    const transport = new FerretExecutionClientError({
      code: 'daemon-unavailable',
      operation: 'watch-execution',
      message: 'raw transport detail',
    });

    try {
      fixture.manager.fire({
        kind: 'watch-failed',
        execution: running,
        error: transport,
      });
      assert.match(
        fixture.host.output.lines[0] ?? '',
        /Lost connection to the Ferret daemon while watching execution\./u,
      );
      assert.ok(
        fixture.diagnosticOutput.errors[0]?.args.includes(transport),
      );

      fixture.manager.fire({
        kind: 'invalidated',
        execution: running,
        reason: 'workspace',
      });
      assert.match(
        fixture.host.output.lines[1] ?? '',
        /workspace changed before a terminal state was reported/u,
      );
      assert.deepStrictEqual(fixture.host.output.showCalls, [true, true]);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('uses active count first and prevents stale timers from winning', () => {
    const fixture = createFixture();
    const first = vscode.Uri.file('/workspace/first.fql');
    const second = vscode.Uri.file('/workspace/second.fql');

    try {
      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(first, execution('running')),
      });
      fixture.manager.activeCount = 0;
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(first, completed('1')),
        event: event('completed', completed('1')),
      });
      const stale = fixture.host.timers[0]!;

      fixture.manager.activeCount = 1;
      fixture.manager.fire({
        kind: 'started',
        execution: managedExecution(second, execution('running')),
      });
      assert.strictEqual(stale.cleared, true);
      assert.strictEqual(fixture.host.status.text, '$(sync~spin) Ferret');

      fixture.host.fire(stale);
      assert.strictEqual(fixture.host.status.text, '$(sync~spin) Ferret');
      assert.strictEqual(fixture.host.status.visible, true);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('falls back safely when a completed result cannot be rendered', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');
    const terminal = execution('completed', {
      output: {
        contentType: 'application/octet-stream',
        data: new Uint8Array([1, 2, 3]),
      },
    });

    try {
      fixture.manager.fire({
        kind: 'finished',
        execution: managedExecution(uri, terminal),
        event: event('completed', terminal),
      });

      assert.match(
        fixture.host.output.lines[0] ?? '',
        /^<result could not be rendered>/u,
      );
      assert.strictEqual(fixture.diagnosticOutput.errors.length, 1);
      assert.deepStrictEqual(fixture.host.output.showCalls, [true]);
    } finally {
      disposeFixture(fixture);
    }
  });

  test('disposes output, status, command, subscription, and pending timer', () => {
    const fixture = createFixture();
    const uri = vscode.Uri.file('/workspace/query.fql');
    fixture.manager.fire({
      kind: 'finished',
      execution: managedExecution(uri, completed('1')),
      event: event('completed', completed('1')),
    });
    const timer = fixture.host.timers[0]!;

    fixture.controller.dispose();
    fixture.controller.dispose();
    assert.strictEqual(timer.cleared, true);
    assert.strictEqual(fixture.host.output.disposed, true);
    assert.strictEqual(fixture.host.status.disposed, true);
    assert.strictEqual(fixture.host.hasCommand(showExecutionOutputCommand), false);

    const lineCount = fixture.host.output.lines.length;
    fixture.manager.fire({
      kind: 'started',
      execution: managedExecution(uri, execution('running')),
    });
    fixture.host.fire(timer);
    assert.strictEqual(fixture.host.output.lines.length, lineCount);
    assert.strictEqual(fixture.host.status.visible, false);
    fixture.manager.dispose();
  });
});

function createFixture(): Fixture {
  const manager = new FakeManager();
  const diagnosticOutput = new FakeDiagnosticOutput();
  const host = new FakeHost();
  const controller = new ExecutionFeedbackController(
    manager,
    diagnosticOutput,
    host,
  );

  return { controller, diagnosticOutput, host, manager };
}

function disposeFixture(fixture: Fixture): void {
  fixture.controller.dispose();
  fixture.manager.dispose();
}

function managedExecution(
  documentUri: vscode.Uri,
  value: FerretExecution,
  startedAt = 0,
): ManagedExecution {
  return {
    id: value.id,
    sessionId: value.sessionId,
    documentUri,
    startedAt,
    execution: value,
    cancel: () => Promise.resolve(),
  };
}

function execution(
  status: FerretExecution['status'],
  overrides: Partial<FerretExecution> = {},
): FerretExecution {
  return {
    id: 'execution-1',
    sessionId: 'session-1',
    status,
    parameters: {},
    options: { outputContentType: 'application/json' },
    ...overrides,
  };
}

function completed(value: string): FerretExecution {
  return execution('completed', {
    output: {
      contentType: 'application/json',
      data: new TextEncoder().encode(value),
    },
  });
}

function failed(failure: FerretExecutionFailure): FerretExecution {
  return execution('failed', { failure });
}

function event(
  kind: 'completed' | 'failed' | 'cancelled',
  value: FerretExecution,
) {
  return {
    executionId: value.id,
    sequence: 3,
    kind,
    execution: value,
  } as const;
}

function diagnostic(uri: vscode.Uri): FerretDiagnostic {
  return {
    uri: uri.toString(),
    range: {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 9 },
    },
    severity: 'error',
    code: 'FQL1001',
    source: 'ferret',
    message: 'cannot query number',
    relatedInformation: [
      {
        uri: vscode.Uri.file('/workspace/helper.fql').toString(),
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 5 },
        },
        message: 'value declared here',
      },
    ],
  };
}
