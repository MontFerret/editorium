import * as hostPath from 'node:path';
import type * as vscode from 'vscode';
import { validateParameters } from '../execution/parameters';
import { resolveWorkingDirectory } from '../execution/working-directory';
import type { FerretdExecutable } from '../ferretd';
import type { RuntimeSelection } from '../runtime/coordinator';

export interface PreparedDebugLaunch extends RuntimeSelection {
  readonly executable: FerretdExecutable;
  readonly configPath?: string;
  readonly arguments: Record<string, unknown>;
  verifyConfiguration(): Promise<void>;
}

// The adapter's Go JSON decoder matches launch fields case-insensitively.
const runtimeFields = new Set(['program', 'cwd', 'runtimename', 'parameters', 'workingdirectory']);

export function snapshotDebugArguments(config: vscode.DebugConfiguration, paths = hostPath) {
  const program = launchField(config, 'program')?.value;
  const cwd = launchField(config, 'cwd')?.value;
  if (typeof program !== 'string' || !program.trim().endsWith('.fql')) {
    throw new Error('Set program to a local .fql source file.');
  }
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('Set cwd to a local directory.');
  const directory = launchField(config, 'workingDirectory')?.value;
  if (directory !== undefined && typeof directory !== 'string') throw new Error('Set workingDirectory to a string.');
  const parameters = launchField(config, 'parameters');
  // VS Code substitution and Uri.fsPath can spell the same drive differently.
  // ferretd uses the compilation root when it names the compiled source.
  const source = debugSourcePath(program, paths);
  const root = cwd === undefined ? undefined : debugSourcePath(cwd, paths);
  return {
    root: root?.trim() || paths.dirname(source.trim()),
    directory,
    parameters: parameters && validateParameters(parameters.value),
    // VS Code can add metadata before sending launch. Keep these source inputs
    // consistent with the workspace used to resolve a native directory.
    program: source,
    cwd: root,
  };
}

function debugSourcePath(value: string, paths: typeof hostPath): string {
  if (paths.sep !== '\\') return value;
  return value.replace(/^(\s*(?:\\\\[?.]\\)?)([A-Z])(?=:[\\/])/, (_, prefix: string, drive: string) =>
    prefix + drive.toLowerCase());
}

function launchField(config: vscode.DebugConfiguration, name: string): { value: unknown } | undefined {
  const keys = Object.keys(config).filter(key => key.toLowerCase() === name.toLowerCase());
  if (keys.length > 1) throw new Error(`Specify ${name} only once in the launch options.`);
  return keys.length ? { value: config[keys[0]!] } : undefined;
}

export async function prepareDebugArguments(
  snapshot: ReturnType<typeof snapshotDebugArguments>, runtime: RuntimeSelection,
): Promise<Record<string, unknown>> {
  const directory = await resolveWorkingDirectory(snapshot.directory, snapshot.root, runtime);
  const args: Record<string, unknown> = { program: snapshot.program };
  if (snapshot.cwd !== undefined) args.cwd = snapshot.cwd;
  if (snapshot.parameters !== undefined) args.parameters = snapshot.parameters;
  if (directory !== undefined) args.workingDirectory = directory;
  if (runtime.selector !== '') args.runtimeName = runtime.selector;
  return args;
}

export function mergeDebugArguments(
  original: Record<string, unknown> | undefined, prepared: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = Object.entries(original ?? {}).filter(([key]) => !runtimeFields.has(key.toLowerCase()));
  return { ...Object.fromEntries(metadata), ...prepared };
}
