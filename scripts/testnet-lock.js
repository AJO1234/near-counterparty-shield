#!/usr/bin/env node
// Locks a vault created with `testnet:setup -- --unlocked`: redeploys the current
// contract build if --redeploy is given, then deletes the vault's full-access key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider } from 'near-api-js';

process.env.NEAR_NETWORK = 'testnet';
const { config } = await import('../src/config.js');
const root = fileURLToPath(new URL('..', import.meta.url));
const file = path.join(config.dataDir, 'testnet.json');
const tn = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!tn.vaultKey) {
  console.log(`${tn.vault} is already locked (no key saved).`);
  process.exit(0);
}
const vault = new Account(tn.vault, new JsonRpcProvider({ url: config.rpc[0] }), tn.vaultKey);
if (process.argv.includes('--redeploy')) {
  await vault.deployContract(new Uint8Array(fs.readFileSync(path.join(root, 'contracts/vault/res/shield_vault.wasm'))));
  console.log(`redeployed contract to ${tn.vault}`);
}
if (!process.argv.includes('--redeploy-only')) {
  const { keys } = await vault.getAccessKeyList();
  for (const k of keys) await vault.deleteKey(k.public_key);
  delete tn.vaultKey;
  tn.vaultLocked = true;
  fs.writeFileSync(file, JSON.stringify(tn, null, 2));
  console.log(`✓ ${tn.vault} locked: it has no access keys, so its code can never change.`);
}
