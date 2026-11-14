import { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { withholdSessionReply } from './withheld-session';
import { WireHost } from './wire-host';
import { readRunOptions, type RunOptions } from '../execution/run-options';
import { RuntimeCoordinator } from '../runtime/coordinator';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import * as vscode from 'vscode';

import { DaemonError } from '../daemon/errors';
import {
  createDaemonEndpoint,
  type DaemonEndpoint,
} from '../daemon/endpoint';
import {
  DaemonController,
  type DaemonProcess,
} from '../daemon/manager';
import { FerretExecutionClient } from '../execution/client';
import {
  ExecutionCommandController,
  type ExecutionCommandHost,
  runFileCommand,
} from '../execution/commands';
import {
  ExecutionManagerError,
  FerretExecutionClientError,
} from '../execution/errors';
import {
  ExecutionFeedbackController,
  type ExecutionFeedbackHost,
  executionOutputChannelName,
} from '../execution/feedback';
import {
  FerretExecutionManager,
  type ExecutionClient,
  type ManagedExecution,
  type ManagedExecutionChange,
} from '../execution/manager';
import type {
  FerretDiagnostic,
  FerretExecution,
  FerretExecutionEvent,
  FerretSession,
} from '../execution/types';
import { extensionId } from '../test/extension-identity';

const saveAndRunAction = 'Save and Run';
const eventTimeout = 15_000;

type TerminalChange = Extract<
  ManagedExecutionChange,
  {
    readonly kind: 'finished' | 'invalidated' | 'watch-failed';
  }
>;

interface RootSpec {
  readonly files: Readonly<Record<string, string>>;
  readonly name: string;
}

interface CapturedError {
  readonly args: readonly unknown[];
  readonly message: string;
}

class CaptureOutput {
  private readonly errorEmitter =
    new vscode.EventEmitter<CapturedError>();

  public readonly errors: CapturedError[] = [];
  public readonly infos: string[] = [];

  public error(message: string, ...args: unknown[]): void {
    const captured = { args, message };
    this.errors.push(captured);
    this.errorEmitter.fire(captured);
  }

  public info(message: string): void {
    this.infos.push(message);
  }

  public show(): void {}

  public waitForError(
    predicate: (error: CapturedError) => boolean,
    description: string,
  ): Promise<CapturedError> {
    const captured = this.errors.find(predicate);
    if (captured !== undefined) {
      return Promise.resolve(captured);
    }

    return waitForEvent(this.errorEmitter.event, predicate, description);
  }

  public dispose(): void {
    this.errorEmitter.dispose();
  }
}

class InstrumentedExecutionClient {
  public activeWatches = 0;
  public readonly closedExecutions: string[] = [];
  public readonly closedSessions: string[] = [];
  public readonly createdExecutions: FerretExecution[] = [];
  public readonly createdSessions: FerretSession[] = [];
  public readonly events = new Map<string, FerretExecutionEvent[]>();
  private readonly executionCloseEmitter =
    new vscode.EventEmitter<string>();
  private readonly watchCountEmitter = new vscode.EventEmitter<number>();

  public bind(inner: FerretExecutionClient): ExecutionClient {
    return {
      createSession: (...args) => this.createSession(inner, ...args),
      createExecution: (...args) => this.createExecution(inner, ...args),
      watchExecution: (...args) => this.watchExecution(inner, ...args),
      runExecution: (...args) => inner.runExecution(...args),
      cancelExecution: id => inner.cancelExecution(id),
      closeExecution: id => this.closeExecution(inner, id),
      closeSession: id => this.closeSession(inner, id),
    };
  }

  private async createSession(inner: FerretExecutionClient, ...args: Parameters<ExecutionClient['createSession']>): Promise<FerretSession> {
    const session = await inner.createSession(...args);
    this.createdSessions.push(session);

    return session;
  }

  private async createExecution(inner: FerretExecutionClient, ...args: Parameters<ExecutionClient['createExecution']>): Promise<FerretExecution> {
    const execution = await inner.createExecution(...args);
    this.createdExecutions.push(execution);

    return execution;
  }

  private watchExecution(
    inner: FerretExecutionClient,
    executionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<FerretExecutionEvent> {
    const source = inner.watchExecution(executionId, signal);
    // The async iterator method has its own `this`; retain the client owner.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;

    return {
      async *[Symbol.asyncIterator]() {
        client.activeWatches += 1;
        client.watchCountEmitter.fire(client.activeWatches);
        try {
          for await (const event of source) {
            const events = client.events.get(executionId) ?? [];
            events.push(event);
            client.events.set(executionId, events);
            yield event;
          }
        } finally {
          client.activeWatches -= 1;
          client.watchCountEmitter.fire(client.activeWatches);
        }
      },
    };
  }

  private async closeExecution(inner: FerretExecutionClient, executionId: string): Promise<void> {
    await inner.closeExecution(executionId);
    this.closedExecutions.push(executionId);
    this.executionCloseEmitter.fire(executionId);
  }

  private async closeSession(inner: FerretExecutionClient, sessionId: string): Promise<void> {
    await inner.closeSession(sessionId);
    this.closedSessions.push(sessionId);
  }

  public waitForExecutionClose(executionId: string): Promise<void> {
    if (this.closedExecutions.includes(executionId)) {
      return Promise.resolve();
    }

    return waitForEvent(
      this.executionCloseEmitter.event,
      (closedId) => closedId === executionId,
      `Execution ${executionId} cleanup`,
    ).then(() => undefined);
  }

  public waitForNoActiveWatches(): Promise<void> {
    if (this.activeWatches === 0) {
      return Promise.resolve();
    }

    return waitForEvent(
      this.watchCountEmitter.event,
      (count) => count === 0,
      'execution watches to close',
    ).then(() => undefined);
  }

  public dispose(): void {
    this.executionCloseEmitter.dispose();
    this.watchCountEmitter.dispose();
  }
}

class MemoryOutputChannel {
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

class MemoryStatusBar {
  public command: string | vscode.Command | undefined;
  public disposed = false;
  public name: string | undefined;
  public text = '';
  public tooltip: string | vscode.MarkdownString | undefined;
  public visible = false;

  public hide(): void {
    this.visible = false;
  }

  public show(): void {
    this.visible = true;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class IntegrationFeedbackHost implements ExecutionFeedbackHost {
  public readonly output = new MemoryOutputChannel();
  public readonly status = new MemoryStatusBar();

  public clearTimer(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
  }

  public createOutputChannel(name: string): vscode.OutputChannel {
    assert.strictEqual(name, executionOutputChannelName);
    return this.output as unknown as vscode.OutputChannel;
  }

  public createStatusBarItem(): vscode.StatusBarItem {
    return this.status as unknown as vscode.StatusBarItem;
  }

  public displayPath(uri: vscode.Uri): string {
    return basename(uri.fsPath);
  }

  public monotonicNow(): number {
    return performance.now();
  }

  public registerCommand(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  public setTimer(
    handler: () => void,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(handler, delay);
  }

  public wallNow(): Date {
    return new Date();
  }
}

class IntegrationCommandHost implements ExecutionCommandHost {
  public getRunSettings(uri: vscode.Uri): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('ferret.run', uri);
  }

  private readonly activeEditorEmitter = new vscode.EventEmitter<void>();
  private readonly handlers = new Map<string, () => Promise<void>>();
  public activeDocument: vscode.TextDocument | undefined;
  public readonly errorMessages: string[] = [];
  public readonly informationMessages: string[] = [];
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
    this.handlers.set(command, handler);
    return new vscode.Disposable(() => this.handlers.delete(command));
  }

  public setContext(): Thenable<unknown> {
    return Promise.resolve();
  }

  public showErrorMessage(message: string): Thenable<unknown> {
    this.errorMessages.push(message);
    return Promise.resolve(undefined);
  }

  public showInformationMessage(
    message: string,
  ): Thenable<string | undefined> {
    this.informationMessages.push(message);
    return Promise.resolve(this.nextInformationSelection);
  }

  public async invoke(command: string): Promise<void> {
    const handler = this.handlers.get(command);
    assert.ok(handler, `Expected ${command} to be registered`);
    await handler();
  }

  public dispose(): void {
    this.activeEditorEmitter.dispose();
  }
}

class RealExecutionFixture {
  public readonly client: InstrumentedExecutionClient;
  public readonly daemon: DaemonController;
  public readonly endpoints: DaemonEndpoint[] = [];
  public readonly feedback: ExecutionFeedbackController;
  public readonly feedbackHost = new IntegrationFeedbackHost();
  public readonly manager: FerretExecutionManager;
  public readonly output = new CaptureOutput();
  public readonly runtime: RuntimeCoordinator;
  public selection = '';
  public readonly processes: ChildProcess[] = [];
  public readonly roots: ReadonlyMap<string, string>;
  private disposed = false;
  private readonly invalidatedExecutions = new Set<string>();
  private readonly invalidatedSessions = new Set<string>();

  private constructor(
    public readonly temporaryRoot: string,
    roots: ReadonlyMap<string, string>,
    executable: string,
  ) {
    this.roots = roots;
    this.daemon = new DaemonController(
      () => ({
        executable,
        extraArguments: [],
        source: 'configured',
      }),
      this.output,
      (command, args) => this.spawn(command, args),
      async () => {
        const endpoint = await createDaemonEndpoint();
        this.endpoints.push(endpoint);
        return endpoint;
      },
    );
    this.client = new InstrumentedExecutionClient();
    this.runtime = new RuntimeCoordinator(this.daemon, { entered: '' }, () => this.selection);
    this.manager = new FerretExecutionManager(
      this.daemon,
      connection => this.client.bind(new FerretExecutionClient(connection)),
      this.daemon.workspaceRegistry,
      this.output,
      this.runtime,
    );
    this.feedback = new ExecutionFeedbackController(
      this.manager,
      this.output,
      this.feedbackHost,
    );
  }

  public static async create(
    executable: string,
    specs: readonly RootSpec[],
  ): Promise<RealExecutionFixture> {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'ferret-execution-integration-'),
    );
    const roots = new Map<string, string>();
    for (const spec of specs) {
      const root = join(temporaryRoot, spec.name);
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(root));
      roots.set(spec.name, root);
      for (const [relativePath, source] of Object.entries(spec.files)) {
        const target = join(root, relativePath);
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(dirname(target)),
        );
        await writeFile(target, source);
      }
    }

    const fixture = new RealExecutionFixture(
      temporaryRoot,
      roots,
      executable,
    );
    try {
      await fixture.daemon.updateWorkspaceFolders([...roots.values()]);
      assert.equal(fixture.processes.length, 0);
      return fixture;
    } catch (error) {
      await fixture.dispose();
      throw error;
    }
  }

  public path(root: string, relativePath: string): string {
    const value = this.roots.get(root);
    assert.ok(value, `Missing integration root ${root}`);
    return join(value, relativePath);
  }

  public async document(
    root: string,
    relativePath: string,
  ): Promise<vscode.TextDocument> {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(this.path(root, relativePath)),
    );
    assert.strictEqual(document.languageId, 'ferret');
    return document;
  }

  public latestProcess(): ChildProcess {
    const process = this.processes.at(-1);
    assert.ok(process, 'Expected a ferretd child process');
    return process;
  }

  public expectGenerationLoss(): void {
    for (const execution of this.client.createdExecutions) {
      if (!this.client.closedExecutions.includes(execution.id)) {
        this.invalidatedExecutions.add(execution.id);
      }
    }
    for (const session of this.client.createdSessions) {
      if (!this.client.closedSessions.includes(session.id)) {
        this.invalidatedSessions.add(session.id);
      }
    }
  }

  public expectWorkspaceLoss(workspaceId: string): void {
    const sessionIds = new Set(
      this.client.createdSessions
        .filter(({ source }) => source.workspaceId === workspaceId)
        .map(({ id }) => id),
    );
    for (const sessionId of sessionIds) {
      if (!this.client.closedSessions.includes(sessionId)) {
        this.invalidatedSessions.add(sessionId);
      }
    }
    for (const execution of this.client.createdExecutions) {
      if (
        sessionIds.has(execution.sessionId) &&
        !this.client.closedExecutions.includes(execution.id)
      ) {
        this.invalidatedExecutions.add(execution.id);
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    this.feedback.dispose();
    await this.manager.dispose();
    await this.runtime.shutdown();
    assert.strictEqual(this.manager.activeCount, 0);
    assert.strictEqual(this.client.activeWatches, 0);
    assert.deepStrictEqual(
      this.client.createdExecutions
        .map(({ id }) => id)
        .filter(
          (id) =>
            !this.client.closedExecutions.includes(id) &&
            !this.invalidatedExecutions.has(id),
        ),
      [],
      'Expected every valid-generation Execution to close',
    );
    assert.deepStrictEqual(
      this.client.createdSessions
        .map(({ id }) => id)
        .filter(
          (id) =>
            !this.client.closedSessions.includes(id) &&
            !this.invalidatedSessions.has(id),
        ),
      [],
      'Expected every valid-generation Session to close',
    );
    for (const process of this.processes) {
      assert.ok(
        process.exitCode !== null || process.signalCode !== null,
        'Expected every extension-owned ferretd process to exit',
      );
    }
    if (process.platform !== 'win32') {
      for (const endpoint of this.endpoints) {
        const socket = endpoint.grpc.slice('unix://'.length);
        await assert.rejects(
          stat(dirname(socket)),
          (error: unknown) =>
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT',
        );
      }
    }
    this.client.dispose();
    this.output.dispose();
    await rm(this.temporaryRoot, { recursive: true, force: true });
  }

  private spawn(command: string, args: readonly string[]): DaemonProcess {
    const child = spawn(command, [...args], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.processes.push(child);
    return child;
  }
}

suite('ferretd execution integration', () => {
  let executable: string;
  let sources: Readonly<Record<string, string>>;

  suiteSetup(async () => {
    executable = requireFerretdPath();
    await access(
      executable,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
    sources = {
      invalid: await fixtureSource('invalid.fql'),
      long: await fixtureSource('long-running.fql'),
      none: await fixtureSource('no-result.fql'),
      success: await fixtureSource('success.fql'),
    };
  });

  test('reports an offline Wire default, preserves the Debug guard, and restores built-in Run', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'main.fql': 'RETURN 42\n' } },
    ]);
    const config = join(fixture.temporaryRoot, 'runtimes.json');
    let resolutions = 0;
    const debug = new FerretDebugAdapterDescriptorFactory(async () => {
      resolutions++;
      return { source: 'configured', executable };
    }, fixture.output, fixture.runtime);
    const session = (configuration: object) => ({ id: 'guard', configuration }) as vscode.DebugSession;
    try {
      const document = await fixture.document('root', 'main.fql');
      await writeFile(config, JSON.stringify({ defaultRuntime: 'offline', runtimes: [{
        name: 'offline', label: 'Offline', provider: 'wire', endpoint: 'tcp://127.0.0.1:1', insecure: true,
      }] }));
      fixture.runtime.save({ entered: config, path: config });
      await fixture.runtime.reload();
      assert.equal(fixture.runtime.view.catalog?.defaultRuntime, 'offline');
      await assert.rejects(fixture.manager.run(document), /runtime.*unavailable/i);
      assert.throws(() => debug.createDebugAdapterDescriptor(session({})), /Daemon default/);
      fixture.selection = 'offline';
      fixture.runtime.save({ entered: '' });
      await assert.rejects(fixture.manager.run(document), /Reload/);
      await fixture.runtime.reload();
      await assert.rejects(fixture.manager.run(document), /runtime.*unavailable/i);
      assert.throws(() => debug.createDebugAdapterDescriptor(session({})), /Daemon default/);
      fixture.selection = '';
      assert.throws(() => debug.createDebugAdapterDescriptor(session({ runtimeName: 'local' })), /Daemon default/);
      assert.equal(resolutions, 0);
      assert.equal(fixture.client.createdSessions.length, 0);
      const result = await runToTerminal(fixture, document);
      assert.equal(resultValue(result.change), 42);
    } finally {
      await debug.shutdown();
      await fixture.dispose();
    }
  });

  test('shares a native plan across default and explicit local while applying per-Run inputs', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'root', files: {
        '.tmp/query.fql': 'RETURN [@item, TO_STRING(IO::FS::READ("marker.txt"))]',
        'marker.txt': 'workspace',
      } },
      { name: 'other', files: { 'marker.txt': 'override' } },
    ]);
    try {
      const config = join(fixture.temporaryRoot, 'runtimes.json');
      await writeFile(config, '{}');
      fixture.runtime.save({ entered: config, path: config });
      const query = await fixture.document('root', '.tmp/query.fql');
      const a = await runToTerminal(fixture, query, { parameters: { item: false } });
      assert.deepEqual(resultValue(a.change), [false, 'workspace']);
      const b = await runToTerminal(fixture, query, { runtimeName: 'local', parameters: { item: 7 }, workingDirectory: '../other' });
      assert.deepEqual(resultValue(b.change), [7, 'override']);
      assert.equal(a.handle.sessionId, b.handle.sessionId);
      assert.equal(fixture.client.createdSessions.length, 1);
      await writeFile(config, '{ }');
      await assert.rejects(fixture.manager.run(query, { runtimeName: 'local' }), /Reload/);
      assert.equal(fixture.client.createdExecutions.length, 2);
    } finally { await fixture.dispose(); }
  });

  test('refreshes the native plan after external same-size edits across an editor reopen', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'external.fql': 'RETURN 1' } },
    ]);
    try {
      const doc = await fixture.document('root', 'external.fql');
      await vscode.window.showTextDocument(doc);
      const before = await runToTerminal(fixture, doc);
      assert.equal(resultValue(before.change), 1);
      await writeFile(doc.uri.fsPath, 'RETURN 2');
      const after = await runToTerminal(fixture, doc);
      assert.equal(resultValue(after.change), 2);
      assert.notEqual(before.handle.sessionId, after.handle.sessionId);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await writeFile(doc.uri.fsPath, 'RETURN 3');
      const reopened = await fixture.document('root', 'external.fql');
      const third = await runToTerminal(fixture, reopened);
      assert.equal(resultValue(third.change), 3);
      assert.notEqual(third.handle.sessionId, after.handle.sessionId);
    } finally { await fixture.dispose(); }
  });

  test('runs literal toJSON properties from real resource-scoped settings', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'settings.fql': 'RETURN @payload' } },
    ]);
    const document = await fixture.document('root', 'settings.fql');
    const settings = () => vscode.workspace.getConfiguration('ferret.run', document.uri);
    try {
      const payload = { toJSON: 'literal', nested: [{ ToJson: false }] };
      // The test profile is temporary. Reading by source URI exercises the
      // extension host's configuration proxy, including nested JSON objects.
      await settings().update('parameters', { payload }, vscode.ConfigurationTarget.Global);
      const run = await runToTerminal(fixture, document, readRunOptions({}, settings()));
      assert.deepEqual(resultValue(run.change), payload);
    } finally {
      await settings().update('parameters', undefined, vscode.ConfigurationTarget.Global);
      await fixture.dispose();
    }
  });

  test('runs on the living Wire host, releases each binding, and reacquires after Stop', async () => {
    const binary = process.env.FERRET_WIRE_HOST_PATH;
    assert.ok(binary, 'make test vscode must supply the independent Wire host');
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'source', files: {
        'query.fql': 'RETURN {value: DEMO::IDENTITY(@value), marker: TO_STRING(IO::FS::READ("marker.txt"))}',
        'block.fql': 'RETURN DEMO::BLOCK(@token)',
        'local.fql': 'RETURN TO_STRING(IO::FS::READ("marker.txt"))',
        'marker.txt': 'editor',
      } },
    ]);
    const appRoot = join(fixture.temporaryRoot, 'application');
    let host: WireHost | undefined;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(appRoot));
      await writeFile(join(appRoot, 'marker.txt'), 'application');
      host = new WireHost(binary, appRoot);
      const { endpoint } = await host.wait('ready');
      assert.ok(endpoint);
      const config = join(fixture.temporaryRoot, 'runtimes.json');
      await writeFile(config, JSON.stringify({ defaultRuntime: 'App', runtimes: [
        { name: 'App', provider: 'wire', endpoint, insecure: true },
      ] }));
      fixture.runtime.save({ entered: config, path: config });
      const value = { boolean: true, number: 7, text: '7', nested: [null, { valid: false }] };
      const query = await fixture.document('source', 'query.fql');
      const first = await runToTerminal(fixture, query, { parameters: { value } });
      assert.deepEqual(resultValue(first.change), { value, marker: 'application' });
      const firstId = (await host.wait('connected')).id;
      assert.ok(firstId);
      await host.wait('released', 1, firstId);

      const local = await runToTerminal(fixture, await fixture.document('source', 'local.fql'), { runtimeName: 'local' });
      assert.equal(resultValue(local.change), 'editor');
      assert.equal(host.count('connected'), 1);

      const block = await fixture.document('source', 'block.fql');
      const terminal = waitForTerminal(fixture.manager, block.uri);
      const handle = await fixture.manager.run(block, { runtimeName: 'App', parameters: { token: 'stop' } });
      const secondId = (await host.wait('connected', 2)).id;
      assert.ok(secondId && secondId !== firstId);
      await host.wait('entered', 1, undefined, 'stop');
      const daemon = fixture.latestProcess();
      const held = await withholdSessionReply(fixture.daemon.requireConnection().executions);
      try {
        const lost = assert.rejects(fixture.manager.run(query, { parameters: { value } }), /cancelled/);
        await Promise.race([held.committed, lost.then(() => { throw new Error('Run ended before its Session was published'); })]);
        const lostId = (await host.wait('connected', 3)).id;
        assert.ok(lostId && lostId !== secondId);
        await fixture.manager.cancel(query.uri);
        await lost;
        await host.wait('released', 1, lostId);
        assert.equal(fixture.manager.getActive(block.uri)?.id, handle.id);
        assert.equal(host.count('released'), 2);
        assert.equal(host.count('engineClosed'), 0);
      } finally { held.dispose(); }
      await handle.cancel();
      assertFinished(await terminal, 'cancelled');
      await host.wait('cancelled', 1, undefined, 'stop');
      await host.wait('released', 1, secondId);

      const again = await runToTerminal(fixture, query, { runtimeName: 'App', parameters: { value }, workingDirectory: fixture.path('source', '') });
      assert.deepEqual(resultValue(again.change), { value, marker: 'editor' });
      assert.notEqual(again.handle.sessionId, first.handle.sessionId);
      assert.equal(fixture.latestProcess(), daemon);
      const thirdId = (await host.wait('connected', 4)).id;
      assert.ok(thirdId && thirdId !== secondId);
      await host.wait('released', 1, thirdId);
      assert.equal(host.count('engineClosed'), 0);
    } finally {
      try {
        await fixture.dispose();
        if (host) assert.equal(host.count('engineClosed'), 0);
      } finally { await host?.close(); }
    }
  });

  test('executes, reuses, refreshes, and renders real daemon results', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      {
        name: 'root',
        files: {
          'invalid.fql': sources.invalid!,
          'main.fql': sources.success!,
          'none.fql': sources.none!,
          'runtime-errors.fql': `LET first = @first
LET second = @second
LET third = @third
RETURN [first, second, third]`,
        },
      },
    ]);

    try {
      const document = await fixture.document('root', 'main.fql');
      const first = await runToTerminal(fixture, document);
      assertFinished(first.change, 'completed');
      assert.deepStrictEqual(resultValue(first.change), {
        name: 'Ferret',
        count: 2,
      });
      const firstEvents = eventKinds(fixture, first.handle.id);
      const lifecycle = [
        'created',
        'started',
        'completed',
      ] as const;
      assert.deepStrictEqual(
        firstEvents,
        lifecycle.filter((kind) => firstEvents.includes(kind)),
        `Unexpected execution lifecycle: ${firstEvents.join(', ')}`,
      );
      assert.strictEqual(firstEvents.at(-1), 'completed');
      assert.strictEqual(fixture.manager.activeCount, 0);
      await fixture.client.waitForExecutionClose(first.handle.id);

      const second = await runToTerminal(fixture, document);
      assertFinished(second.change, 'completed');
      assert.deepStrictEqual(resultValue(second.change), {
        name: 'Ferret',
        count: 2,
      });
      assert.strictEqual(second.handle.sessionId, first.handle.sessionId);
      assert.notStrictEqual(second.handle.id, first.handle.id);
      assert.strictEqual(fixture.manager.activeCount, 0);

      await replaceDocument(document, 'RETURN "after"\n');
      assert.strictEqual(await document.save(), true);
      const refreshed = await runToTerminal(fixture, document);
      assertFinished(refreshed.change, 'completed');
      assert.strictEqual(resultValue(refreshed.change), 'after');
      assert.notStrictEqual(refreshed.handle.sessionId, first.handle.sessionId);

      const noneDocument = await fixture.document('root', 'none.fql');
      const none = await runToTerminal(fixture, noneDocument);
      assertFinished(none.change, 'completed');
      assert.strictEqual(resultValue(none.change), null);

      const runtimeDocument = await fixture.document(
        'root',
        'runtime-errors.fql',
      );
      const runtime = await runToTerminal(fixture, runtimeDocument);
      assertFinished(runtime.change, 'failed');
      const runtimeFailure = runtime.change.execution.execution.failure;
      assert.ok(runtimeFailure, 'Expected runtime failure details');
      assert.strictEqual(runtimeFailure.category, 'runtime');
      assert.strictEqual(runtimeFailure.message, 'Found 3 errors');
      assert.strictEqual(runtimeFailure.diagnostics.length, 3);
      for (const [index, name] of [
        '@first',
        '@second',
        '@third',
      ].entries()) {
        const diagnostic: FerretDiagnostic | undefined =
          runtimeFailure.diagnostics[index];
        assert.ok(diagnostic, `Expected runtime diagnostic ${index}`);
        assert.strictEqual(diagnostic.range.start.line, index);
        assert.notDeepStrictEqual(
          diagnostic.range.start,
          diagnostic.range.end,
        );
        assert.match(diagnostic.message, /missing parameter/u);
        assert.match(diagnostic.message, new RegExp(name, 'u'));
      }

      const invalid = await fixture.document('root', 'invalid.fql');
      await assert.rejects(
        fixture.manager.run(invalid),
        (error: unknown) =>
          error instanceof FerretExecutionClientError &&
          error.code === 'compilation-failed' &&
          (error.diagnostics?.length ?? 0) > 0,
      );

      const userOutput = fixture.feedbackHost.output.lines.join('\n');
      assert.match(userOutput, /Running main\.fql/u);
      assert.match(userOutput, /"name": "Ferret"/u);
      assert.match(userOutput, /\nnull\n/u);
      for (const [line, name] of [
        '@first',
        '@second',
        '@third',
      ].entries()) {
        assert.match(
          userOutput,
          new RegExp(`runtime-errors\\.fql:${line + 1}:\\d+`, 'u'),
        );
        assert.match(userOutput, new RegExp(name, 'u'));
      }
      assert.match(userOutput, /Execution failed: invalid\.fql/u);
      assert.match(userOutput, /invalid\.fql:\d+:\d+/u);
      assert.doesNotMatch(userOutput, /grpc|protobuf|ferretd daemon/iu);
      assert.ok(
        fixture.output.infos.some((line) =>
          line.startsWith('Ferret daemon started:'),
        ),
        'Expected daemon lifecycle details in the Ferret developer channel',
      );
      assert.deepStrictEqual(fixture.output.errors, []);
    } finally {
      await fixture.dispose();
    }
  });

  test('rejects dirty source, saves through the command, and reserves duplicate runs', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      {
        name: 'root',
        files: {
          'dirty.fql': 'RETURN "old"\n',
          'duplicate.fql': sources.long!,
        },
      },
    ]);
    const commandHost = new IntegrationCommandHost();
    const commands = new ExecutionCommandController(
      fixture.manager,
      fixture.output,
      commandHost,
    );

    try {
      const dirty = await fixture.document('root', 'dirty.fql');
      await replaceDocument(dirty, 'RETURN "new"\n');
      assert.strictEqual(dirty.isDirty, true);
      const sessionCount = fixture.client.createdSessions.length;
      await assert.rejects(
        fixture.manager.run(dirty),
        (error: unknown) =>
          error instanceof ExecutionManagerError &&
          error.code === 'document-dirty',
      );
      assert.strictEqual(fixture.client.createdSessions.length, sessionCount);

      commandHost.activeDocument = dirty;
      commandHost.nextInformationSelection = saveAndRunAction;
      const terminal = waitForTerminal(fixture.manager, dirty.uri);
      await commandHost.invoke(runFileCommand);
      const saved = await terminal;
      assertFinished(saved, 'completed');
      assert.strictEqual(resultValue(saved), 'new');
      assert.strictEqual(dirty.isDirty, false);

      const duplicate = await fixture.document('root', 'duplicate.fql');
      const duplicateTerminal = waitForTerminal(
        fixture.manager,
        duplicate.uri,
      );
      const beforeExecutions = fixture.client.createdExecutions.length;
      const attempts = await Promise.allSettled([
        fixture.manager.run(duplicate),
        fixture.manager.run(duplicate),
      ]);
      const fulfilled = attempts.find(
        (attempt): attempt is PromiseFulfilledResult<ManagedExecution> =>
          attempt.status === 'fulfilled',
      );
      const rejected = attempts.find(
        (attempt): attempt is PromiseRejectedResult =>
          attempt.status === 'rejected',
      );
      assert.ok(fulfilled);
      assert.ok(
        rejected?.reason instanceof ExecutionManagerError &&
          rejected.reason.code === 'execution-already-running',
      );
      assert.strictEqual(
        fixture.client.createdExecutions.length,
        beforeExecutions + 1,
      );
      await fulfilled.value.cancel();
      assertFinished(await duplicateTerminal, 'cancelled');
    } finally {
      commands.dispose();
      commandHost.dispose();
      await fixture.dispose();
    }
  });

  test('handles real cancellation, completion races, and concurrent documents', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      {
        name: 'root',
        files: {
          'a.fql': sources.long!,
          'b.fql': sources.long!,
          'concurrent-a.fql': sources.long!,
          'concurrent-b.fql': sources.long!,
          'race.fql': 'WAIT(1ms)\nRETURN "race"\n',
        },
      },
    ]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const firstDocument = await fixture.document('root', 'a.fql');
      const firstTerminal = waitForTerminal(
        fixture.manager,
        firstDocument.uri,
      );
      const first = await fixture.manager.run(firstDocument);
      assert.strictEqual(first.execution.status, 'running');
      assert.strictEqual(fixture.client.activeWatches, 1);
      await first.cancel();
      assertFinished(await firstTerminal, 'cancelled');
      await fixture.client.waitForNoActiveWatches();
      const cancellationOutput = fixture.feedbackHost.output.lines.join('\n');
      assert.match(cancellationOutput, /Execution cancelled: a\.fql/u);
      assert.doesNotMatch(cancellationOutput, /Execution failed: a\.fql/u);

      await replaceDocument(firstDocument, 'RETURN "after cancel"\n');
      assert.strictEqual(await firstDocument.save(), true);
      const rerun = await runToTerminal(fixture, firstDocument);
      assertFinished(rerun.change, 'completed');
      assert.strictEqual(resultValue(rerun.change), 'after cancel');

      const raceDocument = await fixture.document('root', 'race.fql');
      const raceTerminal = waitForTerminal(fixture.manager, raceDocument.uri);
      await fixture.manager.run(raceDocument);
      const cancelResult = await Promise.allSettled([
        fixture.manager.cancel(raceDocument.uri),
      ]);
      const race = await raceTerminal;
      assert.ok(race.kind === 'finished');
      assert.ok(
        race.event.kind === 'completed' || race.event.kind === 'cancelled',
      );
      const cancellation = cancelResult[0];
      if (cancellation?.status === 'rejected') {
        assert.ok(
          cancellation.reason instanceof FerretExecutionClientError &&
            (cancellation.reason.code === 'invalid-state' ||
              cancellation.reason.code === 'closed' ||
              cancellation.reason.code === 'not-found'),
        );
      }

      const a = await fixture.document('root', 'concurrent-a.fql');
      const b = await fixture.document('root', 'concurrent-b.fql');
      const aTerminal = waitForTerminal(fixture.manager, a.uri);
      const bTerminal = waitForTerminal(fixture.manager, b.uri);
      const [aExecution, bExecution] = await Promise.all([
        fixture.manager.run(a),
        fixture.manager.run(b),
      ]);
      assert.notStrictEqual(aExecution.id, bExecution.id);
      assert.notStrictEqual(aExecution.sessionId, bExecution.sessionId);
      assert.strictEqual(fixture.manager.activeCount, 2);
      assert.strictEqual(
        fixture.feedbackHost.status.text,
        '$(sync~spin) Ferret (2)',
      );
      await aExecution.cancel();
      assertFinished(await aTerminal, 'cancelled');
      assert.strictEqual(fixture.manager.getActive(b.uri), bExecution);
      assert.strictEqual(fixture.manager.activeCount, 1);
      assert.strictEqual(fixture.feedbackHost.status.text, '$(sync~spin) Ferret');
      await bExecution.cancel();
      assertFinished(await bTerminal, 'cancelled');
      await immediate();
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      await fixture.dispose();
    }
  });

  test('isolates equal relative paths and invalidates only a removed workspace', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'project-a', files: { 'main.fql': sources.long! } },
      { name: 'project-b', files: { 'main.fql': sources.long! } },
    ]);

    try {
      const a = await fixture.document('project-a', 'main.fql');
      const b = await fixture.document('project-b', 'main.fql');
      const aTerminal = waitForTerminal(fixture.manager, a.uri);
      const bTerminal = waitForTerminal(fixture.manager, b.uri);
      const [aExecution, bExecution] = await Promise.all([
        fixture.manager.run(a),
        fixture.manager.run(b),
      ]);
      assert.notStrictEqual(aExecution.sessionId, bExecution.sessionId);
      const sessions = fixture.client.createdSessions.slice(-2);
      assert.deepStrictEqual(sessions.map(({ runtimeName }) => runtimeName), ['local', 'local']);
      assert.notStrictEqual(
        sessions[0]?.source.workspaceId,
        sessions[1]?.source.workspaceId,
      );
      assert.strictEqual(sessions[0]?.source.relativePath, 'main.fql');
      assert.strictEqual(sessions[1]?.source.relativePath, 'main.fql');

      const removedWorkspace =
        fixture.daemon.workspaceRegistry.resolveDocument(a.uri.fsPath)
          ?.workspaceId;
      assert.ok(removedWorkspace);
      fixture.expectWorkspaceLoss(removedWorkspace);
      await fixture.daemon.updateWorkspaceFolders([
        fixture.roots.get('project-b')!,
      ]);
      const removed = await aTerminal;
      assert.ok(
        removed.kind === 'invalidated' ||
          (removed.kind === 'finished' &&
            removed.event.kind === 'cancelled'),
      );
      assert.strictEqual(fixture.manager.getActive(b.uri), bExecution);
      assert.strictEqual(fixture.manager.activeCount, 1);
      await bExecution.cancel();
      assertFinished(await bTerminal, 'cancelled');
    } finally {
      await fixture.dispose();
    }
  });

  test('discards crashed and restarted daemon generations while remaining reusable', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      {
        name: 'root',
        files: {
          'long.fql': sources.long!,
          'quick.fql': sources.success!,
        },
      },
    ]);

    try {
      const quick = await fixture.document('root', 'quick.fql');
      const initial = await runToTerminal(fixture, quick);
      assertFinished(initial.change, 'completed');
      const oldWorkspace =
        fixture.daemon.workspaceRegistry.workspaces[0]?.id;

      const long = await fixture.document('root', 'long.fql');
      const crashedTerminal = waitForTerminal(fixture.manager, long.uri);
      await fixture.manager.run(long);
      const beforeCrashExecutions = fixture.client.createdExecutions.length;
      fixture.expectGenerationLoss();
      assert.strictEqual(fixture.latestProcess().kill('SIGKILL'), true);
      const crashed = await crashedTerminal;
      if (crashed.kind === 'invalidated') {
        assert.strictEqual(crashed.reason, 'daemon-generation');
        assert.ok(
          crashed.cause instanceof DaemonError &&
            crashed.cause.code === 'unavailable',
        );
      } else {
        assert.ok(crashed.kind === 'watch-failed');
        assert.ok(
          crashed.error instanceof FerretExecutionClientError &&
            crashed.error.code === 'daemon-unavailable',
        );
      }
      assert.strictEqual(fixture.manager.activeCount, 0);
      await fixture.client.waitForNoActiveWatches();
      await fixture.output.waitForError(
        ({ message }) => message.startsWith('Ferret daemon disconnected:'),
        'Ferret daemon disconnect log',
      );
      assert.ok(
        fixture.output.errors.some(({ message }) =>
          message.startsWith('Ferret daemon disconnected:'),
        ),
      );
      await fixture.daemon.stop();
      assert.strictEqual(
        fixture.client.createdExecutions.length,
        beforeCrashExecutions,
        'A crashed execution must not be recreated automatically',
      );

      const recovered = await runToTerminal(fixture, quick);
      const freshWorkspace =
        fixture.daemon.workspaceRegistry.workspaces[0]?.id;
      assert.ok(freshWorkspace);
      assert.notStrictEqual(freshWorkspace, oldWorkspace);
      assertFinished(recovered.change, 'completed');
      assert.notStrictEqual(recovered.handle.sessionId, initial.handle.sessionId);

      const restartTerminal = waitForTerminal(fixture.manager, long.uri);
      await fixture.manager.run(long);
      fixture.expectGenerationLoss();
      await fixture.daemon.stop();
      const restarted = await restartTerminal;
      assert.ok(restarted.kind === 'invalidated');
      assert.strictEqual(restarted.reason, 'daemon-generation');
      assert.strictEqual(fixture.manager.activeCount, 0);

      await replaceDocument(long, 'RETURN "after restart"\n');
      assert.strictEqual(await long.save(), true);
      const afterRestart = await runToTerminal(fixture, long);
      assertFinished(afterRestart.change, 'completed');
      assert.strictEqual(resultValue(afterRestart.change), 'after restart');
    } finally {
      await fixture.dispose();
    }
  });

  test('keeps execution and Session ownership independent of an editor tab', async () => {
    const fixture = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'main.fql': sources.long! } },
    ]);

    try {
      const document = await fixture.document('root', 'main.fql');
      await vscode.window.showTextDocument(document);
      const firstTerminal = waitForTerminal(fixture.manager, document.uri);
      const first = await fixture.manager.run(document);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      assert.strictEqual(fixture.manager.getActive(document.uri), first);
      await first.cancel();
      assertFinished(await firstTerminal, 'cancelled');

      const reopened = await fixture.document('root', 'main.fql');
      const secondTerminal = waitForTerminal(fixture.manager, reopened.uri);
      const second = await fixture.manager.run(reopened);
      assert.strictEqual(second.sessionId, first.sessionId);
      await second.cancel();
      assertFinished(await secondTerminal, 'cancelled');
    } finally {
      await fixture.dispose();
    }
  });

  test('allocates isolated real endpoints and stops only owned processes', async () => {
    const first = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'main.fql': sources.success! } },
    ]);
    const second = await RealExecutionFixture.create(executable, [
      { name: 'root', files: { 'main.fql': sources.success! } },
    ]);

    try {
      await Promise.all([first.runtime.catalog(), second.runtime.catalog()]);
      assert.notStrictEqual(first.endpoints[0]?.cli, second.endpoints[0]?.cli);
      await first.dispose();
      second.daemon.requireConnection();
      const document = await second.document('root', 'main.fql');
      const completed = await runToTerminal(second, document);
      assertFinished(completed.change, 'completed');
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

function requireFerretdPath(): string {
  const executable = process.env.FERRETD_TEST_PATH;
  assert.ok(
    executable,
    'FERRETD_TEST_PATH must point to the pinned ferretd executable',
  );
  return resolve(executable);
}

async function fixtureSource(name: string): Promise<string> {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Expected VS Code to load ${extensionId}`);
  return readFile(
    join(extension.extensionPath, 'test', 'fixtures', 'execution', name),
    'utf8',
  );
}

async function runToTerminal(
  fixture: RealExecutionFixture,
  document: vscode.TextDocument,
  options?: RunOptions,
): Promise<{
  readonly change: TerminalChange;
  readonly handle: ManagedExecution;
}> {
  const terminal = waitForTerminal(fixture.manager, document.uri);
  const handle = await fixture.manager.run(document, options);
  return { change: await terminal, handle };
}

function waitForTerminal(
  manager: FerretExecutionManager,
  documentUri: vscode.Uri,
): Promise<TerminalChange> {
  return waitForEvent(
    manager.onDidChangeExecution,
    (change) => {
      const uri =
        'documentUri' in change
          ? change.documentUri
          : change.execution.documentUri;
      return (
        uri.toString() === documentUri.toString() &&
        (change.kind === 'finished' ||
          change.kind === 'invalidated' ||
          change.kind === 'watch-failed')
      );
    },
    `terminal execution state for ${documentUri.toString()}`,
  ).then((change) => change as TerminalChange);
}

function assertFinished(
  change: TerminalChange,
  expected: 'completed' | 'failed' | 'cancelled',
): asserts change is Extract<
  ManagedExecutionChange,
  { readonly kind: 'finished' }
> {
  assert.strictEqual(change.kind, 'finished');
  assert.strictEqual(change.event.kind, expected);
  assert.strictEqual(change.execution.execution.status, expected);
}

function resultValue(change: TerminalChange): unknown {
  assertFinished(change, 'completed');
  const output = change.execution.execution.output;
  assert.ok(output, 'Expected completed execution output');
  assert.strictEqual(output.contentType, 'application/json');
  return JSON.parse(Buffer.from(output.data).toString('utf8'));
}

function eventKinds(
  fixture: RealExecutionFixture,
  executionId: string,
): readonly FerretExecutionEvent['kind'][] {
  return (fixture.client.events.get(executionId) ?? []).map(
    ({ kind }) => kind,
  );
}

async function replaceDocument(
  document: vscode.TextDocument,
  source: string,
): Promise<void> {
  const last = document.lineAt(document.lineCount - 1);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(0, 0, last.lineNumber, last.range.end.character),
    source,
  );
  assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
}

function waitForEvent<T>(
  event: vscode.Event<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  return new Promise<T>((resolveEvent, rejectEvent) => {
    // Assigned after finish is defined because finish closes over both handles.
    // eslint-disable-next-line prefer-const
    let listener: vscode.Disposable | undefined;
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      listener?.dispose();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      action();
    };

    listener = event((value) => {
      if (predicate(value)) {
        finish(() => resolveEvent(value));
      }
    });
    timer = setTimeout(
      () =>
        finish(() =>
          rejectEvent(new Error(`Timed out waiting for ${description}`)),
        ),
      eventTimeout,
    );
  });
}

function immediate(): Promise<void> {
  return new Promise((resolveImmediate) => setImmediate(resolveImmediate));
}
