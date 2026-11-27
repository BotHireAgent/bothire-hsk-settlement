// Thin client for the HSP Agentic Payment MCP server (Streamable HTTP).
// Access is by IP allowlist; no credentials are sent from here.
import tls from 'node:tls';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, fetch as undiciFetch } from 'undici';

export const HSP_MCP_URL = process.env.HSP_MCP_URL || 'https://mcp-qa.hashkeymerchant.com/';

/**
 * Optional egress through a TCP forward (e.g. `ssh -L 8443:mcp-qa.hashkeymerchant.com:443 host`) so the
 * request leaves from the allowlisted host's IP. TLS still verifies the real server name end to end;
 * the forward only carries encrypted bytes. Set HSP_VIA=127.0.0.1:8443 to enable.
 */
function viaFetch() {
  const via = process.env.HSP_VIA;
  if (!via) return undefined;
  const [host, port] = via.split(':');
  const dispatcher = new Agent({
    connect: (opts, cb) => {
      const sock = tls.connect({ host, port: Number(port), servername: opts.servername || opts.hostname, ALPNProtocols: ['http/1.1'] });
      sock.once('secureConnect', () => cb(null, sock));
      sock.once('error', (e) => cb(e, null));
    },
  });
  return (url, init) => undiciFetch(url, { ...init, dispatcher });
}

export class Hsp {
  constructor(url = HSP_MCP_URL, log = () => {}) {
    this.url = url;
    this.log = log;
    this.client = null;
  }

  async connect() {
    if (this.client) return this;
    const client = new Client({ name: 'bothire-hsk-agent', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url), { fetch: viaFetch() }));
    this.client = client;
    return this;
  }

  async call(name, args = {}) {
    await this.connect();
    this.log('hsp', `→ ${name}`);
    const res = await this.client.callTool({ name, arguments: args });
    let out = res.structuredContent;
    if (out === undefined) {
      const text = (res.content || []).map((c) => c.text || '').join('');
      try {
        out = JSON.parse(text);
      } catch {
        out = { text };
      }
    }
    if (res.isError) {
      const msg = typeof out === 'object' ? JSON.stringify(out) : String(out);
      throw new Error(`HSP ${name} failed: ${msg.slice(0, 500)}`);
    }
    return out;
  }

  chainConfig() {
    return this.call('get_chain_config');
  }

  /** Picks the token entry for a chain + symbol from get_chain_config (never hardcoded). */
  async token(chainId, symbol) {
    const cfg = await this.chainConfig();
    const t = (cfg.tokens || []).find((x) => Number(x.chain_id) === Number(chainId) && x.symbol === symbol);
    const n = (cfg.networks || []).find((x) => Number(x.chain_id) === Number(chainId));
    if (!t || !n) throw new Error(`HSP does not list ${symbol} on chain ${chainId}`);
    return { ...t, network: n.name };
  }

  createOrder(a) {
    return this.call('create_order', a);
  }
  getOrder(flowId) {
    return this.call('get_order', { flow_id: flowId });
  }
  preparePayment(flowId, payer, protocol) {
    return this.call('prepare_payment', { flow_id: flowId, payer, protocol });
  }
  finalizePayment(a) {
    return this.call('finalize_payment', a);
  }
  submitPayment(paymentMandateJson) {
    return this.call('submit_payment', { payment_mandate_json: paymentMandateJson });
  }
  queryPayment(merchantName, { flowId, paymentRequestId }) {
    const a = { expected_merchant_name: merchantName };
    if (paymentRequestId) a.payment_request_id = paymentRequestId;
    else a.flow_id = flowId;
    return this.call('query_payment', a);
  }

  async close() {
    try {
      await this.client?.close();
    } catch {}
    this.client = null;
  }
}

/**
 * The cart hash HSP bound to an order, read from the merchant_authorization JWT that HSP signs and
 * stores on the order (get_order -> cartmandate.merchant_authorization). We read it straight from
 * HSP over TLS, so it is HSP's value, not something the paying side told us.
 */
export function cartHashOfOrder(order) {
  const jwt = order?.cartmandate?.merchant_authorization;
  if (typeof jwt !== 'string' || jwt.split('.').length !== 3) throw new Error('order has no merchant_authorization');
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  const h = String(payload.cart_hash || '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('merchant_authorization has no cart_hash');
  return `0x${h}`;
}

/** HSP statuses after which the money is on-chain and safe to act on. */
export const PAID_STATES = new Set(['payment-safe', 'payment-finalized']);
export const FAILED_STATES = new Set(['payment-failed']);
