// Live check (needs network): every mainnet entry in data/known-accounts.json exists on-chain.
// Run: node test/known-accounts.live.js
import { KNOWN } from '../src/lookalike.js';
import { getAccount } from '../src/near.js';

let bad = 0;
for (const [id, label] of Object.entries(KNOWN.mainnet)) {
  const a = await getAccount(id);
  console.log(`${a ? 'ok     ' : 'MISSING'} ${id}  (${label})${a ? `  contract=${a.code_hash !== '11111111111111111111111111111111'}` : ''}`);
  if (!a) bad++;
}
process.exitCode = bad ? 1 : 0;
