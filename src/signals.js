// Collects the raw facts about a receiver account. Each collector returns a
// signal { id, label, points, detail, source } or marks itself unavailable.
// Positive points = more risk; negative = evidence the receiver is safe.
import { config } from './config.js';
import { getAccount, rpc, indexer, archive } from './near.js';
import { checkLookalike, trustedFamily } from './lookalike.js';
import { blocklist, history } from './store.js';

const DAY = 24 * 3600 * 1000;
const EMPTY_CODE = '11111111111111111111111111111111';
const YOCTO = 10n ** 24n;

export const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function validateAccountId(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64 || !ACCOUNT_RE.test(id)) {
    return 'not a valid NEAR account id (lowercase a-z, 0-9, "-", "_", "." and 2-64 characters)';
  }
  return null;
}

export function accountKind(id) {
  if (/^[0-9a-f]{64}$/.test(id)) return 'implicit';
  if (/^0x[0-9a-f]{40}$/.test(id)) return 'eth-implicit';
  return 'named';
}

const fmtAge = (ms) => {
  const d = ms / DAY;
  if (d < 1) return `${Math.max(1, Math.round(ms / 3600000))} hour(s)`;
  if (d < 60) return `${Math.round(d)} day(s)`;
  return `${(d / 365).toFixed(1)} year(s)`;
};

const toNear = (yocto) => Number((BigInt(yocto) * 1000n) / YOCTO) / 1000;

/**
 * Receiver-level facts (cacheable, same for every agent).
 * Every collector runs even if another one fails; failures become `unavailable`.
 */
