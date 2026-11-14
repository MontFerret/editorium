import * as vscode from 'vscode';

interface DebugMessage {
  type: string;
  command?: string;
  event?: string;
  success?: boolean;
  message?: string;
  body?: {
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
  public session?: vscode.DebugSession;

  public constructor(private readonly name: string) {
    this.tracker = vscode.debug.registerDebugAdapterTrackerFactory('ferret', {
      createDebugAdapterTracker: session => {
        if (session.name !== this.name) return undefined;
        this.session = session;
        return {
          onDidSendMessage: (message: DebugMessage) => {
            this.history.push(message);
            this.changes.fire();
          },
        };
      },
    });
  }

  public wait(predicate: (value: DebugMessage) => boolean, ordinal = 1): Promise<DebugMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.history.filter(predicate)[ordinal - 1];
        if (found) { clearTimeout(timer); listener.dispose(); resolve(found); }
      };
      const listener = this.changes.event(check);
      const timer = setTimeout(() => {
        listener.dispose();
        const events = this.history.map(item => item.event ?? item.command);
        reject(new Error(`Missing DAP message for ${this.name} after ${events.join(', ')}`));
      }, 15_000);
      check();
    });
  }

  public dispose(): void {
    this.tracker.dispose();
    this.changes.dispose();
  }
}
