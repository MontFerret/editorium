import * as vscode from 'vscode';
import type { RuntimeCoordinator } from './coordinator';

export const runtimeNameKey = 'ferret.runtimeName';

interface RuntimeItem extends vscode.QuickPickItem {
  readonly runtimeName: string;
}

export function openRuntimePicker(
  runtime: RuntimeCoordinator,
  state: vscode.Memento,
  picker = vscode.window.createQuickPick<RuntimeItem>(),
): vscode.Disposable {
  picker.title = 'Ferret: Select Runtime';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  const refresh = () => {
    const selected = state.get(runtimeNameKey, '');
    const { catalog, status, message } = runtime.view;
    picker.busy = status === 'loading';
    picker.placeholder = message ?? (picker.busy ? 'Loading runtime catalog…' : 'Choose a runtime for future launches');
    const items: RuntimeItem[] = [{
      label: 'Daemon default', runtimeName: '', description: catalog?.defaultRuntime,
    }];
    for (const entry of catalog?.runtimes ?? []) {
      items.push({
        label: entry.name, description: entry.label, detail: entry.provider,
        runtimeName: entry.name,
      });
    }
    if (selected && !items.some(item => item.runtimeName === selected)) {
      items.push({ label: selected, runtimeName: selected, description: catalog ? 'Unavailable' : 'Saved selection' });
    }
    picker.items = items;
    picker.activeItems = items.filter(item => item.runtimeName === selected);
  };
  const subscriptions = [
    runtime.onDidChange(refresh),
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (!item) return;
      const save = state.update(runtimeNameKey, item.runtimeName);
      picker.hide();
      void Promise.resolve(save).catch(error => vscode.window.showErrorMessage(String(error)));
    }),
    picker.onDidHide(() => dispose()),
  ];
  function dispose(): void {
    if (subscriptions.length === 0) return;
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
    picker.dispose();
  }
  refresh();
  picker.show();
  void runtime.catalog();
  return { dispose };
}
