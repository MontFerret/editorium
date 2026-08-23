import * as assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yauzl from 'yauzl';

import {
  acquireFerretd,
  copyFileAtomic,
  readFerretdVersion,
} from '../../../scripts/ferretd.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const vsceEntrypoint = join(
  repositoryRoot,
  'node_modules',
  '@vscode',
  'vsce',
  'vsce',
);
const maximumVSIXEntrySize = 128 * 1024 * 1024;

export const supportedTargets = Object.freeze([
  Object.freeze({
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    artifact: 'ferretd_darwin_arm64.tar.gz',
    archiveType: 'tar.gz',
    binaryName: 'ferretd',
    runner: 'macos-14',
    unix: true,
  }),
  Object.freeze({
    id: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    artifact: 'ferretd_darwin_x86_64.tar.gz',
    archiveType: 'tar.gz',
    binaryName: 'ferretd',
    runner: 'macos-15-intel',
    unix: true,
  }),
  Object.freeze({
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    artifact: 'ferretd_linux_x86_64.tar.gz',
    archiveType: 'tar.gz',
    binaryName: 'ferretd',
    runner: 'ubuntu-24.04',
    unix: true,
  }),
  Object.freeze({
    id: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    artifact: 'ferretd_linux_arm64.tar.gz',
    archiveType: 'tar.gz',
    binaryName: 'ferretd',
    runner: 'ubuntu-24.04-arm',
    unix: true,
  }),
  Object.freeze({
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    artifact: 'ferretd_windows_x86_64.zip',
    archiveType: 'zip',
    binaryName: 'ferretd.exe',
    runner: 'windows-2025',
    unix: false,
  }),
  Object.freeze({
    id: 'win32-arm64',
    platform: 'win32',
    arch: 'arm64',
    artifact: 'ferretd_windows_arm64.zip',
    archiveType: 'zip',
    binaryName: 'ferretd.exe',
    runner: 'windows-11-arm',
    unix: false,
  }),
]);

export function detectHostTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const target = supportedTargets.find(
    (candidate) =>
      candidate.platform === platform && candidate.arch === arch,
  );
  if (target === undefined) {
    throw new Error(
      `Unsupported host platform ${platform}-${arch}; supported targets: ` +
        supportedTargets.map(({ id }) => id).join(', '),
    );
  }

  return target;
}

export function resolveTarget(
  id,
  platform = process.platform,
  arch = process.arch,
) {
  if (id === undefined) {
    return detectHostTarget(platform, arch);
  }

  const target = supportedTargets.find((candidate) => candidate.id === id);
  if (target === undefined) {
    throw new Error(
      `Unsupported VS Code target ${id}; supported targets: ` +
        supportedTargets.map(({ id: targetId }) => targetId).join(', '),
    );
  }

  return target;
}

export function parseDistributionArguments(args) {
  let target;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--target') {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (target !== undefined) {
      throw new Error('--target may only be specified once');
    }

    target = args[index + 1];
    if (target === undefined || target.startsWith('--')) {
      throw new Error('--target requires a value');
    }
    index += 1;
  }

  return { target };
}

export function githubMatrix() {
  return {
    include: supportedTargets.map(({ id: target, runner }) => ({
      target,
      runner,
    })),
  };
}

export function vsixFilename(version, target) {
  return `ferret-vscode-${version}-${target.id}.vsix`;
}

export async function prepareTarget(target, options = {}) {
  rejectUnsafeCrossPackaging(target, options.platform ?? process.platform);

  const acquired = await acquireFerretd({
    repositoryRoot: options.repositoryRoot ?? repositoryRoot,
    target: target.id,
    artifact: target.artifact,
    archiveType: target.archiveType,
    binaryName: target.binaryName,
    unix: target.unix,
    fetchImplementation: options.fetchImplementation ?? globalThis.fetch,
  });
  const targetPackageRoot = options.packageRoot ?? packageRoot;
  const stageRoot = join(
    options.repositoryRoot ?? repositoryRoot,
    '.dist',
    'staging',
    randomUUID(),
  );
  const temporaryBin = join(stageRoot, 'bin');
  const stagedBinary = join(temporaryBin, target.binaryName);
  await copyFileAtomic(
    acquired.binaryPath,
    stagedBinary,
    target.unix ? 0o755 : 0o644,
  );

  const finalBin = join(targetPackageRoot, 'bin');
  try {
    await rm(finalBin, { recursive: true, force: true });
    await rename(temporaryBin, finalBin);
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }

  const finalBinary = join(finalBin, target.binaryName);
  if (isNativeTarget(target, options.platform, options.arch)) {
    await smokeBinary(finalBinary, acquired.version);
  } else if (!options.quiet) {
    console.log(
      `Skipped execution smoke test for foreign target ${target.id}.`,
    );
  }

  if (!options.quiet) {
    console.log(
      `Prepared ferretd ${acquired.version} for ${target.id}: ${finalBinary}`,
    );
  }

  return {
    ...acquired,
    stagedBinary: finalBinary,
  };
}

