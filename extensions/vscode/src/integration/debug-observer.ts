import * as vscode from 'vscode';

interface DebugMessage {
  type: string;
  command?: string;
  event?: string;
  success?: boolean;
  message?: string;
  body?: {
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

  public wait(predicate: (value: DebugMessage) => boolean, ordinal = 1): Promise<DebugMessage> {
    return this.until(() => this.history.filter(predicate)[ordinal - 1], 'DAP message');
  }

  public async waitForEditorEnd(): Promise<void> {
    await this.until(() => this.editorEnded || undefined, 'VS Code session termination');
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
        const events = this.history.map(item => item.event ?? item.command);
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
