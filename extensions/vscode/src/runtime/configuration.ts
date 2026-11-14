import { hasUnambiguousRoot } from '../host-path';
import * as hostPath from 'node:path';

export interface RuntimeConfiguration {
  readonly entered: unknown;
  readonly path?: string;
  readonly problem?: string;
}

export function resolveRuntimeConfiguration(
  entered: unknown,
  base?: string,
  paths = hostPath,
): RuntimeConfiguration {
  if (typeof entered !== 'string') {
    return { entered, problem: 'Set ferret.runtime.configPath to a string containing a filesystem path.' };
  }
  if (entered === '') return { entered };
  if (/\$\{[^}]*\}/.test(entered)) {
    return { entered, problem: 'Use a filesystem path in ferret.runtime.configPath. Variable expansion is unavailable.' };
  }
  const normalized = paths.normalize(entered);
  if (!hasUnambiguousRoot(entered, paths)) {
    return { entered, problem: 'Use a fully qualified drive or UNC path in ferret.runtime.configPath.' };
  }
  if (paths.isAbsolute(entered)) return { entered, path: normalized };
  if (!base || !paths.isAbsolute(base)) {
    return { entered, problem: 'Set an absolute ferret.runtime.configPath in a window without exactly one file-backed workspace folder.' };
  }
  return { entered, path: paths.resolve(base, entered) };
}