export async function packageTarget(target, options = {}) {
  const prepared = await prepareTarget(target, options);
  const targetPackageRoot = options.packageRoot ?? packageRoot;
  const manifest = JSON.parse(
    await readFile(join(targetPackageRoot, 'package.json'), 'utf8'),
  );
  const vsixPath = join(
    targetPackageRoot,
    vsixFilename(manifest.version, target),
  );

  await execFileAsync(
    process.execPath,
    [
      options.vsceEntrypoint ?? vsceEntrypoint,
      'package',
      '--target',
      target.id,
      '--no-dependencies',
      '--out',
      vsixPath,
    ],
    { cwd: targetPackageRoot },
  );

  await validateVSIX({
    vsixPath,
    target,
    stagedBinary: prepared.stagedBinary,
    version: prepared.version,
    packageManifest: manifest,
    platform: options.platform,
    arch: options.arch,
  });

  if (!options.quiet) {
    console.log(`Packaged and verified ${target.id}: ${vsixPath}`);
  }

  return { ...prepared, vsixPath };
}

export async function validateVSIX({
  vsixPath,
  target,
  stagedBinary,
  version,
  packageManifest,
  platform,
  arch,
}) {
  const binaryEntryName = `extension/bin/${target.binaryName}`;
  const expectedFiles = [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/LICENSE.txt',
    binaryEntryName,
    'extension/language-configuration.json',
    'extension/out/extension.js',
    'extension/package.json',
    'extension/readme.md',
    'extension/syntaxes/ferret.tmLanguage.json',
  ].sort();
  const entries = await readVSIXEntries(vsixPath, new Set([
    'extension.vsixmanifest',
    'extension/package.json',
    binaryEntryName,
  ]));

  assert.deepStrictEqual(
    [...entries.keys()].sort(),
    expectedFiles,
    `Unexpected VSIX contents in ${vsixPath}`,
  );

  const vsixManifest = requiredEntry(entries, 'extension.vsixmanifest');
  const targetMatch = /\bTargetPlatform="([^"]+)"/u.exec(
    vsixManifest.contents.toString('utf8'),
  );
  assert.strictEqual(
    targetMatch?.[1],
    target.id,
    'VSIX target platform does not match the requested target',
  );

  const packagedManifest = JSON.parse(
    requiredEntry(entries, 'extension/package.json').contents.toString(
      'utf8',
    ),
  );
  assert.strictEqual(packagedManifest.name, packageManifest.name);
  assert.strictEqual(packagedManifest.version, packageManifest.version);

  const binaryEntry = requiredEntry(entries, binaryEntryName);
  const stagedContents = await readFile(stagedBinary);
  assert.ok(
    binaryEntry.contents.equals(stagedContents),
    'Packaged daemon bytes differ from the verified staged daemon',
  );

  if (target.unix) {
    const mode = (binaryEntry.externalFileAttributes >>> 16) & 0xffff;
    assert.strictEqual(
      mode & 0o777,
      0o755,
      `Packaged ${target.binaryName} mode is not 0755`,
    );
  }

  if (isNativeTarget(target, platform, arch)) {
    const temporary = await mkdtemp(join(tmpdir(), 'ferret-vsix-'));
    const extracted = join(temporary, target.binaryName);
    try {
      await writeFile(extracted, binaryEntry.contents, {
        mode: target.unix ? 0o755 : 0o644,
      });
      if (target.unix) {
        await chmod(extracted, 0o755);
      }
      await smokeBinary(extracted, version);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return {
    binaryDigest: createHash('sha256')
      .update(binaryEntry.contents)
      .digest('hex'),
  };
}

export async function installTarget(target, options = {}) {
  const packaged = await packageTarget(target, options);
  const command = options.codeCommand ?? 'code';

  try {
    await execFileAsync(
      command,
      ['--install-extension', packaged.vsixPath, '--force'],
      { cwd: options.packageRoot ?? packageRoot },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `VS Code CLI "${command}" was not found. The VSIX is available at ` +
          `${packaged.vsixPath}. Install it manually with: ` +
          `${command} --install-extension "${packaged.vsixPath}" --force`,
      );
    }
    throw error;
  }

  if (!options.quiet) {
    console.log(`Installed ${packaged.vsixPath}`);
  }

  return packaged;
}

