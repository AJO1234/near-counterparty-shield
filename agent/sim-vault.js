// A local stand-in for the Shield Vault contract, applying the SAME rules as
// contracts/vault/src/lib.rs. Used by the demo when no testnet accounts are set
// up, so the demo runs on any machine. The real contract is the source of truth.
import crypto from 'node:crypto';
import { ticketMessage, nearToYocto } from '../src/tickets.js';

export class VaultRefused extends Error {}

export class SimVault {
  constructor({ vault, owner, agent, shieldPublicKeyHex, maxPerPaymentNear, dailyLimitNear }) {
    Object.assign(this, { vault, owner, agent, shieldPublicKeyHex });
    this.maxPerPayment = BigInt(nearToYocto(maxPerPaymentNear));
    this.dailyLimit = BigInt(nearToYocto(dailyLimitNear));
    this.spentToday = 0n;
    this.usedNonces = new Set();
    this.n = 0;
  }

  #require(cond, msg) {
    if (!cond) throw new VaultRefused(`vault refused: ${msg}`);
  }

  #spend(amount) {
    this.#require(amount > 0n, 'amount must be positive');
    this.#require(amount <= this.maxPerPayment, 'amount exceeds the per-payment cap');
    this.#require(this.spentToday + amount <= this.dailyLimit, 'daily spending cap reached');
    this.spentToday += amount;
  }

  /** vault.pay, called with the agent's function-call key. */
  pay({ caller, receiver, amountYocto, nonce, expiresAtMs, signatureHex }) {
    this.#require(caller === this.agent, 'only the agent account can call pay');
    this.#require(Date.now() <= expiresAtMs, 'shield ticket expired');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(this.shieldPublicKeyHex, 'hex')]);
    const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const msg = ticketMessage({ vault: this.vault, receiver, amountYocto, nonce, expiresAtMs });
    let ok = false;
    try {
      ok = crypto.verify(null, Buffer.from(msg), pub, Buffer.from(signatureHex || '', 'hex'));
    } catch {
      ok = false;
    }
    this.#require(ok, 'shield ticket signature is invalid');
    this.#require(!this.usedNonces.has(nonce), 'shield ticket already used');
    this.#spend(BigInt(amountYocto));
    this.usedNonces.add(nonce);
    return { hash: `simulated-tx-${++this.n}`, receiver, amountYocto };
  }

  /** vault.owner_pay: needs the owner's full-access key (1 yoctoNEAR attached). */
  ownerPay({ caller, attachedYocto, receiver, amountYocto }) {
    this.#require(attachedYocto === 1n, 'attach exactly 1 yoctoNEAR (full-access key required)');
    this.#require(caller === this.owner, 'only the owner');
    this.#spend(BigInt(amountYocto));
    return { hash: `simulated-tx-${++this.n}`, receiver, amountYocto };
  }
}

/** Signer for GuardedWallet backed by the simulated vault. */
export function simSigner(vault) {
  return {
    async pay(ticket) {
      return vault.pay({ caller: vault.agent, ...ticket });
    },
    async ownerPay(receiver, amountNear) {
      // In the simulation the human's approval stands in for the owner's key.
      return vault.ownerPay({ caller: vault.owner, attachedYocto: 1n, receiver, amountYocto: nearToYocto(amountNear) });
    },
  };
}
