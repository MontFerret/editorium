import * as assert from 'node:assert/strict';
import { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { requireFerretdExecutable } from '../ferretd';
import type { RuntimeCoordinator } from '../runtime/coordinator';
import type { ServerOutput } from '../server';
import type { DebugObserver } from './debug-observer';
import { launchInlineDebug } from './inline-debug-launch';
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
    const launch = launchInlineDebug(factory, boundary, program);
    const { adapter } = launch;
    observer = launch.observer;

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
    for (const child of children) {
      assert.deepEqual([child.exitCode, child.signalCode], [0, null], `Expected cooperative DAP shutdown for pid ${child.pid}`);
    }
    assert.equal(observer.count(m => m.event === 'stopped'), 0);
    assert.equal(host.count('engineClosed'), 0);
    if (id !== undefined) {
      if (boundary === 'connect') {
        // Stop interrupted the handshake before the client learned its connection ID.
        await host.wait('released', 1, id);
        assert.equal(host.count('released', id), 1);
      } else {
        await host.waitForGracefulRelease(id);
      }
    }
    assert.equal(host.count('debugStart'), 0, `The host received a Debug START after Stop at ${boundary}`);
  } finally {
    releaseAccess();
    if (rpc) host.command('release', boundary);
    try { await factory.shutdown(); }
    finally { observer?.dispose(); processes.dispose(); }
  }
}
