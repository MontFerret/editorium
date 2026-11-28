import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { extensionId } from '../test/extension-identity';
import { DebugObserver } from './debug-observer';
import { FerretdProcesses } from './ferretd-processes';
import { waitForExecutionOutput } from './execution-output';
import { WireHost } from './wire-host';
import { inspectIndexedCollection, inspectVirtualGroups, stepWithPendingWatch } from './variables-view';

suite('Wire debugging through VS Code', () => {
  const target = vscode.ConfigurationTarget.Global;
  let project: string, source: string, application: string, config: string;
  let host: WireHost | undefined;
  let blockedRun: string | undefined;
  let primaryProject: string | undefined;
  let observers: DebugObserver[];
  let breakpoints: vscode.SourceBreakpoint[];
  let settings: vscode.WorkspaceConfiguration;
  let processes: FerretdProcesses;
  let savedSettings: Map<string, unknown>;
  const uri = (name: string) => vscode.Uri.file(join(source, name));

  async function startHost(previousEndpoint?: string): Promise<void> {
    const binary = process.env.FERRET_WIRE_HOST_PATH;
    assert.ok(binary);
    host = new WireHost(binary, application, true);
    // The OS may recycle a port immediately after host loss.
    if (previousEndpoint && (await host.wait('ready')).endpoint === previousEndpoint) {
      const occupyingOldEndpoint = host;
      try {
        host = new WireHost(binary, application, true);
        await host.wait('ready');
      } finally { await occupyingOldEndpoint.close(); }
    }
    await configureFile(config, 'App');
    await settings.update('runtime.configPath', config, target);
    await reload();
  }

  async function configureFile(path: string, name: string): Promise<void> {
    const { endpoint } = await host!.wait('ready');
    await writeFile(path, JSON.stringify({ defaultRuntime: name, runtimes: [
      { name, provider: 'wire', insecure: true, endpoint },
    ] }));
  }

  let previousExecutable: string | undefined;
  suiteSetup(async () => {
    settings = vscode.workspace.getConfiguration('ferret');
    previousExecutable = settings.inspect<string>('server.path')?.globalValue;
    await settings.update('server.path', process.env.FERRETD_TEST_PATH, target);
    await vscode.extensions.getExtension(extensionId)!.activate();
  });
  suiteTeardown(async () => { await settings.update('server.path', previousExecutable, target); });

  setup(async () => {
    blockedRun = undefined;
    primaryProject = undefined;
    observers = [];
    breakpoints = [];
    savedSettings = new Map(['runtime.configPath', 'run.parameters', 'run.workingDirectory'].map(key => [key, settings.inspect(key)?.globalValue]));
    processes = new FerretdProcesses(process.env.FERRETD_TEST_PATH!);
    project = await mkdtemp(join(vscode.workspace.workspaceFolders!.find(f => f.name === 'secondary')!.uri.fsPath, 'ferret-debug-'));
    source = join(project, '.tmp');
    await mkdir(source);
    application = await mkdtemp(join(tmpdir(), 'ferret-host-'));
    config = join(source, 'runtimes.json');
    await startHost();
  });

  teardown(async () => {
    try {
      const [runStop] = await Promise.allSettled([stopBlockedRun()]);
      const stops = await Promise.allSettled(observers.map(async observer => {
        try { await observer.stopIfActive(); }
        finally { observer.dispose(); }
      }));
      await processes.closed(processes.starts('dap'));
      for (const stop of [runStop, ...stops]) if (stop.status === 'rejected') throw stop.reason;
    } finally {
      try { await host?.close(); } finally {
        host = undefined;
        processes.dispose();
        vscode.debug.removeBreakpoints(breakpoints);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
          .filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath.startsWith(source + sep));
        if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
        for (const [key, previous] of savedSettings) await settings.update(key, previous, target);
        await reload();
        if (project) await rm(project, { recursive: true, force: true });
        if (primaryProject) await rm(primaryProject, { recursive: true, force: true });
        if (application) await rm(application, { recursive: true, force: true });
      }
    }
  });

  function observe(name: string): DebugObserver {
    const observer = new DebugObserver(name);
    observers.push(observer);
    return observer;
  }

  async function launch(name: string, file: string, options: object): Promise<DebugObserver> {
    const observer = observe(name);
    assert.equal(await vscode.debug.startDebugging(undefined, {
      type: 'ferret', request: 'launch', name, program: uri(file).fsPath, cwd: source, ...options,
    }), true);
    return observer;
  }

  async function select(position: 'first' | 'last'): Promise<void> {
    await vscode.commands.executeCommand('ferret.selectRuntime');
    await vscode.commands.executeCommand('quickInput.' + position);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }

  for (const runtimeName of ['local', 'App']) {
    for (const [kind, size] of [['array', 100], ['array', 10_000], ['array', 1_000_000], ['dataset', 1_000_000]] as const) {
      test(`opens ${kind} of ${size} in the Variables view on ${runtimeName}`, async () => {
        const file = 'large.fql';
        const program = uri(file);
        const source = kind === 'array' ? `ARRAYS::RANGE(0, ${size - 1})` : `(FOR n IN 0..${size - 1} RETURN n)`;
        await writeFile(program.fsPath, `LET results = ${source}\nLET sample = {rows: [1, 2]}\nLET size = LENGTH(results)\nRETURN size + sample.rows[0]`);
        breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(2, 0))));
        vscode.debug.addBreakpoints(breakpoints);
        const observer = await launch(`Variables view ${runtimeName}`, file, { runtimeName });
        await inspectIndexedCollection(observer, size);
      });
    }
  }

  test('opens virtual groups and follows unknown continuations in the Variables view', async () => {
    const program = uri('views.fql');
    await writeFile(program.fsPath, 'LET rows = DEMO::INSPECTED("mixed", 103)\nLET result = 7\nRETURN [result, rows]');
    breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(program, new vscode.Position(1, 0))));
    vscode.debug.addBreakpoints(breakpoints);
    const observer = await launch('Mixed variables', 'views.fql', { runtimeName: 'App' });
    await inspectVirtualGroups(observer);
  });

  test('refreshes an expanded watch across a step with a pending Wire page', async () => {
    const file = 'watch.fql';
    await writeFile(uri(file).fsPath, 'VAR rows = DEMO::INSPECTED("known", 100)\nrows = [777]\nRETURN rows');
    breakpoints.push(new vscode.SourceBreakpoint(new vscode.Location(uri(file), new vscode.Position(1, 0))));
    vscode.debug.addBreakpoints(breakpoints);
    const observer = await launch('Inspect across step', file, { runtimeName: 'App' });
    await stepWithPendingWatch(observer, host!);
  });

  test('uses F5, the picker and explicit overrides, steps through local source, and inspects hosted values', async () => {
    const program = uri('inspect.fql');
    const line = 'LET text = "😀" LET nextValue = value + 1';
    await writeFile(program.fsPath, 'LET value = DEMO::IDENTITY(@value)\n' + line + '\nRETURN nextValue\n');
    await settings.update('run.parameters', { value: 41.5, typed: [false, null] }, target);
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(program,
      new vscode.Position(1, line.indexOf('LET nextValue'))));
    breakpoints.push(breakpoint);
    vscode.debug.addBreakpoints([breakpoint]);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(program));
    const observer = observe('Debug Current Ferret File');
    await vscode.commands.executeCommand('workbench.action.debug.start');
    const response = await observer.wait(m => m.command === 'setBreakpoints');
    assert.equal(response.success, true, response.message);
    const binding = response.body?.breakpoints?.[0];
    assert.ok(binding, 'Expected a binding for the local source breakpoint');
    assert.equal(binding.verified, true, binding.message);
    assert.equal(binding.line, 2);
    assert.equal(binding.column, line.indexOf('LET nextValue') + 1);
    assert.equal((await observer.wait(m => m.command === 'launch')).body?.runtimeName, 'App');
    const { threadId, reason } = (await observer.wait(m => m.event === 'stopped')).body!;
    assert.equal(reason, 'breakpoint');
    const session = observer.session!;
    const { stackFrames } = await session.customRequest('stackTrace', { threadId });
    const frame = stackFrames[0];
    assert.equal(relative(program.fsPath, frame.source.path), '');
    assert.equal(frame.line, 2);
    assert.equal(frame.column, line.indexOf('LET nextValue') + 1);
    const { scopes } = await session.customRequest('scopes', { frameId: frame.id });
    for (const name of ['Locals', 'Parameters']) {
      const scope = scopes.find((item: { name: string }) => item.name === name);
      const { variables } = await session.customRequest('variables', { variablesReference: scope.variablesReference });
      assert.ok(variables.some((item: { name: string; value: string }) =>
        item.name.replace(/^@/, '') === 'value' && item.value === '41.5'), name);
    }
    const evaluation = await session.customRequest('evaluate', { expression: 'value + 1', frameId: frame.id, context: 'watch' });
    assert.equal(evaluation.result, '42.5');
    await session.customRequest('next', { threadId });
    assert.equal((await observer.wait(m => m.event === 'stopped', 2)).body?.reason, 'step');
    await session.customRequest('continue', { threadId });
    await observer.wait(m => m.event === 'output' && !!m.body?.output?.includes('42.5'));
    await observer.wait(m => m.event === 'terminated');
    await host!.wait('released');
    await writeFile(join(application, 'root.txt'), 'host-root');
    await writeFile(uri('native.fql').fsPath, 'RETURN TO_STRING(IO::FS::READ("root.txt"))');
    const native = await launch('explicit native', 'native.fql', {
      runtimeName: 'local', workingDirectory: relative(source, application),
    });
    await native.wait(m => m.event === 'output' && !!m.body?.output?.includes('host-root'));
    assert.equal((await native.wait(m => m.command === 'launch')).body?.runtimeName, 'local');
    await native.wait(m => m.event === 'terminated');
    assert.equal(host!.count('connected'), 1);
    await writeFile(uri('simple.fql').fsPath, 'RETURN 42');
    // Local is the last item in this catalog. An explicitly empty selector
    // overrides that choice and follows the Wire default.
    try {
      await select('last');
      const picked = await launch('picked local', 'simple.fql', {});
      assert.equal((await picked.wait(m => m.command === 'launch')).body?.runtimeName, 'local');
      await picked.wait(m => m.event === 'terminated');
      const chosen = await launch('explicit default', 'native.fql', { runtimeName: '' });
      assert.equal((await chosen.wait(m => m.command === 'launch')).body?.runtimeName, 'App');
      await chosen.wait(m => m.event === 'output' && !!m.body?.output?.includes('host-root'));
      await chosen.wait(m => m.event === 'terminated');
      await host!.wait('released', 2);
    } finally { await select('first'); }
  });

  async function program(file: string, contents: string): Promise<void> {
    await writeFile(uri(file).fsPath, contents);
  }

  async function focus(file: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri(file));
    await vscode.window.showTextDocument(document, { preview: false });
    if (vscode.window.activeTextEditor?.document !== document) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
    if (vscode.window.activeTextEditor?.document !== document) {
      await new Promise<void>((resolve, reject) => {
        const listener = vscode.window.onDidChangeActiveTextEditor(editor => {
          if (editor?.document === document) { clearTimeout(timer); listener.dispose(); resolve(); }
        });
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error(`Expected ${file} to become active, found ${vscode.window.activeTextEditor?.document.fileName}`));
        }, 15_000);
      });
    }
    assert.equal(document.languageId, 'ferret');
    assert.equal(document.isDirty, false);
  }

  async function run(file: string, options: object = {}): Promise<void> {
    await focus(file);
    await vscode.commands.executeCommand('ferret.runFile', options);
  }

  async function startBlockedRun(file: string, options: object = {}): Promise<void> {
    await focus(file);
    blockedRun = file;
    await vscode.commands.executeCommand('ferret.runFile', options);
  }

  async function stopBlockedRun(): Promise<void> {
    let cancellation: Thenable<unknown> | undefined;
    try {
      if (blockedRun) {
        await focus(blockedRun);
        cancellation = vscode.commands.executeCommand('ferret.cancelExecution');
      }
    } finally {
      // A pending acquisition can finish cancelling only after compilation returns.
      host?.command('releaseAll');
    }
    await cancellation;
    blockedRun = undefined;
  }

  async function reload(): Promise<void> {
    await vscode.commands.executeCommand('ferret.reloadRuntimes');
  }

  async function released(file: string, ordinal = 1): Promise<number> {
    const id = await host!.binding(uri(file).fsPath, ordinal);
    await host!.waitForGracefulRelease(id);
    assert.equal(host!.count('engineClosed'), 0);
    return id;
  }

  function breakpoint(file: string, line: number): void {
    const point = new vscode.SourceBreakpoint(new vscode.Location(uri(file), new vscode.Position(line - 1, 0)));
    breakpoints.push(point);
    vscode.debug.addBreakpoints([point]);
  }

  async function inspect(debug: DebugObserver, file: string, line: number, value: number): Promise<number> {
    const stop = await debug.wait(m => m.event === 'stopped');
    assert.equal(stop.body?.reason, 'breakpoint');
    const threadId = stop.body.threadId!;
    const session = debug.session!;
    const { stackFrames } = await session.customRequest('stackTrace', { threadId });
    const frame = stackFrames[0];
    assert.equal(relative(uri(file).fsPath, frame.source.path), '');
    assert.equal(frame.line, line);
    const { scopes } = await session.customRequest('scopes', { frameId: frame.id });
    const locals = scopes.find((s: { name: string }) => s.name === 'Locals');
    const { variables } = await session.customRequest('variables', { variablesReference: locals.variablesReference });
    assert.ok(variables.some((v: { name: string; value: string }) => v.name === 'value' && v.value === String(value)));
    return threadId;
  }

  async function completed(debug: DebugObserver, expected: string, name = 'App'): Promise<void> {
    assert.equal((await debug.wait(m => m.command === 'launch')).body?.runtimeName, name);
    await debug.wait(m => m.event === 'output' && !!m.body?.output?.includes(expected));
    assert.equal((await debug.wait(m => m.event === 'exited')).body?.exitCode, 0);
    await debug.wait(m => m.event === 'terminated');
    await debug.waitForEditorEnd();
  }

  test('Reload preserves active bindings and survivors make independent progress', async () => {
    const daemon = processes.starts('serve');
    assert.equal(daemon.length, 1);
    const shared = 'shared.fql';
    await program(shared, 'LET value = @block ? DEMO::BLOCK(@token) : DEMO::IDENTITY(@value)\nRETURN value');
    breakpoint(shared, 2);
    await host!.arm('block:surviving-run');
    await startBlockedRun(shared, { parameters: { block: true, token: 'surviving-run', value: 0 } });
    await host!.wait('held', 1, undefined, 'block:surviving-run');
    const runId = await host!.binding(uri(shared).fsPath);
    await reload(); // Run alone.
    assert.equal(processes.starts('serve').length, daemon.length);

    const survivor = await launch('survivor', shared, { parameters: { block: false, token: 'survivor', value: 101 } });
    await inspect(survivor, shared, 2, 101);
    const survivorId = await host!.binding(uri(shared).fsPath, 2);
    await reload(); // Both operations.
    assert.equal(processes.starts('serve').length, daemon.length);

    await program('finisher.fql', 'LET value = DEMO::IDENTITY(301)\nRETURN value + 1');
    breakpoint('finisher.fql', 2);
    const finisher = await launch('finisher', 'finisher.fql', {});
    const thread = await inspect(finisher, 'finisher.fql', 2, 301);
    await finisher.session!.customRequest('continue', { threadId: thread });
    await completed(finisher, '302');
    const finishedId = await released('finisher.fql');
    assert.equal(host!.count('debugStart', finishedId), 1);

    const stopped = await launch('stopped', shared, { parameters: { block: true, token: 'stop-only-me', value: 202 } });
    await host!.wait('entered', 1, undefined, 'stop-only-me');
    const stoppedId = await host!.binding(uri(shared).fsPath, 3);
    await vscode.debug.stopDebugging(stopped.session!);
    await host!.wait('cancelled', 1, undefined, 'stop-only-me');
    await host!.waitForGracefulRelease(stoppedId);
    assert.equal(new Set([finishedId, stoppedId, survivorId, runId]).size, 4);
    assert.equal(host!.count('released', survivorId), 0);
    assert.equal(host!.count('released', runId), 0);

    host!.command('release', 'block:surviving-run');
    await waitForExecutionOutput(/"surviving-run"\s+Completed [^\n]*shared\.fql/);
    await host!.waitForGracefulRelease(runId);
    blockedRun = undefined;
    const survivingThread = await inspect(survivor, shared, 2, 101);
    await survivor.session!.customRequest('continue', { threadId: survivingThread });
    await completed(survivor, '101');
    assert.equal(survivor.count(m => m.event === 'output' && !!m.body?.output?.includes('302')), 0);
    await host!.waitForGracefulRelease(survivorId);
    assert.equal(host!.count('released'), 4);
    await processes.closed(processes.starts('dap'));
    await reload();
    assert.equal(processes.starts('serve').length, 2);
    await processes.closed(daemon);

    await program('after-reload.fql', 'RETURN DEMO::IDENTITY(714)');
    await run('after-reload.fql');
    await waitForExecutionOutput(/714\s+Completed [^\n]*after-reload\.fql/);
    await released('after-reload.fql');
    await completed(await launch('after reload', 'after-reload.fql', {}), '714');
    await released('after-reload.fql', 2);
  });

  for (const transition of ['save another path', 'edit adopted file']) {
    test(`${transition} preserves a suspended launch and requires explicit Reload`, async () => {
      await program('captured.fql', 'LET value = DEMO::IDENTITY(50)\nRETURN value + 1');
      await program('probe.fql', 'RETURN DEMO::IDENTITY(321)');
      breakpoint('captured.fql', 2);
      const captured = await launch('captured', 'captured.fql', {});
      const threadId = await inspect(captured, 'captured.fql', 2, 50);
      const daemon = processes.starts('serve');
      await reload(); // Only this suspended Debug holds an activity reservation.
      assert.deepEqual(processes.starts('serve'), daemon);
      assert.equal(daemon[0]!.exitCode, null);
      const changedPath = transition === 'save another path';
      const alternate = join(source, 'alternate.json');
      await configureFile(changedPath ? alternate : config, 'Changed');
      if (changedPath) await settings.update('runtime.configPath', alternate, target);

      async function blocked(file: string): Promise<void> {
        await program(file, 'RETURN DEMO::IDENTITY(99)');
        await run(file);
        const failure = await waitForExecutionOutput(new RegExp('Execution failed: [^\\n]*' + file.replace('.', '\\.') + '\\s+[^\\n]*Reload Runtimes', 'i'));
        assert.ok(failure);
        const attempt = await Promise.resolve(vscode.debug.startDebugging(undefined, {
          type: 'ferret', request: 'launch', name: 'pending revision', program: uri(file).fsPath,
        })).catch(() => false);
        assert.equal(attempt, false);
        assert.equal(host!.count('connected'), 1);
        assert.equal(processes.starts('serve').length, daemon.length);
      }
      await blocked(changedPath ? 'pending-path.fql' : 'pending-bytes.fql');
      if (changedPath) {
        await settings.update('runtime.configPath', config, target);
        await blocked('restored-path.fql');
      }
      await captured.session!.customRequest('continue', { threadId });
      await completed(captured, '51');
      await released('captured.fql');
      await processes.closed(processes.starts('dap'));
      await reload();
      assert.equal(processes.starts('serve').length, 2);
      await completed(await launch('adopted', 'probe.fql', {}), '321', changedPath ? 'App' : 'Changed');
      await released('probe.fql');
    });
  }

  test('reads the runtime directory while breakpoints and Run use the secondary source workspace', async () => {
    const folder = vscode.workspace.getWorkspaceFolder(uri('read.fql'))!;
    assert.equal(folder.name, 'secondary');
    const primary = vscode.workspace.workspaceFolders!.find(f => f.name === 'primary')!;
    const twin = join(primary.uri.fsPath, basename(project));
    await mkdir(twin);
    primaryProject = twin;
    await mkdir(join(twin, '.tmp'));
    await writeFile(join(twin, '.tmp', 'read.fql'), 'RETURN "wrong workspace"');
    const wireDirectory = '\u2003data//leaf\u2003';
    // The fixture's Ferret engine trims its session FS root. Observe the raw
    // Wire field separately from the path that this application opens.
    const leaf = join(application, 'data', 'leaf');
    await mkdir(leaf, { recursive: true });
    await writeFile(join(leaf, 'marker.txt'), 'wire-marker');
    // Keep the external native directory on the checkout drive. On Windows the
    // Wire application under TMP can be on another volume.
    const nativeRoot = join(twin, 'native-runtime');
    await mkdir(nativeRoot);
    await writeFile(join(nativeRoot, 'marker.txt'), 'native-marker');
    const nativeDirectory = relative(folder.uri.fsPath, nativeRoot);
    assert.equal(isAbsolute(nativeDirectory), false);
    await program('read.fql', 'LET value = 7\nRETURN TO_STRING(IO::FS::READ("marker.txt"))');
    breakpoint('read.fql', 2);
    for (const [runtimeName, directory, marker] of [
      ['local', nativeDirectory, 'native-marker'],
      ['App', wireDirectory, 'wire-marker'],
    ] as const) {
      await run('read.fql', { runtimeName, workingDirectory: directory });
      await waitForExecutionOutput(new RegExp(marker + '"?\\s+Completed [^\\n]*read\\.fql'));
      await settings.update('run.workingDirectory', directory, target);
      await focus('read.fql');
      const debug = observe('Debug Current Ferret File');
      assert.equal(await vscode.commands.executeCommand('ferret.debugFile', { runtimeName }), true);
      const threadId = await inspect(debug, 'read.fql', 2, 7);
      assert.equal(relative(folder.uri.fsPath, debug.session!.configuration.cwd), '');
      await debug.session!.customRequest('continue', { threadId });
      await completed(debug, marker, runtimeName);
      if (runtimeName === 'local') assert.equal(host!.count('connected'), 0);
    }
    for (const [ordinal, event] of [[1, 'runSession'], [2, 'debugSession']] as const) {
      const id = await released('read.fql', ordinal);
      assert.equal((await host!.wait(event, 1, id)).root, wireDirectory);
    }
    assert.equal(processes.starts('serve').length, 1);
  });

  test('cancels the owned Run while compilation is held and permits Reload', async () => {
    const file = 'pending-cleanup.fql';
    await program(file, 'RETURN DEMO::BLOCK("pending-cleanup")');
    await host!.arm('compile');
    await host!.arm('block:pending-cleanup');
    const started = startBlockedRun(file);
    try {
      const id = (await host!.wait('held', 1, undefined, 'compile')).id;
      assert.ok(id);
      assert.equal(host!.count('entered'), 0);
      await stopBlockedRun();
      await started;
      await host!.waitForGracefulRelease(id);
      assert.equal(host!.count('entered'), 0);
      const original = processes.starts('serve');
      await reload();
      assert.equal(processes.starts('serve').length, original.length + 1);
      await processes.closed(original);
    } finally {
      try { await stopBlockedRun(); } finally { await started; }
    }
  });

  test('reports concurrent host loss and recovers through explicit launches', async () => {
    await writeFile(uri('blocked.fql').fsPath, 'RETURN DEMO::BLOCK("active")');
    await writeFile(uri('paused.fql').fsPath, 'RETURN DEMO::IDENTITY(42)');
    await program('lost-run.fql', 'RETURN DEMO::BLOCK("lost-run")');
    await host!.arm('block:lost-run');
    await startBlockedRun('lost-run.fql');
    await host!.wait('held', 1, undefined, 'block:lost-run');
    const active = await launch('running host loss', 'blocked.fql', {});
    await host!.wait('entered', 1, undefined, 'active');
    const paused = await launch('paused host loss', 'paused.fql', { stopOnEntry: true });
    await paused.wait(m => m.event === 'stopped');
    const originalEndpoint = (await host!.wait('ready')).endpoint;
    const lostHost = host!;
    await lostHost.kill();
    host = undefined;
    await assert.rejects(lostHost.kill(), /already exited/);
    for (const debug of [paused, active]) {
      const diagnostic = await debug.wait(m => m.event === 'output' && m.body?.category === 'stderr');
      assert.ok(diagnostic.body?.output?.trim());
      if (debug === paused) assert.match(diagnostic.body?.output ?? '', /App/);
      assert.equal((await debug.wait(m => m.event === 'exited')).body?.exitCode, 1);
      await debug.wait(m => m.event === 'terminated');
    }
    await waitForExecutionOutput(/Execution failed: [^\n]*lost-run\.fql\s+[^\n]*(unavailable|connection|transport|EOF|closed)/i);
    blockedRun = undefined;
    await processes.closed(processes.starts('dap'));
    const offline = observe('offline application');
    // VS Code versions surface failed launches as either false or a rejected promise.
    const attempt = Promise.resolve(vscode.debug.startDebugging(undefined, { type: 'ferret', request: 'launch',
      name: 'offline application', program: uri('paused.fql').fsPath })).catch(() => false);
    const failed = await offline.wait(m => m.command === 'launch');
    assert.equal(failed.success, false);
    assert.match(failed.message ?? '', /App.*unavailable|unavailable.*App/i);
    await attempt;
    await processes.closed(processes.starts('dap'));
    const daemons = processes.starts('serve');
    await startHost(originalEndpoint);
    assert.notEqual((await host!.wait('ready')).endpoint, originalEndpoint);
    assert.equal(processes.starts('serve').length, daemons.length + 1);
    assert.equal(host!.count('connected'), 0);
    await run('paused.fql');
    await waitForExecutionOutput(/42\s+Completed [^\n]*paused\.fql/);
    await released('paused.fql');
    const fresh = await launch('restored host', 'paused.fql', {});
    await completed(fresh, '42');
    await released('paused.fql', 2);
    assert.equal(host!.count('connected'), 2);
    assert.equal(host!.count('entered'), 0);
  });
});
