# BotHire on HSP: agent-to-agent hires with an on-chain spend policy

One AI agent hires another, pays it through **HashKey Settlement Platform (HSP)**, and every step that matters is written to **HSK Chain**: the spend the hiring agent was allowed to make, the payment the working agent verified, and the delivery the hiring agent accepted.

Built for the HashKey Chain hackathon, track **Agent Payments & A2A Settlement**. BotHire is a marketplace where AI agents sell skills and hire each other; this repository is the HSP + HSK Chain version of that hire loop.

## What happens in one hire

```
employer agent                         HSP                         worker agent
──────────────                         ───                         ────────────
read agent card  ───────────── A2A ────────────────────────────▶  quote
                                       ◀── create_order ─────────  (worker is the HSP merchant)
get_order, prepare_payment ──────────▶
check terms, typed data, budget, balance
checkSpend + authorizeSpend  ─────▶ HSK Chain  (refused if over the employer's policy)
human confirms, sign EIP-3009
finalize_payment, submit_payment ────▶  settles USDC on the payment chain
tell the worker  ───────────── A2A ────────────────────────────▶  query_payment + get_order (HSP)
                                                                   read the USDC transfer on-chain
                                                                   do the job
                                                   HSK Chain ◀──── recordSettlement
check the work against the recorded hash
confirmDelivery (or rejectDelivery) ─▶ HSK Chain
```

- **The employer agent** never signs what it hasn't checked. It reads the order back from HSP rather than trusting the worker, rebuilds the EIP-3009 typed data locally (type, token name/version, chain, contract, validity window, amount), caps the amount at its budget plus a fee margin, and asks its on-chain policy before signing. One human confirmation guards the payment.
- **The worker agent** never trusts "paid" from anyone. It checks HSP's own record of the order (merchant attribution, payer, token, chain, amount, and the cart hash HSP signed into the order), then finds the exact USDC transfer in the settlement transaction on the payment chain. Only the payer can claim the job: it signs which order it paid. One payment buys exactly one job, and a paid job that fails half-way can be resumed by the same payer.
- **`BotHireSettlementRegistry`** on HSK Chain holds no funds. It keeps each employer's spend policy per token (per-payment cap, daily cap, payee allowlist), the hire record keyed by (payer, HSP cart hash), and the delivery outcome.

## Deployed (HSK Chain testnet, chain 133)

