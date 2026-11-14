import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PreparedRuntime } from '../runtime/coordinator';
import { RuntimeLaunchError } from '../runtime/errors';

export async function resolveWorkingDirectory(
  value: string | undefined,
  workspaceRoot: string,
  runtime: PreparedRuntime,
): Promise<string | undefined> {
  if (value === undefined || /^\p{White_Space}*$/u.test(value)) return undefined;
  const version = runtime.connection.apiVersion;
  if (version?.major !== 1 || version.minor < 2) {
    throw new RuntimeLaunchError('A runtime working directory requires ferretd API 1.2 or later in major 1.');
  }
  if (runtime.provider === 'wire') return value;
  try {
    const path = await realpath(resolve(workspaceRoot, value));
    if (!(await stat(path)).isDirectory()) throw new Error('Expected a directory.');
    await access(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (error) {
    throw new RuntimeLaunchError(`Cannot use native working directory "${value}": ${String(error)}`);
  }
}
