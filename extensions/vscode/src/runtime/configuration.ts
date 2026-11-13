import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
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
  if (paths.sep === '\\' && (/^[a-z]:/i.test(entered) || /^[\\/]/.test(entered))) {
    // Node also treats a path rooted on the current drive as absolute. Check
    // the underlying UNC or drive root for extended-length spellings as well.
    const qualified = normalized.replace(/^\\\\[?.]\\UNC(?:\\|$)/i, '\\\\')
      .replace(/^\\\\[?.]\\(?=[a-z]:)/i, '');
    const root = paths.parse(qualified).root;
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\?)$/i.test(root)) {
      return { entered, problem: 'Use a fully qualified drive or UNC path in ferret.runtime.configPath.' };
    }
  }
  if (paths.isAbsolute(entered)) return { entered, path: normalized };
  if (!base || !paths.isAbsolute(base)) {
    return { entered, problem: 'Set an absolute ferret.runtime.configPath in a window without exactly one file-backed workspace folder.' };
  }
  return { entered, path: paths.resolve(base, entered) };
}

export async function fingerprint(path: string): Promise<string> {
  // A POSIX FIFO must not wait for a writer before we can check its type.
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Runtime configuration is not a regular file: ${path}`);
    return createHash('sha256').update(await file.readFile()).digest('hex');
  } finally {
    await file.close();
  }
}
