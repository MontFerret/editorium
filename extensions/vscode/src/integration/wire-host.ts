import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { relative } from 'node:path';
import { createInterface } from 'node:readline';

interface HostEvent {
  readonly event: string;
  readonly id?: number;
  readonly endpoint?: string;
  readonly token?: string;
  readonly root?: string;
}

export class WireHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly changes = new EventEmitter();
  private readonly events: HostEvent[] = [];
  private readonly closed: Promise<void>;
  private ended = false;
  private diagnostics = '';

  public constructor(binary: string, root: string, controlled = false) {
    this.child = spawn(binary, ['-root', root, ...(controlled ? ['-control'] : [])], { cwd: controlled ? root : undefined, stdio: 'pipe', windowsHide: true });
    this.child.stdin.on('error', error => { this.diagnostics += String(error); });
    this.child.stderr.on('data', (data: Buffer) => { this.diagnostics += data.toString(); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.events.push(JSON.parse(line) as HostEvent); }
      catch { this.diagnostics += line; }
      this.changes.emit('change');
    });
    this.closed = new Promise(resolve => {
      this.child.on('error', error => { this.diagnostics += String(error); });
      this.child.once('close', () => {
        this.ended = true;
        this.changes.emit('change');
        resolve();
      });
    });
  }

  public count(event: string, id?: number): number {
    return this.events.filter(item => item.event === event && (id === undefined || item.id === id)).length;
  }

  public wait(event: string, ordinal = 1, id?: number, token?: string): Promise<HostEvent> {
    return this.find(event, ordinal, item =>
      (id === undefined || item.id === id) && (token === undefined || item.token === token), `${id ?? ''} ${token ?? ''}`);
  }

  public async binding(program: string, ordinal = 1): Promise<number> {
    const event = await this.find('compile', ordinal, item =>
      item.token !== undefined && relative(program, item.token) === '', program);
    if (!event.id) throw new Error(`No binding ID for ${program}`);
    return event.id;
  }

  public async arm(name: string): Promise<void> {
    const ordinal = 1 + this.events.filter(item => item.event === 'armed' && item.token === name).length;
    this.command('arm', name);
    await this.wait('armed', ordinal, undefined, name);
  }

  public command(action: 'arm' | 'release' | 'releaseAll', name?: string): void {
    if (!this.ended) this.child.stdin.write(JSON.stringify({ action, name }) + '\n');
  }

  private find(event: string, ordinal: number, matches: (item: HostEvent) => boolean, description: string): Promise<HostEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), 15_000);
      const finish = (value?: HostEvent) => {
        clearTimeout(timer);
        this.changes.off('change', check);
        if (value) resolve(value);
        else reject(new Error(`Missing host event ${event} #${ordinal} ${description} (exit ${this.child.exitCode ?? this.child.signalCode}): ${JSON.stringify(this.events)} ${this.diagnostics}`));
      };
      const check = () => {
        const found = this.events.filter(item => item.event === event && matches(item))[ordinal - 1];
        if (found || this.ended) finish(found);
      };
      this.changes.on('change', check);
      check();
    });
  }

  public async close(): Promise<void> {
    this.child.stdin.end();
    try {
      await this.waitForClose(5000);
    } catch {
      await this.kill();
    }
    if (this.child.exitCode !== 0 || this.count('engineClosed') !== 1) {
      throw new Error(`Wire fixture teardown failed (exit ${this.child.exitCode}, ${this.child.signalCode}): ${this.diagnostics}`);
    }
  }

  public async kill(): Promise<void> {
    if (!this.ended && !this.child.kill('SIGKILL')) throw new Error(`Failed to terminate Wire fixture pid ${this.child.pid}`);
    await this.waitForClose(10_000);
  }

  private async waitForClose(milliseconds: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Wire fixture pid ${this.child.pid} did not exit: ${this.diagnostics}`)), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
}