async function checkTarget(target) {
  const version = await readFerretdVersion(repositoryRoot);
  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const vsixPath = join(
    packageRoot,
    vsixFilename(packageManifest.version, target),
  );
  const stagedBinary = join(packageRoot, 'bin', target.binaryName);

  await validateVSIX({
    vsixPath,
    target,
    stagedBinary,
    version,
    packageManifest,
  });
  console.log(`Verified ${vsixPath}`);
}

function rejectUnsafeCrossPackaging(target, platform) {
  if (platform === 'win32' && target.unix) {
    throw new Error(
      `Cannot package Unix target ${target.id} on Windows because vsce ` +
        'does not preserve POSIX executable permissions',
    );
  }
}

function isNativeTarget(
  target,
  platform = process.platform,
  arch = process.arch,
) {
  return target.platform === platform && target.arch === arch;
}

async function smokeBinary(binaryPath, version) {
  const { stdout, stderr } = await execFileAsync(binaryPath, ['--version']);
  const expected = `ferretd ${version}`;
  if (stdout.trim() !== expected || stderr.trim() !== '') {
    throw new Error(
      `${basename(binaryPath)} --version returned ${JSON.stringify({
        stdout,
        stderr,
      })}; expected ${JSON.stringify(expected)}`,
    );
  }
}

function readVSIXEntries(path, contentEntries) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null) {
        reject(openError);
        return;
      }

      const entries = new Map();
      let settled = false;
      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        zip.close();
        reject(error);
      };

      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(entries);
      });
      zip.on('entry', (entry) => {
        if (entries.has(entry.fileName)) {
          fail(new Error(`Duplicate VSIX entry: ${entry.fileName}`));
          return;
        }

        const finish = (contents = Buffer.alloc(0)) => {
          entries.set(entry.fileName, {
            contents,
            externalFileAttributes: entry.externalFileAttributes,
          });
          zip.readEntry();
        };
        if (!contentEntries.has(entry.fileName)) {
          finish();
          return;
        }
        if (entry.uncompressedSize > maximumVSIXEntrySize) {
          fail(new Error(`VSIX entry is too large: ${entry.fileName}`));
          return;
        }

        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError !== null) {
            fail(streamError);
            return;
          }

          try {
            finish(await collectStream(stream, maximumVSIXEntrySize));
          } catch (error) {
            fail(error);
          }
        });
      });
      zip.readEntry();
    });
  });
}

async function collectStream(stream, maximumSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumSize) {
      throw new Error('VSIX entry exceeds the size limit');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, size);
}

function requiredEntry(entries, name) {
  const entry = entries.get(name);
  if (entry === undefined) {
    throw new Error(`Missing VSIX entry: ${name}`);
  }

  return entry;
}

async function main() {
  const command = process.argv[2];
  const { target: targetId } = parseDistributionArguments(
    process.argv.slice(3),
  );

  if (command === 'matrix') {
    if (targetId !== undefined) {
      throw new Error('matrix does not accept --target');
    }
    process.stdout.write(`${JSON.stringify(githubMatrix())}\n`);
    return;
  }

  const target = resolveTarget(targetId);
  switch (command) {
    case 'prepare':
      await prepareTarget(target);
      break;
    case 'package':
      await packageTarget(target);
      break;
    case 'install':
      await installTarget(target);
      break;
    case 'check':
      await checkTarget(target);
      break;
    default:
      throw new Error(
        'Expected one command: prepare, package, install, check, or matrix',
      );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
