#!/usr/bin/env node
// Builds contracts/vault to wasm and copies it to contracts/vault/res/shield_vault.wasm.
// Needs Rust with the wasm32-unknown-unknown target. The built file is committed,
// so you only need this if you change the contract.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../contracts/vault/', import.meta.url));
// A target dir without spaces avoids toolchain quoting problems on Windows.
const target = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'shield-vault-target');
const r = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: dir,
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: target },
  shell: process.platform === 'win32',
});
if (r.status !== 0) process.exit(r.status ?? 1);
const built = path.join(target, 'wasm32-unknown-unknown', 'release', 'shield_vault.wasm');
fs.mkdirSync(path.join(dir, 'res'), { recursive: true });
fs.copyFileSync(built, path.join(dir, 'res', 'shield_vault.wasm'));
console.log(`✓ contracts/vault/res/shield_vault.wasm (${fs.statSync(built).size} bytes)`);
