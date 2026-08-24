import * as assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  access,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
class SmokeOutput {
  errors = [];
  infos = [];

  error(message) {
    this.errors.push(message);
  }

  info(message) {
    this.infos.push(message);
  }
  show() {}
}

const binary =
  process.env.FERRETD_TEST_PATH ??
  join(
    packageRoot,
    'bin',
    process.platform === 'win32' ? 'ferretd.exe' : 'ferretd',
  );

try {
  await access(
    binary,
    process.platform === 'win32' ? constants.F_OK : constants.X_OK,
  );
} catch {
  if (process.env.CI !== undefined) {
    throw new Error(
      `Daemon transport smoke requires a ferretd executable in CI: ${binary}`,
    );
  }
  console.log(`Skipped daemon transport smoke; binary not found: ${binary}`);
  process.exitCode = 0;
}

if (process.exitCode === undefined) {
  const require = createRequire(import.meta.url);
  const { DaemonController } = require('../out/daemon/manager.js');
  const { FerretExecutionClient } = require(
    '../out/execution/client.js',
  );
  const root = await mkdtemp(join(tmpdir(), 'ferret-daemon-smoke-'));
  const output = new SmokeOutput();
  const controller = new DaemonController(
    () => ({
      executable: binary,
      extraArguments: ['--must-remain-lsp-only'],
      source: 'configured',
    }),
    output,
  );

  try {
    await writeFile(join(root, 'query.fql'), 'RETURN @value\n');
    await controller.updateWorkspaceFolders([root]);
    await controller.start();
    controller.requireConnection();

    const resolved = controller.workspaceRegistry.resolveDocument(
      join(root, 'query.fql'),
    );
    assert.ok(resolved, 'daemon did not register the temporary workspace');
    const client = new FerretExecutionClient(controller);
    const session = await client.createSession(
      resolved.workspaceId,
      resolved.relativePath,
    );
    assert.deepStrictEqual(session.parameters, ['value']);

    const execution = await client.createExecution(session.id, {
      value: 42,
    });
    const completedEvents = await observeAfter(
      client,
      execution.id,
      () => client.runExecution(execution.id),
    );
    assert.deepStrictEqual(
      completedEvents.map((event) => event.kind),
      ['created', 'started', 'completed'],
    );
    const completed = completedEvents.at(-1)?.execution;
    assert.strictEqual(completed?.status, 'completed');
    assert.strictEqual(completed?.output?.contentType, 'application/json');
    assert.strictEqual(
      JSON.parse(Buffer.from(completed?.output?.data ?? []).toString('utf8')),
      42,
    );
    await client.closeExecution(execution.id);

    await writeFile(
      join(root, 'query.fql'),
      'RETURN [@value, 84]\n',
    );
    const refreshedSession = await client.createSession(
      resolved.workspaceId,
      resolved.relativePath,
    );
    assert.ok(
      refreshedSession.source.revision > session.source.revision,
      'refreshed source revision did not advance',
    );
    assert.deepStrictEqual(refreshedSession.parameters, ['value']);

    const refreshedExecution = await client.createExecution(
      refreshedSession.id,
      { value: 7 },
    );
    const refreshedEvents = await observeAfter(
      client,
      refreshedExecution.id,
      () => client.runExecution(refreshedExecution.id),
    );
    assert.deepStrictEqual(
      refreshedEvents.map((event) => event.kind),
      ['created', 'started', 'completed'],
    );
    const refreshed = refreshedEvents.at(-1)?.execution;
    assert.strictEqual(refreshed?.status, 'completed');
    assert.deepStrictEqual(
      JSON.parse(
        Buffer.from(refreshed?.output?.data ?? []).toString('utf8'),
      ),
      [7, 84],
    );
    await client.closeExecution(refreshedExecution.id);

    const retainedExecution = await client.createExecution(session.id, {
      value: 43,
    });
    const retainedEvents = await observeAfter(
      client,
      retainedExecution.id,
      () => client.runExecution(retainedExecution.id),
    );
    const retained = retainedEvents.at(-1)?.execution;
    assert.strictEqual(retained?.status, 'completed');
    assert.strictEqual(
      JSON.parse(
        Buffer.from(retained?.output?.data ?? []).toString('utf8'),
      ),
      43,
    );
    await client.closeExecution(retainedExecution.id);

    const cancellable = await client.createExecution(refreshedSession.id, {
      value: 0,
    });
    const cancelledEvents = await observeAfter(
      client,
      cancellable.id,
      () => client.cancelExecution(cancellable.id),
    );
    assert.deepStrictEqual(
      cancelledEvents.map((event) => event.kind),
      ['created', 'cancelled'],
    );
    assert.strictEqual(
      cancelledEvents.at(-1)?.execution.status,
      'cancelled',
    );
    await client.closeExecution(cancellable.id);
    await client.closeSession(refreshedSession.id);
    await client.closeSession(session.id);
    console.log(
      `Daemon execution transport smoke passed on ${process.platform}-${process.arch}.`,
    );
  } catch (error) {
    for (const line of output.infos) {
      console.error(line);
    }
    for (const line of output.errors) {
      console.error(line);
    }
    throw error;
  } finally {
    await controller.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function observeAfter(client, executionId, operation) {
  const abort = new AbortController();
  const iterator = client.watchExecution(executionId, abort.signal)[
    Symbol.asyncIterator
  ]();
  const events = [];

  try {
    const current = await nextWithTimeout(iterator, abort);
    assert.strictEqual(current.done, false);
    events.push(current.value);
    const operationResult = await operation();
    assert.ok(
      operationResult.status === 'running' ||
        operationResult.status === 'cancelled',
    );

    while (true) {
      const next = await nextWithTimeout(iterator, abort);
      if (next.done) {
        return events;
      }
      events.push(next.value);
    }
  } finally {
    abort.abort();
  }
}

async function nextWithTimeout(iterator, abort) {
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('timed out waiting for daemon execution event'));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