export async function collectReceiverSignals(receiver) {
  const network = config.network;
  const signals = [];
  const unavailable = [];
  const facts = { receiver, network, kind: accountKind(receiver) };
  const add = (s) => signals.push(s);
  const miss = (id, label, err) => unavailable.push({ id, label, reason: String(err?.message || err).slice(0, 200) });

  // 1. Lookalike / known account (no network needed).
  const look = checkLookalike(receiver, network);
  if (look.exact) {
    facts.known = look.exact.label;
    add({ id: 'known-account', label: 'Well-known account', points: -40, detail: `Verified as ${look.exact.label}.`, source: 'known-accounts list' });
  } else if (look.lookalike) {
    facts.lookalikeOf = look.lookalike.account;
    add({
      id: 'lookalike',
      label: 'Imitates a well-known account',
      points: 80,
      hard: 'block',
      detail: `Looks like ${look.lookalike.account} (${look.lookalike.label}) but is a different account: ${look.lookalike.why}.`,
      source: 'name analysis',
    });
  } else {
    const fam = trustedFamily(receiver, network);
    if (fam) {
      facts.family = fam;
      add({ id: 'trusted-family', label: 'Sub-account of a known project', points: -15, detail: `Only ${fam} can create sub-accounts of ${fam}.`, source: 'NEAR account model' });
    }
  }

  // 2. Existence, balance, contract code (RPC).
  let account;
  try {
    account = await getAccount(receiver);
    facts.exists = !!account;
  } catch (e) {
    miss('account', 'Account state', e);
  }

  if (facts.exists === false) {
    if (facts.kind === 'named') {
      add({
        id: 'missing',
        label: 'Account does not exist',
        points: 70,
        hard: 'block',
        detail: `${receiver} does not exist on ${network}. A transfer would fail, or the name could be registered by anyone later.`,
        source: 'NEAR RPC',
      });
    } else {
      add({
        id: 'unfunded-implicit',
        label: 'Brand-new key-derived account',
        points: 30,
        detail: 'This implicit account has never been funded. Sending to it creates it, so nobody can confirm who holds its key.',
        source: 'NEAR RPC',
      });
    }
    return { facts, signals, unavailable };
  }

  if (account) {
    facts.balanceNear = toNear(account.amount);
    facts.isContract = account.code_hash !== EMPTY_CODE;
    facts.codeHash = account.code_hash;
    facts.storageBytes = account.storage_usage;
    add({ id: 'exists', label: 'Account exists', points: 0, detail: `Balance ${facts.balanceNear} NEAR.`, source: 'NEAR RPC' });
    if (facts.isContract) {
      add({ id: 'contract', label: 'Receiver is a smart contract', points: 0, detail: `Code hash ${account.code_hash}. Payments to a contract are handled by its code, not a person.`, source: 'NEAR RPC' });
    }
  }

  // 3. Who can control the account (RPC access keys).
  try {
    const { keys } = await rpc.accessKeys(receiver);
    const full = keys.filter((k) => k.access_key.permission === 'FullAccess').length;
    facts.fullAccessKeys = full;
    facts.functionCallKeys = keys.length - full;
    if (keys.length === 0 && !facts.isContract) {
      add({
        id: 'dead-account',
        label: 'Nobody can spend from this account',
        points: 70,
        hard: 'block',
        detail: 'It has no access keys and no contract, so anything sent here is stuck forever.',
        source: 'NEAR RPC',
      });
    } else if (facts.isContract && full > 0) {
      add({
        id: 'upgradeable',
        label: 'Contract owner can swap the code',
        points: 10,
        detail: `${full} full-access key(s) can redeploy this contract at any moment, so its behaviour today is not guaranteed tomorrow.`,
        source: 'NEAR RPC',
      });
    } else if (facts.isContract && full === 0) {
      add({ id: 'locked', label: 'Contract is locked', points: -10, detail: 'No full-access keys: the code can only change through the contract itself.', source: 'NEAR RPC' });
    } else {
      add({ id: 'keys', label: 'Who controls it', points: 0, detail: `${full} full-access key(s) and ${keys.length - full} limited key(s): a normal, spendable account.`, source: 'NEAR RPC' });
    }
  } catch (e) {
    miss('access-keys', 'Access keys', e);
  }

  // 4. Age (indexer, else archival binary search).
  try {
    let info;
    let ageSource = 'NearBlocks';
    try {
      info = await indexer.accountInfo(receiver);
      if (!info.createdAt && facts.exists) throw new Error('no creation record');
    } catch {
      const c = await archive.createdAt(receiver);
      info = { createdAt: c.at };
      ageSource = `archival RPC (created at block ${c.height})`;
    }
    if (info.createdAt) {
      const age = Date.now() - info.createdAt;
      facts.createdAt = new Date(info.createdAt).toISOString();
      facts.ageDays = Math.round((age / DAY) * 10) / 10;
      let points = 0;
      if (age < DAY) points = 40;
      else if (age < 7 * DAY) points = 25;
      else if (age < 30 * DAY) points = 10;
      else if (age > 365 * DAY) points = -10;
      add({ id: 'age', label: points > 0 ? 'Recently created account' : 'Account age', points, detail: `Created ${fmtAge(age)} ago (${facts.createdAt.slice(0, 10)}).`, source: ageSource });
    } else if (facts.kind === 'implicit' || facts.kind === 'eth-implicit') {
      // Implicit accounts have no "create account" action; the indexer may have no record.
      miss('age', 'Account age', 'indexer has no creation record for this implicit account');
    } else {
      miss('age', 'Account age', 'indexer returned no creation record');
    }
  } catch (e) {
    miss('age', 'Account age', e);
  }

  // 5. Recent code changes (indexer deployments).
  if (facts.isContract) {
    try {
      const deps = await indexer.deployments(receiver);
      facts.deployments = deps.length;
      const last = deps[deps.length - 1];
      if (last?.at) {
        const since = Date.now() - last.at;
        facts.lastDeployAt = new Date(last.at).toISOString();
        let points = 0;
        if (since < DAY) points = 35;
        else if (since < 7 * DAY) points = 20;
        else if (since < 30 * DAY) points = 8;
        // An upgrade of a long-lived contract is routine maintenance more often than a trap.
        const established = (facts.ageDays || 0) > 180;
        if (points && established) points = Math.round(points / 2);
        add({
          id: 'code-change',
          label: points > 0 ? 'Contract code changed recently' : 'Contract code history',
          points,
          detail: `Code last deployed ${fmtAge(since)} ago (${deps.length} deployment(s) in total)${points && established ? '; halved because the account is long-established' : ''}.`,
          source: 'NearBlocks',
          evidence: last.tx,
        });
      }
    } catch (e) {
      // No indexer: compare today's code with the code 1, 7 and 30 days ago on archival RPC.
      try {
        let changedWithin = null;
        for (const [days, points] of [[1, 35], [7, 20], [30, 8]]) {
          const h = await archive.heightAgo(days * DAY);
          const past = await archive.codeHashAt(receiver, h);
          if (past !== facts.codeHash) {
            changedWithin = { days, points };
            break;
          }
        }
        const established = (facts.ageDays || 0) > 180;
        let points = changedWithin ? changedWithin.points : 0;
        if (points && established) points = Math.round(points / 2);
        add({
          id: 'code-change',
          label: points > 0 ? 'Contract code changed recently' : 'Contract code history',
          points,
          detail: changedWithin
            ? `The code is different from ${changedWithin.days} day(s) ago (or the account did not exist then).`
            : 'Same code as 30 days ago.',
          source: 'archival RPC (code_hash comparison)',
        });
      } catch (e2) {
        miss('code-change', 'Code changes', e2);
      }
    }
  }

  // 6. Activity (indexer).
  try {
    const n = await indexer.txCount(receiver);
    if (n != null) {
      facts.txCount = n;
      let points = 0;
      if (n <= 2) points = 15;
      else if (n < 20) points = 5;
      else if (n > 1000) points = -10;
      add({ id: 'activity', label: n <= 2 ? 'Almost no history' : 'Activity', points, detail: `${n.toLocaleString('en-US')} transaction(s) on record.`, source: 'NearBlocks' });
    }
  } catch (e) {
    miss('activity', 'Activity', e);
  }

  return { facts, signals, unavailable };
}

/** Facts that depend on who is paying and how much (never cached). */
export function collectContextSignals({ receiver, agentId, amountNear }) {
  const signals = [];

  const bl = blocklist.get(receiver);
  if (bl?.reports?.length) {
    const n = bl.reports.length;
    signals.push({
      id: 'blocklist',
      label: 'Reported by other agents',
      points: n >= 2 ? 80 : 40,
      hard: n >= 2 ? 'block' : undefined,
      detail: `${n} independent report(s). Latest: "${bl.reports[n - 1].reason}"`,
      source: 'shared blocklist',
      evidence: bl.reports.map((r) => r.evidence),
    });
  }

  if (agentId) {
    const h = history.get(agentId, receiver);
    if (h && h.count >= 3) {
      signals.push({ id: 'history', label: 'Paid before', points: -15, detail: `This agent has paid this receiver ${h.count} times (${h.totalNear} NEAR in total).`, source: 'shield payment log' });
    } else if (h) {
      signals.push({ id: 'history', label: 'Paid before', points: -5, detail: `This agent has paid this receiver ${h.count} time(s).`, source: 'shield payment log' });
    } else {
      signals.push({ id: 'history', label: 'First payment to this receiver', points: 5, detail: 'This agent has never paid this receiver before.', source: 'shield payment log' });
    }
  }

  if (amountNear != null) {
    signals.push({ id: 'amount', label: 'Amount', points: 0, detail: `${amountNear} NEAR requested.`, source: 'request', amountNear: Number(amountNear) });
  }
  return signals;
}
