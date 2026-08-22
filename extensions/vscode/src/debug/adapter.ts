import * as vscode from 'vscode';

import type { FerretdExecutable } from '../ferretd';
import type { ServerOutput } from '../server';

export const ferretDebugType = 'ferret';

export type FerretdDebugExecutableResolver =
  () => Promise<FerretdExecutable>;

export interface DebugAdapterRegistrationHost {
  registerDebugAdapterDescriptorFactory(
    debugType: string,
    factory: vscode.DebugAdapterDescriptorFactory,
  ): vscode.Disposable;
}

export class FerretDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  public constructor(
    private readonly resolveExecutable: FerretdDebugExecutableResolver,
    private readonly output: ServerOutput,
  ) {}

  public async createDebugAdapterDescriptor(): Promise<vscode.DebugAdapterExecutable> {
    this.output.info('Starting Ferret debug adapter');

    let selection: FerretdExecutable;
    try {
      selection = await this.resolveExecutable();
    } catch (error) {
      this.output.error('Starting Ferret debug adapter failed', error);
      throw error;
    }

    if (selection.source === 'bundled') {
      this.output.info('Ferret debug adapter source: bundled');
      this.output.info(`Bundled ferretd: ${selection.bundledVersion}`);
    } else {
      this.output.info(
        'Ferret debug adapter source: configured override',
      );
      this.output.info(`Executable: ${selection.executable}`);
    }

    const args = ['dap'];
    this.output.info(
      `Ferret debug adapter arguments: ${JSON.stringify(args)}`,
    );

    return new vscode.DebugAdapterExecutable(
      selection.executable,
      args,
    );
  }
}

export function registerFerretDebugAdapter(
  resolveExecutable: FerretdDebugExecutableResolver,
  output: ServerOutput,
  host: DebugAdapterRegistrationHost = vscode.debug,
): vscode.Disposable {
  return host.registerDebugAdapterDescriptorFactory(
    ferretDebugType,
    new FerretDebugAdapterDescriptorFactory(
      resolveExecutable,
      output,
    ),
  );
}
