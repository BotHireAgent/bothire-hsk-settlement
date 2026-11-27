// Wallets, chains and the BotHireSettlementRegistry on HSK Chain.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia, arbitrumSepolia } from 'viem/chains';

export const hskTestnet = defineChain({
  id: 133,
  name: 'HSK Chain Testnet',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://testnet-explorer.hskchain.net' } },
});

export const hskMainnet = defineChain({
  id: 177,
  name: 'HSK Chain',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://hsk.blockscout.com' } },
});

const PAYMENT_CHAINS = { 84532: baseSepolia, 11155111: sepolia, 421614: arbitrumSepolia, 133: hskTestnet };

export const registryChain = process.env.HSK_NETWORK === 'mainnet' ? hskMainnet : hskTestnet;

export const registryAbi = parseAbi([
  'function setController(address agent, address controller)',
  'function setPaused(address agent, bool p)',
  'function setPolicy(address agent, address token, uint256 maxPerPayment, uint256 dailyCap, bool allowlistOnly)',
  'function setPayeeAllowed(address agent, address payee, bool allowed)',
  'function checkSpend(address payer, bytes32 cartHash, address payee, address token, uint256 amount) view returns (bool ok, string reason)',
  'function authorizeSpend(bytes32 cartHash, address payee, address token, uint256 amount)',
  'function cancelAuthorization(address payer, bytes32 cartHash)',
  'function clearPolicy(address agent, address token)',
  'function recordSettlement(address payer, bytes32 cartHash, address token, uint256 amount, string hspPaymentRequestId, bytes32 settlementTx, bytes32 deliverableHash)',
  'function confirmDelivery(bytes32 cartHash, bytes32 receivedHash)',
  'function rejectDelivery(bytes32 cartHash, bytes32 receivedHash)',
  'function getHire(address payer, bytes32 cartHash) view returns ((address payer, address payee, address token, uint256 amount, uint64 authorizedAt, uint64 expiresAt, uint64 settledAt, uint8 status, bytes32 settlementTx, bytes32 deliverableHash, string hspPaymentRequestId))',
  'function policies(address agent, address token) view returns (uint256 maxPerPayment, uint256 dailyCap, bool allowlistOnly, bool active)',
  'function controllerOf(address agent) view returns (address)',
  'function settlementTxUsed(bytes32) view returns (bool)',
]);

export const HIRE_STATUS = ['None', 'Authorized', 'Settled', 'Delivered', 'Rejected', 'Cancelled'];

/** Loads a key file written by `cast wallet new --json`. The path comes from the environment. */
export function loadAccount(envVar) {
  const p = process.env[envVar];
  if (!p) throw new Error(`${envVar} is not set (path to a wallet json file kept outside the repo)`);
  let d = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (Array.isArray(d)) d = d[0];
  const pk = d.private_key || d.privateKey;
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

export function registryAddress() {
  const a = process.env.REGISTRY_ADDRESS;
  if (!a) throw new Error('REGISTRY_ADDRESS is not set');
  return a;
}

export function hskClients(account) {
  const pub = createPublicClient({ chain: registryChain, transport: http() });
  const wallet = account ? createWalletClient({ chain: registryChain, transport: http(), account }) : null;
  return { pub, wallet };
}

export function paymentClient(chainId) {
  const chain = PAYMENT_CHAINS[Number(chainId)];
  if (!chain) throw new Error(`no RPC configured for payment chain ${chainId}`);
  return createPublicClient({ chain, transport: http() });
}

export async function readHire(payer, cartHash) {
  const { pub } = hskClients();
  return pub.readContract({ address: registryAddress(), abi: registryAbi, functionName: 'getHire', args: [payer, cartHash] });
}

/** Sends a registry tx and waits for it. Returns the tx hash. */
export async function registryWrite(account, functionName, args) {
  const { pub, wallet } = hskClients(account);
  const { request } = await pub.simulateContract({
    address: registryAddress(),
    abi: registryAbi,
    functionName,
    args,
    account,
  });
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

/** HSP cart_hash (hex sha256, with or without 0x) -> bytes32. */
export function toBytes32(h) {
  const s = String(h).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`not a 32-byte hash: ${h}`);
  return `0x${s}`;
}

export function explorerTx(chain, hash) {
  return `${chain.blockExplorers.default.url}/tx/${hash}`;
}
