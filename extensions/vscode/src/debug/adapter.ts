import * as vscode from 'vscode';
import { readRuntimeSelector } from '../runtime/selector';
import type { FerretdExecutable } from '../ferretd';
import type { RuntimeCoordinator } from '../runtime/coordinator';
import type { ServerOutput } from '../server';
import { FerretDebugTransport } from './transport';

export const ferretDebugType = 'ferret';

export class FerretDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private readonly adapters = new Set<FerretDebugTransport>();

  public constructor(
    private readonly resolveExecutable: () => Promise<FerretdExecutable>,
    private readonly output: ServerOutput,
    private readonly runtime: Pick<RuntimeCoordinator, 'admitDebug'>,
  ) {}

  public createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterInlineImplementation {
    if ('debugServer' in session.configuration) throw new Error('Remove debugServer to use the owned Ferret debug adapter.');
    const reservation = this.runtime.admitDebug(readRuntimeSelector(session.configuration));
    const transport = new FerretDebugTransport(this.resolveExecutable, this.output, () => {
      this.adapters.delete(transport);
      reservation.release();
    });
    this.adapters.add(transport);
    transport.prepare();
    return new vscode.DebugAdapterInlineImplementation(transport);
  }

  public async shutdown(): Promise<void> {
    const results = await Promise.allSettled([...this.adapters].map(adapter => adapter.shutdown()));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
