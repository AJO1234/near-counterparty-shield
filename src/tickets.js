// Shield tickets: an ed25519 signature over one exact payment, which the Shield
// Vault contract verifies on-chain before it moves any money.
//
// Message (must match `ticket_message` in contracts/vault/src/lib.rs):
//   shield-ticket:v1|<vault>|<receiver>|<amountYocto>|<nonce>|<expiresAtMs>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const TICKET_TTL_MS = Number(process.env.SHIELD_TICKET_TTL_MS || 120_000);

let keyPair;

/** Loads the signing key from SHIELD_SIGNING_KEY (PEM), else data/shield-key.pem, else creates one. */
function keys() {
  if (keyPair) return keyPair;
  let pem = process.env.SHIELD_SIGNING_KEY;
  const file = path.join(config.dataDir, 'shield-key.pem');
  if (!pem && fs.existsSync(file)) pem = fs.readFileSync(file, 'utf8');
  let privateKey;
  if (pem) {
    privateKey = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
  } else {
    ({ privateKey } = crypto.generateKeyPairSync('ed25519'));
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  keyPair = { privateKey, publicKeyHex: raw.toString('hex') };
  return keyPair;
}

export const shieldPublicKeyHex = () => keys().publicKeyHex;

/** "1.5" NEAR -> "1500000000000000000000000" yocto, exactly (no floating point). */
export function nearToYocto(amount) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(`amount "${s}" must be a decimal NEAR value with at most 24 decimals`);
  const [whole, frac = ''] = s.split('.');
  return (BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'))).toString();
}

export function ticketMessage({ vault, receiver, amountYocto, nonce, expiresAtMs }) {
  return `shield-ticket:v1|${vault}|${receiver}|${amountYocto}|${nonce}|${expiresAtMs}`;
}

export function issueTicket({ vault, receiver, amountNear }) {
  const t = {
    vault,
    receiver,
    amountYocto: nearToYocto(amountNear),
    nonce: crypto.randomBytes(12).toString('hex'),
    expiresAtMs: Date.now() + TICKET_TTL_MS,
  };
  const message = ticketMessage(t);
  const signatureHex = crypto.sign(null, Buffer.from(message), keys().privateKey).toString('hex');
  return { ...t, message, signatureHex, shieldPublicKeyHex: keys().publicKeyHex };
}

export function verifyTicket(t, publicKeyHex = keys().publicKeyHex) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, Buffer.from(ticketMessage(t)), pub, Buffer.from(t.signatureHex, 'hex'));
}
