import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  FerretWorkspace,
  ResolvedFerretDocument,
} from './types';

export class FerretWorkspaceRegistry {
  private readonly byRoot = new Map<string, FerretWorkspace>();

  public get workspaces(): readonly FerretWorkspace[] {
    return [...this.byRoot.values()].sort((left, right) =>
      left.root.localeCompare(right.root),
    );
  }

  public clear(): void {
    this.byRoot.clear();
  }

  public delete(root: string): FerretWorkspace | undefined {
    const key = resolve(root);
    const value = this.byRoot.get(key);
    this.byRoot.delete(key);

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
    this.byRoot.set(resolve(workspace.root), {
      id: workspace.id,
      root: resolve(workspace.root),
    });
  }
}
