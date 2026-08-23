import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import semver from 'semver';

import { supportedTargets, vsixFilename } from './distribution.mjs';

const packageManifestPath = new URL('../package.json', import.meta.url);
const releaseTagPrefix = 'vscode/v';

export function resolveReleaseMetadata(tag, packageVersion) {
  if (!tag.startsWith(releaseTagPrefix)) {
    throw new Error(
      `Invalid VS Code release tag ${JSON.stringify(tag)}; expected ` +
        `${releaseTagPrefix}<semver>`,
    );
  }

  const version = tag.slice(releaseTagPrefix.length);
  let parsedVersion;
  try {
    parsedVersion = new semver.SemVer(version);
  } catch {
    parsedVersion = undefined;
  }
  const canonicalVersion =
    parsedVersion === undefined
      ? undefined
      : parsedVersion.version +
        (parsedVersion.build.length === 0
          ? ''
          : `+${parsedVersion.build.join('.')}`);
  if (canonicalVersion !== version) {
    throw new Error(
      `Invalid VS Code release version ${JSON.stringify(version)}; expected ` +
        'canonical SemVer',
    );
  }
  if (version !== packageVersion) {
    throw new Error(
      `VS Code release tag version ${version} does not match ` +
        `extensions/vscode/package.json version ${packageVersion}`,
    );
  }

  return {
    tag,
    version,
    prerelease: parsedVersion.prerelease.length > 0,
    title: `Ferret VS Code ${version}`,
  };
}

export function expectedReleaseAssetNames(
  version,
  targets = supportedTargets,
) {
  return targets.map((target) => vsixFilename(version, target));
}

export async function validateReleaseAssets(directory, version) {
  const expected = expectedReleaseAssetNames(version).sort();
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = entries.map(({ name }) => name).sort();

  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      'Release asset set does not match the supported VS Code targets: ' +
        JSON.stringify({ missing, unexpected }),
    );
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || (await stat(path)).size === 0) {
      throw new Error(`Release asset is not a non-empty file: ${path}`);
    }
  }

  return expected.map((name) => join(directory, name));
}

export function decideReleaseAction(release, metadata) {
  if (release === undefined) {
    return 'create';
  }
  if (release.tagName !== metadata.tag) {
    throw new Error(
      `Existing release tag ${JSON.stringify(release.tagName)} does not ` +
        `match ${JSON.stringify(metadata.tag)}`,
    );
  }
  if (release.isDraft === true) {
    return 'replace-draft';
  }

  const conflicts = [];
  if (release.name !== metadata.title) {
    conflicts.push(`title ${JSON.stringify(release.name)}`);
  }
  if (release.isPrerelease !== metadata.prerelease) {
    conflicts.push(`prerelease=${JSON.stringify(release.isPrerelease)}`);
  }

  const expectedAssets = expectedReleaseAssetNames(metadata.version).sort();
  const actualAssets = Array.isArray(release.assets)
    ? release.assets.map(({ name }) => name).sort()
    : [];
  if (!sameStrings(actualAssets, expectedAssets)) {
    conflicts.push(`assets ${JSON.stringify(actualAssets)}`);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Published release ${metadata.tag} conflicts with the validated ` +
        `release: ${conflicts.join(', ')}`,
    );
  }

  return 'noop';
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function readPackageVersion() {
  const manifest = JSON.parse(await readFile(packageManifestPath, 'utf8'));
  return manifest.version;
}

function parseCommandArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !name.startsWith('--') || value === undefined) {
      throw new Error('Release options must use --name value pairs');
    }
    if (options.has(name)) {
      throw new Error(`Release option may only be specified once: ${name}`);
    }
    options.set(name, value);
  }
  return options;
}

function requiredOption(options, name) {
  const value = options.get(name);
  if (value === undefined) {
    throw new Error(`Missing required release option: ${name}`);
  }
  return value;
}

async function main() {
  const command = process.argv[2];
  const options = parseCommandArguments(process.argv.slice(3));
  const tag = requiredOption(options, '--tag');
  const metadata = resolveReleaseMetadata(tag, await readPackageVersion());

  switch (command) {
    case 'metadata': {
      const format = options.get('--format') ?? 'json';
      if (format === 'json') {
        process.stdout.write(`${JSON.stringify(metadata)}\n`);
      } else if (format === 'github') {
        process.stdout.write(
          `version=${metadata.version}\n` +
            `prerelease=${metadata.prerelease}\n` +
            `title=${metadata.title}\n`,
        );
      } else {
        throw new Error(`Unknown metadata format: ${format}`);
      }
      break;
    }
    case 'check-assets': {
      const directory = requiredOption(options, '--directory');
      const assets = await validateReleaseAssets(directory, metadata.version);
      console.log(`Verified ${assets.length} release assets in ${directory}.`);
      break;
    }
    case 'state': {
      const releaseJSON = requiredOption(options, '--release-json');
      const release = releaseJSON === '' ? undefined : JSON.parse(releaseJSON);
      process.stdout.write(`${decideReleaseAction(release, metadata)}\n`);
      break;
    }
    default:
      throw new Error('Expected one command: metadata, check-assets, or state');
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
