// BotHire worker agent: quotes a job, takes payment through HSP as a merchant, checks the
// payment itself, delivers, and records the settlement on HSK Chain.
//
//   WORKER_KEY_FILE=... REGISTRY_ADDRESS=0x... HSP_VIA=127.0.0.1:8443 node worker.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, parseAbi, parseUnits, formatEther, verifyMessage, createPublicClient, http as viemHttp } from 'viem';
import { Hsp, PAID_STATES, FAILED_STATES, cartHashOfOrder } from './lib/hsp.js';
import {
  loadAccount,
  readHire,
  registryWrite,
  registryChain,
  hskMainnet,
  hskTestnet,
  paymentClient,
  toBytes32,
  explorerTx,
  HIRE_STATUS,
} from './lib/chain.js';
import { hashDeliverable, sameAddr, sleep, dataMessage, paymentNotice } from './lib/util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const MERCHANT_NAME = process.env.MERCHANT_NAME || 'BotHire Worker Agent';
const PAY_CHAIN_ID = Number(process.env.PAY_CHAIN_ID || 84532);
const PAY_TOKEN = process.env.PAY_TOKEN || 'USDC';
const PRICE_USD = process.env.PRICE_USD || '0.01';
const STATE_FILE = process.env.WORKER_STATE_FILE || path.join(here, 'state', 'worker-used.json');
const POLL_MS = 15_000;
const PAY_TIMEOUT_MS = 20 * 60_000;
const QUOTE_TTL_MS = 35 * 60_000;
const TASK_TTL_MS = 2 * 60 * 60_000;
const MAX_QUOTES = 200;
const MAX_TASKS = 500;
const MAX_RUNNING = 5;
const MAX_BODY = 64 * 1024;
const HIRE_REQUESTS_PER_MIN = 10;
const EXPLORERS = ['https://testnet-explorer.hskchain.net/', 'https://hsk.blockscout.com/', 'https://sepolia.basescan.org/'];
const EMPLOYER_KINDS = new Set(['discover', 'quote', 'hsp', 'checked', 'confirm', 'policy', 'signed', 'submitted', 'done', 'error']);

if (!/^\d+(\.\d{1,6})?$/.test(PRICE_USD)) throw new Error('PRICE_USD must be a decimal like 0.01');

const me = loadAccount('WORKER_KEY_FILE');
const events = [];
const sseClients = new Set();
const tasks = new Map(); // taskId -> { task, payer, at }
const flowTask = new Map(); // flowId -> taskId
const quotes = new Map(); // flowId -> quote
const running = new Set(); // flowIds being processed
const hireRequests = new Map(); // ip bucket -> [timestamps]

// Verified payments are remembered across restarts: one payment buys one job, and a paid job that
// failed half-way (RPC, gas) can be resumed by the same payer without paying again.
//   flows[flowId] = { status: 'paid' | 'done', payer, quote, pay }
const state = (() => {
  if (!fs.existsSync(STATE_FILE)) return { flows: {}, txs: [] };
  const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); // refuse to start on a corrupt file
  return { flows: d.flows || {}, txs: d.txs || [] };
})();
const usedTxs = new Set(state.txs);
function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ flows: state.flows, txs: [...usedTxs] }));
  fs.renameSync(tmp, STATE_FILE);
}
const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/** Errors whose message is safe to show the other side. Anything else is reported as "internal error". */
class PublicError extends Error {}
const fail = (m) => {
  throw new PublicError(m);
};
const publicMessage = (e) => (e instanceof PublicError ? e.message : 'internal error');

function pushEvent(e) {
  events.push(e);
  if (events.length > 500) events.shift();
  for (const res of sseClients) res.write(`data: ${JSON.stringify(e)}\n\n`);
}

function log(kind, text, extra = {}) {
  pushEvent({ ...extra, t: new Date().toISOString(), agent: 'worker', kind, text });
  console.log(`[worker] ${kind}: ${text}`);
}

/** Full error detail stays in the local console; the public feed gets the safe message. */
function logError(e) {
  console.error('[worker] error detail:', e);
  log('error', publicMessage(e));
}

const hsp = new Hsp(undefined, log);

