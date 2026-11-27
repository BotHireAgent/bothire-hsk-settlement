import { keccak256, toHex } from 'viem';

/** Stable JSON: sorted keys, no whitespace. Both agents hash the deliverable the same way. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const hashDeliverable = (d) => keccak256(toHex(canonical(d)));

export const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal A2A JSON-RPC client. */
export async function a2a(url, method, params) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  if (text.length > 1_000_000) throw new Error(`A2A ${method}: response too large`);
  const body = JSON.parse(text);
  if (body.error) throw new Error(`A2A ${method}: ${body.error.message}`);
  return body.result;
}

/** Builds an A2A message carrying one structured data part. */
/** The message a payer signs to tell a worker which HSP order it paid. Both agents build it the same way. */
export const paymentNotice = ({ flowId, cartHash, worker }) =>
  `BotHire payment_submitted\nworker: ${String(worker).toLowerCase()}\nflow: ${flowId}\ncart: ${String(cartHash).toLowerCase()}`;

export function dataMessage(data, role = 'user') {
  return {
    kind: 'message',
    role,
    messageId: `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    parts: [{ kind: 'data', data }],
  };
}

export const dataOf = (msgOrTask) => {
  const parts = msgOrTask?.parts || msgOrTask?.status?.message?.parts || [];
  return parts.find((p) => p.kind === 'data')?.data;
};
