import * as assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';

import tarStream from 'tar-stream';

import { sourceArchiveUrl } from './ferretd.mjs';
import {
  replaceDirectoryAtomic,
  syncFerretdProto,
} from './proto.mjs';

const versionOne = '2.0.0-alpha.2';
const versionTwo = '2.0.0-alpha.3';

test('constructs only exact tagged source archive URLs', () => {
  assert.strictEqual(
    sourceArchiveUrl(versionOne),
    'https://github.com/MontFerret/ferretd/archive/refs/tags/' +
      'v2.0.0-alpha.2.tar.gz',
  );
  assert.throws(
    () => sourceArchiveUrl('latest'),
    /Invalid ferretd version/u,
  );
});

test('downloads all ferretd schemas and preserves shared inputs', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  const archive = await sourceArchive(versionOne, [
    ...requiredEntries('one'),
    ['debug/v1/debug.proto', 'debug one'],
  ]);

  const result = await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(archive),
  });

  assert.deepStrictEqual(result, { updated: true, version: versionOne });
  assert.strictEqual(
    await readFile(schemaPath(root, 'debug/v1/debug.proto'), 'utf8'),
    'debug one',
  );
  assert.strictEqual(
    await readFile(schemaPath(root, '.ferretd-version'), 'utf8'),
    `${versionOne}\n`,
  );
  assert.strictEqual(
    await readFile(
      join(root, 'shared', 'proto', 'google', 'rpc', 'status.proto'),
      'utf8',
    ),
    'shared status',
  );
});

test('skips the network when the matching schema tree is present', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, requiredEntries('one')),
    ),
  });

  const result = await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: async () => {
      throw new Error('matching schemas must not be downloaded again');
    },
  });

  assert.deepStrictEqual(result, { updated: false, version: versionOne });
});

test('force refresh replaces the whole managed tree', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, [
        ...requiredEntries('old'),
        ['removed/v1/removed.proto', 'stale'],
      ]),
    ),
  });

  await syncFerretdProto({
    repositoryRoot: root,
    force: true,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, requiredEntries('new')),
    ),
  });

  assert.strictEqual(
    await readFile(schemaPath(root, 'daemon/v1/daemon.proto'), 'utf8'),
    'daemon new',
  );
  await assert.rejects(
    readFile(schemaPath(root, 'removed/v1/removed.proto')),
    { code: 'ENOENT' },
  );
});

test('a version change refreshes schemas and the marker', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, requiredEntries('one')),
    ),
  });
  await writeManifest(root, versionTwo);

  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionTwo, requiredEntries('two')),
    ),
  });

  assert.strictEqual(
    await readFile(schemaPath(root, 'workspace/v1/workspace.proto'), 'utf8'),
    'workspace two',
  );
  assert.strictEqual(
    await readFile(schemaPath(root, '.ferretd-version'), 'utf8'),
    `${versionTwo}\n`,
  );
});

test('download failures leave the previous schemas intact', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, requiredEntries('one')),
    ),
  });
  await writeManifest(root, versionTwo);

  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: root,
      fetchImplementation: async () =>
        new Response('not found', {
          status: 404,
          statusText: 'Not Found',
        }),
    }),
    /HTTP 404 Not Found/u,
  );
  assert.strictEqual(
    await readFile(schemaPath(root, 'daemon/v1/daemon.proto'), 'utf8'),
    'daemon one',
  );
  assert.strictEqual(
    await readFile(schemaPath(root, '.ferretd-version'), 'utf8'),
    `${versionOne}\n`,
  );
});

test('rejects archives with missing required schemas', async (context) => {
  const root = await temporaryRoot(context, versionOne);

  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: root,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionOne, [
          ['daemon/v1/daemon.proto', 'daemon'],
        ]),
      ),
    }),
    /Missing required ferretd schema: execution\/v1\/execution.proto/u,
  );
  await assert.rejects(
    readFile(schemaPath(root, '.ferretd-version')),
    { code: 'ENOENT' },
  );
});

