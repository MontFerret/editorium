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

  test('tracks simultaneous descriptors separately and rejects launch bypasses', async () => {
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {}, requireConnection: () => { throw new Error('unused'); },
    }, { entered: '' }, () => '');
    const factory = new FerretDebugAdapterDescriptorFactory(executable, output, runtime);
    const session = (id: string, configuration = {}) => ({ id, configuration }) as vscode.DebugSession;
    assert.throws(() => factory.createDebugAdapterDescriptor(session('server', { debugServer: 22 })), /debugServer/);
    assert.throws(() => factory.createDebugAdapterDescriptor(session('named', { runtimeName: 'local' })), /Daemon default/);
    for (const id of ['a', 'b']) {
      assert.ok(factory.createDebugAdapterDescriptor(session(id)) instanceof vscode.DebugAdapterInlineImplementation);
    }
    factory.terminate(session('b'));
    await assert.rejects(runtime.reload(), /finish/);
    factory.terminate(session('a'));
    await factory.shutdown();
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
  public kill(): boolean { this.kills++; return true; }
}
