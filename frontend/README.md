# Paseo faucet frontend

Static Vite + TypeScript frontend for the existing `contracts/src/PaseoFaucet.sol` contract.
It adapts the layout, colors, local logo and DM Sans / DM Serif Display typography of
[polkadot-testnet-faucet](https://github.com/paritytech/polkadot-testnet-faucet). The upstream
MIT notice is retained in `UPSTREAM-LICENSE`. Fonts are bundled locally; the page does not
load Google Fonts, reCAPTCHA, analytics or the legacy faucet backend.

## Run

```sh
cd frontend
npm ci
npm run dev
```

The default UI is disconnected and explains that the faucet is being prepared. It never
fabricates a transaction, connection, amount or eligibility result. It is usable for design
review in a normal browser; actual claims need a supported Polkadot host.

For a real deployment, copy `.env.example` to `.env` and set `VITE_FAUCET_ADDRESS` to the
deployed contract H160. `VITE_PRODUCT_ID` must match both its `productId()` and the actual
product identity. Restart Vite after editing the environment. There are no private keys or
backend URLs in this configuration. Do not add a mnemonic or secret to a `VITE_` variable.

For contract deployment, Bulletin/DotNS publication and a real proof-of-personhood
canary test, follow [Deploy and test the Paseo faucet](../docs/DEPLOYMENT.md).

## Scope and chain identity

Only Paseo is supported. The seven display choices are:

| Chain | Registry ID |
|---|---:|
| Paseo Relay | 0 |
| Asset Hub | 1000 |
| People | 1004 |
| Bulletin | 1010 |
| Asset Hub Next | 1500 |
| Bulletin Next | 1501 |
| People Next | 1502 |

Bulletin (1010) and Bulletin Next (1501) are separate choices, as confirmed by the user.
Both are always listed; no Bulletin selector environment setting is needed. No Westend,
Coretime or Bridge Hub option is included.

The contract remains on public Paseo Asset Hub (1000), even when the recipient is on a Next
chain. The SDK descriptor is `devnet_asset_hub`, with its genesis checked against
`0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2`.
The SDK preset named `paseo` is a different network. Host-provided chain access is the only
transport; there is no WebSocket or backend fallback.

The displayed catalog limits product scope. Availability, amounts, caps and balances come
from the deployed contract, not that catalog. A chain that is missing, disabled or unable to
pay cannot be claimed. Ale's current deployment script registers only Asset Hub and People;
the other entries need operator configuration and verified arrival tests. The frontend does
not register destinations or invent their fees.

## Contract integration

`src/faucet.abi.json` is exported from Ale's compiled contract, not the removed alternative
implementation. Regenerate it after any contract change:

```sh
cd contracts
forge build
cd ../frontend
npm run abi
```

The current implementation is explicitly **v1, single destination**. Connection validates
`productId()` and `DOMAIN`. A v2 multi-chain contract requires an ABI and flow update; the
frontend refuses to silently use its v1 assumptions against a changed domain. The whitelist
and pay-every-enabled-chain requirements remain unimplemented in the contract and are not
presented as working UI features.

The integration:

1. Connects a host product-account signer, preserving the host's transaction extensions.
2. Checks account mapping. For a new account, requests PGAS before asking the SDK to create
   the mapping. A PGAS top-up is requested only below a conservative 1-PGAS fee/deposit buffer,
   not on every click. Real zero-PAS setup still needs a host canary test.
3. Reads contract state and obtains the exact `contextFor` and `messageFor` values.
4. Selects People or People Lite keys by declared ring metadata, public Paseo People genesis
   and collection. It does not assume foreign key indexes.
5. Requests a proof, checks its context, SCALE-prefixes it, and checks the alias's epoch quota.
   Full is preferred; a missing membership or already-claimed full alias can fall back to lite.
   Host permission failures stop immediately.
6. Dry-runs `drip`, obtains the user's signature, submits **without value** and waits for
   finality. A stale epoch or an invalid preflight proof gets one regeneration attempt.
   A transaction that may already have been submitted is never automatically resubmitted.
7. Links to the Asset Hub transaction. For remote claims, confirmation means dispatch;
   destination arrival is asynchronous and has a separate explorer link.

SS58 addresses of any prefix decode to AccountId32. H160 is accepted only for Asset Hub.
Ethereum-derived `0xEE`-padded recipients are blocked for remote destinations to avoid the
account-access problem described in the abuse review. PAS formatting uses integer plancks
(10 decimals), and pUSD uses 6 decimals, without floating-point balance conversion.

## Verification

```sh
npm test
npm run build
npx playwright install chromium  # once, if Chromium is not installed
npm run test:ui
```

For a separately installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable.
The browser tests start and stop their own Vite server on port 4173. Tests cover the seven-chain
catalog, address validation, proof encoding, advisory eligibility, signer/ABI handoff, tier
fallback, retries, duplicate/context rejection, new-account setup, responsive layouts, deep
links and absence of third-party requests on the disconnected page. The SDK-facing tests use
explicit test doubles; they do not replace a real host or a cryptographic proof test.

The production SDK descriptor metadata is a large, separately loaded chunk. The initial page
does not load the host integration until connection is requested. `npm audit` currently
reports an upstream `deepmerge-ts <8` advisory through `polkadot-api`'s descriptor CLI dependency
chain. It is not used by the browser claim code. No unverified major-version override was
introduced; track the upstream tooling update before release.

This change does not deploy a contract, publish the frontend, fund the faucet or change Ale's
contract sources. Real proof generation, host permissions, PGAS-only transactions and live
destination arrivals remain release checks. See [the deployment and PoP test runbook](../docs/DEPLOYMENT.md).
