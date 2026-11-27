// BotHire employer agent: finds a worker, gets a quote, checks its own on-chain spend policy,
// signs the HSP payment (after one human confirmation), and confirms delivery on HSK Chain.
//
//   EMPLOYER_KEY_FILE=... REGISTRY_ADDRESS=0x... HSP_VIA=127.0.0.1:8443 node employer.js --worker http://localhost:8787 --address 0x...
//   flags: --yes (skip the prompt)  --budget 0.05 (USD)  --max-fee-bps 100  --mirror (show steps on the worker console)
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erc20Abi, formatUnits, parseUnits, parseAbi } from 'viem';
import { Hsp } from './lib/hsp.js';
import {
  loadAccount,
  hskClients,
  registryAbi,
  registryAddress,
  registryWrite,
  registryChain,
  readHire,
  paymentClient,
  toBytes32,
  explorerTx,
  HIRE_STATUS,
} from './lib/chain.js';
import { a2a, dataMessage, dataOf, hashDeliverable, sameAddr, sleep, paymentNotice } from './lib/util.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const WORKER = arg('worker', 'http://localhost:8787');
const TARGET = arg('address', '0x0000000000000000000000000000000000000000');
const BUDGET = arg('budget', '0.05');
const MAX_FEE_BPS = BigInt(arg('max-fee-bps', '100'));
const AUTO = flag('yes');
const MIRROR = flag('mirror');
const JOB_TIMEOUT_MS = 25 * 60_000;

if (!/^\d+(\.\d{1,6})?$/.test(BUDGET) || !(Number(BUDGET) > 0)) throw new Error('--budget must be a positive decimal like 0.05');
if (!/^0x[0-9a-fA-F]{40}$/.test(TARGET)) throw new Error('--address must be an EVM address');

const me = loadAccount('EMPLOYER_KEY_FILE');

async function say(kind, text, extra) {
  console.log(`[employer] ${kind}: ${text}`);
  if (!MIRROR) return;
  await fetch(`${WORKER}/api/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, text, extra }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

async function confirm(question) {
  if (AUTO) return say('confirm', `${question} (auto-yes)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') throw new Error('stopped by the human');
  await say('confirm', question);
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];
const tokenMetaAbi = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);

/**
 * Rebuilds the EIP-3009 typed data locally and only takes the values from HSP after checking them,
 * so a changed type, domain or a long-lived authorization is refused rather than signed.
 */
async function buildTypedData(prep, tok, chainId, payTo, raw) {
  const e = prep.eip712 || {};
  if (e.primaryType !== 'TransferWithAuthorization') throw new Error(`unexpected primaryType ${e.primaryType}`);
  const got = (e.types?.TransferWithAuthorization || []).map((f) => `${f.name}:${f.type}`).join(',');
  if (got !== TRANSFER_WITH_AUTHORIZATION.map((f) => `${f.name}:${f.type}`).join(',')) throw new Error('unexpected EIP-712 type');
  const pc = paymentClient(chainId);
  const [name, version] = await Promise.all([
    pc.readContract({ address: tok.address, abi: tokenMetaAbi, functionName: 'name' }),
    pc.readContract({ address: tok.address, abi: tokenMetaAbi, functionName: 'version' }),
  ]);
  const d = e.domain || {};
  if (d.name !== name || String(d.version) !== version) throw new Error('EIP-712 domain name/version differ from the token');
  if (!sameAddr(d.verifyingContract, tok.address) || Number(d.chainId) !== Number(chainId)) throw new Error('EIP-712 domain is for another contract or chain');
  const m = e.message || {};
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = BigInt(m.validAfter);
  const validBefore = BigInt(m.validBefore);
  if (validAfter > now + 60n) throw new Error('authorization starts in the future');
  if (validBefore <= now || validBefore > now + 2n * 3600n) throw new Error('authorization validity is not within the next 2 hours');
  if (!/^0x[0-9a-fA-F]{64}$/.test(m.nonce || '')) throw new Error('bad nonce');
  if (!sameAddr(m.from, me.address) || !sameAddr(m.to, payTo) || BigInt(m.value) !== raw) throw new Error('signed transfer differs from the checked terms');
  return {
    domain: { name, version, chainId: Number(chainId), verifyingContract: tok.address },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: 'TransferWithAuthorization',
    message: { from: me.address, to: payTo, value: raw, validAfter, validBefore, nonce: m.nonce },
  };
}

