import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

import tarStream from 'tar-stream';

import {
  readFerretdVersion,
  sourceArchiveUrl,
} from './ferretd.mjs';

const maximumArchiveSize = 64 * 1024 * 1024;
const maximumExpandedArchiveSize = 256 * 1024 * 1024;
const maximumProtoFileSize = 4 * 1024 * 1024;
const maximumProtoTreeSize = 32 * 1024 * 1024;
const versionMarker = '.ferretd-version';
const requiredSchemas = Object.freeze([
  'daemon/v1/daemon.proto',
  'execution/v1/execution.proto',
  'workspace/v1/workspace.proto',
]);

export async function syncFerretdProto({
  repositoryRoot,
  force = false,
  fetchImplementation = globalThis.fetch,
  replaceImplementation = replaceDirectoryAtomic,
}) {
  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  const version = await readFerretdVersion(repositoryRoot);
  const sharedProtoRoot = join(repositoryRoot, 'shared', 'proto');
  const managedRoot = join(sharedProtoRoot, 'ferretd');

  if (!force && await schemasMatch(managedRoot, version)) {
    return { updated: false, version };
  }

  await mkdir(sharedProtoRoot, { recursive: true });
  const stagingRoot = await mkdtemp(
    join(sharedProtoRoot, '.ferretd-stage-'),
  );

  try {
    await downloadAndExtract({
      destination: stagingRoot,
      fetchImplementation,
      version,
    });
    await validateRequiredSchemas(stagingRoot);
    await writeFile(
      join(stagingRoot, versionMarker),
      `${version}\n`,
      { flag: 'wx' },
    );
    await replaceImplementation(stagingRoot, managedRoot);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  return { updated: true, version };
}

export async function replaceDirectoryAtomic(
  source,
  destination,
  {
    renameImplementation = rename,
    removeImplementation = rm,
  } = {},
) {
  const backup = `${destination}.backup-${process.pid}-${randomUUID()}`;
  const hadDestination = await isDirectory(destination);

  if (hadDestination) {
    await renameImplementation(destination, backup);
  }

  try {
    await renameImplementation(source, destination);
  } catch (error) {
    if (hadDestination) {
      try {
        await renameImplementation(backup, destination);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Cannot replace ${destination} or restore its previous contents`,
        );
      }
    }

    throw error;
  }

  if (hadDestination) {
    await removeImplementation(backup, { recursive: true, force: true });
  }
}

async function schemasMatch(managedRoot, version) {
  try {
    const marker = await readFile(
      join(managedRoot, versionMarker),
      'utf8',
    );
    if (marker !== `${version}\n`) {
      return false;
    }

    await validateRequiredSchemas(managedRoot);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function downloadAndExtract({
  destination,
  fetchImplementation,
  version,
}) {
  const url = sourceArchiveUrl(version);
  let response;

  try {
    response = await fetchImplementation(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(`Cannot download ${url}: ${formatError(error)}`);
  }

  if (!response.ok) {
    throw new Error(
      `Cannot download ${url}: HTTP ${response.status} ` +
        response.statusText,
    );
  }
  if (response.body === null) {
    throw new Error(`Cannot download ${url}: response has no body`);
  }

  const extract = tarStream.extract();
  const destinationRoot = resolve(destination);
  const files = new Set();
  let archiveRoot;
  let totalSize = 0;

  extract.on('entry', (header, stream, next) => {
    if (header.name.indexOf('..') !== -1) {
      stream.resume();
      extract.destroy(
        new Error(`Unsafe schema archive path: ${header.name}`),
      );
      return;
    }

    let relativePath;
    try {
      relativePath = protoPath(header.name);
    } catch (error) {
      stream.resume();
      extract.destroy(error);
      return;
    }
    if (relativePath === undefined) {
      stream.on('error', (error) => extract.destroy(error));
      stream.on('end', next);
      stream.resume();
      return;
    }

    const entryRoot = header.name.split('/')[0];
    if (archiveRoot === undefined) {
      archiveRoot = entryRoot;
    } else if (archiveRoot !== entryRoot) {
      stream.resume();
      extract.destroy(new Error('Archive contains multiple source roots'));
      return;
    }

    if (header.type !== 'file') {
      stream.resume();
      extract.destroy(
        new Error(`Schema archive entry is not a regular file: ${header.name}`),
      );
      return;
    }
    const outputPath = resolve(destinationRoot, relativePath);
    const outputRelativePath = relative(destinationRoot, outputPath);
    if (
      outputRelativePath === '' ||
      outputRelativePath === '..' ||
      outputRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(outputRelativePath)
    ) {
      stream.resume();
      extract.destroy(
        new Error(`Unsafe schema archive path: ${header.name}`),
      );
      return;
    }
    if (files.has(relativePath)) {
      stream.resume();
      extract.destroy(
        new Error(`Schema archive contains duplicate ${relativePath}`),
      );
      return;
    }
    if (header.size > maximumProtoFileSize) {
      stream.resume();
      extract.destroy(new Error(`${relativePath} exceeds the file size limit`));
      return;
    }
    if (totalSize + header.size > maximumProtoTreeSize) {
      stream.resume();
      extract.destroy(new Error('Schema archive exceeds the total size limit'));
      return;
    }

    files.add(relativePath);
    totalSize += header.size;
    collectStream(stream, maximumProtoFileSize).then(
      (contents) => {
        mkdir(dirname(outputPath), { recursive: true })
          .then(() => writeFile(
            outputPath,
            contents,
            { flag: 'wx', mode: 0o644 },
          ))
          .then(next, (error) => extract.destroy(error));
      },
      (error) => extract.destroy(error),
    );
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      byteLimit(maximumArchiveSize, 'Source archive'),
      createGunzip(),
      byteLimit(maximumExpandedArchiveSize, 'Expanded source archive'),
      extract,
    );
  } catch (error) {
    throw new Error(`Cannot extract ${url}: ${formatError(error)}`);
  }

  if (files.size === 0) {
    throw new Error(`${url} does not contain proto/ferretd schemas`);
  }
}

function protoPath(archivePath) {
  if (archivePath.startsWith('/') || archivePath.includes('\\')) {
    throw new Error(`Unsafe schema archive path: ${archivePath}`);
  }

  const parts = archivePath.split('/');
  if (
    parts[0] === '' ||
    parts[0] === '.' ||
    parts[0] === '..' ||
    !/^[0-9A-Za-z._-]+$/u.test(parts[0])
  ) {
    throw new Error(`Unsafe schema archive path: ${archivePath}`);
  }
  if (parts.length < 4 || parts[1] !== 'proto' || parts[2] !== 'ferretd') {
    return undefined;
  }
  const directoryEntry = parts.at(-1) === '';
  const relativeParts = parts.slice(3, directoryEntry ? -1 : undefined);
  if (relativeParts.length === 0 && directoryEntry) {
    return undefined;
  }
  if (
    relativeParts.length === 0 ||
    relativeParts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        !/^[0-9A-Za-z._-]+$/u.test(part),
    )
  ) {
    throw new Error(`Unsafe schema archive path: ${archivePath}`);
  }
  if (directoryEntry) {
    return undefined;
  }

  const relativePath = relativeParts.join('/');
  return relativePath.endsWith('.proto') ? relativePath : undefined;
}

async function validateRequiredSchemas(root) {
  for (const schema of requiredSchemas) {
    const path = join(root, schema);
    let metadata;

    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Missing required ferretd schema: ${schema}`);
      }
      throw error;
    }

    if (!metadata.isFile()) {
      throw new Error(`Required ferretd schema is not a file: ${schema}`);
    }
  }
}

function byteLimit(maximumSize, label) {
  let size = 0;

  return new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maximumSize) {
        callback(new Error(`${label} exceeds the size limit`));
        return;
      }

      callback(null, chunk);
    },
  });
}

async function collectStream(stream, maximumSize) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumSize) {
      throw new Error('Schema archive entry exceeds the file size limit');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, size);
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--force')) {
    throw new Error('Usage: npm run proto:sync -- [--force]');
  }
  if (args.filter((argument) => argument === '--force').length > 1) {
    throw new Error('--force may be specified only once');
  }

  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = await syncFerretdProto({
    force: args.includes('--force'),
    repositoryRoot,
  });
  console.log(
    result.updated
      ? `Synchronized ferretd ${result.version} protocol schemas.`
      : `ferretd ${result.version} protocol schemas are already current.`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
