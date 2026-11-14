import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function fingerprintFile(path: string): Promise<string> {
  // A POSIX FIFO must not wait for a writer before we can check its type.
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK;
  const file = await open(path, flags);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Expected a regular file: ${path}`);
    return createHash('sha256').update(await file.readFile()).digest('hex');
  } finally {
    await file.close();
  }
}
