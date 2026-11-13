import * as assert from 'node:assert/strict';
import { basename, relative, join } from 'node:path';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import * as vscode from 'vscode';

import { debugFileCommand } from '../debug/commands';
import { extensionId } from '../test/extension-identity';

const debugType = 'ferret';
const explicitSessionName = 'Ferret DAP integration';
const currentFileSessionName = 'Debug Current Ferret File';
const eventTimeout = 15_000;

suite('ferretd DAP integration', () => {
  test('persists picker selection across Reload and restores local Run and F5', async () => {
    await configureFerretd();
    await vscode.extensions.getExtension(extensionId)!.activate();
    const folder = vscode.workspace.workspaceFolders![0]!;
    const root = await mkdtemp(join(folder.uri.fsPath, 'ferret-runtime-test-'));
    const config = join(root, 'runtimes.json');
    const settings = vscode.workspace.getConfiguration('ferret');
    const save = (path?: string) => settings.update('runtime.configPath', path, vscode.ConfigurationTarget.Global);
    const program = join(root, 'guard.fql');
    const result = join(root, 'result.txt');
    const pick = async (position: 'first' | 'last') => {
      await vscode.commands.executeCommand('ferret.selectRuntime');
      await vscode.commands.executeCommand('quickInput.' + position);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    };
    const launch = { type: debugType, request: 'launch', name: 'Guarded Ferret launch', program };
    try {
      await writeFile(config, JSON.stringify({ defaultRuntime: 'offline', runtimes: [{
        name: 'offline', label: 'Offline', provider: 'wire', endpoint: 'tcp://127.0.0.1:1', insecure: true,
      }] }));
      await writeFile(program, `RETURN IO::FS::WRITE("${basename(root)}/result.txt", TO_BINARY("local Run"))\n`);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(program));
      await vscode.window.showTextDocument(doc);
      await save(config);
      await vscode.commands.executeCommand('ferret.reloadRuntimes');
      // The bundled catalog is ordered by name: Daemon default, local, offline.
      await pick('last');
      await vscode.commands.executeCommand('ferret.runFile');
      assert.equal(await vscode.debug.startDebugging(undefined, launch), false);
      await save();
      assert.equal(await vscode.debug.startDebugging(undefined, launch), false);
      await vscode.commands.executeCommand('ferret.reloadRuntimes');
      await vscode.commands.executeCommand('ferret.runFile');
      assert.equal(await vscode.debug.startDebugging(undefined, launch), false, 'the unavailable saved name still gates Debug');
      await assert.rejects(readFile(result), { code: 'ENOENT' });
      await pick('first');
      for (const options of [{ runtimeName: 'local' }, { RuntimeName: 'local' }, { debugServer: 1234 }]) {
        assert.equal(await vscode.debug.startDebugging(undefined, { ...launch, ...options }), false);
      }
      const watcher = watch(root);
      try {
        const created = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Local Run did not write its result')), eventTimeout);
          watcher.once('close', () => clearTimeout(timeout));
          watcher.on('change', () => {
            void readFile(result, 'utf8').then(value => {
              if (value === 'local Run') resolve();
            }, () => {});
          });
        });
        await Promise.all([created, vscode.commands.executeCommand('ferret.runFile')]);
      } finally {
        watcher.close();
      }
      await runCurrentFileDebugSession(() => vscode.commands.executeCommand('workbench.action.debug.start'));
    } finally {
      await save();
      await pick('first');
      await rm(root, { recursive: true, force: true });
    }
  });

  test('starts the active file through the Ferret debug command', async () => {
    await runCurrentFileDebugSession(() =>
      vscode.commands.executeCommand(debugFileCommand),
    );
  });

  test('forwards a breakpoint, frame inspection, evaluation, and a step through the owned process', async () => {
    await configureFerretd();
    const root = await mkdtemp(join(tmpdir(), 'ferret-dap-inspect-'));
    const program = join(root, 'inspect.fql');
    const name = 'Inspect Ferret runtime transport';
    const breakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(program), new vscode.Position(1, 0)),
    );
    const stops = new vscode.EventEmitter<{ threadId: number; reason: string }>();
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory(debugType, {
      createDebugAdapterTracker: session => session.name === name ? {
        onDidSendMessage: message => {
          if (message.type === 'event' && message.event === 'stopped') stops.fire(message.body);
        },
      } : undefined,
    });
    const nextStop = () => new Promise<{ threadId: number; reason: string }>(resolve => {
      const listener = stops.event(stop => { listener.dispose(); resolve(stop); });
    });
    let session: vscode.DebugSession | undefined;
    try {
      await writeFile(program, 'LET value = 1\nLET nextValue = value + 1\nRETURN nextValue\n');
      vscode.debug.addBreakpoints([breakpoint]);
      const started = waitForDebugSession(vscode.debug.onDidStartDebugSession, 'start', name);
      const first = nextStop();
      await vscode.debug.startDebugging(undefined, { type: debugType, request: 'launch', name, cwd: root, program });
      session = await started;
      const stop = await first;
      assert.equal(stop.reason, 'breakpoint');
      const { stackFrames } = await session.customRequest('stackTrace', { threadId: stop.threadId });
      const frameId = stackFrames[0].id;
      const { scopes } = await session.customRequest('scopes', { frameId });
      const { variables } = await session.customRequest('variables', { variablesReference: scopes[0].variablesReference });
      assert.ok(variables.some((v: { name: string; value: string }) => v.name === 'value' && v.value === '1'));
      const evaluated = await session.customRequest('evaluate', { frameId, expression: 'value + 1', context: 'watch' });
      assert.equal(evaluated.result, '2');
      const second = nextStop();
      await session.customRequest('next', { threadId: stop.threadId });
      const stepped = await second;
      assert.equal(stepped.reason, 'step');
      const ended = waitForDebugSession(vscode.debug.onDidTerminateDebugSession, 'terminate', name);
      await session.customRequest('continue', { threadId: stepped.threadId });
      await ended;
      session = undefined;
    } finally {
      if (session) await vscode.debug.stopDebugging(session);
      vscode.debug.removeBreakpoints([breakpoint]);
      stops.dispose();
      tracker.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('launches and terminates through the registered debug adapter', async () => {
    await configureFerretd();

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected VS Code to load ${extensionId}`);
    const program = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'execution',
      'success.fql',
    );
    const cwd = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'execution',
    );
    const parameters = { integration: true };
    const started = waitForDebugSession(
      vscode.debug.onDidStartDebugSession,
      'start',
      explicitSessionName,
    );
    const terminated = waitForDebugSession(
      vscode.debug.onDidTerminateDebugSession,
      'terminate',
      explicitSessionName,
    );

    let session: vscode.DebugSession | undefined;
    let sessionTerminated = false;
    try {
      assert.strictEqual(
        await vscode.debug.startDebugging(undefined, {
          type: debugType,
          request: 'launch',
          name: explicitSessionName,
          program: program.fsPath,
          cwd: cwd.fsPath,
          parameters,
          stopOnEntry: false,
        }),
        true,
      );
      session = await started;
      assert.strictEqual(session.type, debugType);
      assert.strictEqual(session.name, explicitSessionName);
      assert.strictEqual(session.configuration.program, program.fsPath);
      assert.strictEqual(session.configuration.cwd, cwd.fsPath);
      assert.deepStrictEqual(
        session.configuration.parameters,
        parameters,
      );
      assert.strictEqual(session.configuration.stopOnEntry, false);

      const stopped = await terminated;
      assert.strictEqual(stopped.id, session.id);
      sessionTerminated = true;
    } finally {
      if (session !== undefined && !sessionTerminated) {
        await vscode.debug.stopDebugging(session);
      }
    }
  });
});

async function runCurrentFileDebugSession(
  start: () => Thenable<unknown>,
): Promise<void> {
  await configureFerretd();
  const secondary = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.name === 'secondary',
  );
  assert.ok(secondary, 'Expected the secondary workspace folder');
  const program = vscode.Uri.joinPath(secondary.uri, 'secondary.fql');
  const document = await vscode.workspace.openTextDocument(program);
  await vscode.window.showTextDocument(document);
  const started = waitForDebugSession(
    vscode.debug.onDidStartDebugSession,
    'start',
    currentFileSessionName,
  );
  const terminated = waitForDebugSession(
    vscode.debug.onDidTerminateDebugSession,
    'terminate',
    currentFileSessionName,
  );

  let session: vscode.DebugSession | undefined;
  let sessionTerminated = false;
  try {
    const [, startedSession] = await Promise.all([start(), started]);
    session = startedSession;
    const stopped = await terminated;
    sessionTerminated = true;
    assert.strictEqual(stopped.id, session.id);
    assert.strictEqual(session.type, debugType);
    assert.strictEqual(session.name, currentFileSessionName);
    // VS Code's ${file} substitution can capitalize a Windows drive letter.
    assert.strictEqual(relative(program.fsPath, session.configuration.program), '',
      `Unexpected debug program: ${session.configuration.program}`);
    assert.strictEqual(relative(secondary.uri.fsPath, session.configuration.cwd), '',
      `Unexpected debug directory: ${session.configuration.cwd}`);
    assert.strictEqual(session.configuration.stopOnEntry, false);
  } finally {
    if (session !== undefined && !sessionTerminated) {
      await vscode.debug.stopDebugging(session);
    }
  }
}

async function configureFerretd(): Promise<void> {
  await vscode.workspace
    .getConfiguration('ferret')
    .update(
      'server.path',
      requireFerretdPath(),
      vscode.ConfigurationTarget.Global,
    );
}

function requireFerretdPath(): string {
  const executable = process.env.FERRETD_TEST_PATH;
  assert.ok(
    executable,
    'FERRETD_TEST_PATH must point to the pinned ferretd executable',
  );

  return executable;
}

function waitForDebugSession(
  event: vscode.Event<vscode.DebugSession>,
  eventName: string,
  sessionName: string,
): Promise<vscode.DebugSession> {
  return new Promise((resolveSession, rejectSession) => {
    const timer = setTimeout(() => {
      listener.dispose();
      rejectSession(
        new Error(
          `Timed out waiting for the Ferret debug session to ${eventName}`,
        ),
      );
    }, eventTimeout);
    const listener = event((session) => {
      if (session.type !== debugType || session.name !== sessionName) {
        return;
      }

      clearTimeout(timer);
      listener.dispose();
      resolveSession(session);
    });
  });
}
