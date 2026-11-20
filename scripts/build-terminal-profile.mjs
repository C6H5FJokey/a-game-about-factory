import { execFileSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { build } from 'vite';

const target = 'sim/target/terminal-profile';
const outDir = 'docs/performance.local/terminal-dist';
execFileSync(process.execPath, ['scripts/content.mjs', '--frontend'], { stdio: 'inherit' });
execFileSync('cargo', [
  'build', '--release', '--target', 'wasm32-unknown-unknown',
  '--features', 'terminal-profile', '--manifest-path', 'sim/Cargo.toml', '--target-dir', target,
], { stdio: 'inherit' });
await build({
  mode: 'terminal-profile',
  base: './',
  publicDir: false,
  build: { outDir, emptyOutDir: true },
});
await copyFile(target + '/wasm32-unknown-unknown/release/daybreak_sim.wasm', outDir + '/sim.wasm');
