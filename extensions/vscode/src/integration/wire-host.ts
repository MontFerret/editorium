import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

interface HostEvent {
  readonly event: string;
  readonly id?: number;
  readonly endpoint?: string;
  readonly token?: string;
}

export class WireHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly changes = new EventEmitter();
  private readonly events: HostEvent[] = [];
  private readonly closed: Promise<void>;
  private ended = false;
  private diagnostics = '';

  public constructor(binary: string, root: string) {
    this.child = spawn(binary, ['-root', root], { stdio: 'pipe', windowsHide: true });
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

  public count(event: string): number {
    return this.events.filter(item => item.event === event).length;
  }

  public wait(event: string, ordinal = 1, id?: number, token?: string): Promise<HostEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(), 15_000);
      const finish = (value?: HostEvent) => {
        clearTimeout(timer);
        this.changes.off('change', check);
        if (value) resolve(value);
        else reject(new Error(`Missing host event ${event} #${ordinal}: ${JSON.stringify(this.events)} ${this.diagnostics}`));
      };
      const check = () => {
        const found = this.events.filter(item => item.event === event &&
          (id === undefined || item.id === id) && (token === undefined || item.token === token))[ordinal - 1];
        if (found || this.ended) finish(found);
      };
      this.changes.on('change', check);
      check();
    });
  }

  public async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
