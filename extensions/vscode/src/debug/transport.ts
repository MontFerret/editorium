import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';

import type { ServerOutput } from '../server';
import { DapFrameReader } from './framing';
import { mergeDebugArguments, type PreparedDebugLaunch } from './launch';

interface Envelope {
  type?: string;
  command?: string;
  event?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
  seq?: number;
  request_seq?: number;
  success?: boolean;
  message?: string;
}

export class FerretDebugTransport implements vscode.DebugAdapter {
  private readonly messages = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  public readonly onDidSendMessage = this.messages.event;
  private readonly reader = new DapFrameReader();
  private readonly pending = new Map<number, string>();
  private readonly outgoing: Envelope[] = [];
  private readonly earlyStops: Envelope[] = [];
  private readonly abort = new AbortController();
  private child?: ChildProcessWithoutNullStreams;
  private preparation?: Promise<PreparedDebugLaunch>;
  private launch?: PreparedDebugLaunch;
  private starting?: Promise<void>;
  private checking?: Promise<void>;
  private failure?: Promise<void>;
  private startupDiagnostic?: string;
  private supportsSelection?: boolean;
  private launchRequest?: { seq: number; state: 'held' | 'forwarded' | 'accepted' };
  private stopping = false;
  private terminated = false;
  private finished = false;
  private timer?: NodeJS.Timeout;
  private hardDeadline = 0;
  private forced = false;
  private settle!: () => void;
  private rejectShutdown!: (error: Error) => void;
  private readonly closed = new Promise<void>((resolve, reject) => {
    this.settle = resolve;
    this.rejectShutdown = reject;
  });

  public constructor(
    private readonly prepareLaunch: (signal: AbortSignal) => Promise<PreparedDebugLaunch>,
    private readonly output: ServerOutput,
    private readonly onClosed: () => void,
    private readonly spawnAdapter = (path: string, args: string[]) => spawn(path, args, { windowsHide: true }),
    private readonly graceMs = 10_000,
  ) {
    void this.closed.catch(() => undefined);
  }

  public prepare(): void {
    try { this.preparation ??= this.prepareLaunch(this.abort.signal); }
    catch (error) { this.preparation = Promise.reject(error); }
    void this.preparation.catch(() => undefined);
  }

