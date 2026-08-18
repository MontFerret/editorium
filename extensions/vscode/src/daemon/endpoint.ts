import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DaemonEndpoint {
  readonly cli: string;
  readonly grpc: string;

  dispose(): Promise<void>;
}

export async function createDaemonEndpoint(
  platform: NodeJS.Platform = process.platform,
): Promise<DaemonEndpoint> {
  if (platform === 'win32') {
    const name = `ferretd-vscode-${randomUUID()}`;
    const pipe = `\\\\.\\pipe\\${name}`;

    return {
      cli: `npipe:////./pipe/${name}`,
      grpc: `unix:${pipe}`,
      dispose: () => Promise.resolve(),
    };
  }

  const directory = await mkdtemp(join(tmpdir(), 'ferret-vscode-'));
  try {
    await chmod(directory, 0o700);
    const socket = join(directory, 'ferretd.sock');

    return {
      cli: `unix://${pathToFileURL(socket).pathname}`,
      grpc: `unix://${socket}`,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