function prune() {
  const now = Date.now();
  for (const [k, ts] of hireRequests) if (!ts.some((t) => now - t < 60_000)) hireRequests.delete(k);
  for (const [k, q] of quotes) if (now - q.at > QUOTE_TTL_MS && !running.has(k)) quotes.delete(k);
  for (const [k, t] of tasks) {
    if (now - t.at > TASK_TTL_MS && t.task.status.state !== 'working') {
      tasks.delete(k);
      if (flowTask.get(t.task.contextId) === k) flowTask.delete(t.task.contextId);
    }
  }
}
setInterval(prune, 60_000).unref();

const agentCard = () => ({
  protocolVersion: '0.3.0',
  name: 'BotHire Wallet Report Agent',
  description:
    'A BotHire worker agent. Produces a dated balance and activity report for an EVM address on HSK Chain. ' +
    'Paid per job through HashKey Settlement Platform (HSP); settlement recorded on HSK Chain.',
  url: `${PUBLIC_URL}/a2a`,
  preferredTransport: 'JSONRPC',
  version: '0.2.0',
  provider: { organization: 'BotHire', url: 'https://www.bothire.io' },
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'wallet_report',
      name: 'HSK Chain wallet report',
      description: 'Native HSK balance and transaction count on HSK Chain mainnet and testnet for one address.',
      tags: ['hsk', 'wallet', 'report'],
      examples: ['{"type":"hire_request","task":{"kind":"wallet_report","address":"0x..."}}'],
    },
  ],
  'x-bothire': {
    payment: { rail: 'HSP', merchantName: MERCHANT_NAME, payTo: me.address, chainId: PAY_CHAIN_ID, token: PAY_TOKEN, priceUsd: PRICE_USD },
    settlementRegistry: { chainId: registryChain.id, address: process.env.REGISTRY_ADDRESS },
  },
});

// ------------------------------------------------------------------ job logic

/** IPv4 as is; IPv6 by /64, so rotating addresses inside one allocation counts as one caller. */
function ipBucket(ip) {
  const v = String(ip || '').replace(/^::ffff:/, '');
  return v.includes(':') ? v.split(':').slice(0, 4).join(':') : v;
}

