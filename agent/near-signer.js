// Real signer for GuardedWallet: sends to the deployed Shield Vault on NEAR.
//   pay(ticket)     agent account + its function-call key -> vault.pay (no deposit)
//   ownerPay(...)   owner's full-access key -> vault.owner_pay with 1 yoctoNEAR
import { Account, JsonRpcProvider, teraToGas } from 'near-api-js';
import { nearToYocto } from '../src/tickets.js';

export class VaultCallRefused extends Error {}

function txHash(res) {
  return res?.transaction?.hash || res?.transaction_outcome?.id || 'unknown';
}

/** Surfaces the contract's own panic message, e.g. "shield ticket signature is invalid". */
function contractError(e) {
  const s = String(e?.message || e);
  const m = s.match(/Smart contract panicked: ?([^"\\\n]+)/);
  if (m) return new VaultCallRefused(`vault refused on-chain: ${m[1].trim()}`);
  // Any other execution failure inside the contract is still a refusal: no money moved.
  if (e?.name === 'ContractExecutionError' || /ExecutionError|WebAssembly trap/.test(s)) {
    return new VaultCallRefused(`vault refused on-chain: ${s.split('\n')[0]}`);
  }
  return e;
}

export function nearSigner({ rpcUrl, vault, agentId, agentScopedKey, ownerId, ownerKey }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const agent = new Account(agentId, provider, agentScopedKey);
  const owner = ownerId && ownerKey ? new Account(ownerId, provider, ownerKey) : null;

  async function call(acc, methodName, args, deposit = 0n) {
    try {
      const res = await acc.callFunctionRaw({ contractId: vault, methodName, args, deposit, gas: teraToGas('30') });
      return { hash: txHash(res) };
    } catch (e) {
      throw contractError(e);
    }
  }

  return {
    provider,
    pay: (t) =>
      call(agent, 'pay', { receiver: t.receiver, amount: t.amountYocto, nonce: t.nonce, expires_at_ms: t.expiresAtMs, signature_hex: t.signatureHex }),
    /** vault.pay with arbitrary arguments, signed by the agent key (used to demo bypass attempts). */
    rawPay: (args) => call(agent, 'pay', args),
    ownerPay: (receiver, amountNear) => {
      if (!owner) throw new Error('owner key not configured (OWNER_ACCOUNT_ID / OWNER_PRIVATE_KEY)');
      return call(owner, 'owner_pay', { receiver, amount: nearToYocto(amountNear) }, 1n);
    },
  };
}
