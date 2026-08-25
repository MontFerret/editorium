import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { debugFileCommand } from '../debug/commands';
import { extensionId } from '../test/extension-identity';

const debugType = 'ferret';
const explicitSessionName = 'Ferret DAP integration';
const currentFileSessionName = 'Debug Current Ferret File';
const eventTimeout = 15_000;

suite('ferretd DAP integration', () => {
  test('starts the active file through the standard F5 action', async () => {
    await runCurrentFileDebugSession(() =>
      vscode.commands.executeCommand('workbench.action.debug.start'),
    );
  });

  test('starts the active file through the Ferret debug command', async () => {
    await runCurrentFileDebugSession(() =>
      vscode.commands.executeCommand(debugFileCommand),
    );
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
    assert.strictEqual(session.type, debugType);
    assert.strictEqual(session.name, currentFileSessionName);
    assert.strictEqual(session.configuration.program, program.fsPath);
    assert.strictEqual(session.configuration.cwd, secondary.uri.fsPath);
    assert.strictEqual(session.configuration.stopOnEntry, false);

    const stopped = await terminated;
    assert.strictEqual(stopped.id, session.id);
    sessionTerminated = true;
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
