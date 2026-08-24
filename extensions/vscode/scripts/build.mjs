import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ferretdManifest = JSON.parse(
  await readFile(new URL('../../../ferretd.json', import.meta.url), 'utf8'),
);
if (
  ferretdManifest === null ||
  typeof ferretdManifest !== 'object' ||
  Array.isArray(ferretdManifest) ||
  Object.keys(ferretdManifest).length !== 1 ||
  typeof ferretdManifest.ferretd !== 'string'
) {
  throw new Error(
    `${repositoryRoot}/ferretd.json must contain exactly one ferretd version`,
  );
}
const ferretdVersion = ferretdManifest.ferretd;

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const options = {
  bundle: true,
  define: {
    __BUNDLED_FERRETD_VERSION__: JSON.stringify(ferretdVersion),
  },
  entryPoints: ['src/extension.ts'],
  external: ['vscode'],
  format: 'cjs',
  logLevel: 'info',
  minify: production,
  outfile: 'out/extension.js',
  platform: 'node',
  sourcemap: !production,
  sourcesContent: false,
  target: 'node20',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
