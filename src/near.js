// Thin NEAR data clients: JSON-RPC (with failover), archival RPC, and a
// paced NearBlocks client. No dependencies beyond Node's built-in fetch.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export class UpstreamError extends Error {
  constructor(message, { source, cause } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.source = source;
    this.cause = cause;
  }
}

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.httpTimeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    // Read the body even on 4xx/5xx: JSON-RPC errors often arrive with an error status.
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- JSON-RPC

// Busy public nodes answer "The node reached its limits. Try again later." Those
// calls are retried with backoff instead of failing the whole check.
const BUSY_RE = /reached its limits|Too Many Requests|HTTP 429|HTTP 5\d\d|timeout|aborted/i;

async function rpcCall(endpoints, method, params, attempt = 0) {
  try {
    return await rpcCallOnce(endpoints, method, params);
  } catch (e) {
    if (!e.definite && attempt < 3 && BUSY_RE.test(e.message)) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      return rpcCall(endpoints, method, params, attempt + 1);
    }
    throw e;
  }
}

async function rpcCallOnce(endpoints, method, params) {
  let lastErr;
  for (const url of endpoints) {
    try {
      const { status, body, text } = await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'shield', method, params }),
      });
      if (body && body.error) {
        // A definite answer from the chain (e.g. UNKNOWN_ACCOUNT) is not a reason to fail over.
        const cause = body.error.cause?.name || body.error.name;
        const err = new Error(body.error.data || body.error.message || 'RPC error');
        err.rpcCause = cause;
        err.definite = ['UNKNOWN_ACCOUNT', 'UNKNOWN_BLOCK', 'NO_CONTRACT_CODE', 'INVALID_ACCOUNT', 'GARBAGE_COLLECTED_BLOCK'].includes(cause);
        if (err.definite) throw err;
        lastErr = err;
        continue;
      }
      if (body && 'result' in body) return body.result;
      lastErr = new Error(`HTTP ${status} from ${url}: ${text.slice(0, 120)}`);
    } catch (e) {
      if (e.definite) throw e;
      lastErr = e;
    }
  }
  throw new UpstreamError(`All RPC endpoints failed for ${method}: ${lastErr?.message}`, { source: 'rpc', cause: lastErr });
}

export const rpc = {
  viewAccount: (accountId, blockId) =>
    rpcCall(blockId ? config.archivalRpc : config.rpc, 'query', {
      request_type: 'view_account',
      account_id: accountId,
      ...(blockId ? { block_id: blockId } : { finality: 'final' }),
    }),
  accessKeys: (accountId) =>
    rpcCall(config.rpc, 'query', { request_type: 'view_access_key_list', account_id: accountId, finality: 'final' }),
  latestBlock: () => rpcCall(config.rpc, 'block', { finality: 'final' }),
  block: (height) => rpcCall(config.archivalRpc, 'block', { block_id: height }),
};

