import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';

import type { FerretdExecutable } from '../ferretd';
import type { ServerOutput } from '../server';
import { DapFrameReader } from './framing';

interface Envelope {
  type?: string;
  command?: string;
  event?: string;
  arguments?: { restart?: boolean };
  seq?: number;
  request_seq?: number;
  success?: boolean;
}

export class FerretDebugTransport implements vscode.DebugAdapter {
  private readonly messages = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  public readonly onDidSendMessage = this.messages.event;
  private readonly reader = new DapFrameReader();
  private readonly pending = new Map<number, string>();
  private readonly outgoing: Buffer[] = [];
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private preparation?: Promise<FerretdExecutable>;
  private stopping = false;
  private terminated = false;
  private finished = false;
  private timer?: NodeJS.Timeout;
  private settle!: () => void;
  private rejectShutdown!: (error: Error) => void;
  private readonly closed = new Promise<void>((resolve, reject) => {
    this.settle = resolve;
    this.rejectShutdown = reject;
  });

  public constructor(
    private readonly executable: () => Promise<FerretdExecutable>,
    private readonly output: ServerOutput,
    private readonly onClosed: () => void,
    private readonly spawnAdapter = (path: string) => spawn(path, ['dap'], { windowsHide: true }),
    private readonly graceMs = 1500,
  ) {
    // VS Code's synchronous dispose cannot await shutdown.
    void this.closed.catch(() => undefined);
  }

  public prepare(): void {
    // Capture the executable at admission, before an override change. VS Code
    // attaches its message listener after it receives the inline descriptor.
    try { this.preparation ??= this.executable(); }
    catch (error) { this.preparation = Promise.reject(error); }
    void this.preparation.catch(() => undefined);
  }

  public handleMessage(message: vscode.DebugProtocolMessage): void {
    if (this.stopping) return;
    const request = message as Envelope;
    if (request.type === 'request' && request.seq !== undefined && request.command) {
      this.pending.set(request.seq, request.command);
    }
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    if (this.child) this.child.stdin.write(frame);
    else this.outgoing.push(frame);

    if (request.type === 'request' && request.arguments?.restart !== true) {
      if (request.command === 'disconnect' || (request.command === 'terminate' && !this.child)) {
        this.dispose();
        return;
      }
      if (request.command === 'terminate') {
        // Let the child respond and VS Code disconnect normally, even when Stop
        // arrives during initialization. A stalled child still has a deadline.
        this.timer ??= setTimeout(() => this.dispose(), this.graceMs);
      }
    }
    this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    try {
      this.prepare();
      const selection = await this.preparation!;
      if (this.stopping) { this.finish(); return; }
      this.output.info(`Starting Ferret debug adapter (${selection.source}): ${selection.executable} dap`);
      const child = this.spawnAdapter(selection.executable);
      this.child = child;
      child.once('close', () => this.finish());
      child.on('error', error => this.fail(error));
      child.stdin.on('error', error => this.fail(error));
      child.stdout.on('error', error => this.fail(error));
      child.stderr.on('error', error => this.fail(error));
      child.stderr.on('data', (data: Buffer) => this.output.info(`Ferret DAP: ${data.toString().trimEnd()}`));
      child.stdout.on('data', (data: Buffer) => {
        try { this.reader.push(data, message => this.receive(message as Envelope)); }
        catch (error) { this.fail(error); }
      });
      child.stdout.once('end', () => this.dispose());
      for (const frame of this.outgoing.splice(0)) child.stdin.write(frame);
    } catch (error) {
      this.fail(error);
      if (!this.child) this.finish();
    }
  }

  private receive(message: Envelope): void {
    if (message.type === 'response' && message.request_seq !== undefined) this.pending.delete(message.request_seq);
    if (message.type === 'event' && message.event === 'terminated') this.terminated = true;
    this.messages.fire(message);
    if (message.type === 'response' && message.success === false &&
        (message.command === 'initialize' || message.command === 'launch')) this.dispose();
  }

  private fail(error: unknown): void {
    this.output.error('Ferret debug adapter transport failed', error);
    this.notifyTermination(error instanceof Error ? error.message : String(error));
    this.dispose();
  }

  private notifyTermination(message: string): void {
    for (const [seq, command] of this.pending) {
      this.messages.fire({ seq: 0, type: 'response', request_seq: seq, command, success: false, message });
    }
    this.pending.clear();
    if (!this.terminated) {
      this.terminated = true;
      this.messages.fire({ seq: 0, type: 'event', event: 'terminated' });
    }
  }

  public shutdown(): Promise<void> {
    this.dispose();
    return this.closed;
  }

  public dispose(): void {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
    this.outgoing.length = 0;
    if (!this.child) {
      if (!this.starting) {
        if (this.preparation) void this.preparation.then(() => this.finish(), () => this.finish());
        else this.finish();
      }
      return;
    }
    this.child.stdin.end();
    this.timer = setTimeout(() => {
      try { this.child?.kill('SIGKILL'); }
      catch (error) { this.output.error('Terminating Ferret debug adapter failed', error); }
      this.timer = setTimeout(() => {
        const error = new Error('Ferret debug adapter cleanup has not completed. Runtime reload remains blocked until the process closes.');
        this.output.error(error.message);
        this.rejectShutdown(error);
      }, this.graceMs);
    }, this.graceMs);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = this.stopping = true;
    clearTimeout(this.timer);
    this.notifyTermination('Ferret debug adapter closed.');
    this.messages.dispose();
    this.onClosed();
    this.settle();
  }
}