async function handleHireRequest(d, ip) {
  const now = Date.now();
  const bucket = ipBucket(ip);
  const recent = (hireRequests.get(bucket) || []).filter((t) => now - t < 60_000);
  if (recent.length >= HIRE_REQUESTS_PER_MIN) fail('too many requests, try again in a minute');
  hireRequests.set(bucket, [...recent, now]);
  prune();
  if (quotes.size >= MAX_QUOTES) fail('busy, try again later');

  const task = d.task || {};
  if (task.kind !== 'wallet_report' || !/^0x[0-9a-fA-F]{40}$/.test(task.address || '')) {
    return { type: 'rejected', reason: 'only {kind:"wallet_report", address} is supported' };
  }
  if (d.budgetUsd !== undefined && !(Number(d.budgetUsd) >= Number(PRICE_USD))) {
    return { type: 'rejected', reason: `price is ${PRICE_USD} USD` };
  }
  const tok = await hsp.token(PAY_CHAIN_ID, PAY_TOKEN);
  const stamp = `${now}-${crypto.randomBytes(4).toString('hex')}`;
  const cart = {
    contents: {
      id: `BH-ORDER-${stamp}`,
      user_cart_confirmation_required: true,
      cart_expiry: new Date(now + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      merchant_name: MERCHANT_NAME,
      payment_request: {
        method_data: [
          {
            supported_methods: 'https://www.x402.org/',
            data: {
              x402Version: 2,
              network: tok.network,
              chain_id: PAY_CHAIN_ID,
              contract_address: tok.address,
              pay_to: me.address,
              coin: PAY_TOKEN,
            },
          },
        ],
        details: {
          id: `BH-PAY-${stamp}`,
          display_items: [{ label: `Wallet report ${task.address}`, amount: { currency: 'USD', value: PRICE_USD } }],
          total: { label: 'Total', amount: { currency: 'USD', value: PRICE_USD } },
        },
      },
    },
  };
  const order = await hsp.createOrder({ merchant_name: MERCHANT_NAME, pay_to: me.address, cart_mandate: cart });
  const quote = {
    type: 'quote',
    priceUsd: PRICE_USD,
    merchantName: MERCHANT_NAME,
    payTo: me.address,
    chainId: PAY_CHAIN_ID,
    token: { symbol: PAY_TOKEN, address: tok.address, decimals: tok.decimals, protocol: tok.payment_protocol },
    flowId: order.flow_id,
    paymentRequestId: order.payment_request_id,
    paymentUrl: order.payment_url,
    task: { kind: 'wallet_report', address: task.address },
  };
  quotes.set(order.flow_id, { ...quote, at: now });
  log('quote', `order ${order.payment_request_id} for ${PRICE_USD} USD`);
  return quote;
}

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

async function receiptWithRetry(chainId, hash) {
  const c = paymentClient(chainId);
  for (let i = 0; ; i++) {
    try {
      return await c.waitForTransactionReceipt({ hash, timeout: 60_000 });
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(5_000);
    }
  }
}

/**
 * Waits for HSP to report the payment, then checks everything against sources the paying side
 * can't control: HSP's own order (cart hash, amount, payer) and the token transfer on the payment chain.
 */
async function confirmPayment(quote, claimedCartHash, claimedPayer) {
  const start = Date.now();
  let q;
  for (;;) {
    q = await hsp.queryPayment(MERCHANT_NAME, { flowId: quote.flowId });
    log('hsp', `payment status ${q.status}`);
    if (FAILED_STATES.has(q.status)) fail('HSP reports the payment failed');
    if (PAID_STATES.has(q.status)) break;
    if (Date.now() - start > PAY_TIMEOUT_MS) fail('payment not confirmed in time');
    await sleep(POLL_MS);
  }
  const p = q.payment || {};
  if (!q.attribution_verified) fail('HSP attribution not verified');
  if (q.flow_id !== quote.flowId || p.payment_request_id !== quote.paymentRequestId) fail('HSP returned a different order');
  if (!sameAddr(p.to_pay_address, me.address)) fail('payment is not to this worker');
  if (!sameAddr(p.payer_address, claimedPayer)) fail('payer differs from HSP record');
  if (!sameAddr(p.token_address, quote.token.address)) fail('wrong token');
  if (p.chain !== `eip155:${quote.chainId}`) fail('wrong payment chain');
  const txHash = p.tx_signature;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) fail('no settlement tx hash from HSP');
  if (usedTxs.has(txHash.toLowerCase())) fail('this payment was already used for a job');
  const amt = String(p.amount || '');
  if (!/^\d+(\.\d+)?$/.test(amt) || (amt.split('.')[1] || '').length > quote.token.decimals) fail('HSP did not report a usable amount');
  const expected = parseUnits(amt, quote.token.decimals);
  // The amount HSP charged must cover the list price (stablecoin rate may move it slightly).
  if (expected * 100n < parseUnits(PRICE_USD, quote.token.decimals) * 99n) fail('payment is below the price');

  // The cart hash must be the one HSP bound to this order, not just any cart the payer authorized.
  const order = await hsp.getOrder(quote.flowId);
  const hspCart = cartHashOfOrder(order);
  if (hspCart !== claimedCartHash) fail('cart hash does not belong to this order');

  // The registry entry the employer created before signing must match this payment exactly.
  const hire = await readHire(claimedPayer, hspCart);
  if (HIRE_STATUS[hire.status] !== 'Authorized') fail(`registry hire is ${HIRE_STATUS[hire.status]}`);
  if (!sameAddr(hire.payee, me.address)) fail('registry payee mismatch');
  if (!sameAddr(hire.token, quote.token.address)) fail('registry token mismatch');
  if (hire.amount !== expected) fail('registry amount differs from the HSP payment');
  if (Number(hire.expiresAt) * 1000 < Date.now() + 5 * 60_000) fail('registry authorization is about to expire');

  // Do not trust "paid" from anyone: find the exact token transfer on the payment chain.
  const rc = await receiptWithRetry(quote.chainId, txHash);
  if (rc.status !== 'success') fail('settlement tx failed on-chain');
  const hit = rc.logs.some((lg) => {
    if (!sameAddr(lg.address, quote.token.address)) return false;
    try {
      const ev = decodeEventLog({ abi: transferAbi, data: lg.data, topics: lg.topics });
      return ev.eventName === 'Transfer' && sameAddr(ev.args.to, me.address) && sameAddr(ev.args.from, claimedPayer) && ev.args.value === expected;
    } catch {
      return false;
    }
  });
  if (!hit) fail('no matching token transfer in the settlement tx');
  const pay = { txHash, amount: expected, paymentRequestId: p.payment_request_id, cartHash: hspCart };
  usedTxs.add(txHash.toLowerCase());
  state.flows[quote.flowId] = jsonSafe({ status: 'paid', payer: claimedPayer, quote, pay });
  saveState();
  log('verified', `received ${expected} raw ${quote.token.symbol} in ${txHash}`, { txHash, chainId: quote.chainId });
  return pay;
}

