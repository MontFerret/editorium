import * as vscode from 'vscode';
import type { FerretdExecutable } from '../ferretd';
import type { RuntimeCoordinator } from '../runtime/coordinator';
import type { ServerOutput } from '../server';
import { FerretDebugTransport } from './transport';

export const ferretDebugType = 'ferret';

export class FerretDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  private readonly adapters = new Map<string, FerretDebugTransport>();

  public constructor(
    private readonly resolveExecutable: () => Promise<FerretdExecutable>,
    private readonly output: ServerOutput,
    private readonly runtime: Pick<RuntimeCoordinator, 'admit'>,
  ) {}

  public createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterInlineImplementation {
    if ('debugServer' in session.configuration) throw new Error('Remove debugServer to use the owned Ferret debug adapter.');
    const reservation = this.runtime.admit(session.configuration.runtimeName);
    const transport = new FerretDebugTransport(this.resolveExecutable, this.output, () => {
      this.adapters.delete(session.id);
      reservation.release();
    });
    this.adapters.set(session.id, transport);
    transport.prepare();
    return new vscode.DebugAdapterInlineImplementation(transport);
  }

  public terminate(session: vscode.DebugSession): void {
    this.adapters.get(session.id)?.dispose();
  }

  public async shutdown(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(adapter => adapter.shutdown()));
  }
}
