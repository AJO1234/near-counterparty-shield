// HTTP API. Zero dependencies: Node's built-in http module.
//
//   GET  /health
//   GET  /v1/check?receiver=alice.near&amount=2&agent=my-agent
//   POST /v1/check      { receiver, amountNear?, agentId? }
//   POST /v1/ticket     { vault, receiver, amountNear, agentId? }  -> verdict + signed ticket on ALLOW
//   GET  /v1/pubkey     the Shield's ed25519 public key (configure it in the vault)
//   POST /v1/report     { accountId, reporter, reason, evidence }   (write)
//   GET  /v1/blocklist
//   POST /v1/payments   { agentId, receiver, amountNear, txHash }   (write)
//   GET  /              small web page to try a check by hand
//
// Write routes require `Authorization: Bearer $SHIELD_API_TOKEN` when that variable is set.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { check } from './shield.js';
import { blocklist, history } from './store.js';
import { validateAccountId } from './signals.js';
import { issueTicket, nearToYocto, shieldPublicKeyHex } from './tickets.js';

const PAGE = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const TOKEN = process.env.SHIELD_API_TOKEN || '';

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'cache-control': 'no-store',
  });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('body must be JSON'), { status: 400 });
  }
}

function requireWriteAuth(req) {
  if (!TOKEN) return;
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    throw Object.assign(new Error('missing or wrong bearer token'), { status: 401 });
  }
}

// Per-client rate limit for the routes that hit the chain. Every check costs
// shared, free upstream budget, so a public instance must not be a free proxy.
const LIMIT_PER_MIN = Number(process.env.SHIELD_RATE_LIMIT_PER_MIN || 20);
const hits = new Map(); // ip -> [timestamps]
function rateLimited(req) {
  // Behind a local reverse proxy, trust its X-Real-IP; otherwise use the socket.
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const ip = (local && req.headers['x-real-ip']) || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMIT_PER_MIN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (['/v1/check', '/v1/ticket'].includes(url.pathname) && rateLimited(req)) {
      return send(res, 429, { error: `rate limit: ${LIMIT_PER_MIN} checks per minute` });
    }
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, network: config.network, rpc: config.rpc[0], indexer: config.nearblocks });
    }

    if (url.pathname === '/v1/check' && (req.method === 'GET' || req.method === 'POST')) {
      const q = req.method === 'GET'
        ? { receiver: url.searchParams.get('receiver'), amountNear: url.searchParams.get('amount'), agentId: url.searchParams.get('agent') }
        : await readBody(req);
      if (!q.receiver) return send(res, 400, { error: 'receiver is required' });
      const result = await check({ receiver: q.receiver, amountNear: q.amountNear ?? null, agentId: q.agentId || null, fresh: url.searchParams.get('fresh') === '1' });
      return send(res, 200, result);
    }

    if (url.pathname === '/v1/blocklist' && req.method === 'GET') return send(res, 200, blocklist.all());
    if (url.pathname === '/v1/pubkey' && req.method === 'GET') return send(res, 200, { ed25519: shieldPublicKeyHex() });

    // Check + (only on ALLOW) a signed ticket the Shield Vault contract will accept.
    if (url.pathname === '/v1/ticket' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.vault || !b.receiver || b.amountNear == null) return send(res, 400, { error: 'vault, receiver and amountNear are required' });
      if (validateAccountId(String(b.vault))) return send(res, 400, { error: 'vault is not a valid NEAR account id' });
      nearToYocto(b.amountNear); // validates the amount before any network work
      const result = await check({ receiver: b.receiver, amountNear: b.amountNear, agentId: b.agentId || null });
      const ticket = result.verdict === 'ALLOW' ? issueTicket({ vault: b.vault, receiver: result.receiver, amountNear: b.amountNear }) : null;
      return send(res, 200, { ...result, ticket });
    }

    if (url.pathname === '/v1/report' && req.method === 'POST') {
      requireWriteAuth(req);
      const b = await readBody(req);
      const bad = validateAccountId(String(b.accountId || ''));
      if (bad) return send(res, 400, { error: `accountId is ${bad}` });
      return send(res, 201, blocklist.report(b));
    }

    if (url.pathname === '/v1/payments' && req.method === 'POST') {
      requireWriteAuth(req);
      const b = await readBody(req);
      if (!b.agentId || !b.receiver) return send(res, 400, { error: 'agentId and receiver are required' });
      return send(res, 201, history.record(b));
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || (/required|must|already|valid/.test(e.message) ? 400 : 502);
    return send(res, status, { error: e.message });
  }
});

/** Starts the API. Port 0 picks a free port; resolves to the base URL. */
export function startServer(port = config.port, { quiet = false } = {}) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      if (!quiet) {
        console.log(`Counterparty Shield on ${url}  (network: ${config.network})`);
        if (!TOKEN) console.log('Note: SHIELD_API_TOKEN is not set, so write routes are open. Set it before exposing this server.');
      }
      resolve({ url, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
