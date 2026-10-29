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

Only Paseo is supported. One claim pays every chain the contract has enabled; the frontend
only carries display names and explorer links for these para ids, and shows any other id as
`Parachain <id>`:

| Chain | Registry ID |
|---|---:|
| Paseo Relay | 0 |
| Asset Hub | 1000 |
| People | 1004 |
| Bulletin | 1010 |
| Asset Hub Next | 1500 |
| Bulletin Next | 1501 |
| People Next | 1502 |

Bulletin (1010) and Bulletin Next (1501) are separate chains. Westend, Coretime and Bridge
Hub are not listed.

The contract remains on public Paseo Asset Hub (1000), even when the recipient is on a Next
chain. The SDK descriptor is `devnet_asset_hub`, with its genesis checked against
`0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2`.
The SDK preset named `paseo` is a different network. Host-provided chain access is the only
transport; there is no WebSocket or backend fallback.

Which chains are paid, the amounts, caps and balances come from the deployed contract, not
from that list. `contracts/script/Deploy.s.sol` registers only Asset Hub and People; other
chains need operator configuration and verified arrival tests. The frontend does not register
destinations or invent their fees. The FAQ's tables of amounts per tier and assets per chain
are static: update them in `src/main.ts` whenever the owner changes the tiers or the
destinations.

## Contract integration

`src/faucet.abi.json` is exported from the compiled contract. Regenerate it after any contract
change:

```sh
cd contracts
forge build
cd ../frontend
npm run abi
```

The frontend speaks the `paseo-faucet:v2` contract, where one claim pays every enabled chain.
Opening the faucet validates `productId()` and `DOMAIN`, and refuses a contract with another
domain rather than use the wrong message format. The whitelist (REQ-19) has no UI: the owner
manages it on the contract.

Inside a Polkadot host the page opens the faucet on load and reads its state without anyone
signed in. Whoever is signed in to the host is connected without a click; fees and
account setup wait for the first claim. While nobody is signed in the page stays read-only, and
**Connect Polkadot app** asks the host for its sign-in (`requestLogin`), such as the code that
pairs the Polkadot app, then connects. The page follows the host's connection status, so
signing in or out through the host's own controls updates it too. Outside a host there is no
button, only a note to open the faucet in one.

The integration:

1. Connects a host product-account signer, preserving the host's transaction extensions.
2. At the first claim, checks account mapping. For a new account, requests PGAS before asking
   the SDK to create the mapping. A PGAS top-up is requested only below a conservative 1-PGAS
   fee/deposit buffer, not on every click. Real zero-PAS setup still needs a host canary test.
3. Reads contract state and obtains the exact `contextFor(epoch)` and
   `messageFor(epoch, recipient)` values, and shows what each enabled chain would receive,
   by the contract's rules (minimum, balance including `maxDeliveryFee`, pUSD where offered).
4. Selects People or People Lite keys of the personhood product (`peopl.` and this product's
   TLD) by declared ring metadata: public Paseo People genesis and collection, whether or not
   the ring names the Members pallet. It does not assume foreign key indexes. At connecting,
   a person holding a full key gets one proof over a fixed text that no claim accepts: the host
   checks ring membership before it proves, so a full key that is not in the People ring yet
   fails at once with `NotMember`. The preview then shows the lite amounts and says why, and the
   claim proves lite directly.
5. Requests a proof, checks its context, SCALE-prefixes it, and checks the alias's quota with
   `hasClaimed(epoch, tier, alias, id)` for every enabled chain: an alias every enabled chain
   has paid this epoch is done, one with chains still due claims them. Full is preferred; a
   missing membership or a full alias with nothing due can fall back to lite. Host permission
   failures stop immediately.
6. Dry-runs `drip`, obtains the user's signature, submits **without value** and waits for
   finality. A stale epoch or an invalid preflight proof gets one regeneration attempt.
   A transaction that may already have been submitted is never automatically resubmitted.
7. Decodes the transaction's `Dripped` and `DripSkipped` events and lists what each chain
   received or why it was skipped; a skipped chain can be claimed again in the same period.
   Links to the Asset Hub transaction. For other chains, confirmation means dispatch; arrival
   is asynchronous and each has its own explorer link.

The UI blocks claims once the epoch cap is reached. The contract still lets a person collect
chains skipped earlier in that period; the UI does not offer that, because it cannot know the
person's alias before asking for a proof.

SS58 addresses of any prefix decode to AccountId32, and an H160 to its `0xEE` account. The
same account is paid on every enabled chain, and only Asset Hub can use an `0xEE` account, so
the form warns that what other chains receive for it cannot be spent (K-27 in the abuse
review). PAS formatting uses integer plancks (10 decimals), and pUSD uses 6 decimals, without
floating-point balance conversion.

## Verification

```sh
npm test
npm run build
npx playwright install chromium  # once, if Chromium is not installed
npm run test:ui
```

For a separately installed Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable.
The browser tests start and stop their own Vite servers: port 4173 serves the undeployed page,
and port 4174 a deployed one whose host integration the tests replace with a scripted host.
Tests cover chain display data, address handling, proof encoding, the payout plan and advisory
eligibility, the signer/ABI handoff, the per-chain quota, event decoding, tier fallback,
retries, step timeouts, context rejection, new-account setup, sign-in and the connection
states, responsive layouts, the address deep link and absence of third-party requests on the
disconnected page. The SDK-facing tests use explicit test doubles; they do not replace a real
host or a cryptographic proof test.

The production SDK descriptor metadata is a large, separately loaded chunk. The page loads the
host integration after its first render, and an undeployed page never loads it. `npm audit`
currently reports an upstream `deepmerge-ts <8` advisory through `polkadot-api`'s descriptor CLI
dependency chain. It is not used by the browser claim code. No unverified major-version override was
introduced; track the upstream tooling update before release.

Real proof generation, host permissions, PGAS-only transactions and live destination arrivals
remain release checks. See [the deployment and PoP test runbook](../docs/DEPLOYMENT.md).