test('rejects unsafe and duplicate schema paths', async (context) => {
  const unsafeRoot = await temporaryRoot(context, versionOne);
  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: unsafeRoot,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionOne, [
          ['../escape.proto', 'unsafe'],
          ...requiredEntries('one'),
        ]),
      ),
    }),
    /Unsafe schema archive path/u,
  );

  const unsafeRootEntry = await temporaryRoot(context, versionOne);
  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: unsafeRootEntry,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionOne, requiredEntries('one'), '..'),
      ),
    }),
    /Unsafe schema archive path/u,
  );

  const duplicateRoot = await temporaryRoot(context, versionOne);
  const entries = requiredEntries('one');
  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: duplicateRoot,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionOne, [entries[0], ...entries]),
      ),
    }),
    /duplicate daemon\/v1\/daemon.proto/u,
  );
});

test('rejects malformed and oversized source archives', async (context) => {
  const malformedRoot = await temporaryRoot(context, versionOne);
  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: malformedRoot,
      fetchImplementation: archiveFetch(Buffer.from('not gzip')),
    }),
    /Cannot extract/u,
  );

  const oversizedRoot = await temporaryRoot(context, versionOne);
  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: oversizedRoot,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionOne, [
          [
            'daemon/v1/daemon.proto',
            Buffer.alloc(4 * 1024 * 1024 + 1),
          ],
          ...requiredEntries('one').slice(1),
        ]),
      ),
    }),
    /exceeds the file size limit/u,
  );
});

test('restores the previous tree when replacement fails', async (context) => {
  const root = await temporaryRoot(context, versionOne);
  await syncFerretdProto({
    repositoryRoot: root,
    fetchImplementation: archiveFetch(
      await sourceArchive(versionOne, requiredEntries('one')),
    ),
  });
  await writeManifest(root, versionTwo);
  let injectedFailure = false;

  await assert.rejects(
    syncFerretdProto({
      repositoryRoot: root,
      fetchImplementation: archiveFetch(
        await sourceArchive(versionTwo, requiredEntries('two')),
      ),
      replaceImplementation: (source, destination) =>
        replaceDirectoryAtomic(source, destination, {
          renameImplementation: async (from, to) => {
            if (to === destination && !injectedFailure) {
              injectedFailure = true;
              throw new Error('injected replacement failure');
            }
            await rename(from, to);
          },
        }),
    }),
    /injected replacement failure/u,
  );

  assert.strictEqual(
    await readFile(schemaPath(root, 'daemon/v1/daemon.proto'), 'utf8'),
    'daemon one',
  );
  assert.deepStrictEqual(
    (await readdir(join(root, 'shared', 'proto')))
      .filter((name) => name.startsWith('.ferretd-stage-') ||
        name.includes('.backup-')),
    [],
  );
});

async function temporaryRoot(context, version) {
  const root = await mkdtemp(join(tmpdir(), 'editorium-proto-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeManifest(root, version);
  const googleRoot = join(root, 'shared', 'proto', 'google', 'rpc');
  await mkdir(googleRoot, { recursive: true });
  await writeFile(join(googleRoot, 'status.proto'), 'shared status');
  return root;
}

async function writeManifest(root, version) {
  await writeFile(
    join(root, 'ferretd.json'),
    `${JSON.stringify({ ferretd: version })}\n`,
  );
}

function requiredEntries(suffix) {
  return [
    ['daemon/v1/daemon.proto', `daemon ${suffix}`],
    ['execution/v1/execution.proto', `execution ${suffix}`],
    ['workspace/v1/workspace.proto', `workspace ${suffix}`],
  ];
}

async function sourceArchive(
  version,
  entries,
  sourceRoot = `ferretd-${version}`,
) {
  const pack = tarStream.pack();
  pack.entry({
    name: `${sourceRoot}/proto/ferretd/`,
    type: 'directory',
    mode: 0o755,
  });
  pack.entry({
    name: `${sourceRoot}/proto/ferretd/daemon/`,
    type: 'directory',
    mode: 0o755,
  });
  for (const [path, contents] of entries) {
    pack.entry(
      {
        name: `${sourceRoot}/proto/ferretd/${path}`,
        mode: 0o644,
      },
      Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
    );
  }
  pack.finalize();

  return collect(pack.pipe(createGzip()));
}

function archiveFetch(archive) {
  return async () => new Response(archive);
}

function schemaPath(root, relativePath) {
  return join(root, 'shared', 'proto', 'ferretd', relativePath);
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