async function main() {
  const run = { startedAt: new Date().toISOString(), employer: me.address };

  // 1. Discover
  const card = await (await fetch(`${WORKER}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(15_000) })).json();
  const pay = card['x-bothire']?.payment;
  if (!pay || !/^0x[0-9a-fA-F]{40}$/.test(pay.payTo || '')) throw new Error('worker card has no payment terms');
  // Talk A2A only to the host we chose, not wherever the card points.
  if (new URL(card.url).origin !== new URL(WORKER).origin) throw new Error('agent card points to another host');
  await say('discover', `${card.name}: ${pay.priceUsd} USD via ${pay.rail}, pay_to ${pay.payTo}`);
  if (!(Number(pay.priceUsd) > 0) || Number(pay.priceUsd) > Number(BUDGET)) throw new Error(`price ${pay.priceUsd} not within budget ${BUDGET}`);

  // 2. Ask for the job; the worker opens an HSP order as merchant
  const reply = await a2a(card.url, 'message/send', {
    message: dataMessage({ type: 'hire_request', task: { kind: 'wallet_report', address: TARGET }, budgetUsd: Number(BUDGET), employer: me.address }),
  });
  const quote = dataOf(reply);
  if (quote?.type !== 'quote') throw new Error(`worker declined: ${quote?.reason || 'no quote'}`);
  if (Number(quote.chainId) !== Number(pay.chainId) || quote.token?.symbol !== pay.token || !sameAddr(quote.payTo, pay.payTo)) {
    throw new Error('quote terms differ from the agent card');
  }
  await say('quote', `HSP order ${quote.paymentRequestId}`);

  // 3. Read the order back from HSP, not from the worker
  const hsp = new Hsp(undefined, (k, t) => say(k, t));
  const order = await hsp.getOrder(quote.flowId);
  if (order.merchant_name !== pay.merchantName) throw new Error('merchant name differs from the card');
  const usd = Number(order.payment_amount?.value);
  if (order.payment_amount?.currency !== 'USD' || !Number.isFinite(usd) || usd <= 0 || usd > Number(BUDGET)) {
    throw new Error('order amount missing or over budget');
  }
  const md = (order.method_data || [])[0] || {};
  if (!sameAddr(md.pay_to, pay.payTo) || Number(md.chain_id) !== Number(pay.chainId)) throw new Error('order pays someone else or on another chain');
  const tok = await hsp.token(pay.chainId, pay.token);
  if (!sameAddr(md.contract_address, tok.address)) throw new Error('order token differs from HSP chain config');
  if (tok.payment_protocol !== 'eip3009' || !tok.is_stablecoin) throw new Error(`this agent pays USD stablecoins with eip3009 only`);

  // 4. Prepare the payment and check every term before anything is signed
  const prep = await hsp.preparePayment(quote.flowId, me.address, tok.payment_protocol);
  const raw = BigInt(prep.token_total_raw);
  // Hard cap: the order's USD price (already checked against the budget) plus the fee margin.
  const priced = String(order.payment_amount.value);
  if (!/^\d+(\.\d+)?$/.test(priced) || (priced.split('.')[1] || '').length > tok.decimals) throw new Error('order price unusable');
  const hardCap = (parseUnits(priced, tok.decimals) * (10_000n + MAX_FEE_BPS)) / 10_000n;
  if (raw <= 0n || raw > hardCap) throw new Error(`amount ${raw} over the hard cap ${hardCap} (price + ${MAX_FEE_BPS} bps)`);
  if (!sameAddr(prep.pay_to, pay.payTo) || !sameAddr(prep.payer, me.address)) throw new Error('prepared payment has other parties');
  const typed = await buildTypedData(prep, tok, pay.chainId, pay.payTo, raw);
  const expiresAt = new Date(prep.quote_expires_at);
  if (!(expiresAt > new Date(Date.now() + 30_000))) throw new Error('quote expired; run again');
  const bal = await paymentClient(pay.chainId).readContract({ address: tok.address, abi: erc20Abi, functionName: 'balanceOf', args: [me.address] });
  if (bal < raw) throw new Error(`balance ${formatUnits(bal, tok.decimals)} < ${formatUnits(raw, tok.decimals)} ${tok.symbol}`);
  await say('checked', `pay ${formatUnits(raw, tok.decimals)} ${tok.symbol} to ${prep.pay_to}; terms, typed data, budget and balance checked`);

  // 5. On-chain spend policy (HSK Chain): the contract refuses anything over my limits
  const cartHash = toBytes32(prep.cart_hash);
  const { pub } = hskClients();
  const [ok, reason] = await pub.readContract({
    address: registryAddress(),
    abi: registryAbi,
    functionName: 'checkSpend',
    args: [me.address, cartHash, prep.pay_to, tok.address, raw],
  });
  if (!ok) {
    await say('policy', `blocked by on-chain policy: ${reason}`);
    throw new Error(`policy: ${reason}`);
  }
  await confirm(`Pay ${formatUnits(raw, tok.decimals)} ${tok.symbol} on chain ${pay.chainId} to ${prep.pay_to} (${card.name})?`);
  if (!(new Date(prep.quote_expires_at) > new Date(Date.now() + 30_000))) throw new Error('quote expired while waiting; run again');
  const authTx = await registryWrite(me, 'authorizeSpend', [cartHash, prep.pay_to, tok.address, raw]);
  await say('policy', `spend authorized on ${registryChain.name}`, { txHash: authTx, url: explorerTx(registryChain, authTx) });

  // 6. Sign, finalize and submit. The authorization is not cancelled on failure: HSP may already
  //    hold the signed payment, and the contract only lets the payer cancel after it expires.
  const signature = await me.signTypedData(typed);
  const fin = await hsp.finalizePayment({
    signature,
    payment_payload: prep.payment_payload,
    payment_mandate_contents: prep.payment_mandate_contents,
    cart_hash: prep.cart_hash,
  });
  await say('signed', `payment mandate ready (hash ${String(fin.payment_hash).slice(0, 12)}…)`);
  let sub;
  try {
    sub = await hsp.submitPayment(fin.payment_mandate_json);
  } catch (e) {
    // The submit may have landed even if the reply was lost: ask HSP before giving up.
    const q = await hsp.queryPayment(pay.merchantName, { flowId: quote.flowId }).catch(() => null);
    if (!q || q.status === 'payment-required' || q.status === 'payment-failed') throw e;
    sub = { data: { status: q.status } };
  }
  await say('submitted', `HSP accepted the payment (${sub?.data?.status || 'submitted'})`);

  // 7. Tell the worker; it checks the payment itself before delivering
  const noticeSig = await me.signMessage({ message: paymentNotice({ flowId: quote.flowId, cartHash, worker: pay.payTo }) });
  let task = await a2a(card.url, 'message/send', {
    message: dataMessage({ type: 'payment_submitted', flowId: quote.flowId, cartHash, payer: me.address, signature: noticeSig }),
  });
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (task.status?.state === 'working' || task.status?.state === 'submitted') {
    if (Date.now() > deadline) throw new Error(`worker did not finish in time (task ${task.id})`);
    await sleep(10_000);
    task = await a2a(card.url, 'tasks/get', { id: task.id });
  }
  const out = dataOf(task.status?.message);
  if (task.status?.state !== 'completed') throw new Error(`worker failed: ${out?.reason || 'no reason'}`);

  // 8. Verify the delivery against the on-chain record, then confirm or reject
  const h = hashDeliverable(out.deliverable);
  const hire = await readHire(me.address, cartHash);
  if (HIRE_STATUS[hire.status] !== 'Settled') throw new Error(`registry status ${HIRE_STATUS[hire.status]}`);
  if (h !== hire.deliverableHash || !sameAddr(out.deliverable?.address, TARGET)) {
    const tx = await registryWrite(me, 'rejectDelivery', [cartHash, h]);
    await say('done', `delivery rejected on ${registryChain.name}`, { txHash: tx, url: explorerTx(registryChain, tx) });
    throw new Error('deliverable does not match the recorded hash or the task');
  }
  const confirmTx = await registryWrite(me, 'confirmDelivery', [cartHash, h]);
  await say('done', `delivery confirmed on ${registryChain.name}`, { txHash: confirmTx, url: explorerTx(registryChain, confirmTx) });

  Object.assign(run, {
    finishedAt: new Date().toISOString(),
    worker: pay.payTo,
    paymentRequestId: quote.paymentRequestId,
    flowId: quote.flowId,
    cartHash,
    amountRaw: prep.token_total_raw,
    token: tok.address,
    paymentChainId: Number(pay.chainId),
    paymentTx: hire.settlementTx,
    registryChainId: registryChain.id,
    registry: registryAddress(),
    authorizeTx: authTx,
    recordTx: out.recordTx,
    confirmTx,
    deliverableHash: h,
    deliverable: out.deliverable,
  });
  const runsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, `run-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  console.log(`\nDone. Evidence written to ${file}`);
  await hsp.close();
}

main().catch(async (e) => {
  await say('error', e.message);
  process.exitCode = 1;
});
