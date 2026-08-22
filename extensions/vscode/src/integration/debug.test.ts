import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

const extensionId = 'ferretlang.fql';
const debugType = 'ferret';
const sessionName = 'Ferret DAP integration';
const eventTimeout = 15_000;

suite('ferretd DAP integration', () => {
  test('launches and terminates through the registered debug adapter', async () => {
    const executable = requireFerretdPath();
    await vscode.workspace
      .getConfiguration('ferret')
      .update(
        'server.path',
        executable,
        vscode.ConfigurationTarget.Global,
      );

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected VS Code to load ${extensionId}`);
    const program = vscode.Uri.joinPath(
      extension.extensionUri,
      'test',
      'fixtures',
      'execution',
      'success.fql',
    );
    const started = waitForDebugSession(
      vscode.debug.onDidStartDebugSession,
      'start',
    );
    const terminated = waitForDebugSession(
      vscode.debug.onDidTerminateDebugSession,
      'terminate',
    );

    let session: vscode.DebugSession | undefined;
    let sessionTerminated = false;
    try {
      assert.strictEqual(
        await vscode.debug.startDebugging(undefined, {
          type: debugType,
          request: 'launch',
          name: sessionName,
          program: program.fsPath,
          parameters: { integration: true },
          stopOnEntry: false,
        }),
        true,
      );
      session = await started;
      assert.strictEqual(session.type, debugType);
      assert.strictEqual(session.name, sessionName);

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
