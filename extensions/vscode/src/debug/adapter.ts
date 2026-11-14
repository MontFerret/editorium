import * as vscode from 'vscode';
import { readRuntimeSelector } from '../runtime/selector';
import { requireFerretdExecutable, type FerretdExecutable } from '../ferretd';
import type { RuntimeCoordinator } from '../runtime/coordinator';
import type { ServerOutput } from '../server';
import { prepareDebugArguments, snapshotDebugArguments } from './launch';
import { FerretDebugTransport } from './transport';

export const ferretDebugType = 'ferret';

export class FerretDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private readonly adapters = new Set<FerretDebugTransport>();

  public constructor(
    private readonly readExecutable: () => FerretdExecutable,
    private readonly output: ServerOutput,
    private readonly runtime: Pick<RuntimeCoordinator, 'admitDebug'>,
    private readonly checkExecutable = requireFerretdExecutable,
  ) {}

  public createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterInlineImplementation {
    if ('debugServer' in session.configuration) throw new Error('Remove debugServer to use the owned Ferret debug adapter.');
    const snapshot = snapshotDebugArguments(session.configuration);
    const selection = this.readExecutable();
    const reservation = this.runtime.admitDebug(readRuntimeSelector(session.configuration));
    const transport = new FerretDebugTransport(async signal => {
      // Start discovery on the admitted daemon generation, before an override
      // can replace it. Join both tasks even when cancellation or access fails.
      const [catalog, access] = await Promise.allSettled([
        reservation.prepareDebug(signal), this.checkExecutable(selection),
      ]);
      if (access.status === 'rejected') throw access.reason;
      if (catalog.status === 'rejected') throw catalog.reason;
      const runtime = catalog.value;
      const executable = access.value;
      signal.throwIfAborted();
      const args = await prepareDebugArguments(snapshot, runtime);
      return { ...runtime, executable, arguments: args, configPath: reservation.configPath,
        verifyConfiguration: reservation.verifyConfiguration };
    }, this.output, () => {
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
