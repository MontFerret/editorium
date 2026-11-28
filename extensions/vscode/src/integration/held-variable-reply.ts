import * as assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { DapFrameReader } from '../debug/framing';
import type { DebugObserver } from './debug-observer';

/** Delay one real adapter reply before the inline transport receives it. */
export class HeldVariableReply {
  private pending?: () => void;
  private match?: (sequence: number) => boolean;
  private timer?: NodeJS.Timeout;
  private notify?: (sequence: number) => void;

  public intercept(stdout: Readable): void {
    // spawn precedes stdout data. Start at a frame boundary and keep the original receiver.
    const receivers = stdout.listeners('data');
    assert.equal(receivers.length, 1);
    const receive = receivers[0] as (data: Buffer) => void;
    stdout.removeListener('data', receive);
    const reader = new DapFrameReader();
    stdout.on('data', (chunk: Buffer) => reader.push(chunk, message => {
      const reply = message as { command?: string; type?: string; request_seq?: number; success?: boolean };
      const body = Buffer.from(JSON.stringify(message));
      const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
      const forward = () => receive.call(stdout, framed);
      if (reply.type === 'response' && reply.command === 'variables' && reply.success &&
          reply.request_seq !== undefined && this.match?.(reply.request_seq)) {
        this.match = undefined;
        this.pending = forward;
        clearTimeout(this.timer);
        this.notify!(reply.request_seq);
      } else forward();
    }));
  }

  public holdFirstIndexedPage(observer: DebugObserver): Promise<number> {
    this.match = seq => observer.requests.some(m => m.seq === seq && m.command === 'variables' &&
      m.arguments?.filter === 'indexed' && m.arguments.start === 0 && m.arguments.count === 100);
    return new Promise((resolve, reject) => {
      this.notify = resolve;
      this.timer = setTimeout(() => {
        const requested = observer.requests.filter(m => m.command === 'variables').map(m => m.arguments?.variablesReference);
        reject(new Error(`No first indexed page among requested references: ${requested.join(', ')}`));
      }, 10_000);
    });
  }

  public release(): void {
    clearTimeout(this.timer);
    this.match = undefined;
    this.pending?.();
    this.pending = undefined;
  }
}
