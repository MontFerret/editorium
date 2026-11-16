import * as assert from 'node:assert/strict';
import { dirname } from 'node:path';
import type * as vscode from 'vscode';
import { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { requireFerretdExecutable } from '../ferretd';
import type { RuntimeCoordinator } from '../runtime/coordinator';
import type { ServerOutput } from '../server';
import { DebugObserver } from './debug-observer';
import { FerretdProcesses } from './ferretd-processes';
import type { WireHost } from './wire-host';

export type StartupBoundary = 'before spawn' | 'connect' | 'compile' | 'before configurationDone' | 'close';

// Drive the registered factory's inline adapter directly so the test owns when
// configurationDone and Stop are sent, even before VS Code exposes a session.
export async function stopDuringStartup(boundary: StartupBoundary, program: string, executable: string,
  runtime: RuntimeCoordinator, output: ServerOutput, host: WireHost): Promise<void> {
  const processes = new FerretdProcesses(executable);
  let releaseAccess!: () => void;
  const access = new Promise<void>(resolve => { releaseAccess = resolve; });
  const factory = new FerretDebugAdapterDescriptorFactory(() => ({ executable, source: 'configured' }), output, runtime,
    async selection => {
      if (boundary === 'before spawn') await access;
      return requireFerretdExecutable(selection);
    });
  const rpc = boundary === 'connect' || boundary === 'compile' || boundary === 'close';
  let observer: DebugObserver | undefined;
  try {
    if (rpc) await host.arm(boundary);
    const configuration = { type: 'ferret', request: 'launch', name: boundary, program, cwd: dirname(program), stopOnEntry: true };
    const descriptor = factory.createDebugAdapterDescriptor({ configuration } as unknown as vscode.DebugSession);
    const adapter = (descriptor as { implementation: vscode.DebugAdapter }).implementation;
    observer = new DebugObserver(boundary, adapter);
    adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize', arguments: {
      adapterID: 'ferret', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
    } });
    adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: configuration });

    let id: number | undefined;
    if (rpc) {
      id = (await host.wait('held', 1, undefined, boundary)).id;
      assert.ok(id);
    } else if (boundary === 'before configurationDone') {
      await observer.wait(m => m.event === 'initialized');
      id = await host.binding(program);
    }
    adapter.handleMessage({ type: 'request', seq: 3, command: 'terminate' });
    if (boundary === 'before spawn' || boundary === 'close' || boundary === 'compile') {
      await assert.rejects(runtime.reload(), /finish before reloading/);
      if (boundary === 'close') assert.equal(host.count('released', id), 0);
    }
    // Connect is interruptible. Wire deliberately joins a pending plan
    // allocation so it can reclaim the reply even after its caller stops.
    if (boundary === 'connect') await host.wait('interrupted', 1, id, boundary);
    adapter.handleMessage({ type: 'request', seq: 4, command: 'configurationDone' });
    releaseAccess();
    if (rpc) host.command('release', boundary);
    assert.equal((await observer.wait(m => m.command === 'launch')).success, false);
    await observer.wait(m => m.event === 'terminated');
    const children = processes.starts('dap');
    assert.equal(children.length, boundary === 'before spawn' ? 0 : 1);
    await processes.closed(children);
    assert.ok(children.every(child => child.signalCode === null), 'Expected cooperative DAP shutdown');
    assert.equal(observer.count(m => m.event === 'stopped'), 0);
    assert.equal(host.count('engineClosed'), 0);
    if (id !== undefined) {
      await host.wait('released', 1, id);
      assert.equal(host.count('released', id), 1);
    }
  } finally {
    releaseAccess();
    if (rpc) host.command('release', boundary);
    try { await factory.shutdown(); }
    finally { observer?.dispose(); processes.dispose(); }
  }
}
