import * as vscode from 'vscode';

interface DebugMessage {
  type: string;
  seq?: number;
  request_seq?: number;
  command?: string;
  arguments?: {
    variablesReference?: number; filter?: string; start?: number; count?: number; requestId?: number;
    expression?: string;
    supportsVariablePaging?: boolean; supportsVariableType?: boolean;
  };
  event?: string;
  success?: boolean;
  message?: string;
  body?: {
    variablesReference?: number; result?: string;
    variables?: Array<{ name: string; value: string; type?: string; variablesReference: number;
      namedVariables?: number; indexedVariables?: number; presentationHint?: { kind?: string } }>;
    breakpoints?: Array<{ verified: boolean; line?: number; column?: number; message?: string }>;
    runtimeName?: string;
    threadId?: number;
    reason?: string;
    exitCode?: number;
    category?: string;
    output?: string;
  };
}

/** Test-only observation of DAP as actually published to the editor. */
export class DebugObserver implements vscode.Disposable {
  private readonly history: DebugMessage[] = [];
  readonly requests: DebugMessage[] = [];
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly tracker: vscode.Disposable;
  private editorEnded = false;
  public session?: vscode.DebugSession;

  public constructor(private readonly name: string, adapter?: vscode.DebugAdapter) {
    if (adapter) {
      this.tracker = adapter.onDidSendMessage(m => this.record(m as DebugMessage));
      return;
    }
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('ferret', {
      createDebugAdapterTracker: session => {
        if (this.session || session.name !== this.name) return undefined;
        this.session = session;
        return {
          onWillReceiveMessage: (message: DebugMessage) => { this.requests.push(message); this.changes.fire(); },
          onDidSendMessage: (message: DebugMessage) => this.record(message),
        };
      },
    });
    this.tracker = vscode.Disposable.from(tracker, vscode.debug.onDidTerminateDebugSession(session => {
      if (session.id === this.session?.id) {
        this.editorEnded = true;
        this.changes.fire();
      }
    }));
  }

  private record(message: DebugMessage): void {
    this.history.push(message);
    this.changes.fire();
  }

  public count(predicate: (value: DebugMessage) => boolean): number {
    return this.history.filter(predicate).length;
  }

  public waitRequest(predicate: (value: DebugMessage) => boolean): Promise<DebugMessage> {
    return this.until(() => this.requests.find(predicate), 'DAP request');
  }

  public wait(predicate: (value: DebugMessage) => boolean, ordinal = 1): Promise<DebugMessage> {
    return this.until(() => this.history.filter(predicate)[ordinal - 1], 'DAP message');
  }

  public async waitForEditorEnd(): Promise<void> {
    await this.until(() => this.editorEnded || undefined, 'VS Code session termination');
  }

  public async stopIfActive(): Promise<void> {
    if (!this.session || this.editorEnded) return;
    if (!this.history.some(m => m.event === 'terminated')) {
      try {
        await vscode.debug.stopDebugging(this.session);
      } catch (error) {
        if (!this.editorEnded && !this.history.some(m => m.event === 'terminated')) throw error;
      }
    }
    // VS Code can reject a launch before registering it as a started session.
    if (this.history.some(m => m.command === 'launch' && m.success)) await this.waitForEditorEnd();
  }

  private until<T>(find: () => T | undefined, description: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = find();
        if (found !== undefined) { clearTimeout(timer); listener.dispose(); resolve(found); }
      };
      const listener = this.changes.event(check);
      const timer = setTimeout(() => {
        listener.dispose();
        const events = this.history.map(item => {
          const rows = item.body?.variables;
          return rows ? `variables(${rows.length}, ${rows[0]?.name}…${rows.at(-1)?.name})` : item.event ?? item.command;
        });
        reject(new Error(`Missing ${description} for ${this.name} after ${events.join(', ')}`));
      }, 15_000);
      check();
    });
  }

  public dispose(): void {
    this.tracker.dispose();
    this.changes.dispose();
  }
}
