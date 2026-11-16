import { dirname } from 'node:path';
import type * as vscode from 'vscode';
import type { FerretDebugAdapterDescriptorFactory } from '../debug/adapter';
import { DebugObserver } from './debug-observer';

// The test owns the DAP client so only its explicit requests reach this adapter.
export function launchInlineDebug(factory: FerretDebugAdapterDescriptorFactory, name: string, program: string) {
  const configuration = { type: 'ferret', request: 'launch', name, program, cwd: dirname(program), stopOnEntry: true };
  const descriptor = factory.createDebugAdapterDescriptor({ configuration } as unknown as vscode.DebugSession);
  const adapter = (descriptor as { implementation: vscode.DebugAdapter }).implementation;
  const observer = new DebugObserver(name, adapter);
  adapter.handleMessage({ type: 'request', seq: 1, command: 'initialize', arguments: {
    adapterID: 'ferret', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
  } });
  adapter.handleMessage({ type: 'request', seq: 2, command: 'launch', arguments: configuration });
  return { adapter, observer };
}
