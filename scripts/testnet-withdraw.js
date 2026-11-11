#!/usr/bin/env node
// Owner withdraws spare NEAR from a vault back to the owner account.
//   OWNER_ACCOUNT_ID=... OWNER_PRIVATE_KEY=... npm run testnet:withdraw -- <vault.testnet> <amountNear>
import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';

process.env.NEAR_NETWORK = 'testnet';
const { config } = await import('../src/config.js');
const { nearToYocto } = await import('../src/tickets.js');
const [vault, amount] = process.argv.slice(2);
if (!vault || !amount) {
  console.error('usage: npm run testnet:withdraw -- <vault.testnet> <amountNear>');
  process.exit(2);
}
const owner = new Account(process.env.OWNER_ACCOUNT_ID, new JsonRpcProvider({ url: config.rpc[0] }), process.env.OWNER_PRIVATE_KEY);
const res = await owner.callFunctionRaw({ contractId: vault, methodName: 'withdraw', args: { amount: nearToYocto(amount) }, deposit: 1n, gas: teraToGas('30') });
console.log(`✓ withdrew ${amount} NEAR from ${vault}: ${config.explorer}/txns/${res.transaction.hash}`);
