import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { ConfiguredTraceOutputChannel } from '../trace-output';

suite('Ferret language server trace output', () => {
  test('maps the conventional trace setting to language-client tracing', async () => {
    const configuration = vscode.workspace.getConfiguration('ferret');
    const output = vscode.window.createOutputChannel(
      `Ferret trace test ${Date.now()}`,
      { log: true },
    );

    await configuration.update(
      'trace.server',
      'off',
      vscode.ConfigurationTarget.Global,
    );
    const traceOutput = new ConfiguredTraceOutputChannel(output);

    try {
      assert.strictEqual(traceOutput.logLevel, vscode.LogLevel.Info);

      await configuration.update(
        'trace.server',
        'messages',
        vscode.ConfigurationTarget.Global,
      );
      await waitForTraceLevel(traceOutput, vscode.LogLevel.Trace);

      await configuration.update(
        'trace.server',
        'off',
        vscode.ConfigurationTarget.Global,
      );
      await waitForTraceLevel(traceOutput, vscode.LogLevel.Info);
    } finally {
      traceOutput.dispose();
      output.dispose();
      await configuration.update(
        'trace.server',
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
  });
});

async function waitForTraceLevel(
  output: ConfiguredTraceOutputChannel,
  expected: vscode.LogLevel,
): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (output.logLevel !== expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  assert.strictEqual(output.logLevel, expected);
}
