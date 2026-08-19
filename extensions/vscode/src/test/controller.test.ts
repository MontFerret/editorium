import * as assert from 'node:assert/strict';

import { FerretServerController } from '../controller';
import type { DaemonController } from '../daemon/manager';
import type { LanguageServerController, ServerOutput } from '../server';

class FakeOutput implements ServerOutput {
  public readonly errors: string[] = [];

  public error(message: string): void {
    this.errors.push(message);
  }
  public info(): void {}
  public show(): void {}
}

class FakeComponent {
  public readonly events: string[];
  public startError: Error | undefined;
  public stopGate: Promise<void> | undefined;

  public constructor(
    protected readonly name: string,
    events: string[],
  ) {
    this.events = events;
  }

  public async start(): Promise<void> {
    this.events.push(`start:${this.name}`);
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  public async stop(): Promise<void> {
    this.events.push(`stop:${this.name}`);
    await this.stopGate;
  }

  public updateWorkspaceFolders(): Promise<void> {
    return Promise.resolve();
  }
}

suite('Ferret coordinated server lifecycle', () => {
  test('fully stops both generations before a coalesced restart', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new FakeComponent('daemon', events);
    const controller = createController(language, daemon);
    await controller.start();
    events.length = 0;

    let releaseLanguageStop: (() => void) | undefined;
    language.stopGate = new Promise<void>((resolve) => {
      releaseLanguageStop = resolve;
    });
    const first = controller.restart();
    const second = controller.restart();
    assert.strictEqual(first, second);
    await immediate();
    assert.deepStrictEqual(events, ['stop:lsp', 'stop:daemon']);

    releaseLanguageStop?.();
    await first;
    assert.deepStrictEqual(events, [
      'stop:lsp',
      'stop:daemon',
      'start:lsp',
      'start:daemon',
    ]);
  });

  test('starts the LSP independently when daemon startup fails', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new FakeComponent('daemon', events);
    daemon.startError = new Error('daemon failed');
    const output = new FakeOutput();
    const controller = createController(language, daemon, output);

    await controller.start();

    assert.deepStrictEqual(events, ['start:lsp', 'start:daemon']);
    assert.ok(output.errors.some((line) => line.includes('daemon failed')));
  });

  test('applies one selected executable generation to both services', async () => {
    const events: string[] = [];
    let executable = '/ferretd/first';
    const language = new SelectedComponent(
      'lsp',
      events,
      () => executable,
    );
    const daemon = new SelectedComponent(
      'daemon',
      events,
      () => executable,
    );
    const controller = createController(language, daemon);

    await controller.start();
    executable = '/ferretd/second';
    await controller.restart();

    assert.deepStrictEqual(events, [
      'start:lsp:/ferretd/first',
      'start:daemon:/ferretd/first',
      'stop:lsp',
      'stop:daemon',
      'start:lsp:/ferretd/second',
      'start:daemon:/ferretd/second',
    ]);
  });
});

class SelectedComponent extends FakeComponent {
  public constructor(
    name: string,
    events: string[],
    private readonly selectedExecutable: () => string,
  ) {
    super(name, events);
  }

  public override async start(): Promise<void> {
    this.events.push(
      `start:${this.name}:${this.selectedExecutable()}`,
    );
  }
}

function createController(
  language: FakeComponent,
  daemon: FakeComponent,
  output: FakeOutput = new FakeOutput(),
): FerretServerController {
  return new FerretServerController(
    language as unknown as LanguageServerController,
    daemon as unknown as DaemonController,
    output,
  );
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
