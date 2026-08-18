import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';

import tarStream from 'tar-stream';
import yazl from 'yazl';

import {
  acquireFerretd,
  parseChecksums,
  readFerretdVersion,
  releaseAssetUrl,
} from './ferretd.mjs';

test('reads the single pinned ferretd version', async (context) => {
  const root = await temporaryRoot(context);
  await writeFile(
    join(root, 'ferretd.json'),
    '{"ferretd":"2.0.0-alpha.2"}\n',
  );

  assert.strictEqual(await readFerretdVersion(root), '2.0.0-alpha.2');

  await writeFile(
    join(root, 'ferretd.json'),
    '{"ferretd":"latest","extra":true}\n',
  );
  await assert.rejects(
    readFerretdVersion(root),
    /exactly one valid "ferretd" version/u,
  );
});

test('parses strict published checksums', () => {
  const first = '1'.repeat(64);
  const second = 'a'.repeat(64);
  assert.deepStrictEqual(
    [...parseChecksums(
      `${first}  ferretd_linux_x86_64.tar.gz\r\n` +
        `${second}  ferretd_windows_arm64.zip\r\n`,
    )],
    [
      ['ferretd_linux_x86_64.tar.gz', first],
      ['ferretd_windows_arm64.zip', second],
    ],
  );
  assert.throws(
    () => parseChecksums(`${first} *unsafe/path\n`),
    /Invalid checksum line/u,
  );
  assert.throws(
    () => parseChecksums(`${first}  duplicate\n${first}  duplicate\n`),
    /Duplicate checksum entry/u,
  );
});

test('constructs only official pinned release URLs', () => {
  assert.strictEqual(
    releaseAssetUrl('2.0.0-alpha.2', 'ferretd_checksums.txt'),
    'https://github.com/MontFerret/ferretd/releases/download/' +
      'v2.0.0-alpha.2/ferretd_checksums.txt',
  );
  assert.throws(
    () => releaseAssetUrl('latest', 'ferretd_checksums.txt'),
    /Invalid ferretd version/u,
  );
  assert.throws(
    () => releaseAssetUrl('2.0.0', '../ferretd'),
    /Invalid ferretd release asset/u,
  );
});

test('verifies and extracts only the root tar executable', async (context) => {
  const root = await pinnedRoot(context);
  const artifact = 'ferretd_linux_x86_64.tar.gz';
  const binary = Buffer.from('verified daemon');
  const archive = await tarArchive([
    ['README.md', Buffer.from('ignored')],
    ['ferretd', binary],
  ]);
  const fetchImplementation = releaseFetch(artifact, archive);

  const acquired = await acquireFerretd({
    repositoryRoot: root,
    target: 'linux-x64',
    artifact,
    archiveType: 'tar.gz',
    binaryName: 'ferretd',
    unix: true,
    fetchImplementation,
  });

  assert.deepStrictEqual(await readFile(acquired.binaryPath), binary);
  assert.strictEqual((await stat(acquired.binaryPath)).mode & 0o777, 0o755);
  assert.strictEqual(acquired.version, '2.0.0-alpha.2');
});

test('verifies and extracts the root Windows executable', async (context) => {
  const root = await pinnedRoot(context);
  const artifact = 'ferretd_windows_x86_64.zip';
  const binary = Buffer.from('verified windows daemon');
  const archive = await zipArchive([
    ['LICENSE', Buffer.from('ignored')],
    ['ferretd.exe', binary],
  ]);

  const acquired = await acquireFerretd({
    repositoryRoot: root,
    target: 'win32-x64',
    artifact,
    archiveType: 'zip',
    binaryName: 'ferretd.exe',
    unix: false,
    fetchImplementation: releaseFetch(artifact, archive),
  });

  assert.deepStrictEqual(await readFile(acquired.binaryPath), binary);
});

test('fails closed on checksum mismatch', async (context) => {
  const root = await pinnedRoot(context);
  const artifact = 'ferretd_linux_x86_64.tar.gz';
  const archive = await tarArchive([
    ['ferretd', Buffer.from('untrusted')],
  ]);
  const cacheRoot = join(
    root,
    '.dist',
    'ferretd',
    '2.0.0-alpha.2',
    'linux-x64',
  );
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(join(cacheRoot, artifact), archive);
  await writeFile(
    join(cacheRoot, 'ferretd_checksums.txt'),
    `${'0'.repeat(64)}  ${artifact}\n`,
  );

  await assert.rejects(
    acquireFerretd({
      repositoryRoot: root,
      target: 'linux-x64',
      artifact,
      archiveType: 'tar.gz',
      binaryName: 'ferretd',
      unix: true,
      fetchImplementation: async () => {
        throw new Error('cached files must be used');
      },
    }),
    /Checksum mismatch/u,
  );
  await assert.rejects(
    readFile(
      join(cacheRoot, artifact),
    ),
    { code: 'ENOENT' },
  );
});

test('reports official release download failures', async (context) => {
  const root = await pinnedRoot(context);

  await assert.rejects(
    acquireFerretd({
      repositoryRoot: root,
      target: 'linux-x64',
      artifact: 'ferretd_linux_x86_64.tar.gz',
      archiveType: 'tar.gz',
      binaryName: 'ferretd',
      unix: true,
      fetchImplementation: async () =>
        new Response('not found', {
          status: 404,
          statusText: 'Not Found',
        }),
    }),
    /HTTP 404 Not Found/u,
  );
});

test('rejects archives without the exact root executable', async (context) => {
  const root = await pinnedRoot(context);
  const artifact = 'ferretd_linux_x86_64.tar.gz';
  const archive = await tarArchive([
    ['nested/ferretd', Buffer.from('wrong location')],
  ]);

  await assert.rejects(
    acquireFerretd({
      repositoryRoot: root,
      target: 'linux-x64',
      artifact,
      archiveType: 'tar.gz',
      binaryName: 'ferretd',
      unix: true,
      fetchImplementation: releaseFetch(artifact, archive),
    }),
    /does not contain ferretd/u,
  );
});

async function pinnedRoot(context) {
  const root = await temporaryRoot(context);
  await writeFile(
    join(root, 'ferretd.json'),
    '{"ferretd":"2.0.0-alpha.2"}\n',
  );
  return root;
}

async function temporaryRoot(context) {
  const root = await mkdtemp(join(tmpdir(), 'editorium-ferretd-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function releaseFetch(artifact, archive, digest = sha256(archive)) {
  const checksums = Buffer.from(`${digest}  ${artifact}\n`);

  return async (url) => {
    if (url.endsWith('/ferretd_checksums.txt')) {
      return new Response(checksums);
    }
    if (url.endsWith(`/${artifact}`)) {
      return new Response(archive);
    }
    return new Response('not found', { status: 404 });
  };
}

async function tarArchive(entries) {
  const pack = tarStream.pack();
  for (const [name, contents] of entries) {
    pack.entry({ name, mode: 0o755 }, contents);
  }
  pack.finalize();

  return collect(pack.pipe(createGzip()));
}

async function zipArchive(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, contents] of entries) {
    zip.addBuffer(contents, name, { mode: 0o100755 });
  }
  zip.end();

  return collect(zip.outputStream);
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}
