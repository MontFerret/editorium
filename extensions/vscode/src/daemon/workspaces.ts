import { isAbsolute, relative, resolve, sep } from 'node:path';

import type * as vscode from 'vscode';

import type {
  FerretWorkspace,
  ResolvedFerretDocument,
} from './types';

export class FerretWorkspaceRegistry {
  private readonly byRoot = new Map<string, FerretWorkspace>();
  private readonly invalidationEmitter =
    new LocalEventEmitter<FerretWorkspaceInvalidation>();

  public readonly onDidInvalidateWorkspaces =
    this.invalidationEmitter.event;

  public get workspaces(): readonly FerretWorkspace[] {
    return [...this.byRoot.values()].sort((left, right) =>
      left.root.localeCompare(right.root),
    );
  }

  public clear(): void {
    const workspaceIds = this.workspaces.map(({ id }) => id);
    this.byRoot.clear();
    this.emitInvalidation(workspaceIds);
  }

  public delete(root: string): FerretWorkspace | undefined {
    const key = resolve(root);
    const value = this.byRoot.get(key);
    this.byRoot.delete(key);
    if (value !== undefined) {
      this.emitInvalidation([value.id]);
    }

    return value;
  }

  public get(root: string): FerretWorkspace | undefined {
    return this.byRoot.get(resolve(root));
  }

  public resolveDocument(
    documentPath: string,
  ): ResolvedFerretDocument | undefined {
    if (!isAbsolute(documentPath)) {
      return undefined;
    }

    const candidate = resolve(documentPath);
    const matches = this.workspaces
      .map((workspace) => ({
        workspace,
        relativePath: relative(workspace.root, candidate),
      }))
      .filter(({ relativePath }) =>
        relativePath !== '' &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath),
      )
      .sort(
        (left, right) =>
          right.workspace.root.length - left.workspace.root.length,
      );
    const match = matches[0];
    if (match === undefined) {
      return undefined;
    }

    return {
      workspaceId: match.workspace.id,
      relativePath: match.relativePath.split(sep).join('/'),
    };
  }

  public set(workspace: FerretWorkspace): void {
    const root = resolve(workspace.root);
    const previous = this.byRoot.get(root);
    this.byRoot.set(root, {
      id: workspace.id,
      root,
    });
    if (previous !== undefined && previous.id !== workspace.id) {
      this.emitInvalidation([previous.id]);
    }
  }

  private emitInvalidation(workspaceIds: readonly string[]): void {
    if (workspaceIds.length > 0) {
      this.invalidationEmitter.fire({ workspaceIds });
    }
  }
}

export interface FerretWorkspaceInvalidation {
  readonly workspaceIds: readonly string[];
}

class LocalEventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  public readonly event: vscode.Event<T> = (
    listener,
    thisArgs,
    disposables,
  ) => {
    const registered =
      thisArgs === undefined
        ? listener
        : (event: T) => listener.call(thisArgs, event);
    this.listeners.add(registered);
    const disposable: vscode.Disposable = {
      dispose: () => this.listeners.delete(registered),
    };
    disposables?.push(disposable);

    return disposable;
  };

  public fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}
