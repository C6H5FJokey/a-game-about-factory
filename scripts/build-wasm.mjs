import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = fileURLToPath(new URL('../sim/target/', import.meta.url));
const build = spawnSync('cargo', [
  'build', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', 'sim/Cargo.toml', '--target-dir', target,
], { cwd: root, stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const output = new URL('../public/', import.meta.url);
mkdirSync(output, { recursive: true });
copyFileSync(new URL('../sim/target/wasm32-unknown-unknown/release/daybreak_sim.wasm', import.meta.url), new URL('sim.wasm', output));
