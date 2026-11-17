// Build everything and write the five .tgz files to ./packed/.
// core, mongo, nest and browser are packed from their workspaces.
// angular is packed from packages/angular/dist (the ng-packagr output), because the
// source package.json of angular has no entry points.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const out = resolve(root, 'packed');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build']);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of ['core', 'mongo', 'nest', 'browser']) {
  run('npm', ['pack', '--pack-destination', out], resolve(root, 'packages', name));
}
run('npm', ['pack', '--pack-destination', out], resolve(root, 'packages/angular/dist'));
console.log(`\nPacked files are in ${out}`);
