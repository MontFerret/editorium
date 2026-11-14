import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';
import { extensionId } from '../test/extension-identity';
import { DebugObserver } from './debug-observer';
import { WireHost } from './wire-host';

suite('Wire debugging through VS Code', () => {
  const target = vscode.ConfigurationTarget.Global;
  let project: string, source: string, application: string, config: string;
  let host: WireHost | undefined;
  let observers: DebugObserver[];
  let breakpoints: vscode.SourceBreakpoint[];
  let settings: vscode.WorkspaceConfiguration;
  const uri = (name: string) => vscode.Uri.file(join(source, name));

  async function startHost(): Promise<void> {
    const binary = process.env.FERRET_WIRE_HOST_PATH;
    assert.ok(binary);
    host = new WireHost(binary, application);
    const { endpoint } = await host.wait('ready');
    await writeFile(config, JSON.stringify({ defaultRuntime: 'App', runtimes: [
      { name: 'App', provider: 'wire', insecure: true, endpoint },
    ] }));
    await settings.update('runtime.configPath', config, target);
    await vscode.commands.executeCommand('ferret.reloadRuntimes');
  }

  setup(async () => {
    observers = [];
    breakpoints = [];
    settings = vscode.workspace.getConfiguration('ferret');
    await settings.update('server.path', process.env.FERRETD_TEST_PATH, target);
    await vscode.extensions.getExtension(extensionId)!.activate();
    project = await mkdtemp(join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, 'ferret-debug-'));
    source = join(project, '.tmp');
    await mkdir(source);
    application = await mkdtemp(join(tmpdir(), 'ferret-host-'));
    config = join(source, 'runtimes.json');
    await startHost();
  });

  teardown(async () => {
    vscode.debug.removeBreakpoints(breakpoints);
    for (const observer of observers) {
      if (observer.session) await vscode.debug.stopDebugging(observer.session);
      observer.dispose();
    }
    await host?.close();
    host = undefined;
    await settings.update('runtime.configPath', undefined, target);
    await settings.update('run.parameters', undefined, target);
    await vscode.commands.executeCommand('ferret.reloadRuntimes');
    await rm(project, { recursive: true, force: true });
    await rm(application, { recursive: true, force: true });
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

  test('Stop releases only its binding while another Debug and Run continue on the same application', async () => {
    const program = uri('block.fql');
    await writeFile(program.fsPath, 'RETURN DEMO::BLOCK(@token)');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(program));
    await vscode.commands.executeCommand('ferret.runFile', { parameters: { token: 'run' } });
    await host!.wait('entered', 1, undefined, 'run');
    try {
      for (const token of ['first', 'second']) {
        const debug = await launch(token, 'block.fql', { runtimeName: 'App', parameters: { token } });
        await host!.wait('entered', 1, undefined, token);
        assert.equal((await debug.wait(m => m.command === 'launch')).body?.runtimeName, 'App');
      }
      const id = (await host!.wait('connected', 2)).id;
      await vscode.debug.stopDebugging(observers[0]!.session);
      await host!.wait('cancelled', 1, undefined, 'first');
      await host!.wait('released', 1, id);
      assert.equal(host!.count('released'), 1);
      assert.equal(host!.count('engineClosed'), 0);
      await vscode.debug.stopDebugging(observers[1]!.session);
      await host!.wait('released', 2);
    } finally {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(program));
      await vscode.commands.executeCommand('ferret.cancelExecution');
    }
    await host!.wait('released', 3);
    await writeFile(uri('again.fql').fsPath, 'RETURN DEMO::IDENTITY(42)');
    const again = await launch('fresh binding', 'again.fql', {});
    await again.wait(m => m.event === 'output' && !!m.body?.output?.includes('42'));
    await host!.wait('released', 4);
  });

  test('reports loss of a running and a suspended host without another debug request', async () => {
    await writeFile(uri('blocked.fql').fsPath, 'RETURN DEMO::BLOCK("active")');
    await writeFile(uri('paused.fql').fsPath, 'RETURN DEMO::IDENTITY(42)');
    const active = await launch('running host loss', 'blocked.fql', {});
    await host!.wait('entered', 1, undefined, 'active');
    const paused = await launch('paused host loss', 'paused.fql', { stopOnEntry: true });
    await paused.wait(m => m.event === 'stopped');
    await host!.close();
    host = undefined;
    for (const debug of [paused, active]) {
      const diagnostic = await debug.wait(m => m.event === 'output' && m.body?.category === 'stderr');
      assert.ok(diagnostic.body?.output?.trim());
      if (debug === paused) assert.match(diagnostic.body?.output ?? '', /App/);
      assert.equal((await debug.wait(m => m.event === 'exited')).body?.exitCode, 1);
      await debug.wait(m => m.event === 'terminated');
    }
    const offline = observe('offline application');
    // VS Code versions surface failed launches as either false or a rejected promise.
    const attempt = Promise.resolve(vscode.debug.startDebugging(undefined, { type: 'ferret', request: 'launch',
      name: 'offline application', program: uri('paused.fql').fsPath })).catch(() => false);
    const failed = await offline.wait(m => m.command === 'launch');
    assert.equal(failed.success, false);
    assert.match(failed.message ?? '', /App.*unavailable|unavailable.*App/i);
    await attempt;
    await startHost();
    const fresh = await launch('restored host', 'paused.fql', {});
    await fresh.wait(m => m.event === 'output' && !!m.body?.output?.includes('42'));
    await host!.wait('released');
    assert.equal(host!.count('connected'), 1);
  });
});
