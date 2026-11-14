import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonConnection } from '../daemon/types';
import { resolveWorkingDirectory } from '../execution/working-directory';

suite('Run filesystem options', () => {
  const connection = { apiVersion: { major: 1, minor: 3 } } as DaemonConnection;
  const wire = { connection, selector: '', name: 'App', provider: 'wire' as const };
  const native = { ...wire, name: 'local', provider: 'native' as const };
  test('recognizes Go whitespace and forwards other Wire text verbatim', async () => {
    for (const value of ['', ' \t\u0085\u2003']) assert.equal(await resolveWorkingDirectory(value, '/missing', wire), undefined);
    for (const value of ['\uFEFF', ' C:\\remote\\path ', ' ../relative ', '${workspaceFolder}']) {
      assert.equal(await resolveWorkingDirectory(value, '/missing', wire), value);
    }
  });
  test('resolves against the registered root and accepts a canonical directory outside it', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'editorium-cwd-'));
    try {
      const root = join(temp, 'workspace'), outside = join(temp, 'runtime');
      await mkdir(root);
      await mkdir(outside);
      const link = join(root, 'link');
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      for (const value of ['link', '../runtime', outside]) {
        assert.equal(await resolveWorkingDirectory(value, root, native), await realpath(outside));
      }
      await writeFile(join(root, 'file'), 'x');
      for (const value of ['file', 'missing']) await assert.rejects(resolveWorkingDirectory(value, root, native), /native working directory/);
      const older = { ...native, connection: { apiVersion: { major: 1, minor: 1 } } as DaemonConnection };
      assert.equal(await resolveWorkingDirectory(' ', root, older), undefined);
      await assert.rejects(resolveWorkingDirectory('.', root, older), /API 1.2/);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
