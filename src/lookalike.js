// Lookalike detection: is this receiver pretending to be a well-known account?
// Example: "ref-finance-v2.near" or "v2-ref-finance.near" imitating "v2.ref-finance.near".
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const known = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../data/known-accounts.json', import.meta.url)), 'utf8'));

// Extra known accounts for your own deployment: SHIELD_KNOWN="vendor.testnet=Our data vendor,api.testnet=API"
for (const pair of (process.env.SHIELD_KNOWN || '').split(',').filter(Boolean)) {
  const [acct, ...label] = pair.split('=');
  const net = /\.testnet$/.test(acct.trim()) ? 'testnet' : 'mainnet';
  (known[net] ||= {})[acct.trim().toLowerCase()] = label.join('=').trim() || 'operator-listed account';
}

export const KNOWN = known; // { mainnet: { accountId: label }, testnet: {...}, trustedRoots: {...} }

// Characters people swap to fake a name.
const HOMOGLYPHS = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/0/g, 'o'],
  [/1/g, 'l'],
  [/3/g, 'e'],
  [/5/g, 's'],
];

const SUFFIXES = /\.(near|testnet|tg)$/;

/** Split an account name into its meaningful words: "v2.ref-finance.near" -> ["finance","ref","v2"] */
export function words(accountId) {
  return accountId
    .toLowerCase()
    .replace(SUFFIXES, '')
    .split(/[.\-_]+/)
    .filter((w) => w && w !== 'near' && w !== 'testnet')
    .sort();
}

function skeleton(accountId) {
  let s = words(accountId).join('');
  for (const [re, to] of HOMOGLYPHS) s = s.replace(re, to);
  return s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// "wrap.near.claims.near" contains "wrap.near" as whole segments; "unwrap.near" does not.
function containsSegments(id, account) {
  const hay = id.split('.');
  const needle = account.split('.');
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((seg, j) => hay[i + j] === seg)) return true;
  }
  return false;
}

/**
 * Sub-accounts can only be created by their parent, so "anything.ref-finance.near"
 * really does belong to ref-finance.near. Those are family, not impostors.
 */
export function trustedFamily(accountId, network) {
  const roots = known.trustedRoots[network] || [];
  return roots.find((root) => accountId === root || accountId.endsWith(`.${root}`)) || null;
}

/**
 * @returns {{ exact?: {account,label}, lookalike?: {account,label,why} }}
 */
export function checkLookalike(accountId, network) {
  const list = known[network] || {};
  const id = accountId.toLowerCase();
  if (list[id]) return { exact: { account: id, label: list[id] } };
  if (trustedFamily(id, network)) return {};
  // 64-hex implicit accounts are key-derived; name tricks do not apply.
  if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) return {};

  const sk = skeleton(id);
  for (const [account, label] of Object.entries(list)) {
    if (/^[0-9a-f]{64}$/.test(account)) continue;
    const ksk = skeleton(account);
    if (ksk.length < 4) continue;
    let why = null;
    if (sk === ksk) why = 'same words in a different order or with different separators';
    else if (containsSegments(id, account)) {
      why = `contains the full name "${account}" but is not owned by it`;
    } else if (ksk.length >= 6 && levenshtein(sk, ksk) <= (ksk.length >= 10 ? 2 : 1)) {
      why = 'differs by one or two characters';
    }
    if (why) return { lookalike: { account, label, why } };
  }
  return {};
}
