#!/usr/bin/env node
// Usage: npm run check -- <receiver> [amountNear] [agentId]
import { check } from './shield.js';

const [receiver, amountNear, agentId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!receiver) {
  console.error('Usage: npm run check -- <receiver.near> [amountNear] [agentId]');
  process.exit(2);
}

const ICON = { ALLOW: '[ALLOW]', WARN: '[WARN] ', BLOCK: '[BLOCK]' };
const r = await check({ receiver, amountNear, agentId });
console.log(`\n${ICON[r.verdict]} ${r.receiver} on ${r.network}  (risk score ${r.score ?? 'n/a'})\n`);
for (const x of r.reasons) console.log(`  - ${x}`);
for (const x of r.reassurance) console.log(`  + ${x}`);
for (const s of r.signals.filter((s) => !s.points && s.id !== 'amount')) console.log(`  · ${s.label}: ${s.detail}`);
for (const u of r.unavailable) console.log(`  ? not checked: ${u.label} (${u.reason})`);
if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
// exitCode (not process.exit) lets pending sockets close cleanly; exiting
// mid-close trips a libuv assertion on Windows.
process.exitCode = r.verdict === 'BLOCK' ? 1 : 0;