async function doWork(task) {
  const out = { kind: 'wallet_report', address: task.address, generatedAt: new Date().toISOString(), chains: [] };
  for (const chain of [hskMainnet, hskTestnet]) {
    const c = createPublicClient({ chain, transport: viemHttp() });
    const [bal, nonce, block] = await Promise.all([
      c.getBalance({ address: task.address }),
      c.getTransactionCount({ address: task.address }),
      c.getBlockNumber(),
    ]);
    out.chains.push({ chainId: chain.id, name: chain.name, block: block.toString(), balanceHsk: formatEther(bal), txCount: nonce });
  }
  return out;
}

/** recordSettlement with retries; a retry first checks whether an earlier attempt already landed. */
async function recordWithRetry(payer, quote, pay, deliverableHash) {
  for (let i = 0; ; i++) {
    try {
      return await registryWrite(me, 'recordSettlement', [
        payer,
        pay.cartHash,
        quote.token.address,
        pay.amount,
        pay.paymentRequestId,
        pay.txHash,
        deliverableHash,
      ]);
    } catch (e) {
      const h = await readHire(payer, pay.cartHash).catch(() => null);
      if (h && HIRE_STATUS[h.status] === 'Settled' && h.settlementTx.toLowerCase() === pay.txHash.toLowerCase()) return null;
      if (i >= 2) throw e;
      await sleep(10_000);
    }
  }
}

async function runPaidJob(taskId, d) {
  const entry = tasks.get(taskId);
  const setState = (state, data) => {
    entry.task.status = { state, timestamp: new Date().toISOString(), message: data ? dataMessage(data, 'agent') : undefined };
  };
  try {
    const saved = state.flows[d.flowId];
    let quote, pay;
    if (saved?.status === 'paid') {
      // Resume: the payment was verified earlier; skip straight to the work.
      ({ quote } = saved);
      pay = { ...saved.pay, amount: BigInt(saved.pay.amount) };
      log('resume', `payment ${pay.txHash.slice(0, 10)}… already verified, resuming the job`);
    } else {
      quote = quotes.get(d.flowId);
      pay = await confirmPayment(quote, d.cartHash, d.payer);
    }
    const deliverable = await doWork(quote.task);
    const deliverableHash = hashDeliverable(deliverable);
    log('work', `report ready ${deliverableHash.slice(0, 10)}…`);
    const recordTx = await recordWithRetry(d.payer, quote, pay, deliverableHash);
    if (recordTx) log('record', `settlement recorded on ${registryChain.name}`, { txHash: recordTx, url: explorerTx(registryChain, recordTx) });
    state.flows[d.flowId].status = 'done';
    saveState();
    entry.task.artifacts = [{ artifactId: 'report', name: 'wallet_report', parts: [{ kind: 'data', data: deliverable }] }];
    setState('completed', {
      type: 'delivery',
      deliverable,
      deliverableHash,
      paymentTx: pay.txHash,
      paymentChainId: quote.chainId,
      recordTx,
      registryChainId: registryChain.id,
    });
  } catch (e) {
    logError(e);
    setState('failed', { type: 'error', reason: publicMessage(e) });
  } finally {
    running.delete(d.flowId);
  }
}