  public handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as Envelope;
    if (this.stopping) {
      if (!this.finished && request.type === 'request') {
        const shutdown = request.command === 'terminate' || request.command === 'disconnect';
        this.reply(request, shutdown, shutdown ? undefined : 'Ferret debug adapter is closing.');
      }
      return;
    }
    if (request.type === 'request' && request.seq !== undefined && request.command) {
      this.pending.set(request.seq, request.command);
      if (request.command === 'launch') this.launchRequest ??= { seq: request.seq, state: 'held' };
      const stop = request.arguments?.restart !== true &&
        (request.command === 'disconnect' || request.command === 'terminate');
      if (stop) {
        this.abort.abort();
        if (!this.launchRequest || this.launchRequest.state === 'held') {
          this.reply(request, true);
          this.dispose();
        } else {
          this.write(request);
          if (request.command === 'disconnect') this.dispose();
          else this.awaitShutdownProgress();
        }
        return;
      }
      if (request.command === 'cancel') {
        // A launch held at the initialize/fingerprint gate is still ours.
        if (this.launchRequest?.state === 'held' && this.launchRequest.seq === request.arguments?.requestId) {
          this.reply(request, true);
          this.dispose();
        } else if (this.child) this.write(request);
        else this.reply(request, true);
        return;
      }
    }
    this.outgoing.push(request);
    if (this.child) this.flush();
    else this.starting ??= this.start();
  }

  private async start(): Promise<void> {
    try {
      this.prepare();
      this.launch = await this.preparation!;
      this.abort.signal.throwIfAborted();
      await this.launch.verifyConfiguration();
      this.abort.signal.throwIfAborted();
      const { executable, configPath } = this.launch;
      const args = configPath ? ['dap', '--runtime-config', configPath] : ['dap'];
      this.output.info(`Starting Ferret debug adapter (${executable.source}): ${executable.executable} dap`);
      const child = this.spawnAdapter(executable.executable, args);
      this.child = child;
      child.once('close', (code, signal) => {
        if (!this.abort.signal.aborted && !this.terminated) {
          this.fail(new Error(`Ferret debug adapter closed (${signal ?? code}). See Ferret output for adapter diagnostics.`));
        }
        void this.finish();
      });
      child.on('error', error => this.fail(error));
      child.stdin.on('error', error => this.fail(error));
      child.stdout.on('error', error => this.fail(error));
      child.stderr.on('error', error => this.fail(error));
      const diagnostics = createInterface({ input: child.stderr });
      diagnostics.on('line', (line: string) => {
        this.output.info(`Ferret DAP: ${line}`);
        if (this.supportsSelection === undefined && line.startsWith('ferretd: ')) this.startupDiagnostic = line;
      });
      child.stdout.on('data', (data: Buffer) => {
        try { this.reader.push(data, message => this.receive(message as Envelope)); }
        catch (error) { this.fail(error); }
      });
      child.stdout.once('end', () => {
        // close follows drained stdio. EOF must also unblock a child waiting for input.
        if (this.terminated || this.abort.signal.aborted) this.dispose();
        else {
          // Process diagnostics on stderr can arrive after stdout EOF.
          child.stdin.end();
          this.timer ??= setTimeout(() => this.fail(new Error('Ferret DAP output closed.')), this.graceMs);
        }
      });
      this.flush();
    } catch (error) {
      if (!this.abort.signal.aborted) this.fail(error);
      if (!this.child) await this.finish();
    }
  }

  private flush(): void {
    while (this.outgoing.length && !this.abort.signal.aborted && !this.checking) {
      const request = this.outgoing[0]!;
      if (request.type === 'request' && request.command === 'launch') {
        if (this.supportsSelection === undefined) return;
        const launch = this.launch!;
        this.checking = launch.verifyConfiguration().then(() => {
          if (this.abort.signal.aborted) return;
          if (!this.supportsSelection) {
            if (launch.arguments.workingDirectory !== undefined) {
              throw new Error('A Debug workingDirectory override requires a Ferret adapter that advertises runtime selection.');
            }
            if (launch.configPath || launch.selector !== '') {
              throw new Error('This Ferret debug adapter does not support runtime selection.');
            }
          }
          this.outgoing.shift();
          if (this.launchRequest && this.launchRequest.seq === request.seq) this.launchRequest.state = 'forwarded';
          this.write({ ...request, arguments: mergeDebugArguments(request.arguments, launch.arguments) });
        }).catch(error => {
          if (!this.abort.signal.aborted) this.fail(error);
        }).finally(() => {
          this.checking = undefined;
          this.flush();
        });
        return;
      }
      this.write(this.outgoing.shift()!);
    }
  }

  private write(message: Envelope): void {
    const body = Buffer.from(JSON.stringify(message));
    this.child!.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  private receive(message: Envelope): void {
    if (this.failure) return;
    if (message.type === 'response' && message.request_seq !== undefined) {
      const command = this.pending.get(message.request_seq);
      if (command === 'initialize') {
        if (message.success !== true) {
          this.fail(new Error(message.message ?? 'Ferret debug adapter initialization failed.'));
          return;
        }
        this.supportsSelection = message.body?.supportsFerretRuntimeSelection === true;
      }
      if (command === 'launch' && message.success === true) {
        if (this.abort.signal.aborted) {
          this.reply({ seq: message.request_seq, command }, false, 'cancelled');
          return;
        }
        const launch = this.launch!;
        const name = message.body?.runtimeName;
        if ((launch.configPath || launch.selector !== '' || name !== undefined) && name !== launch.name) {
          this.fail(new Error(`The debug adapter did not acknowledge the expected Ferret runtime "${launch.name}".`));
          return;
        }
        if (this.launchRequest?.seq === message.request_seq) this.launchRequest.state = 'accepted';
      }
      this.pending.delete(message.request_seq);
      this.messages.fire(message);
      if (command === 'initialize') this.flush();
      if (command === 'launch') {
        if (this.launchRequest?.state === 'accepted' && !this.abort.signal.aborted) {
          for (const stop of this.earlyStops.splice(0)) this.messages.fire(stop);
        } else this.dispose();
      }
      if (command === 'terminate' || command === 'disconnect') this.awaitShutdownProgress();
      return;
    }
    if (message.type === 'event') {
      if (message.event === 'stopped' && (this.launchRequest?.state !== 'accepted' || this.abort.signal.aborted)) {
        if (!this.abort.signal.aborted) this.earlyStops.push(message);
        return;
      }
      if (message.event === 'terminated') {
        if (this.terminated) return;
        this.terminated = true;
        this.awaitShutdownProgress();
      }
    }
    this.messages.fire(message);
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    // Recheck startup failures before publishing them. Child close can race this read.
    this.failure = Promise.resolve().then(async () => {
      let diagnostic = this.startupDiagnostic ?? error;
      if (this.launch?.configPath && this.supportsSelection === undefined) {
        try { await this.launch.verifyConfiguration(); }
        catch (changed) { diagnostic = changed; }
      }
      const message = diagnostic instanceof Error ? diagnostic.message : String(diagnostic);
      this.output.error(`Ferret debug adapter failed: ${message}`);
      this.notifyTermination(message);
    });
    this.dispose();
  }

  private reply(request: Envelope, success: boolean, message?: string): void {
    if (request.seq !== undefined) this.pending.delete(request.seq);
    this.messages.fire({ seq: 0, type: 'response', request_seq: request.seq, command: request.command, success, message });
  }

  private notifyTermination(message: string): void {
    for (const [seq, command] of this.pending) this.reply({ seq, command }, false, message);
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
    this.abort.abort();
    if (!this.failure && this.launchRequest?.state === 'held') {
      this.reply({ seq: this.launchRequest.seq, command: 'launch' }, false, 'cancelled');
    }
    this.outgoing.length = this.earlyStops.length = 0;
    if (!this.child) {
      if (!this.starting) void this.finish();
      return;
    }
    this.child.stdin.end();
    this.awaitShutdownProgress();
  }

  private awaitShutdownProgress(): void {
    if (!this.abort.signal.aborted || !this.child || this.forced || this.finished) return;
    // Allow another grace interval on shutdown acknowledgments, with a fixed
    // overall bound even if an adapter never closes its streams.
    this.hardDeadline ||= Date.now() + 3 * this.graceMs;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.stopping) { this.dispose(); return; }
      this.forced = true;
      this.output.error('Forcing Ferret debug adapter termination. Remote cleanup could not be confirmed.');
      try { this.child?.kill('SIGKILL'); }
      catch (error) { this.output.error('Terminating Ferret debug adapter failed', error); }
      this.timer = setTimeout(() => {
        const error = new Error('Ferret debug adapter cleanup has not completed. Runtime reload remains blocked until the process closes.');
        this.output.error(error.message);
        this.rejectShutdown(error);
      }, this.graceMs);
    }, Math.min(this.graceMs, Math.max(0, this.hardDeadline - Date.now())));
  }

  private async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = this.stopping = true;
    this.abort.abort();
    clearTimeout(this.timer);
    await Promise.allSettled([this.preparation, this.failure, this.checking]);
    this.notifyTermination('Ferret debug adapter closed.');
    this.messages.dispose();
    this.onClosed();
    this.settle();
  }
}