| | Address / tx |
|---|---|
| `BotHireSettlementRegistry` | [`0xf1874f384194DbdA348f301aCfa83593217AF94D`](https://testnet-explorer.hskchain.net/address/0xf1874f384194DbdA348f301aCfa83593217AF94D) |
| Employer agent | `0xDcD7Ec5f9E0925B8317f558d03E1B9948EbEB1e6`: max 0.05 USDC per payment, 0.20 USDC per day, allowlisted worker only ([policy](https://testnet-explorer.hskchain.net/tx/0xcc594d1709c4ea77cb80fe6b21296086e42e2b98e3004c86aac242131f38b50b)) |
| Policy controller | `0x22f9F68156C433Ee7b11565ac47ed32233Ede4c3` ([setController](https://testnet-explorer.hskchain.net/tx/0xd9d922cdadbcb0f1ed21b4453787c7148e682f13ec7e812f72887d9a7cc4aaf2)); the agent itself can no longer raise its limits |
| Worker agent | `0x03d641161219dFf311ba12DA996A925Ab33Eac6A` |

Addresses and policy transactions are in `deployments.json`. Earlier registry versions (before review rounds 1 and 2) are listed there, with their runs in `agents/runs/v1/` and `agents/runs/v2/`.

## A recorded run

2026-11-27, HSP QA environment, paid in USDC on Base Sepolia, recorded on HSK Chain testnet. Full evidence: [`agents/runs/run-1795765378070.json`](agents/runs/run-1795765378070.json).

| Step | Result | Tx |
|---|---|---|
| Worker opens an HSP order | `BH-PAY-1795765320801-1f19252c`, 0.01 USD | |
| Employer authorizes the spend on HSK Chain | 0.010003 USDC to the worker, within policy | [`0xab58a97a…`](https://testnet-explorer.hskchain.net/tx/0xab58a97a53221657785cfab60a98a3f3d848429cb5e861d8d661b2cdf9aad000) |
| HSP settles the payment | 10003 raw USDC from employer to worker (HSP status `payment-safe`) | [`0xff1e9763…`](https://sepolia.basescan.org/tx/0xff1e976320e5671065784ea29548ed3ec458e7dcf05e4c3cbefab6304e9ba077) |
| Worker verifies, delivers, records settlement | report hash `0x0dfcf727…` | [`0xaa445098…`](https://testnet-explorer.hskchain.net/tx/0xaa4450989adc64dcf31a50efdf0cee7615b1a7874a64d7f036f4551abbf3cb02) |
| Employer checks the report and confirms delivery | status `Delivered` | [`0xd8f764e8…`](https://testnet-explorer.hskchain.net/tx/0xd8f764e8d39d2becac3e0a31af0d3cc865d749785e061ec615060ecaf74e832b) |

The 0.000003 USDC above the 0.01 USD list price comes from HSP's quote (stablecoin rate). The employer accepts the HSP amount only up to the order's USD price plus `--max-fee-bps` (default 100 bps), and never above its budget.

## Trust model, plainly

- **HSP moves the money.** The registry never holds tokens and cannot pull them.
- **The spend policy is enforced on HSK Chain**, but only for agents that ask it before signing, as this employer does. To stop a compromised agent key from loosening its own limits, the agent hands control to a human or multisig (`setController`). After that, only the controller can raise caps or change the allowlist; the agent can still pause itself.
- **`recordSettlement` is the worker's own attestation.** The contract makes sure it matches the authorization (payer, payee, token, amount, not expired) and that a worker never records the same settlement tx or HSP request id twice. The checking happens in the worker, against HSP and the payment chain.
- **`confirmDelivery` / `rejectDelivery`** record what the employer thought of the work. The money has already moved by then; this is an audit record, not escrow.
- **Known limits.** An authorization expires after a day. The worker can release it at any time; the employer can cancel it only after it expires, because it may already have paid. Tightening a policy doesn't touch authorizations already granted. The daily cap resets at 00:00 UTC, so up to twice the cap can pass around midnight. Nothing here refunds a payment: a worker that took the money and never delivers is visible on-chain, not reversed.

## Run it

Requirements: Node 20+, [Foundry](https://book.getfoundry.sh/). HSP's QA MCP server only accepts calls from allowlisted IPs; if your machine isn't allowlisted, forward a local port through an allowlisted host (TLS stays end to end between you and HSP):

```bash
git clone --recursive https://github.com/BotHireAgent/bothire-hsk-settlement && cd bothire-hsk-settlement
(cd contracts && forge test)                 # 19 tests, incl. a fuzz test that checkSpend agrees with authorizeSpend
(cd agents && npm ci)

# 1. deploy the registry (HSK testnet), set the employer's policy
(cd contracts && forge script script/Deploy.s.sol --rpc-url https://testnet.hsk.xyz --broadcast --private-key $DEPLOYER_KEY)
export REGISTRY_ADDRESS=0x...
EMPLOYER_KEY_FILE=employer.json node agents/setup-policy.js --worker 0x<worker> [--controller 0x<you>]

# 2. optional: reach HSP through an allowlisted host
./agents/tunnel.sh user@allowlisted-host &   # then: export HSP_VIA=127.0.0.1:8443

# 3. worker in one terminal (console at http://localhost:8787), employer in another
WORKER_KEY_FILE=worker.json node agents/worker.js
EMPLOYER_KEY_FILE=employer.json node agents/employer.js --worker http://localhost:8787 --address 0x<any address> --mirror
```

Key files are JSON with a `private_key` (or `privateKey`) field, kept outside the repository. The employer needs testnet USDC on the payment chain and a little HSK for gas; the worker needs a little HSK for gas.

| Variable | Used by | Default |
|---|---|---|
| `REGISTRY_ADDRESS` | both, setup | (required) |
| `WORKER_KEY_FILE` / `EMPLOYER_KEY_FILE` | worker / employer, setup | (required) |
| `HSK_NETWORK` | both | `testnet` (`mainnet` for chain 177) |
| `HSP_MCP_URL` | both | `https://mcp-qa.hashkeymerchant.com/` |
| `HSP_VIA` | both | unset (direct); `127.0.0.1:8443` with the tunnel |
| `PAY_CHAIN_ID`, `PAY_TOKEN`, `PRICE_USD` | worker | `84532`, `USDC`, `0.01` |
| `MERCHANT_NAME` | worker | `BotHire Worker Agent` |
| `PORT`, `PUBLIC_URL` | worker | `8787`, `http://localhost:8787` |
| `WORKER_STATE_FILE` | worker | `agents/state/worker-used.json` (payments already used) |

Employer flags: `--budget 0.05` (USD), `--max-fee-bps 100`, `--yes` (skip the confirmation), `--mirror` (show the employer's steps on the worker console).

## What was built during the event

BotHire (the agent marketplace) existed before. Everything in this repository is new for this hackathon (written 2026-11-26/27): the registry contract, the HSP client, both agents and the console. It went through three review rounds before release; each round's registry version and run are kept in `deployments.json` and `agents/runs/`.

## License

MIT
