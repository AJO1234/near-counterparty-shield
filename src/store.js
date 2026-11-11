// Small JSON-file stores: the shared blocklist and each agent's payment history.
// Writes are atomic (temp file + rename) so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

class JsonStore {
  constructor(file, empty) {
    this.file = path.join(config.dataDir, file);
    this.empty = empty;
    this.data = null;
  }
  load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = structuredClone(this.empty);
    }
    return this.data;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- blocklist

const blocklistStore = new JsonStore('blocklist.json', { accounts: {} });

const EVIDENCE_RE = /^([1-9A-HJ-NP-Za-km-z]{43,44}|https?:\/\/\S+)$/; // NEAR tx hash or a URL

export const blocklist = {
  get(accountId) {
    return blocklistStore.load().accounts[accountId] || null;
  },
  all() {
    return blocklistStore.load().accounts;
  },
  /**
   * A report must carry evidence (a tx hash or a URL) and a reason. One reporter
   * counts once per account, so a single agent cannot get anything blocked alone.
   */
  report({ accountId, reporter, reason, evidence }) {
    if (!accountId || !reporter) throw new Error('accountId and reporter are required');
    if (!reason || reason.length < 8) throw new Error('reason must say what happened (8+ characters)');
    if (!evidence || !EVIDENCE_RE.test(evidence)) throw new Error('evidence must be a NEAR transaction hash or a URL');
    const db = blocklistStore.load();
    const entry = (db.accounts[accountId] ||= { reports: [] });
    if (entry.reports.some((r) => r.reporter === reporter)) {
      throw new Error(`${reporter} has already reported ${accountId}`);
    }
    entry.reports.push({ reporter, reason: reason.slice(0, 500), evidence, at: new Date().toISOString() });
    blocklistStore.save();
    return entry;
  },
};

// ---------------------------------------------------------------- payment history

const historyStore = new JsonStore('history.json', { agents: {} });

export const history = {
  get(agentId, receiver) {
    return historyStore.load().agents[agentId]?.[receiver] || null;
  },
  record({ agentId, receiver, amountNear, txHash }) {
    const db = historyStore.load();
    const agent = (db.agents[agentId] ||= {});
    const h = (agent[receiver] ||= { count: 0, totalNear: 0, first: new Date().toISOString(), last: null, lastTx: null });
    h.count += 1;
    h.totalNear = Number((h.totalNear + (Number(amountNear) || 0)).toFixed(6));
    h.last = new Date().toISOString();
    h.lastTx = txHash || null;
    historyStore.save();
    return h;
  },
};
