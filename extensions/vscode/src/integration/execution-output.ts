import * as vscode from 'vscode';

/** Read the same Ferret Execution output model displayed by the workbench. */
export function waitForExecutionOutput(pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let latest = '';
    const check = () => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'output' || !doc.uri.toString(true).includes('Ferret Execution')) continue;
        latest = doc.getText();
        const match = latest.match(pattern);
        if (match) { dispose(); resolve(match[0]); return; }
      }
    };
    const opened = vscode.workspace.onDidOpenTextDocument(check);
    const changed = vscode.workspace.onDidChangeTextDocument(check);
    const timer = setTimeout(() => {
      dispose();
      reject(new Error(`Missing ${pattern} in Ferret Execution: ${latest.slice(-2000)}`));
    }, 15_000);
    const dispose = () => { clearTimeout(timer); opened.dispose(); changed.dispose(); };
    check();
  });
}
