import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve } from 'node:path';

export interface RuntimeConfiguration {
  readonly entered: unknown;
  readonly path?: string;
  readonly problem?: string;
}

export function resolveRuntimeConfiguration(entered: unknown, base?: string): RuntimeConfiguration {
  if (typeof entered !== 'string') {
    return { entered, problem: 'Set ferret.runtime.configPath to a string containing a filesystem path.' };
  }
  if (entered === '') return { entered };
  if (/\$\{[^}]*\}/.test(entered)) {
    return { entered, problem: 'Use a filesystem path in ferret.runtime.configPath. Variable expansion is unavailable.' };
  }
  // A Windows drive-relative or root-relative path depends on process state.
  if (process.platform === 'win32' && /^(?:[a-z]:(?![\\/])|[\\/](?![\\/]))/i.test(entered)) {
    return { entered, problem: 'Use a fully qualified drive or UNC path in ferret.runtime.configPath.' };
  }
  if (isAbsolute(entered)) return { entered, path: normalize(entered) };
  if (!base || !isAbsolute(base)) {
    return { entered, problem: 'Set an absolute ferret.runtime.configPath in a window without exactly one file-backed workspace folder.' };
  }
  return { entered, path: resolve(base, entered) };
}

export async function fingerprint(path: string): Promise<string> {
  // Check before opening as well: opening a named pipe can block.
  if (!(await stat(path)).isFile()) throw new Error(`Runtime configuration is not a regular file: ${path}`);
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Runtime configuration is not a regular file: ${path}`);
    return createHash('sha256').update(await file.readFile()).digest('hex');
  } finally {
    await file.close();
  }
}
