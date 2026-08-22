import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

import * as vscode from 'vscode';

interface FerretdExecutableBase {
  readonly executable: string;
}

export type FerretdExecutable =
  | (FerretdExecutableBase & {
      readonly source: 'bundled';
      readonly bundledVersion: string;
    })
  | (FerretdExecutableBase & {
      readonly source: 'configured';
    });

export type FerretdExecutableAccess = (
  path: string,
  mode: number,
) => Promise<void>;

export class FerretdExecutableUnavailableError extends Error {
  public readonly cause: unknown;

  public constructor(
    public readonly selection: FerretdExecutable,
    cause: unknown,
  ) {
    super(unavailableMessage(selection));
    this.name = 'FerretdExecutableUnavailableError';
    this.cause = cause;
  }
}

export function createFerretdExecutable(
  configuredPath: string,
  bundledExecutable: string,
  bundledVersion: string,
): FerretdExecutable {
  if (configuredPath !== '') {
    return {
      executable: configuredPath,
      source: 'configured',
    };
  }

  return {
    executable: bundledExecutable,
    source: 'bundled',
    bundledVersion,
  };
}

export function readFerretdExecutable(
  context: vscode.ExtensionContext,
  bundledVersion: string,
): FerretdExecutable {
  const configuredPath = vscode.workspace
    .getConfiguration('ferret')
    .get<string>('server.path', '');

  return createFerretdExecutable(
    configuredPath,
    context.asAbsolutePath(
      `bin/${bundledExecutableName(process.platform)}`,
    ),
    bundledVersion,
  );
}

export async function requireFerretdExecutable(
  selection: FerretdExecutable,
  checkAccess: FerretdExecutableAccess = access,
): Promise<FerretdExecutable> {
  const mode =
    process.platform === 'win32' ? constants.F_OK : constants.X_OK;

  try {
    await checkAccess(selection.executable, mode);
  } catch (error) {
    throw new FerretdExecutableUnavailableError(selection, error);
  }

  return selection;
}

export function bundledExecutableName(
  platform: NodeJS.Platform,
): 'ferretd' | 'ferretd.exe' {
  return platform === 'win32' ? 'ferretd.exe' : 'ferretd';
}

function unavailableMessage(selection: FerretdExecutable): string {
  if (selection.source === 'configured') {
    return (
      'The ferretd executable configured by ferret.server.path is ' +
      `unavailable or not executable: "${selection.executable}". ` +
      'Correct ferret.server.path before starting Ferret debugging. ' +
      'The configured override is authoritative and will not fall back ' +
      'to the bundled executable.'
    );
  }

  return (
    'The ferretd executable bundled with the Ferret extension is ' +
    'unavailable or not executable. Reinstall the extension package ' +
    'for this extension host before starting Ferret debugging.'
  );
}
