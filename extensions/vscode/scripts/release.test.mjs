import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decideReleaseAction,
  expectedReleaseAssetNames,
  resolveReleaseMetadata,
  validateReleaseAssets,
} from './release.mjs';

test('resolves stable, prerelease, and build-metadata release tags', () => {
  assert.deepStrictEqual(resolveReleaseMetadata('vscode/v0.1.0', '0.1.0'), {
    tag: 'vscode/v0.1.0',
    version: '0.1.0',
    prerelease: false,
    title: 'Ferret VS Code 0.1.0',
  });
  assert.strictEqual(
    resolveReleaseMetadata(
      'vscode/v0.2.0-beta.2',
      '0.2.0-beta.2',
    ).prerelease,
    true,
  );
  assert.strictEqual(
    resolveReleaseMetadata('vscode/v0.2.0+build.5', '0.2.0+build.5')
      .prerelease,
    false,
  );
});

test('rejects malformed, unrelated, and noncanonical release tags', () => {
  for (const tag of [
    'v0.1.0',
    'jetbrains/v0.1.0',
    'vscode/0.1.0',
    'vscode/v',
    'vscode/v1.2',
    'vscode/v01.2.3',
    'vscode/vv1.2.3',
  ]) {
    assert.throws(() => resolveReleaseMetadata(tag, '0.1.0'));
  }
});

test('rejects a release tag that differs from the package version', () => {
  assert.throws(
    () => resolveReleaseMetadata('vscode/v0.2.0', '0.1.0'),
    /does not match extensions\/vscode\/package\.json version 0\.1\.0/u,
  );
});

test('derives the complete release asset set from supported targets', () => {
  assert.deepStrictEqual(expectedReleaseAssetNames('0.1.0'), [
    'ferret-vscode-0.1.0-darwin-arm64.vsix',
    'ferret-vscode-0.1.0-darwin-x64.vsix',
    'ferret-vscode-0.1.0-linux-x64.vsix',
    'ferret-vscode-0.1.0-linux-arm64.vsix',
    'ferret-vscode-0.1.0-win32-x64.vsix',
    'ferret-vscode-0.1.0-win32-arm64.vsix',
  ]);
});

test('accepts exactly one non-empty release asset per supported target', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'editorium-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  for (const name of expectedReleaseAssetNames('0.1.0')) {
    await writeFile(join(directory, name), 'vsix');
  }

  assert.strictEqual(
    (await validateReleaseAssets(directory, '0.1.0')).length,
    6,
  );
});

test('rejects missing, unexpected, and empty release assets', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'editorium-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const names = expectedReleaseAssetNames('0.1.0');

  for (const name of names.slice(1)) {
    await writeFile(join(directory, name), 'vsix');
  }
  await writeFile(join(directory, 'unexpected.vsix'), 'vsix');
  await assert.rejects(
    validateReleaseAssets(directory, '0.1.0'),
    /"missing":\["ferret-vscode-0\.1\.0-darwin-arm64\.vsix"\].*"unexpected":\["unexpected\.vsix"\]/u,
  );

  await rm(join(directory, 'unexpected.vsix'));
  await writeFile(join(directory, names[0]), '');
  await assert.rejects(
    validateReleaseAssets(directory, '0.1.0'),
    /is not a non-empty file/u,
  );
});

test('creates absent releases, replaces drafts, and accepts matching reruns', () => {
  const metadata = resolveReleaseMetadata('vscode/v0.1.0', '0.1.0');
  assert.strictEqual(decideReleaseAction(undefined, metadata), 'create');
  assert.strictEqual(
    decideReleaseAction(
      {
        tagName: metadata.tag,
        name: metadata.title,
        isDraft: true,
        isPrerelease: false,
        assets: [],
      },
      metadata,
    ),
    'replace-draft',
  );
  assert.strictEqual(
    decideReleaseAction(
      {
        tagName: metadata.tag,
        name: metadata.title,
        isDraft: false,
        isPrerelease: false,
        assets: expectedReleaseAssetNames(metadata.version).map((name) => ({
          name,
        })),
      },
      metadata,
    ),
    'noop',
  );
});

test('rejects conflicting published releases', () => {
  const metadata = resolveReleaseMetadata(
    'vscode/v0.2.0-beta.1',
    '0.2.0-beta.1',
  );
  const release = {
    tagName: metadata.tag,
    name: 'Wrong title',
    isDraft: false,
    isPrerelease: false,
    assets: [{ name: 'partial.vsix' }],
  };

  assert.throws(
    () => decideReleaseAction(release, metadata),
    /conflicts with the validated release/u,
  );
});