/** Returns the account, or null when the chain says it does not exist. */
export async function getAccount(accountId) {
  try {
    return await rpc.viewAccount(accountId);
  } catch (e) {
    if (e.rpcCause === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

// ---------------------------------------------------------------- archival fallback
// When no indexer is available (NearBlocks retired its testnet API), facts are
// read straight from archival RPC: account creation by binary search over block
// heights (~30 calls), and code changes by comparing code_hash at past heights.

async function viewAt(accountId, height) {
  // Some heights have no block (skipped); try the next few.
  for (let h = height; h < height + 4; h++) {
    try {
      return await rpc.viewAccount(accountId, h);
    } catch (e) {
      if (e.rpcCause === 'UNKNOWN_ACCOUNT') return null;
      if (e.rpcCause === 'UNKNOWN_BLOCK' || e.rpcCause === 'GARBAGE_COLLECTED_BLOCK') continue;
      // Testnet's archive has holes for some old state ("MissingTrieValue"). Treat that
      // height as unusable; the binary search then moves on to later heights.
      if (/MissingTrieValue/.test(e.message)) return undefined;
      throw e;
    }
  }
  return undefined; // no usable block in range
}

async function blockTimeMs(height) {
  for (let h = height; h < height + 4; h++) {
    try {
      const b = await rpc.block(h);
      return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
    } catch (e) {
      if (e.rpcCause !== 'UNKNOWN_BLOCK') throw e;
    }
  }
  throw new UpstreamError(`no block near height ${height}`, { source: 'archival-rpc' });
}

// An account's creation time never changes, so it is cached on disk across runs.
// (Deleted-and-recreated accounts would keep the old date; rare enough to accept.)
const ageCacheFile = path.join(config.dataDir, `created-at.${config.network}.json`);
const ageCache = {
  data: null,
  load() {
    if (!this.data) {
      try {
        this.data = JSON.parse(fs.readFileSync(ageCacheFile, 'utf8'));
      } catch {
        this.data = {};
      }
    }
    return this.data;
  },
  get(id) {
    return this.load()[id] || null;
  },
  set(id, v) {
    this.load()[id] = v;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(ageCacheFile, JSON.stringify(this.data, null, 2));
    } catch {
      /* cache is an optimisation only */
    }
  },
};

export const archive = {
  /** Creation time (ms) of an account that exists now, via binary search. Cached for good. */
  async createdAt(accountId) {
    const cached = ageCache.get(accountId);
    if (cached) return cached;
    const r = await this.createdAtUncached(accountId);
    ageCache.set(accountId, r);
    return r;
  },

  async createdAtUncached(accountId) {
    const head = (await rpc.latestBlock()).header.height;
    let lo = 1; // known: account absent (or before any block)
    let hi = head; // known: account present
    while (hi - lo > 4) {
      const mid = Math.floor((lo + hi) / 2);
      const a = await viewAt(accountId, mid);
      if (a) hi = mid;
      else lo = mid; // absent, or no block there: search later heights
    }
    return { at: await blockTimeMs(hi), height: hi };
  },

  /** Height of the block roughly `msAgo` before now (estimated from block rate). */
  async heightAgo(msAgo) {
    const latest = await rpc.latestBlock();
    const head = latest.header.height;
    const nowMs = Number(BigInt(latest.header.timestamp_nanosec) / 1_000_000n);
    const span = 100_000;
    const pastMs = await blockTimeMs(head - span);
    const msPerBlock = (nowMs - pastMs) / span;
    return Math.max(1, Math.floor(head - msAgo / msPerBlock));
  },

  /** code_hash at a past height, or null if the account did not exist then. */
  async codeHashAt(accountId, height) {
    const a = await viewAt(accountId, height);
    return a ? a.code_hash : null;
  },
};

// ---------------------------------------------------------------- NearBlocks
// The free tier is rate-limited per IP and exposes no budget headers, so every
// caller is serialised onto one chain with a minimum gap, plus backoff on 429.

let nbChain = Promise.resolve();
let nbLast = 0;

function nearblocks(path) {
  const run = async () => {
    const headers = { accept: 'application/json' };
    if (config.nearblocksKey) headers.authorization = `Bearer ${config.nearblocksKey}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = nbLast + config.nearblocksMinIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      nbLast = Date.now();
      const { status, body } = await fetchJson(config.nearblocks + path, { headers });
      if (status === 429) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (status >= 200 && status < 300 && body) return body;
      throw new UpstreamError(`NearBlocks HTTP ${status} for ${path}`, { source: 'nearblocks' });
    }
    throw new UpstreamError(`NearBlocks rate-limited for ${path}`, { source: 'nearblocks' });
  };
  const p = nbChain.then(run, run);
  nbChain = p.catch(() => {});
  return p;
}

const ns = (t) => (t == null ? null : Number(BigInt(String(t)) / 1_000_000n)); // ns -> ms

export const indexer = {
  /** { createdAt (ms) | null, deleted } */
  async accountInfo(accountId) {
    const body = await nearblocks(`/v1/account/${encodeURIComponent(accountId)}`);
    const a = body?.account?.[0];
    if (!a || !a.account_id) return { exists: false, createdAt: null };
    return {
      exists: true,
      createdAt: ns(a.created?.block_timestamp),
      createdTx: a.created?.transaction_hash || null,
      deletedAt: ns(a.deleted?.block_timestamp),
    };
  },
  /** Contract deployments, oldest first: [{ at (ms), tx, by }] */
  async deployments(accountId) {
    const body = await nearblocks(`/v1/account/${encodeURIComponent(accountId)}/contract/deployments`);
    return (body?.deployments || [])
      .map((d) => ({ at: ns(d.block_timestamp), tx: d.transaction_hash, by: d.receipt_predecessor_account_id }))
      .sort((a, b) => a.at - b.at);
  },
  async txCount(accountId) {
    const body = await nearblocks(`/v1/account/${encodeURIComponent(accountId)}/txns/count`);
    const n = body?.txns?.[0]?.count;
    return n == null ? null : Number(n);
  },
};
