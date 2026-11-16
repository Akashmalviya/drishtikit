// Builds one Node package twice (CommonJS and ESM) plus type files.
// Run from the package folder: `node ../../scripts/build-pkg.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc', { paths: [process.cwd(), new URL('..', import.meta.url).pathname] });

rmSync('dist', { recursive: true, force: true });

// A package can set `drishtikit.lib` in its package.json, for example to add the browser types.
const lib = JSON.parse(readFileSync('package.json', 'utf8')).drishtikit?.lib;

const common = {
  extends: '../../tsconfig.base.json',
  include: ['src'],
};

const cjs = {
  ...common,
  compilerOptions: { module: 'node16', moduleResolution: 'node16', outDir: 'dist/cjs', ...(lib ? { lib } : {}), declaration: true, declarationDir: 'dist/types', rootDir: 'src' },
};
const esm = {
  ...common,
  compilerOptions: { module: 'esnext', moduleResolution: 'bundler', outDir: 'dist/esm', ...(lib ? { lib } : {}), declaration: false, rootDir: 'src' },
};

for (const [name, config] of [['cjs', cjs], ['esm', esm]]) {
  const file = `.tsconfig.${name}.json`;
  writeFileSync(file, JSON.stringify(config));
  try {
    execFileSync(process.execPath, [tsc, '-p', file], { stdio: 'inherit' });
  } finally {
    rmSync(file, { force: true });
  }
}
mkdirSync('dist/esm', { recursive: true });
writeFileSync('dist/esm/package.json', '{"type":"module"}\n');
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
