import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { readFerretdVersion } from '../../../scripts/ferretd.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const ferretdVersion = await readFerretdVersion(repositoryRoot);

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
