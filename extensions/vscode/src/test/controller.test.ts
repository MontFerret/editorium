import * as assert from 'node:assert/strict';

import { FerretServerController } from '../controller';
import { DaemonController } from '../daemon/manager';
import { FerretWorkspaceRegistry } from '../daemon/workspaces';
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

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  public updateWorkspaceFolders(): Promise<void> {
    return Promise.resolve();
  }
}

suite('Ferret coordinated server lifecycle', () => {
  test('restarts only the LSP without invalidating daemon state', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new StatefulDaemon(events);
    const controller = createController(language, daemon);
    await controller.start();
    daemon.workspaceRegistry.set({ id: 'workspace-1', root: '/workspace' });
    daemon.cachedSessionIds.add('session-1');
    const generation = daemon.generation;
    const invalidated: string[][] = [];
    const listener = daemon.workspaceRegistry.onDidInvalidateWorkspaces(
      (event) => invalidated.push([...event.workspaceIds]),
    );
    events.length = 0;

    await controller.restartLanguageServer();

    listener.dispose();
    assert.deepStrictEqual(events, ['stop:lsp', 'start:lsp']);
    assert.strictEqual(daemon.generation, generation);
    assert.strictEqual(generation.aborted, false);
    assert.deepStrictEqual(
      daemon.workspaceRegistry.workspaces.map(({ id }) => id),
      ['workspace-1'],
    );
    assert.deepStrictEqual([...daemon.cachedSessionIds], ['session-1']);
    assert.deepStrictEqual(invalidated, []);
  });

  test('restarts only the daemon and replaces its generation', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new StatefulDaemon(events);
    const controller = createController(language, daemon);
    await controller.start();
    daemon.workspaceRegistry.set({ id: 'workspace-1', root: '/workspace' });
    daemon.cachedSessionIds.add('session-1');
    const generation = daemon.generation;
    const invalidated: string[][] = [];
    const listener = daemon.workspaceRegistry.onDidInvalidateWorkspaces(
      (event) => invalidated.push([...event.workspaceIds]),
    );
    events.length = 0;

    await controller.restartDaemon();

    listener.dispose();
    assert.deepStrictEqual(events, ['stop:daemon', 'start:daemon']);
    assert.strictEqual(generation.aborted, true);
    assert.notStrictEqual(daemon.generation, generation);
    assert.deepStrictEqual(daemon.cachedSessionIds.size, 0);
    assert.deepStrictEqual(invalidated, [['workspace-1']]);
  });

  test('fully stops both generations before a coalesced restart', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new StatefulDaemon(events);
    const controller = createController(language, daemon);
    await controller.start();
    const generation = daemon.generation;
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
    assert.strictEqual(generation.aborted, true);
    assert.notStrictEqual(daemon.generation, generation);
  });

  test('starts the LSP independently when daemon startup fails', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const output = new FakeOutput();
    const daemon = new DaemonController(
      () => ({
        executable: '/configured/ferretd',
        extraArguments: [],
        source: 'configured',
      }),
      output,
      () => {
        throw new Error('daemon process must not be created');
      },
      async () => {
        throw new Error('daemon failed');
      },
    );
    const controller = new FerretServerController(
      language as unknown as LanguageServerController,
      daemon,
      output,
    );

    await controller.start();

    assert.deepStrictEqual(events, ['start:lsp']);
    assert.deepStrictEqual(output.errors, [
      'Starting Ferret daemon failed: Ferret daemon startup failed: daemon failed',
    ]);
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

  test('stops both services during final shutdown', async () => {
    const events: string[] = [];
    const language = new FakeComponent('lsp', events);
    const daemon = new FakeComponent('daemon', events);
    const controller = createController(language, daemon);
    await controller.start();
    events.length = 0;

    await controller.stop();

    assert.deepStrictEqual(events, ['stop:lsp', 'stop:daemon']);
  });
});

class StatefulDaemon extends FakeComponent {
  private generationController = new AbortController();

  public readonly cachedSessionIds = new Set<string>();
  public readonly workspaceRegistry = new FerretWorkspaceRegistry();

  public constructor(events: string[]) {
    super('daemon', events);
  }

  public get generation(): AbortSignal {
    return this.generationController.signal;
  }

  public override async start(): Promise<void> {
    await super.start();
    if (this.generationController.signal.aborted) {
      this.generationController = new AbortController();
    }
  }

  public override async stop(): Promise<void> {
    await super.stop();
    this.generationController.abort();
    this.workspaceRegistry.clear();
    this.cachedSessionIds.clear();
  }
}

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
