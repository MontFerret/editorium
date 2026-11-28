import * as assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { posix, win32 } from 'node:path';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';

import { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { snapshotDebugArguments, prepareDebugArguments, type PreparedDebugLaunch } from '../debug/launch';
import { DapFrameReader } from '../debug/framing';
import { FerretDebugTransport } from '../debug/transport';
import { RuntimeCoordinator } from '../runtime/coordinator';

const output = { info() {}, error() {}, show() {} };
const executable = async () => ({ executable: '/ferretd', source: 'configured' as const });
const prepare = async () => ({
  executable: await executable(), selector: '', name: 'local', provider: 'native' as const,
  arguments: { program: '/main.fql' }, verifyConfiguration: async () => {},
});
const initialize = { seq: 1, type: 'request', command: 'initialize', arguments: { custom: '🦦' } };
const frame = (body: object) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
};

suite('owned Ferret debug adapter', () => {
  test('frames UTF-8 by bytes and transparently forwards split and coalesced messages', async () => {
    const child = new DebugChild();
    let closed = 0;
    const adapter = new FerretDebugTransport(prepare, output, () => { closed++; }, () => child.process);
    const messages: object[] = [];
    adapter.onDidSendMessage(message => messages.push(message));
    adapter.handleMessage(initialize);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.stdin.read(), frame(initialize));
    const reply = { seq: 2, type: 'response', request_seq: 1, success: true, body: { text: '🦦' } };
    const reverse = { seq: 3, type: 'request', command: 'runInTerminal', arguments: { custom: true } };
    const packet = Buffer.concat([frame(reply), frame(reverse)]);
    const cut = packet.indexOf(Buffer.from('🦦')) + 1;
    child.stdout.write(packet.subarray(0, cut));
    child.stdout.write(packet.subarray(cut));
    assert.deepEqual(messages, [reply, reverse]);
    adapter.dispose();
    const closing = adapter.shutdown();
    assert.equal(closed, 0);
    child.emit('close', 0);
    await closing;
    adapter.dispose();
    assert.equal(closed, 1);
  });

  test('preserves inspection capabilities, page identities, virtual metadata and targeted cancellation', async () => {
    for (const capabilities of [{}, { supportsVariablePaging: true, supportsVariableType: true }]) {
      const child = new DebugChild();
      const adapter = new FerretDebugTransport(prepare, output, () => {}, () => child.process);
      const messages: object[] = [];
      adapter.onDidSendMessage(m => messages.push(m));
      try {
        const init = { ...initialize, arguments: capabilities };
        adapter.handleMessage(init);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(child.stdin.read(), frame(init));
        const page = { type: 'request', seq: 42, command: 'variables',
          arguments: { variablesReference: 9, filter: 'indexed', start: 100, count: 100 } };
        const cancel = { type: 'request', seq: 44, command: 'cancel', arguments: { requestId: 42 } };
        adapter.handleMessage(page);
        adapter.handleMessage(cancel);
        assert.deepEqual(child.stdin.read(), Buffer.concat([frame(page), frame(cancel)]));
        const ack = { type: 'response', seq: 73, request_seq: 44, command: 'cancel', success: true };
        const reply = { type: 'response', seq: 74, request_seq: 42, command: 'variables', success: true, body: {
          variables: [{ name: '[100…]', value: '', variablesReference: 91, namedVariables: 0,
            presentationHint: { kind: 'virtual' } }, { name: 'e\u0301😀', value: 'Array(0)', type: 'Array',
            variablesReference: 0, indexedVariables: 0 }],
        } };
        child.stdout.write(Buffer.concat([frame(ack), frame(reply)]));
        assert.deepEqual(messages, [ack, reply]);
      } finally {
        adapter.dispose();
        child.emit('close', 0);
        await adapter.shutdown();
      }
    }
  });

  test('releases failed resolution and confirmed failed spawn, and waits for stream failure teardown', async () => {
    for (const failure of ['resolve', 'spawn', 'stream']) {
      const child = new DebugChild();
      let closed = 0;
      const adapter = new FerretDebugTransport(async () => {
        if (failure === 'resolve') throw new Error('missing executable');
        return prepare();
      }, output, () => { closed++; }, () => child.process);
      const messages: object[] = [];
      adapter.onDidSendMessage(message => messages.push(message));
      adapter.handleMessage(initialize);
      await new Promise(resolve => setImmediate(resolve));
      if (failure !== 'resolve') {
        if (failure === 'spawn') child.emit('error', new Error('spawn ENOENT'));
        else child.stdout.emit('error', new Error('stream broken'));
        assert.equal(closed, 0);
        child.emit('close');
      }
      await adapter.shutdown();
      assert.equal(closed, 1);
      assert.ok(messages.some(message => 'success' in message && message.success === false));
    }
    assert.throws(() => new DapFrameReader().push(Buffer.from('Content-Length: -1\r\n\r\n'), () => {}));
  });

  test('stop during executable resolution prevents spawn and holds admission until resolution settles', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof prepare>>) => void;
    const resolving = new Promise<Awaited<ReturnType<typeof prepare>>>(done => { resolve = done; });
    let ended = false;
    let spawned = false;
    const adapter = new FerretDebugTransport(() => resolving, output, () => { ended = true; }, () => {
      spawned = true;
      return new DebugChild().process;
    });
    adapter.handleMessage(initialize);
    const shutdown = adapter.shutdown();
    assert.equal(ended, false);
    resolve(await prepare());
    await shutdown;
    assert.equal(spawned, false);
    assert.equal(ended, true);
  });

  test('retains the reservation if forced termination fails until actual close', async () => {
    const child = new DebugChild();
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const lease = runtime.admitDebug();
    const errors: string[] = [];
    const adapter = new FerretDebugTransport(prepare, { ...output, error: m => errors.push(m) },
      lease.release, () => child.process, 0);
    adapter.handleMessage(initialize);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(adapter.shutdown(), /cleanup has not completed/);
    assert.equal(child.kills, 1);
    assert.ok(errors.some(m => m.includes('Remote cleanup could not be confirmed')));
    await assert.rejects(runtime.reload(), /finish/);
    child.emit('close');
    await new Promise(resolve => setImmediate(resolve));
    await runtime.reload();
    await runtime.shutdown();
  });

  test('gates the exact launch before writing it and checks acknowledgment before publishing stops', async () => {
    for (const scenario of [
      { capability: undefined, selector: '', ack: undefined, ok: true },
      { capability: true, selector: '', ack: 'wrong', ok: false },
      { capability: false, selector: 'local', ack: 'local', ok: false },
      { capability: undefined, selector: '', configPath: '/A', ack: 'App', ok: false },
      { capability: true, selector: '', configPath: '/A', ack: undefined, ok: false },
      { capability: true, selector: 'App', configPath: '/A', ack: 'local', ok: false },
      { capability: true, selector: 'App', configPath: '/A', ack: 'App', ok: true },
    ]) {
      const child = new DebugChild();
      const args = { program: '/fixture.fql', runtimeName: scenario.selector, parameters: { typed: [true, 4] } };
      let writes = 0;
      const adapter = new FerretDebugTransport(async () => ({
        ...await prepare(), name: scenario.configPath ? 'App' : 'local', selector: scenario.selector,
        configPath: scenario.configPath, arguments: args, verifyConfiguration: async () => { writes++; },
      }), output, () => {}, (_exe, argv) => {
        assert.deepEqual(argv, scenario.configPath ? ['dap', '--runtime-config', '/A'] : ['dap']);
        return child.process;
      });
      const messages: Array<{ success?: boolean; event?: string; request_seq?: number }> = [];
      adapter.onDidSendMessage(m => messages.push(m));
      const launch = { type: 'request', seq: 2, command: 'launch', arguments: {
        __sessionId: 'opaque', future: [7], RuntimeName: 'later', workingDirectory: 'late',
      } };
      adapter.handleMessage(initialize);
      adapter.handleMessage(launch);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(child.stdin.read(), frame(initialize));
      const init = { type: 'response', request_seq: 1, command: 'initialize', success: true,
        body: { supportsFerretRuntimeSelection: scenario.capability } };
      child.stdout.write(frame(init));
      await new Promise(resolve => setImmediate(resolve));
      if ((scenario.configPath || scenario.selector) && !scenario.capability) {
        assert.equal(child.stdin.read(), null);
        assert.equal(writes, 2);
      } else {
        const sent = { ...launch, arguments: { __sessionId: 'opaque', future: [7], ...args } };
        assert.deepEqual(child.stdin.read(), frame(sent));
        assert.equal(writes, 2);
        const configure = { seq: 3, type: 'request', command: 'configurationDone' };
        adapter.handleMessage(configure);
        assert.deepEqual(child.stdin.read(), frame(configure));
        const stop = { type: 'event', event: 'stopped' };
        const success = { type: 'response', request_seq: 2, command: 'launch', success: true,
          body: { runtimeName: scenario.ack } };
        child.stdout.write(Buffer.concat([frame(stop), frame(success), frame(stop)]));
      }
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(messages.filter(m => m.request_seq === 2).map(m => m.success), [scenario.ok]);
      assert.equal(messages.some(m => m.event === 'stopped'), scenario.ok);
      if (scenario.ok) assert.ok(messages.findIndex(m => m.request_seq === 2) < messages.findIndex(m => m.event === 'stopped'));
      adapter.dispose();
      child.emit('close');
      await adapter.shutdown();
    }
  });

  test('a failed pre-spawn fingerprint check prevents adapter startup', async () => {
    let spawned = false;
    const adapter = new FerretDebugTransport(async () => ({
      ...await prepare(), configPath: '/A', verifyConfiguration: async () => {
        throw new Error('Runtime configuration changed. Use Reload Runtimes.');
      },
    }), output, () => {}, () => { spawned = true; return new DebugChild().process; });
    const messages: Array<{ message?: string; request_seq?: number }> = [];
    adapter.onDidSendMessage(m => messages.push(m));
    adapter.handleMessage(initialize);
    await new Promise(resolve => setImmediate(resolve));
    await adapter.shutdown();
    assert.equal(spawned, false);
    assert.match(messages.find(m => m.request_seq === 1)?.message ?? '', /Reload/);
  });

  test('holds a launch during fingerprint verification and suppresses it on Stop or file change', async () => {
    for (const action of ['change', 'terminate', 'disconnect', 'cancel']) {
      const child = new DebugChild();
      let checked = 0, release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      let closed = 0;
      const adapter = new FerretDebugTransport(async () => ({
        ...await prepare(), configPath: '/A',
        verifyConfiguration: async () => {
          if (++checked === 2) {
            await waiting;
            if (action === 'change') throw new Error('file changed: Reload Runtimes');
          }
        },
      }), output, () => { closed++; }, () => child.process);
      const messages: Array<{ command?: string; message?: string; success?: boolean }> = [];
      adapter.onDidSendMessage(m => messages.push(m));
      adapter.handleMessage(initialize);
      await new Promise(resolve => setImmediate(resolve));
      child.stdin.read();
      child.stdout.write(frame({ type: 'response', request_seq: 1, success: true, body: { supportsFerretRuntimeSelection: true } }));
      adapter.handleMessage({ seq: 2, type: 'request', command: 'launch' });
      if (action !== 'change') {
        adapter.handleMessage({ seq: 3, type: 'request', command: action, arguments: { requestId: 2 } });
        assert.equal(child.stdin.read(), null);
        assert.ok(child.stdin.writableEnded);
        assert.ok(messages.some(m => m.command === action && m.success));
        assert.deepEqual(messages.filter(m => m.command === 'launch').map(m => m.message), ['cancelled']);
        child.emit('close');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, 0, 'closing stdio must join the held fingerprint check');
      }
      release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(child.stdin.read(), null, 'the held launch must never reach the adapter');
      if (action === 'change') child.emit('close');
      await adapter.shutdown();
      const replies = messages.filter(m => m.command === 'launch');
      assert.equal(replies.length, 1);
      assert.equal(replies[0]?.success, false);
      if (action === 'change') assert.match(replies[0]?.message ?? '', /Reload/);
      assert.equal(closed, 1);
    }
  });

  test('forwards cancellation of a blocked acquisition by its original launch request ID', async () => {
    const child = new DebugChild();
    const adapter = new FerretDebugTransport(prepare, output, () => {}, () => child.process);
    const replies: Array<{ request_seq?: number; success?: boolean; message?: string }> = [];
    adapter.onDidSendMessage(m => replies.push(m));
    adapter.handleMessage(initialize);
    await new Promise(resolve => setImmediate(resolve));
    child.stdin.read();
    child.stdout.write(frame({ type: 'response', request_seq: 1, success: true }));
    adapter.handleMessage({ seq: 6, type: 'request', command: 'launch' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(child.stdin.read()?.includes('"seq":6'));
    const cancel = { seq: 7, type: 'request', command: 'cancel', arguments: { requestId: 6 } };
    adapter.handleMessage(cancel);
    assert.deepEqual(child.stdin.read(), frame(cancel));
    child.stdout.write(frame({ type: 'response', request_seq: 7, success: true }));
    child.stdout.write(frame({ type: 'response', request_seq: 6, success: false, message: 'cancelled' }));
    child.emit('close');
    await adapter.shutdown();
    assert.deepEqual(replies.filter(m => m.request_seq === 6).map(m => m.message), ['cancelled']);
    assert.equal(child.kills, 0);
  });

  test('rechecks a configured adapter startup failure before settling initialize', async () => {
    for (const changed of [false, true]) {
      const child = new DebugChild();
      let checks = 0;
      const adapter = new FerretDebugTransport(async () => ({
        ...await prepare(), configPath: '/A',
        verifyConfiguration: async () => { if (++checks === 2 && changed) throw new Error('Reload Runtimes'); },
      }), output, () => {}, () => child.process);
      let message: string | undefined;
      adapter.onDidSendMessage(m => { if ('message' in m) message = m.message as string; });
      adapter.handleMessage(initialize);
      await new Promise(resolve => setImmediate(resolve));
      child.stderr.end('ferretd: invalid runtime configuration: expected JSON\n');
      child.emit('close', 1);
      await adapter.shutdown();
      assert.equal(checks, 2);
      assert.match(message ?? '', changed ? /Reload/ : /expected JSON/);
    }
  });

  test('captures typed parameters and literal Wire paths independently of later mutations', async () => {
    const config = { type: 'ferret', request: 'launch', name: 'query', program: '/root/query.fql',
      parameters: { value: [true, false] }, workingDirectory: ' C:\\application ' };
    const snapshot = snapshotDebugArguments(config);
    config.parameters.value.pop();
    const runtime: PreparedDebugLaunch = { ...await prepare(), provider: 'wire', name: 'App', selector: '' };
    assert.deepEqual(await prepareDebugArguments(snapshot, runtime), {
      parameters: { value: [true, false] }, workingDirectory: ' C:\\application ', program: '/root/query.fql',
    });
    assert.throws(() => snapshotDebugArguments({ ...config, parameters: { n: Infinity } }), /finite/);
    assert.throws(() => snapshotDebugArguments({ ...config, workingDirectory: null }), /string/);
  });

  test('uses one Windows drive spelling for compiler and debugger source paths', async () => {
    const config = { type: 'ferret', request: 'launch', name: 'query', program: 'C:\\Work\\Query.fql',
      cwd: 'c:\\Work', workingDirectory: 'D:\\Host' };
    const runtime = { ...await prepare(), provider: 'wire' as const };
    const snapshot = snapshotDebugArguments(config, win32);
    assert.deepEqual(await prepareDebugArguments(snapshot, runtime), {
      program: 'c:\\Work\\Query.fql', cwd: 'c:\\Work', workingDirectory: 'D:\\Host',
    });
    assert.equal(snapshotDebugArguments({ ...config, cwd: 'C:/Work' }, win32).cwd, 'c:/Work');
    assert.equal(snapshotDebugArguments({ ...config, cwd: undefined }, win32).root, 'c:\\Work');
    for (const program of ['Sub\\Query.fql', '\\\\Server\\Share\\Query.fql', 'C:Query.fql']) {
      assert.equal(snapshotDebugArguments({ ...config, program }, win32).program, program);
    }
    assert.equal(snapshotDebugArguments(config, posix).program, config.program);
  });

  test('requires positive adapter capability for a nonblank local working directory', async () => {
    for (const capability of [undefined, false, true]) {
      for (const directory of ['.', ' \t']) {
        const child = new DebugChild();
        const input = snapshotDebugArguments({ type: 'ferret', request: 'launch', name: 'local',
          program: __filename.replace(/\.js$/, '.fql'), workingDirectory: directory });
        const adapter = new FerretDebugTransport(async () => {
          const local = await prepare();
          return { ...local, arguments: await prepareDebugArguments(input, local) };
        }, output, () => {}, () => child.process);
        const replies: Array<{ request_seq?: number; success?: boolean; message?: string }> = [];
        adapter.onDidSendMessage(m => replies.push(m));
        const started = new Promise<void>(resolve => child.stdin.once('readable', resolve));
        adapter.handleMessage(initialize);
        adapter.handleMessage({ type: 'request', seq: 20, command: 'launch' });
        await started;
        assert.deepEqual(child.stdin.read(), frame(initialize));
        child.stdout.write(frame({ type: 'response', request_seq: 1, success: true,
          body: { supportsFerretRuntimeSelection: capability } }));
        await new Promise(resolve => setImmediate(resolve));
        if (!capability && directory === '.') {
          assert.equal(child.stdin.read(), null);
          assert.equal(replies.find(m => m.request_seq === 20)?.success, false);
          assert.match(replies.find(m => m.request_seq === 20)?.message ?? '', /workingDirectory/);
        } else {
          const bytes: Buffer = child.stdin.read();
          assert.ok(bytes.includes('"command":"launch"'));
          assert.equal(bytes.includes('"workingDirectory"'), directory === '.');
          child.stdout.write(frame({ type: 'response', request_seq: 20, success: true }));
          assert.equal(replies.find(m => m.request_seq === 20)?.success, true);
        }
        adapter.dispose();
        child.emit('close');
        await adapter.shutdown();
      }
    }
  });

  test('assembles a fragmented multi-megabyte payload and reads the following frame', () => {
    const first = { value: '🦦'.repeat(600_000) };
    const next = { value: 'next' };
    const bytes = Buffer.concat([frame(first), frame(next)]);
    const messages: object[] = [];
    const reader = new DapFrameReader();
    const split = bytes.indexOf('\r\n\r\n') + 1;
    reader.push(bytes.subarray(0, split), message => messages.push(message));
    reader.push(bytes.subarray(split, split + 2), message => messages.push(message));
    for (let i = split + 2; i < bytes.length; i += 997) {
      reader.push(bytes.subarray(i, i + 997), message => messages.push(message));
    }
    assert.deepEqual(messages, [first, next]);
  });

  test('first ordinary terminate forwards the request and forces a stalled child to close', async () => {
    const child = new DebugChild();
    let closed = 0;
    const killed = new Promise<void>(resolve => child.once('killed', resolve));
    const adapter = new FerretDebugTransport(prepare, output, () => { closed++; }, () => child.process, 0);
    const spawned = new Promise<void>(resolve => child.stdin.once('readable', resolve));
    adapter.handleMessage(initialize);
    await spawned;
    child.stdin.read();
    await child.launch(adapter);
    const terminate = { seq: 2, type: 'request', command: 'terminate' };
    adapter.handleMessage(terminate);
    assert.deepEqual(child.stdin.read(), frame(terminate));
    await killed;
    assert.ok(child.stdin.writableEnded);
    assert.equal(closed, 0);
    child.emit('close', 0);
    await adapter.shutdown();
    assert.equal(closed, 1);
  });

  test('slow cooperative Stop extends the grace period and holds Reload through close', async () => {
    const child = new DebugChild();
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const errors: string[] = [];
    const grace = 400;
    const adapter = new FerretDebugTransport(prepare, { ...output, error: m => errors.push(m) },
      runtime.admitDebug().release, () => child.process, grace);
    const messages: object[] = [];
    adapter.onDidSendMessage(message => messages.push(message));
    const spawned = new Promise<void>(resolve => child.stdin.once('readable', resolve));
    adapter.handleMessage(initialize);
    await spawned;
    child.stdin.read();
    await child.launch(adapter);
    messages.length = 0;
    const restart = { seq: 2, type: 'request', command: 'terminate', arguments: { restart: true } };
    const stop = { seq: 3, type: 'request', command: 'terminate' };
    const disconnect = { seq: 4, type: 'request', command: 'disconnect' };
    const refused = { type: 'response', request_seq: 2, command: 'terminate', success: false };
    const stopped = { type: 'response', request_seq: 3, command: 'terminate', success: true };
    const terminated = { type: 'event', event: 'terminated' };
    adapter.handleMessage(restart);
    child.stdout.write(frame(refused));
    adapter.handleMessage(stop);
    await assert.rejects(runtime.reload(), /finish/);
    await new Promise(resolve => setTimeout(resolve, grace * 0.65));
    child.stdout.write(Buffer.concat([frame(stopped), frame(terminated)]));
    await new Promise(resolve => setTimeout(resolve, grace * 0.65));
    assert.equal(child.stdin.writableEnded, false);
    adapter.handleMessage(disconnect);
    assert.deepEqual(child.stdin.read(), Buffer.concat([frame(restart), frame(stop), frame(disconnect)]));
    assert.deepEqual(messages, [refused, stopped, terminated]);
    await assert.rejects(runtime.reload(), /finish/);
    child.emit('close');
    await adapter.shutdown();
    assert.equal(child.kills, 0);
    assert.deepEqual(errors, []);
    await runtime.reload();
    await runtime.shutdown();
  });

  test('Stop during initialization cancels the queued launch and sends EOF', async () => {
    const child = new DebugChild();
    let closed = 0;
    const adapter = new FerretDebugTransport(prepare, output, () => { closed++; }, () => child.process);
    const replies: Array<{ request_seq?: number; message?: string; success?: boolean; event?: string }> = [];
    adapter.onDidSendMessage(m => replies.push(m));
    const spawned = new Promise<void>(resolve => child.stdin.once('readable', resolve));
    adapter.handleMessage(initialize);
    adapter.handleMessage({ seq: 65, type: 'request', command: 'launch' });
    await spawned;
    assert.deepEqual(child.stdin.read(), frame(initialize));
    child.stdout.write(frame({ type: 'event', event: 'stopped' }));
    adapter.handleMessage({ seq: 66, type: 'request', command: 'terminate' });
    assert.ok(child.stdin.writableEnded);
    child.stdout.write(frame({ type: 'response', request_seq: 1, success: true }));
    assert.equal(child.stdin.read(), null);
    assert.equal(closed, 0);
    child.emit('close');
    await adapter.shutdown();
    assert.equal(replies.find(m => m.request_seq === 66)?.success, true);
    assert.deepEqual(replies.filter(m => m.request_seq === 65).map(m => m.message), ['cancelled']);
    assert.equal(replies.some(m => m.event === 'stopped'), false);
    assert.equal(closed, 1);
    assert.equal(child.kills, 0);
  });

  test('protocol Stop before executable resolution suppresses spawn', async () => {
    let ready!: (value: Awaited<ReturnType<typeof prepare>>) => void;
    const resolving = new Promise<Awaited<ReturnType<typeof prepare>>>(resolve => { ready = resolve; });
    let closed!: () => void;
    const ended = new Promise<void>(resolve => { closed = resolve; });
    let spawned = false;
    const adapter = new FerretDebugTransport(() => resolving, output, closed, () => {
      spawned = true;
      return new DebugChild().process;
    });
    adapter.handleMessage(initialize);
    const replies: Array<{ request_seq?: number; message?: string; success?: boolean }> = [];
    adapter.onDidSendMessage(m => replies.push(m));
    adapter.handleMessage({ seq: 3, type: 'request', command: 'launch' });
    adapter.handleMessage({ seq: 2, type: 'request', command: 'terminate' });
    assert.deepEqual(replies.filter(m => m.request_seq === 3).map(m => m.message), ['cancelled']);
    assert.equal(replies.find(m => m.request_seq === 2)?.success, true);
    ready(await prepare());
    await ended;
    await adapter.shutdown();
    assert.equal(spawned, false);
  });

  test('owns overlapping descriptors with the same session ID and rejects launch bypasses', async () => {
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const resolvers: Array<(value: Awaited<ReturnType<typeof executable>>) => void> = [];
    const factory = new FerretDebugAdapterDescriptorFactory(
      () => ({ source: 'configured', executable: '/selected' }), output, runtime,
      () => new Promise(resolve => resolvers.push(resolve)),
    );
    const session = (id: string, configuration = {}) => ({ id, configuration: { program: '/main.fql', ...configuration } }) as unknown as vscode.DebugSession;
    assert.throws(() => factory.createDebugAdapterDescriptor(session('server', { debugServer: 22 })), /debugServer/);
    for (const options of [{ runtimeName: '', RuntimeName: '' }, { RUNTIMENAME: 5 }]) {
      assert.throws(() => factory.createDebugAdapterDescriptor(session('named', options)), /string|only once/);
    }
    assert.equal(resolvers.length, 0);
    const first = factory.createDebugAdapterDescriptor(session('same'));
    // VS Code's inline descriptor owns this implementation; its public type is opaque.
    (first as { implementation: vscode.DebugAdapter }).implementation.dispose();
    factory.createDebugAdapterDescriptor(session('same'));
    let stopped = false;
    const shutdown = factory.shutdown().then(() => { stopped = true; });
    resolvers[1]!(await executable());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    await assert.rejects(runtime.reload(), /finish/);
    resolvers[0]!(await executable());
    await shutdown;
    await runtime.reload();
    await runtime.shutdown();
  });
});

class DebugChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public get process(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
  public kills = 0;
  public kill(): boolean { this.kills++; this.emit('killed'); return true; }
  public async launch(adapter: FerretDebugTransport): Promise<void> {
    this.stdout.write(frame({ type: 'response', request_seq: 1, success: true }));
    const launch = { seq: 50, type: 'request', command: 'launch' };
    adapter.handleMessage(launch);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(this.stdin.read(), frame({ ...launch, arguments: { program: '/main.fql' } }));
    this.stdout.write(frame({ type: 'response', request_seq: launch.seq, command: 'launch', success: true }));
  }
}
