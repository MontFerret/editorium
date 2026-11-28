import * as assert from 'node:assert/strict';
import { relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import * as vscode from 'vscode';

import { debugFileCommand } from '../debug/commands';
import { extensionId } from '../test/extension-identity';
import { DebugObserver } from './debug-observer';
import { FerretdProcesses } from './ferretd-processes';

const debugType = 'ferret';
const explicitSessionName = 'Ferret DAP integration';
const currentFileSessionName = 'Debug Current Ferret File';
const eventTimeout = 15_000;

suite('ferretd DAP integration', () => {
  test('uses native F5 without a launch configuration', async () => {
    await runCurrentFileDebugSession(() => vscode.commands.executeCommand('workbench.action.debug.start'));
  });

  test('starts the active file through the Ferret debug command', async () => {
    await runCurrentFileDebugSession(() =>
      vscode.commands.executeCommand(debugFileCommand),
    );
  });

  test('uses a working directory override with the unconfigured local adapter', async () => {
    await configureFerretd();
    const root = await mkdtemp(join(tmpdir(), 'ferret-dap-source-'));
    const directory = await mkdtemp(join(tmpdir(), 'ferret-dap-runtime-'));
    const program = join(root, 'read.fql');
    const name = 'Local runtime directory';
    const observer = new DebugObserver(name);
    const processes = new FerretdProcesses(requireFerretdPath());
    try {
      await writeFile(program, 'RETURN TO_STRING(IO::FS::READ("marker.txt"))');
      await writeFile(join(root, 'marker.txt'), 'compilation root');
      await writeFile(join(directory, 'marker.txt'), 'local runtime override');
      assert.equal(await vscode.debug.startDebugging(undefined, {
        type: debugType, request: 'launch', name, program, cwd: root,
        runtimeName: '', workingDirectory: relative(root, directory),
      }), true);
      assert.equal((await observer.wait(m => m.command === 'launch')).body?.runtimeName, 'local');
      await observer.wait(m => m.event === 'output' && !!m.body?.output?.includes('local runtime override'));
      await observer.wait(m => m.event === 'terminated');
    } finally {
      try { await observer.stopIfActive(); }
      finally {
        observer.dispose();
        processes.dispose();
        await processes.closed(processes.starts('dap'));
        await removeFixtureDirectory(directory);
        await removeFixtureDirectory(root);
      }
    }
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
    const processes = new FerretdProcesses(requireFerretdPath());
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
      try { if (session) await vscode.debug.stopDebugging(session); }
      finally {
        vscode.debug.removeBreakpoints([breakpoint]);
        stops.dispose();
        tracker.dispose();
        processes.dispose();
        await processes.closed(processes.starts('dap'));
        await removeFixtureDirectory(root);
      }
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

function removeFixtureDirectory(directory: string): Promise<void> {
  // Windows editor and filesystem watchers can release handles after the adapter closes.
  return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

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
