// Turns signals into a verdict: ALLOW, WARN or BLOCK, with the reasons.
//
// Design rules:
//  - Some findings are decisive on their own (a lookalike, a dead account) -> BLOCK.
//  - If a core check could not run, the verdict is at least WARN. The shield never
//    fails open: "I could not check" is never reported as "safe".
//  - A large payment to a receiver that is neither well-known nor paid before is
//    at least WARN, whatever the score.
import { config } from './config.js';
import { collectReceiverSignals, collectContextSignals, validateAccountId } from './signals.js';

const cache = new Map(); // receiver -> { at, result }
const CORE = new Set(['account', 'access-keys', 'age']);

export async function receiverReport(receiver, { fresh = false } = {}) {
  const hit = cache.get(receiver);
  if (!fresh && hit && Date.now() - hit.at < config.cacheTtlMs) return { ...hit.result, cached: true };
  const result = await collectReceiverSignals(receiver);
  // Only cache complete reports, so a temporary outage is retried next time.
  if (!result.unavailable.length) cache.set(receiver, { at: Date.now(), result });
  return { ...result, cached: false };
}

export function decide({ signals, unavailable, facts, amountNear }) {
  const score = signals.reduce((s, x) => s + (x.points || 0), 0);
  const reasons = [];
  let verdict = score >= config.thresholds.block ? 'BLOCK' : score >= config.thresholds.warn ? 'WARN' : 'ALLOW';

  const hardBlocks = signals.filter((s) => s.hard === 'block');
  if (hardBlocks.length) {
    verdict = 'BLOCK';
    reasons.push(...hardBlocks.map((s) => `${s.label}: ${s.detail}`));
  }

  const missingCore = unavailable.filter((u) => CORE.has(u.id));
  if (missingCore.length && verdict === 'ALLOW') {
    verdict = 'WARN';
    reasons.push(`Could not verify ${missingCore.map((u) => u.label.toLowerCase()).join(', ')}, so this is not a confirmed ALLOW.`);
  }

  const trusted = facts.known || facts.family;
  const paidBefore = signals.some((s) => s.id === 'history' && s.points < 0);
  if (amountNear != null && Number(amountNear) >= config.thresholds.largeAmountNear && !trusted && !paidBefore && verdict === 'ALLOW') {
    verdict = 'WARN';
    reasons.push(`${amountNear} NEAR is a large payment to a receiver that is neither well-known nor paid before.`);
  }

  // Remaining reasons: the strongest risk signals, then the reassuring ones.
  for (const s of [...signals].sort((a, b) => b.points - a.points)) {
    if (hardBlocks.includes(s)) continue;
    if (s.points > 0) reasons.push(`${s.label}: ${s.detail}`);
  }
  const reassurance = signals.filter((s) => s.points < 0).map((s) => `${s.label}: ${s.detail}`);

  return { verdict, score, reasons, reassurance };
}

/**
 * Main entry point.
 * @param {{ receiver: string, agentId?: string, amountNear?: number|string, fresh?: boolean }} req
 */
export async function check({ receiver, agentId, amountNear, fresh }) {
  receiver = String(receiver || '').trim().toLowerCase();
  const invalid = validateAccountId(receiver);
  if (invalid) {
    return {
      verdict: 'BLOCK',
      receiver,
      score: null,
      reasons: [`Receiver is ${invalid}.`],
      reassurance: [],
      signals: [],
      unavailable: [],
      facts: {},
      network: config.network,
      checkedAt: new Date().toISOString(),
    };
  }
  if (amountNear != null && amountNear !== '' && !(Number(amountNear) >= 0)) {
    throw new Error('amountNear must be a non-negative number');
  }
  const amount = amountNear === '' || amountNear == null ? null : Number(amountNear);

  const base = await receiverReport(receiver, { fresh });
  const signals = [...base.signals, ...collectContextSignals({ receiver, agentId, amountNear: amount })];
  const decision = decide({ signals, unavailable: base.unavailable, facts: base.facts, amountNear: amount });

  return {
    verdict: decision.verdict,
    receiver,
    network: config.network,
    score: decision.score,
    reasons: decision.reasons,
    reassurance: decision.reassurance,
    signals,
    unavailable: base.unavailable,
    facts: base.facts,
    cached: base.cached,
    explorer: `${config.explorer}/address/${receiver}`,
    checkedAt: new Date().toISOString(),
  };
}
