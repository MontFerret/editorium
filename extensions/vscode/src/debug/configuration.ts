import * as vscode from 'vscode';

import { ferretDebugType } from './adapter';

const vscodeLaunchMetadata = [
  'type',
  'request',
  'name',
  '__configurationTarget',
  '__sessionId',
] as const;

export interface DebugAdapterTrackerRegistrationHost {
  registerDebugAdapterTrackerFactory(
    debugType: string,
    factory: vscode.DebugAdapterTrackerFactory,
  ): vscode.Disposable;
}

export function normalizeFerretLaunchArguments(
  configuration: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const launchArguments = { ...configuration };
  for (const key of vscodeLaunchMetadata) {
    delete launchArguments[key];
  }

  return launchArguments;
}

export function normalizeFerretLaunchRequest(message: unknown): void {
  if (
    !isRecord(message) ||
    message.type !== 'request' ||
    message.command !== 'launch' ||
    !isRecord(message.arguments)
  ) {
    return;
  }

  message.arguments = normalizeFerretLaunchArguments(message.arguments);
}

export function registerFerretLaunchConfigurationTracker(
  host: DebugAdapterTrackerRegistrationHost = vscode.debug,
): vscode.Disposable {
  return host.registerDebugAdapterTrackerFactory(ferretDebugType, {
    createDebugAdapterTracker: () => ({
      onWillReceiveMessage: normalizeFerretLaunchRequest,
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
