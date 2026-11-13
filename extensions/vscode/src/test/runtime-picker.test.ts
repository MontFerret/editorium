import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DaemonConnection } from '../daemon/types';
import { RuntimeCoordinator } from '../runtime/coordinator';
import { openRuntimePicker, runtimeNameKey } from '../runtime/picker';

type Item = vscode.QuickPickItem & { runtimeName: string };

suite('runtime picker', () => {
  test('detaches on cancel and preserves a newer literal selection across shared discovery', async () => {
    let selected = 'disappeared';
    const writes: string[] = [];
    const state = {
      get: () => selected, keys: () => [runtimeNameKey],
      update: async (key: string, value: string) => {
        assert.equal(key, runtimeNameKey);
        writes.push(value);
        selected = value;
      },
    } as vscode.Memento;
    const entry = { name: 'Daemon default', label: 'Δ literal 🦦', provider: 'wire' };
    let release!: () => void;
    const deferred = new Promise<void>(done => { release = done; });
    let count = 0;
    const runtime = new RuntimeCoordinator({
      start: async () => {}, stop: async () => {},
      requireConnection: () => ({ signal: new AbortController().signal }) as DaemonConnection,
    }, { entered: '' }, () => selected, async () => {
      count++;
      await deferred;
      return { defaultRuntime: entry.name, runtimes: [entry] };
    });
    const first = new Picker();
    openRuntimePicker(runtime, state, first.host);
    first.hide();
    assert.ok(first.disposed);
    assert.equal(selected, 'disappeared');
    const second = new Picker();
    openRuntimePicker(runtime, state, second.host);
    assert.ok(second.busy);
    selected = 'newer';
    release();
    await runtime.catalog();
    assert.equal(count, 1);
    assert.equal(second.activeItems[0]?.runtimeName, 'newer');
    assert.equal(second.activeItems[0]?.description, 'Unavailable');
    assert.deepEqual(writes, []);
    assert.ok(first.busy, 'closed picker received a catalog update');
    const literal = second.items.find(item => item.runtimeName === entry.name)!;
    assert.equal(literal.description, entry.label);
    assert.equal(literal.detail, 'wire');
    second.accept(literal);
    assert.deepEqual(writes, [entry.name]);
    const third = new Picker();
    openRuntimePicker(runtime, state, third.host);
    third.accept(third.items[0]!);
    assert.deepEqual(writes, [entry.name, '']);
    await runtime.shutdown();
  });
});

class Picker {
  private readonly accepted = new vscode.EventEmitter<void>();
  private readonly hidden = new vscode.EventEmitter<void>();
  public onDidAccept = this.accepted.event;
  public onDidHide = this.hidden.event;
  public disposed = false;
  public busy = false;
  public items: Item[] = [];
  public activeItems: Item[] = [];
  public selectedItems: Item[] = [];
  public get host() { return this as unknown as vscode.QuickPick<Item>; }
  public show(): void {}
  public accept(item: Item): void { this.selectedItems = [item]; this.accepted.fire(); }
  public hide(): void { this.hidden.fire(); }
  public dispose(): void { this.disposed = true; this.accepted.dispose(); this.hidden.dispose(); }
}
