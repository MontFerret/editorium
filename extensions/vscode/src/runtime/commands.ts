import * as vscode from 'vscode';
import type { RuntimeCoordinator } from './coordinator';
import { resolveRuntimeConfiguration } from './configuration';
import { openRuntimePicker } from './picker';

export function readRuntimeConfiguration() {
  const folders = vscode.workspace.workspaceFolders;
  const folder = folders?.length === 1 ? folders[0] : undefined;
  const entered = vscode.workspace.getConfiguration('ferret').get<unknown>('runtime.configPath', '');
  return resolveRuntimeConfiguration(entered, folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined);
}

export function registerRuntimeCommands(runtime: RuntimeCoordinator, state: vscode.Memento): vscode.Disposable {
  let picker: vscode.Disposable | undefined;
  const operate = async (operation: () => Promise<void>) => {
    try {
      await operation();
      if (runtime.view.message) void vscode.window.showWarningMessage(runtime.view.message);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };
  return vscode.Disposable.from(
    { dispose: () => picker?.dispose() },
    vscode.commands.registerCommand('ferret.selectRuntime', () => {
      picker?.dispose();
      picker = openRuntimePicker(runtime, state);
    }),
    vscode.commands.registerCommand('ferret.reloadRuntimes', () => operate(() => runtime.reload())),
    vscode.commands.registerCommand('ferret.retryRuntimeDiscovery', () => operate(() => runtime.retry())),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('ferret.runtime.configPath')) runtime.save(readRuntimeConfiguration());
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => runtime.save(readRuntimeConfiguration())),
  );
}
