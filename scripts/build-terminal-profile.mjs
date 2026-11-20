import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { build } from 'vite';

const dense = process.argv.includes('--dense');
const mode = dense ? 'dense-profile' : 'terminal-profile';
const target = 'sim/target/' + mode;
const outDir = dense ? 'docs/performance.local/dense-dist' : 'docs/performance.local/terminal-dist';
execFileSync(process.execPath, ['scripts/content.mjs', '--frontend'], { stdio: 'inherit' });
execFileSync('cargo', [
  'build', '--release', '--target', 'wasm32-unknown-unknown',
  '--features', mode, '--manifest-path', 'sim/Cargo.toml', '--target-dir', target,
], { stdio: 'inherit' });
await build({
  mode,
  base: './',
  publicDir: false,
  build: { outDir, emptyOutDir: true },
});
await copyFile(target + '/wasm32-unknown-unknown/release/daybreak_sim.wasm', outDir + '/sim.wasm');
