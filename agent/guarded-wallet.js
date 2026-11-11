// GuardedWallet: the only way the agent can pay.
//
//   BLOCK -> refuses. Nothing is signed.
//   WARN  -> asks a human. Only the human's key (owner_pay on the vault) can send it.
//   ALLOW -> gets a Shield ticket and calls vault.pay with the agent's function-call key.
//
// The vault contract re-checks the ticket on-chain, so skipping this wrapper does
// not help an attacker: without a valid ticket the contract refuses.

export class PaymentRefused extends Error {
  constructor(verdict) {
    super(`Payment to ${verdict.receiver} refused (${verdict.verdict}): ${verdict.reasons[0] || 'no reason given'}`);
    this.name = 'PaymentRefused';
    this.verdict = verdict;
  }
}

export class GuardedWallet {
  /**
   * @param {object} o
   * @param {string} o.shieldUrl   Counterparty Shield base URL
   * @param {string} o.agentId     the agent's NEAR account (its history is tracked per agent)
   * @param {string} o.vault       the Shield Vault contract account
   * @param {object} o.signer      { pay(ticket), ownerPay(receiver, amountNear) }
   * @param {(verdict) => Promise<boolean>} o.askHuman  called on WARN
   * @param {(line: string) => void} [o.log]
   */
  constructor({ shieldUrl, agentId, vault, signer, askHuman, log = console.log }) {
    Object.assign(this, { shieldUrl, agentId, vault, signer, askHuman, log });
  }

  async pay(receiver, amountNear, { memo } = {}) {
    this.log(`shield: checking ${receiver} for ${amountNear} NEAR${memo ? ` (${memo})` : ''}`);
    const res = await fetch(`${this.shieldUrl}/v1/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vault: this.vault, receiver, amountNear: String(amountNear), agentId: this.agentId }),
    });
    const verdict = await res.json();
    if (!res.ok) throw new Error(`shield error: ${verdict.error}`);
    this.log(`shield: ${verdict.verdict} (risk score ${verdict.score})`);
    for (const r of verdict.reasons) this.log(`   - ${r}`);

    if (verdict.verdict === 'BLOCK') throw new PaymentRefused(verdict);

    let tx;
    if (verdict.verdict === 'WARN') {
      const ok = await this.askHuman(verdict);
      if (!ok) throw new PaymentRefused({ ...verdict, reasons: ['A human declined the payment.', ...verdict.reasons] });
      tx = await this.signer.ownerPay(verdict.receiver, String(amountNear));
    } else {
      tx = await this.signer.pay(verdict.ticket);
    }

    // Record the payment so future checks know this agent has paid this receiver.
    await fetch(`${this.shieldUrl}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.SHIELD_API_TOKEN ? { authorization: `Bearer ${process.env.SHIELD_API_TOKEN}` } : {}) },
      body: JSON.stringify({ agentId: this.agentId, receiver: verdict.receiver, amountNear: Number(amountNear), txHash: tx.hash }),
    }).catch(() => {});
    return { verdict, tx };
  }
}
