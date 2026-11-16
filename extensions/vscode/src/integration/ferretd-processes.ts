import type { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { relative } from 'node:path';

type Command = 'dap' | 'serve';

/** Observe the children launched by the extension inside this test window. */
export class FerretdProcesses {
  private readonly channel = channel('child_process');
  private readonly children: Record<Command, ChildProcess[]> = { dap: [], serve: [] };
  private readonly closures = new Map<ChildProcess, Promise<void>>();

  public constructor(private readonly executable: string) {
    this.channel.subscribe(this.created);
  }

  private readonly created = (message: unknown): void => {
    const child = (message as { process: ChildProcess }).process;
    child.once('spawn', () => {
      const command = child.spawnargs[1];
      if (relative(this.executable, child.spawnfile) !== '' || (command !== 'dap' && command !== 'serve')) return;
      this.children[command].push(child);
      this.closures.set(child, new Promise(resolve => child.once('close', () => resolve())));
    });
  };

  public starts(command: Command): readonly ChildProcess[] {
    return [...this.children[command]];
  }

  public async closed(children: readonly ChildProcess[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(children.map(child => this.closures.get(child))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Waiting for ferretd close: ' +
            children.map(c => `${c.spawnargs[1]} pid=${c.pid} exit=${c.exitCode ?? c.signalCode}`).join(', '))), 15_000);
        }),
      ]);
      // Drain transport close continuations, including the coordinator lease release.
      await new Promise(resolve => setImmediate(resolve));
    } finally { clearTimeout(timer); }
  }

  public dispose(): void {
    this.channel.unsubscribe(this.created);
  }
}
