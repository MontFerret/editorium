import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DebugObserver } from './debug-observer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { HeldVariableReply } from './held-variable-reply';

async function withWorkbench(check: (window: Page) => Promise<void>): Promise<void> {
  const data = process.env.FERRET_TEST_USER_DATA;
  assert.ok(data, 'Expected the isolated VS Code test profile');
  const port = (await readFile(join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const renderer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  try {
    const window = renderer.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench'));
    assert.ok(window, 'Expected the VS Code workbench');
    await check(window);
  } finally { await renderer.close(); }
}

async function expandToReference(observer: DebugObserver, reference: number): Promise<void> {
  // List expansion and focus movement can resolve before the async workbench tree installs its rows.
  const deadline = Date.now() + 10_000;
  while (!observer.requests.some(m => m.command === 'variables' && m.arguments?.variablesReference === reference)) {
    assert.ok(Date.now() < deadline, `Variables view did not open reference ${reference}`);
    await vscode.commands.executeCommand('list.expand');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function inspectIndexedCollection(observer: DebugObserver, size: number): Promise<void> {
  await observer.wait(m => m.event === 'stopped');
  const command = (id: string) => vscode.commands.executeCommand(id);
  const focus = 'workbench.debug.action.focusVariablesView';
  await command(focus);
  const root = (await observer.wait(m => m.body?.variables?.some(v => v.name === 'results') === true))
    .body!.variables!.find(v => v.name === 'results')!;
  assert.equal(root.value, `Array(${size})`);
  assert.equal(root.indexedVariables, size);
  assert.equal(root.namedVariables, 0);
  assert.ok(root.variablesReference > 0);
  const init = observer.requests.find(m => m.command === 'initialize')?.arguments;
  assert.equal(init?.supportsVariablePaging, true);
  assert.equal(init?.supportsVariableType, true);
  const pages = () => observer.requests.filter(m => m.command === 'variables' &&
    m.arguments?.variablesReference === root.variablesReference);
  assert.equal(pages().length, 0);
  await command(focus);
  await command('list.focusFirst');
  // Locals is auto-expanded. Walk down the native tree to the first leaf range.
  await command('list.focusDown');
  await expandToReference(observer, root.variablesReference);
  async function assertPage(start: number) {
    const reply = await observer.wait(m => m.command === 'variables' && m.body?.variables?.[0]?.name === String(start));
    const request = pages().find(m => m.seq === reply.request_seq);
    assert.deepEqual(request?.arguments, { variablesReference: root.variablesReference, filter: 'indexed', start, count: 100 });
    assert.deepEqual(reply.body!.variables!.map(v => v.name), Array.from({ length: 100 }, (_, i) => String(start + i)));
  }
  await assertPage(0);
  assert.equal(pages().length, 1);
  if (size > 100) {
    await command('list.collapse');
    await command('list.focusDown');
    await command('list.expand');
    await assertPage(100);
    assert.equal(pages().length, 2);
  }

  const watch = 'workbench.debug.action.focusWatchView';
  await command(watch);
  try {
    await vscode.commands.executeCommand('debug.addToWatchExpressions', { variable: { evaluateName: 'sample' } });
    await observer.wait(m => m.command === 'evaluate' && m.body?.result === 'Object(1)');
    await command(watch);
    await command('list.focusFirst');
    await command('list.expand');
    const member = (await observer.wait(m => !!m.body?.variables?.some(v => v.name === 'rows'))).body!.variables!.find(v => v.name === 'rows')!;
    assert.equal(member.value, 'Array(2)');
    await expandToReference(observer, member.variablesReference);
    await observer.wait(m => m.body?.variables?.length === 2 && m.body.variables[0]?.value === '1');
    await command('workbench.action.debug.stepOver');
    await observer.wait(m => m.event === 'stopped', 2);
    await observer.wait(m => m.command === 'evaluate' && m.body?.result === 'Object(1)', 2);
  } finally {
    await command('workbench.debug.viewlet.action.removeAllWatchExpressions');
  }
}

export async function inspectVirtualGroups(observer: DebugObserver): Promise<void> {
  await observer.wait(m => m.event === 'stopped');
  const command = (id: string) => vscode.commands.executeCommand(id);
  const focus = 'workbench.debug.action.focusVariablesView';
  await command(focus);
  const root = (await observer.wait(m => !!m.body?.variables?.some(v => v.name === 'rows')))
    .body!.variables!.find(v => v.name === 'rows')!;
  await withWorkbench(async window => {
    const visible = window.locator('.debug-variables .monaco-list-row');
    const expand = (name: string) => visible.filter({ has: window.locator('.name').filter({ hasText: name }) })
      .locator('.monaco-tl-twistie').click({ timeout: 10_000 });
    await expand('rows');
    const groups = (await observer.wait(m => !!m.body?.variables?.some(v => v.name === 'Named'))).body!.variables!;
    const named = groups.find(v => v.name === 'Named')!;
    assert.equal(named.presentationHint?.kind, 'virtual');
    assert.ok(named.variablesReference > 0);
    assert.equal(named.namedVariables, undefined);
    assert.equal(named.indexedVariables, 0);
    assert.ok(observer.requests.some(m => m.arguments?.variablesReference === root.variablesReference && m.arguments.filter === 'named'));
    await expand(named.name);
    const rows = (await observer.wait(m => !!m.body?.variables?.some(v => v.name === '[100…]'))).body!.variables!;
    assert.deepEqual(rows.slice(0, 2).map(v => v.name), ['0', 'e\u0301😀']);
    const next = rows.at(-1)!;
    assert.equal(next.presentationHint?.kind, 'virtual');
    assert.ok(next.variablesReference > 0);
    assert.equal(next.namedVariables, undefined);
    await command('list.focusLast');
    await expand(next.name);
    const tail = (await observer.wait(m => !!m.body?.variables?.some(v => v.name === '102'))).body!.variables!;
    assert.deepEqual(tail.map(v => v.name), ['100', '101', '102']);
    assert.ok(observer.requests.some(m => m.arguments?.variablesReference === next.variablesReference));
  });
}

export async function stepWithPendingWatch(observer: DebugObserver, gate: HeldVariableReply, pane: 'Watch' | 'Variables'): Promise<void> {
  await observer.wait(m => m.event === 'stopped');
  const command = (id: string) => vscode.commands.executeCommand(id);
  const focus = 'workbench.debug.action.focusWatchView';
  await withWorkbench(async window => {
    try {
      const rows = window.locator('.debug-watch .monaco-list-row');
      await command(focus);
      await vscode.commands.executeCommand('debug.addToWatchExpressions', { variable: { evaluateName: 'rows' } });
      const initial = (await observer.wait(m => m.command === 'evaluate' && m.body?.result === 'Rows')).body!;
      await command(focus);
      await command('list.focusFirst');
      let reference = initial.variablesReference!;
      if (pane === 'Variables') {
        await command('list.expand');
        await rows.locator('.value').filter({ hasText: 'Array(1)' }).first().waitFor({ timeout: 10_000 });
        await command('workbench.debug.action.focusVariablesView');
        const locals = await observer.wait(m => !!m.body?.variables?.some(v => v.name === 'rows'));
        reference = locals.body!.variables!.find(v => v.name === 'rows')!.variablesReference;
        await command('list.focusFirst');
        await command('list.focusDown');
      }
      const held = gate.hold(observer, reference);
      const expanding = command('list.expand');
      const sequence = await held;
      await command('workbench.action.debug.stepOver');
      await observer.wait(m => m.event === 'stopped', 2);
      const isOldPage = (m: { command?: string; request_seq?: number }) => m.command === 'variables' && m.request_seq === sequence;
      assert.equal(observer.count(isOldPage), 0);
      // VS Code serializes refresh behind a pending expansion in the same tree.
      if (pane === 'Watch') gate.release();
      await command(focus);
      await observer.wait(m => m.command === 'evaluate' && m.body?.result === 'Array(1)');
      const child = rows.locator('.value').filter({ hasText: /^777$/ });
      await child.waitFor({ timeout: 10_000 });
      if (pane === 'Variables') {
        assert.equal(observer.count(isOldPage), 0);
        gate.release();
      }
      const stale = await observer.wait(isOldPage);
      assert.equal(stale.body?.variables?.length, 100);
      await expanding;
      if (pane === 'Variables') {
        const vars = window.locator('.debug-variables .monaco-list-row .value');
        await vars.filter({ hasText: /^777$/ }).waitFor({ timeout: 10_000 });
        assert.deepEqual(await vars.allTextContents(), ['Array(1)', '777']);
      }
      assert.deepEqual(await rows.locator('.value').allTextContents(), ['Array(1)', '777']);
    } finally {
      gate.release();
      await command('workbench.debug.viewlet.action.removeAllWatchExpressions');
    }
  });
}
