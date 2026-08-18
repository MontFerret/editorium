import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
const output = execFileSync(executable, ['ls', '--no-dependencies'], {
  cwd: packageRoot,
  encoding: 'utf8',
});
const actualFiles = output
  .split(/\r?\n/u)
  .map((file) => file.trim())
  .filter(Boolean)
  .sort();
const expectedFiles = [
  'LICENSE',
  'README.md',
  'out/extension.js',
  'package.json',
].sort();

assert.deepStrictEqual(
  actualFiles,
  expectedFiles,
  `Unexpected VSIX contents:\n${actualFiles.join('\n')}`,
);

console.log(`Verified ${actualFiles.length} VSIX files.`);
