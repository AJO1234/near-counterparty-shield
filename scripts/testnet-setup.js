#!/usr/bin/env node
// One-time TESTNET setup. You need one funded testnet account (the "owner").
//
//   OWNER_ACCOUNT_ID=you.testnet OWNER_PRIVATE_KEY=ed25519:... npm run testnet:setup
//
// It creates, under your account:
//   agent.<owner>     the AI agent. Ends up holding ONLY a function-call key for vault.pay
//   vault.<owner>     the Shield Vault contract, funded, initialised, then LOCKED (full key deleted)
//   charity.<owner>   an approved receiver for the demo
// and writes data/testnet.json (gitignored), which `npm run demo -- --testnet` reads.
//
// Testnet only. Refuses to run against mainnet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, teraToGas } from 'near-api-js';

process.env.NEAR_NETWORK = 'testnet';
const { config } = await import('../src/config.js');
const { shieldPublicKeyHex, nearToYocto } = await import('../src/tickets.js');

const root = fileURLToPath(new URL('..', import.meta.url));
const WASM = process.env.VAULT_WASM || path.join(root, 'contracts/vault/res/shield_vault.wasm');
const OUT = path.join(config.dataDir, 'testnet.json');

const owner = process.env.OWNER_ACCOUNT_ID;
const ownerKey = process.env.OWNER_PRIVATE_KEY;
const fail = (m) => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};
if (!owner || !ownerKey) fail('Set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY (a funded testnet account). See README "Run it on testnet".');
if (owner === 'yourname.testnet' || /PASTE_HERE/.test(ownerKey)) fail('Replace the placeholders: OWNER_ACCOUNT_ID = your real testnet account, OWNER_PRIVATE_KEY = its exported key.');
if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(ownerKey.trim())) fail('OWNER_PRIVATE_KEY must look like ed25519:<base58 characters>. Export it from your wallet (Settings → Security → Export private key).');
if (!owner.endsWith('.testnet')) fail(`OWNER_ACCOUNT_ID must be a .testnet account (got ${owner}). This script never touches mainnet.`);
if (!fs.existsSync(WASM)) fail(`Contract not built: ${WASM} is missing. Run: npm run build:contract`);
if (fs.existsSync(OUT) && !process.argv.includes('--force')) fail(`${OUT} already exists. Re-run with --force to create a fresh set of accounts.`);

const provider = new JsonRpcProvider({ url: config.rpc[0] });
const ownerAcc = new Account(owner, provider, ownerKey);
const suffix = process.argv.includes('--force') ? `-${Date.now().toString(36).slice(-4)}` : '';
const ids = { agent: `agent${suffix}.${owner}`, vault: `vault${suffix}.${owner}`, charity: `charity${suffix}.${owner}` };
const N = (x) => BigInt(nearToYocto(x));
const link = (id) => `${config.explorer}/address/${id}`;
const step = (s) => console.log(`\n→ ${s}`);

const balance = await ownerAcc.getBalance();
console.log(`owner ${owner}: ${Number(balance / 10n ** 21n) / 1000} NEAR`);
// Budget: vault 4.5 (2.7 of it pays for the contract's 262 KB of storage, the rest is
// the payment float) + agent 0.3 (gas) + charity 0.1 + transaction fees.
if (balance < N('5.5')) fail('The owner needs at least 5.5 testnet NEAR. Top it up from a testnet faucet.');

// 1. Agent: create with a temporary full key, add the scoped key, then delete the full key.
step(`create ${ids.agent}`);
const agentFull = KeyPair.fromRandom('ed25519');
const agentScoped = KeyPair.fromRandom('ed25519');
await ownerAcc.createAccount({ newAccountId: ids.agent, publicKey: agentFull.getPublicKey(), nearToTransfer: N('0.3') });

// 2. Vault: create, deploy, init.
step(`create ${ids.vault}, deploy and initialise the contract`);
const vaultKey = KeyPair.fromRandom('ed25519');
await ownerAcc.createAccount({ newAccountId: ids.vault, publicKey: vaultKey.getPublicKey(), nearToTransfer: N('4.5') });
const vaultAcc = new Account(ids.vault, provider, vaultKey.toString());
await vaultAcc.deployContract(new Uint8Array(fs.readFileSync(WASM)));
const limits = { max_per_payment: nearToYocto(process.env.VAULT_MAX_PER_PAYMENT || '1'), daily_limit: nearToYocto(process.env.VAULT_DAILY_LIMIT || '1.5') };
await vaultAcc.callFunction({
  contractId: ids.vault,
  methodName: 'new',
  args: { owner, agent: ids.agent, shield_public_key_hex: shieldPublicKeyHex(), ...limits },
  gas: teraToGas('30'),
});

// 3. Agent key: function-call only, only vault.pay, with a gas allowance.
step(`give ${ids.agent} a key that can ONLY call ${ids.vault}.pay, then delete its full-access key`);
const agentAcc = new Account(ids.agent, provider, agentFull.toString());
await agentAcc.addFunctionCallAccessKey({
  publicKey: agentScoped.getPublicKey(),
  contractId: ids.vault,
  methodNames: ['pay'],
  allowance: N('0.25'),
});
await agentAcc.deleteKey(agentFull.getPublicKey());

// 4. Lock the vault: with no full-access key, nobody can redeploy its code.
//    With --unlocked the key is kept (saved to testnet.json) so the contract can be
//    redeployed while testing; lock it afterwards with `npm run testnet:lock`.
if (!process.argv.includes('--unlocked')) {
  step(`lock ${ids.vault} (delete its full-access key)`);
  await vaultAcc.deleteKey(vaultKey.getPublicKey());
}

// 5. Approved demo receiver.
step(`create ${ids.charity} (the approved receiver in the demo)`);
await ownerAcc.createAccount({ newAccountId: ids.charity, publicKey: KeyPair.fromRandom('ed25519').getPublicKey(), nearToTransfer: N('0.1') });

const cfg = await provider.callFunction({ contractId: ids.vault, method: 'get_config', args: {} });
const state = {
  network: 'testnet',
  createdAt: new Date().toISOString(),
  owner,
  agent: ids.agent,
  vault: ids.vault,
  charity: ids.charity,
  agentScopedKey: agentScoped.toString(), // testnet-only; can only call vault.pay
  vaultLocked: !process.argv.includes('--unlocked'),
  ...(process.argv.includes('--unlocked') ? { vaultKey: vaultKey.toString() } : {}),
  vaultConfig: cfg,
};
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(state, null, 2), { mode: 0o600 });

console.log('\n✓ Done. Vault config read back from chain:');
console.log(JSON.stringify(cfg, null, 2));
console.log(`\n  agent   ${link(ids.agent)}\n  vault   ${link(ids.vault)}\n  charity ${link(ids.charity)}`);
console.log(`\nSaved ${OUT}. Next: npm run demo -- --testnet`);
