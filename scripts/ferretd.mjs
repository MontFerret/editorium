import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import tarStream from 'tar-stream';
import yauzl from 'yauzl';

const releaseRepository = 'MontFerret/ferretd';
const checksumAsset = 'ferretd_checksums.txt';
const maximumBinarySize = 128 * 1024 * 1024;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export async function readFerretdVersion(repositoryRoot) {
  const manifestPath = join(repositoryRoot, 'ferretd.json');
  let manifest;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${manifestPath}: ${formatError(error)}`);
  }

  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== 1 ||
    typeof manifest.ferretd !== 'string' ||
    !versionPattern.test(manifest.ferretd)
  ) {
    throw new Error(
      `${manifestPath} must contain exactly one valid "ferretd" version`,
    );
  }

  return manifest.ferretd;
}

export function parseChecksums(contents) {
  const checksums = new Map();

  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    if (rawLine === '') {
      continue;
    }

    const match = /^([0-9a-f]{64})  ([^/\\]+)$/u.exec(rawLine);
    if (match === null) {
      throw new Error(`Invalid checksum line ${index + 1}`);
    }

    const [, digest, name] = match;
    if (checksums.has(name)) {
      throw new Error(`Duplicate checksum entry for ${name}`);
    }

    checksums.set(name, digest);
  }

  if (checksums.size === 0) {
    throw new Error('Checksum manifest is empty');
  }

  return checksums;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);

  return hash.digest('hex');
}

export function releaseAssetUrl(version, assetName) {
  validateFerretdVersion(version);
  if (!/^[0-9A-Za-z._-]+$/u.test(assetName)) {
    throw new Error(`Invalid ferretd release asset: ${assetName}`);
  }

  return (
    `https://github.com/${releaseRepository}/releases/download/` +
    `v${version}/${assetName}`
  );
}

export function sourceArchiveUrl(version) {
  validateFerretdVersion(version);

  return (
    `https://github.com/${releaseRepository}/archive/refs/tags/` +
    `v${version}.tar.gz`
  );
}

export async function acquireFerretd({
  repositoryRoot,
  target,
  artifact,
  archiveType,
  binaryName,
  unix,
  fetchImplementation = globalThis.fetch,
}) {
  validateAcquisitionInput({
    target,
    artifact,
    archiveType,
    binaryName,
  });

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required');
  }

  const version = await readFerretdVersion(repositoryRoot);
  const cacheRoot = join(
    repositoryRoot,
    '.dist',
    'ferretd',
    version,
    target,
  );
  await mkdir(cacheRoot, { recursive: true });

  const checksumPath = join(cacheRoot, checksumAsset);
  if (!(await isFile(checksumPath))) {
    await downloadFile(
      releaseAssetUrl(version, checksumAsset),
      checksumPath,
      fetchImplementation,
    );
  }

  const checksums = parseChecksums(await readFile(checksumPath, 'utf8'));
  const expectedDigest = checksums.get(artifact);
  if (expectedDigest === undefined) {
    throw new Error(
      `${checksumAsset} does not contain ${artifact} for ${target}`,
    );
  }

  const archivePath = join(cacheRoot, artifact);
  if (!(await isFile(archivePath))) {
    await downloadFile(
      releaseAssetUrl(version, artifact),
      archivePath,
      fetchImplementation,
    );
  }

  const actualDigest = await sha256File(archivePath);
  if (actualDigest !== expectedDigest) {
    await rm(archivePath, { force: true });

    throw new Error(
      `Checksum mismatch for ${artifact}: expected ${expectedDigest}, got ${actualDigest}`,
    );
  }

  const binary = await extractBinary(
    archivePath,
    archiveType,
    binaryName,
  );
  const extractedPath = join(cacheRoot, 'extracted', binaryName);
  await writeFileAtomic(extractedPath, binary, unix ? 0o755 : 0o644);

  return {
    archivePath,
    binaryPath: extractedPath,
    digest: actualDigest,
    version,
  };
}

