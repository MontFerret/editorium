import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import yazl from 'yazl';

import {
  detectHostTarget,
  githubMatrix,
  parseDistributionArguments,
  prepareTarget,
  resolveTarget,
  supportedTargets,
  validateVSIX,
  vsixFilename,
} from './distribution.mjs';

const expectedTargets = [
  ['darwin-arm64', 'ferretd_darwin_arm64.tar.gz', 'macos-14'],
  ['darwin-x64', 'ferretd_darwin_x86_64.tar.gz', 'macos-15-intel'],
  ['linux-x64', 'ferretd_linux_x86_64.tar.gz', 'ubuntu-24.04'],
  ['linux-arm64', 'ferretd_linux_arm64.tar.gz', 'ubuntu-24.04-arm'],
  ['win32-x64', 'ferretd_windows_x86_64.zip', 'windows-2025'],
  ['win32-arm64', 'ferretd_windows_arm64.zip', 'windows-11-arm'],
];

test('keeps the supported target, artifact, and runner matrix together', () => {
  assert.deepStrictEqual(
    supportedTargets.map(({ id, artifact, runner }) => [
      id,
      artifact,
      runner,
    ]),
    expectedTargets,
  );
  assert.deepStrictEqual(
    githubMatrix().include,
    expectedTargets.map(([target, , runner]) => ({ target, runner })),
  );
});

test('derives deterministic release filenames from the shared targets', () => {
  assert.deepStrictEqual(
    supportedTargets.map((target) => vsixFilename('0.2.0-beta.1', target)),
    [
      'ferret-vscode-0.2.0-beta.1-darwin-arm64.vsix',
      'ferret-vscode-0.2.0-beta.1-darwin-x64.vsix',
      'ferret-vscode-0.2.0-beta.1-linux-x64.vsix',
      'ferret-vscode-0.2.0-beta.1-linux-arm64.vsix',
      'ferret-vscode-0.2.0-beta.1-win32-x64.vsix',
      'ferret-vscode-0.2.0-beta.1-win32-arm64.vsix',
    ],
  );
});

test('detects supported hosts and rejects unsupported combinations', () => {
  assert.strictEqual(detectHostTarget('darwin', 'arm64').id, 'darwin-arm64');
  assert.strictEqual(detectHostTarget('win32', 'arm64').id, 'win32-arm64');
  assert.throws(
    () => detectHostTarget('freebsd', 'x64'),
    /Unsupported host platform freebsd-x64/u,
  );
  assert.throws(
    () => resolveTarget('linux-armhf'),
    /Unsupported VS Code target linux-armhf/u,
  );
});

test('parses only one explicit target argument', () => {
  assert.deepStrictEqual(parseDistributionArguments([]), {
    target: undefined,
  });
  assert.deepStrictEqual(
    parseDistributionArguments(['--target', 'linux-x64']),
    { target: 'linux-x64' },
  );
  assert.throws(
    () => parseDistributionArguments(['--unknown']),
    /Unknown argument/u,
  );
  assert.throws(
    () => parseDistributionArguments(['--target']),
    /requires a value/u,
  );
  assert.throws(
    () =>
      parseDistributionArguments([
        '--target',
        'linux-x64',
        '--target',
        'linux-arm64',
      ]),
    /only be specified once/u,
  );
});

test('rejects Windows-hosted Unix packaging before downloading', async () => {
  await assert.rejects(
    prepareTarget(resolveTarget('linux-x64'), {
      platform: 'win32',
      arch: 'x64',
      quiet: true,
      fetchImplementation: async () => {
        throw new Error('fetch must not be called');
      },
    }),
    /does not preserve POSIX executable permissions/u,
  );
});

test('validates the exact platform-specific VSIX contents', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'editorium-vsix-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stagedBinary = join(root, 'ferretd');
  const vsixPath = join(root, 'ferret-vscode-0.1.0-linux-x64.vsix');
  const binary = Buffer.from('packaged daemon bytes');
  await writeFile(stagedBinary, binary, { mode: 0o755 });
  await createVSIX(vsixPath, binary);

  await validateVSIX({
    vsixPath,
    target: resolveTarget('linux-x64'),
    stagedBinary,
    version: '2.0.0-alpha.2',
    packageManifest: { name: 'fql', version: '0.1.0' },
    platform: 'freebsd',
    arch: 'x64',
  });
});

async function createVSIX(path, binary) {
  const zip = new yazl.ZipFile();
  const entries = new Map([
    ['[Content_Types].xml', '<Types/>'],
    [
      'extension.vsixmanifest',
      '<PackageManifest><Metadata><Identity ' +
        'TargetPlatform="linux-x64"/></Metadata></PackageManifest>',
    ],
    ['extension/LICENSE.txt', 'license'],
    ['extension/language-configuration.json', '{}'],
    ['extension/out/extension.js', 'module.exports = {};'],
    [
      'extension/package.json',
      JSON.stringify({ name: 'fql', version: '0.1.0' }),
    ],
    ['extension/readme.md', '# Ferret'],
    ['extension/syntaxes/ferret.tmLanguage.json', '{}'],
  ]);
  for (const [name, contents] of entries) {
    zip.addBuffer(Buffer.from(contents), name);
  }
  zip.addBuffer(binary, 'extension/bin/ferretd', {
    mode: 0o100755,
  });
  zip.end();

  const chunks = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(chunk);
  }
  await writeFile(path, Buffer.concat(chunks));
}