async function startPaidJob(d) {
  if (typeof d.flowId !== 'string' || d.flowId.length > 100) fail('flowId required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(d.payer || '')) fail('payer address required');
  let cartHash;
  try {
    cartHash = toBytes32(d.cartHash);
  } catch {
    fail('cartHash must be 32 bytes');
  }
  // Only the payer can claim the job (and read its delivery): it signs which order it paid.
  const notice = paymentNotice({ flowId: d.flowId, cartHash, worker: me.address });
  const okSig = /^0x[0-9a-fA-F]{130}$/.test(d.signature || '') && (await verifyMessage({ address: d.payer, message: notice, signature: d.signature }).catch(() => false));
  if (!okSig) fail('payment notice must be signed by the payer');

  const saved = state.flows[d.flowId];
  if (saved && !sameAddr(saved.payer, d.payer)) fail('this order was paid by someone else');
  const existing = flowTask.get(d.flowId);
  // Same payer asking again: hand back the task, unless it failed and can be resumed.
  if (existing && tasks.has(existing) && tasks.get(existing).task.status.state !== 'failed') return tasks.get(existing).task;
  if (saved?.status === 'done') fail('this order was already delivered');
  if (!saved && !quotes.has(d.flowId)) fail('unknown flowId');
  if (running.has(d.flowId)) fail('this order is already being processed');
  if (running.size >= MAX_RUNNING) fail('busy, try again later');
  prune();
  if (tasks.size >= MAX_TASKS) fail('busy, try again later');
  running.add(d.flowId);
  // Random task ids: knowing one is what lets a caller read the delivery.
  const id = `task-${crypto.randomUUID()}`;
  tasks.set(id, { at: Date.now(), task: { kind: 'task', id, contextId: d.flowId, status: { state: 'working', timestamp: new Date().toISOString() } } });
  flowTask.set(d.flowId, id);
  runPaidJob(id, { flowId: d.flowId, payer: d.payer, cartHash });
  return tasks.get(id).task;
}

// ------------------------------------------------------------------ A2A JSON-RPC

async function rpc(body, ip) {
  const { method, params = {} } = body;
  if (method === 'message/send') {
    const d = (params.message?.parts || []).find((p) => p.kind === 'data')?.data || {};
    log('a2a', `message/send ${String(d.type).slice(0, 40)}`);
    if (d.type === 'hire_request') return dataMessage(await handleHireRequest(d, ip), 'agent');
    if (d.type === 'payment_submitted') return await startPaidJob(d);
    throw Object.assign(new PublicError('unsupported message type'), { code: -32602 });
  }
  if (method === 'tasks/get') {
    const t = typeof params.id === 'string' && tasks.get(params.id);
    if (!t) throw Object.assign(new PublicError('task not found'), { code: -32001 });
    return t.task;
  }
  throw Object.assign(new PublicError('method not found'), { code: -32601 });
}

function send(res, code, body, type = 'application/json', cors = false) {
  const h = { 'content-type': type };
  if (cors) h['access-control-allow-origin'] = '*';
  res.writeHead(code, h);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > MAX_BODY) throw new PublicError('body too large');
  }
  return raw;
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/** The employer CLI on the same machine mirrors its steps here so the console shows both sides. */
function acceptEmployerEvent(e) {
  const kind = String(e?.kind || '');
  if (!EMPLOYER_KINDS.has(kind)) return;
  const ev = { t: new Date().toISOString(), agent: 'employer', kind, text: String(e.text || '').slice(0, 300) };
  const x = e.extra || {};
  if (typeof x.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x.txHash)) ev.txHash = x.txHash;
  if (typeof x.url === 'string' && EXPLORERS.some((p) => x.url.startsWith(p)) && /^[\w:/.\-]+$/.test(x.url)) ev.url = x.url;
  pushEvent(ev);
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, PUBLIC_URL);
      if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') return send(res, 200, agentCard(), 'application/json', true);
      if (req.method === 'GET' && url.pathname === '/api/events') return send(res, 200, events);
      if (req.method === 'GET' && url.pathname === '/events') {
        if (sseClients.size >= 20) return send(res, 503, { error: 'too many viewers' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(here, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && (url.pathname === '/a2a' || url.pathname === '/api/log')) {
        // JSON only: blocks cross-site "simple" form/text posts from browsers.
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'application/json required' });
        const raw = await readBody(req);
        if (url.pathname === '/api/log') {
          if (!isLoopback(req)) return send(res, 403, { error: 'local only' });
          try {
            acceptEmployerEvent(JSON.parse(raw));
          } catch {}
          return send(res, 204, '');
        }
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        }
        try {
          return send(res, 200, { jsonrpc: '2.0', id: body.id ?? null, result: await rpc(body, req.socket.remoteAddress) });
        } catch (e) {
          logError(e);
          const code = e instanceof PublicError && e.code ? e.code : -32000;
          return send(res, 200, { jsonrpc: '2.0', id: body.id ?? null, error: { code, message: publicMessage(e) } });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof PublicError ? 413 : 500, { error: publicMessage(e) });
    }
  })
  .listen(PORT, () => log('start', `worker ${me.address} on ${PUBLIC_URL} (registry on ${registryChain.name})`));