export async function copyFileAtomic(source, destination, mode) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;

  try {
    await copyFile(source, temporary);
    await chmod(temporary, mode);
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function downloadFile(url, destination, fetchImplementation) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;

  try {
    const response = await fetchImplementation(url, { redirect: 'follow' });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (response.body === null) {
      throw new Error('response has no body');
    }

    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`Cannot download ${url}: ${formatError(error)}`);
  }
}

async function extractBinary(archivePath, archiveType, binaryName) {
  if (archiveType === 'tar.gz') {
    return extractTarGzipBinary(archivePath, binaryName);
  }

  if (archiveType === 'zip') {
    return extractZipBinary(archivePath, binaryName);
  }

  throw new Error(`Unsupported archive type: ${archiveType}`);
}

async function extractTarGzipBinary(archivePath, binaryName) {
  const extract = tarStream.extract();
  let binary;

  extract.on('entry', (header, stream, next) => {
    if (header.name !== binaryName) {
      stream.on('error', (error) => extract.destroy(error));
      stream.on('end', next);
      stream.resume();
      return;
    }

    if (binary !== undefined) {
      stream.resume();
      extract.destroy(new Error(`Archive contains duplicate ${binaryName}`));
      return;
    }
    if (header.type !== 'file') {
      stream.resume();
      extract.destroy(new Error(`${binaryName} is not a regular file`));
      return;
    }

    collectStream(stream, maximumBinarySize).then(
      (contents) => {
        binary = contents;
        next();
      },
      (error) => extract.destroy(error),
    );
  });

  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      extract,
    );
  } catch (error) {
    throw new Error(
      `Cannot extract ${archivePath}: ${formatError(error)}`,
    );
  }

  if (binary === undefined) {
    throw new Error(`${archivePath} does not contain ${binaryName}`);
  }

  return binary;
}

async function extractZipBinary(archivePath, binaryName) {
  const zip = await openZip(archivePath);
  let binary;

  try {
    while (true) {
      const entry = await readZipEntry(zip);
      if (entry === undefined) {
        break;
      }
      if (entry.fileName !== binaryName) {
        continue;
      }
      if (binary !== undefined) {
        throw new Error(`Archive contains duplicate ${binaryName}`);
      }
      if (/\/$/u.test(entry.fileName)) {
        throw new Error(`${binaryName} is not a regular file`);
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const fileType = mode & 0o170000;
      if (fileType !== 0 && fileType !== 0o100000) {
        throw new Error(`${binaryName} is not a regular file`);
      }
      if (entry.uncompressedSize > maximumBinarySize) {
        throw new Error(`${binaryName} exceeds the extraction size limit`);
      }

      const stream = await openZipEntry(zip, entry);
      binary = await collectStream(stream, maximumBinarySize);
    }
  } catch (error) {
    zip.close();
    throw new Error(
      `Cannot extract ${archivePath}: ${formatError(error)}`,
    );
  }

  zip.close();
  if (binary === undefined) {
    throw new Error(`${archivePath} does not contain ${binaryName}`);
  }

  return binary;
}

function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(zip);
    });
  });
}

function readZipEntry(zip) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };

    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function openZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(stream);
    });
  });
}

async function collectStream(stream, maximumSize) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumSize) {
      throw new Error('Archive entry exceeds the extraction size limit');
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks, size);
}

async function writeFileAtomic(destination, contents, mode) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;

  try {
    await writeFile(temporary, contents, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function isFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function validateAcquisitionInput({
  target,
  artifact,
  archiveType,
  binaryName,
}) {
  if (!/^[a-z0-9-]+$/u.test(target)) {
    throw new Error(`Invalid distribution target: ${target}`);
  }

  if (!/^[0-9A-Za-z._-]+$/u.test(artifact)) {
    throw new Error(`Invalid release artifact: ${artifact}`);
  }

  if (archiveType !== 'tar.gz' && archiveType !== 'zip') {
    throw new Error(`Unsupported archive type: ${archiveType}`);
  }

  if (binaryName !== 'ferretd' && binaryName !== 'ferretd.exe') {
    throw new Error(`Invalid daemon executable name: ${binaryName}`);
  }
}

function validateFerretdVersion(version) {
  if (!versionPattern.test(version)) {
    throw new Error(`Invalid ferretd version: ${version}`);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
