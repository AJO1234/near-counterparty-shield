// Network endpoints and scoring thresholds. Everything here can be
// overridden with environment variables (see .env.example).
import { fileURLToPath } from 'node:url';

const NETWORKS = {
  mainnet: {
    rpc: ['https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'],
    archivalRpc: ['https://archival-rpc.mainnet.fastnear.com'],
    nearblocks: 'https://api.nearblocks.io',
    explorer: 'https://nearblocks.io',
  },
  testnet: {
    rpc: ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'],
    archivalRpc: ['https://archival-rpc.testnet.fastnear.com'],
    nearblocks: 'https://api-testnet.nearblocks.io',
    explorer: 'https://testnet.nearblocks.io',
  },
};

const network = (process.env.NEAR_NETWORK || 'mainnet').toLowerCase();
if (!NETWORKS[network]) {
  throw new Error(`NEAR_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')} (got "${network}")`);
}

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

export const config = {
  network,
  rpc: list(process.env.NEAR_RPC) || NETWORKS[network].rpc,
  archivalRpc: list(process.env.NEAR_ARCHIVAL_RPC) || NETWORKS[network].archivalRpc,
  nearblocks: process.env.NEARBLOCKS_API || NETWORKS[network].nearblocks,
  nearblocksKey: process.env.NEARBLOCKS_API_KEY || '',
  explorer: NETWORKS[network].explorer,

  port: Number(process.env.PORT || 8787),
  dataDir: process.env.SHIELD_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),

  // How long a verdict for the same receiver is reused (account facts change slowly).
  cacheTtlMs: Number(process.env.SHIELD_CACHE_TTL_MS || 10 * 60 * 1000),
  // NearBlocks' free tier is roughly 6 requests per minute per IP.
  nearblocksMinIntervalMs: Number(process.env.NEARBLOCKS_MIN_INTERVAL_MS || 2500),
  httpTimeoutMs: Number(process.env.SHIELD_HTTP_TIMEOUT_MS || 12000),

  thresholds: {
    // Risk points: >= block -> BLOCK, >= warn -> WARN, else ALLOW.
    block: 60,
    warn: 25,
    // Amount above which an unknown receiver is escalated to at least WARN (in NEAR).
    largeAmountNear: Number(process.env.SHIELD_LARGE_AMOUNT_NEAR || 5),
  },
};
