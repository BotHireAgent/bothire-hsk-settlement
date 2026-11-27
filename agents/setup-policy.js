// One-time: set the employer's spend policy for one token on the registry, allowlist the worker,
// and optionally hand control of the policy to a human or multisig.
//   EMPLOYER_KEY_FILE=... REGISTRY_ADDRESS=0x... node setup-policy.js --worker 0x... --token 0x... [--max 50000] [--daily 200000] [--controller 0x...]
// Amounts are raw token units (USDC has 6 decimals: 50000 = 0.05 USDC).
// After --controller is set, only that address can loosen the policy (the agent can still pause).
import { loadAccount, registryWrite, registryChain, explorerTx, hskClients, registryAbi, registryAddress } from './lib/chain.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const me = loadAccount('EMPLOYER_KEY_FILE');
const worker = arg('worker');
const token = arg('token', '0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // USDC on Base Sepolia
const controller = arg('controller');
if (!isAddr(worker)) throw new Error('--worker 0x... required');
if (!isAddr(token)) throw new Error('--token must be an address');
if (controller !== undefined && !isAddr(controller)) throw new Error('--controller must be an address');
const max = BigInt(arg('max', '50000'));
const daily = BigInt(arg('daily', '200000'));

const t1 = await registryWrite(me, 'setPolicy', [me.address, token, max, daily, true]);
console.log('setPolicy', explorerTx(registryChain, t1));
const t2 = await registryWrite(me, 'setPayeeAllowed', [me.address, worker, true]);
console.log('setPayeeAllowed', explorerTx(registryChain, t2));
if (controller) {
  const t3 = await registryWrite(me, 'setController', [me.address, controller]);
  console.log('setController', explorerTx(registryChain, t3));
}
const { pub } = hskClients();
const read = (functionName, args) => pub.readContract({ address: registryAddress(), abi: registryAbi, functionName, args });
console.log('policy', await read('policies', [me.address, token]));
console.log('controller', await read('controllerOf', [me.address]));
