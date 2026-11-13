import * as assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';

import { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { DapFrameReader } from '../debug/framing';
import { FerretDebugTransport } from '../debug/transport';
import { RuntimeCoordinator } from '../runtime/coordinator';

const output = { info() {}, error() {}, show() {} };
const executable = async () => ({ executable: '/ferretd', source: 'configured' as const });
const initialize = { seq: 1, type: 'request', command: 'initialize', arguments: { custom: '🦦' } };
const frame = (body: object) => {
  const bytes = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
};

suite('owned Ferret debug adapter', () => {
  test('frames UTF-8 by bytes and transparently forwards split and coalesced messages', async () => {
    const child = new DebugChild();
    let closed = 0;
    const adapter = new FerretDebugTransport(executable, output, () => { closed++; }, () => child.process);
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

  test('releases failed resolution and confirmed failed spawn, and waits for stream failure teardown', async () => {
    for (const failure of ['resolve', 'spawn', 'stream']) {
      const child = new DebugChild();
      let closed = 0;
      const adapter = new FerretDebugTransport(async () => {
        if (failure === 'resolve') throw new Error('missing executable');
        return executable();
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
    let resolve!: (value: Awaited<ReturnType<typeof executable>>) => void;
    const resolving = new Promise<Awaited<ReturnType<typeof executable>>>(done => { resolve = done; });
    let ended = false;
    let spawned = false;
    const adapter = new FerretDebugTransport(() => resolving, output, () => { ended = true; }, () => {
      spawned = true;
      return new DebugChild().process;
    });
    adapter.handleMessage(initialize);
    const shutdown = adapter.shutdown();
    assert.equal(ended, false);
    resolve(await executable());
    await shutdown;
    assert.equal(spawned, false);
    assert.equal(ended, true);
  });

  test('retains the reservation if forced termination fails until actual close', async () => {
    const child = new DebugChild();
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const lease = runtime.admit();
    const adapter = new FerretDebugTransport(executable, output, lease.release, () => child.process, 0);
    adapter.handleMessage(initialize);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(adapter.shutdown(), /cleanup has not completed/);
    assert.equal(child.kills, 1);
    await assert.rejects(runtime.reload(), /finish/);
    child.emit('close');
    await runtime.reload();
    await runtime.shutdown();
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
    const adapter = new FerretDebugTransport(executable, output, () => { closed++; }, () => child.process, 0);
    const spawned = new Promise<void>(resolve => child.stdin.once('readable', resolve));
    adapter.handleMessage(initialize);
    await spawned;
    child.stdin.read();
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

  test('forwards restart, terminate replies, and disconnect in order during graceful Stop', async () => {
    const child = new DebugChild();
    const adapter = new FerretDebugTransport(executable, output, () => {}, () => child.process);
    const messages: object[] = [];
    adapter.onDidSendMessage(message => messages.push(message));
    const spawned = new Promise<void>(resolve => child.stdin.once('readable', resolve));
    adapter.handleMessage(initialize);
    await spawned;
    child.stdin.read();
    const restart = { seq: 2, type: 'request', command: 'terminate', arguments: { restart: true } };
    const stop = { seq: 3, type: 'request', command: 'terminate' };
    const disconnect = { seq: 4, type: 'request', command: 'disconnect' };
    const refused = { type: 'response', request_seq: 2, command: 'terminate', success: false };
    const stopped = { type: 'response', request_seq: 3, command: 'terminate', success: true };
    const terminated = { type: 'event', event: 'terminated' };
    adapter.handleMessage(restart);
    child.stdout.write(frame(refused));
    adapter.handleMessage(stop);
    child.stdout.write(Buffer.concat([frame(stopped), frame(terminated)]));
    assert.equal(child.stdin.writableEnded, false);
    adapter.handleMessage(disconnect);
    assert.deepEqual(child.stdin.read(), Buffer.concat([frame(restart), frame(stop), frame(disconnect)]));
    assert.deepEqual(messages, [refused, stopped, terminated]);
    child.emit('close');
    await adapter.shutdown();
    assert.equal(child.kills, 0);
  });

  test('protocol Stop before executable resolution suppresses spawn', async () => {
    let ready!: (value: Awaited<ReturnType<typeof executable>>) => void;
    const resolving = new Promise<Awaited<ReturnType<typeof executable>>>(resolve => { ready = resolve; });
    let closed!: () => void;
    const ended = new Promise<void>(resolve => { closed = resolve; });
    let spawned = false;
    const adapter = new FerretDebugTransport(() => resolving, output, closed, () => {
      spawned = true;
      return new DebugChild().process;
    });
    adapter.handleMessage(initialize);
    adapter.handleMessage({ seq: 2, type: 'request', command: 'terminate' });
    ready(await executable());
    await ended;
    await adapter.shutdown();
    assert.equal(spawned, false);
  });

  test('owns overlapping descriptors with the same session ID and rejects launch bypasses', async () => {
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const resolvers: Array<(value: Awaited<ReturnType<typeof executable>>) => void> = [];
    const factory = new FerretDebugAdapterDescriptorFactory(() => new Promise(resolve => resolvers.push(resolve)), output, runtime);
    const session = (id: string, configuration = {}) => ({ id, configuration }) as vscode.DebugSession;
    assert.throws(() => factory.createDebugAdapterDescriptor(session('server', { debugServer: 22 })), /debugServer/);
    for (const options of [{ runtimeName: 'local' }, { RunTimeName: 'local' }, { runtimeName: '', RuntimeName: '' }, { RUNTIMENAME: 5 }]) {
      assert.throws(() => factory.createDebugAdapterDescriptor(session('named', options)), /Daemon default|only once/);
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
}
