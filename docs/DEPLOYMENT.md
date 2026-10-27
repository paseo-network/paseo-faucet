# Deploy and test the Paseo faucet

This runbook deploys the contract and the frontend as a Polkadot product on **public
Paseo**. One claim pays every enabled destination. `contracts/script/Deploy.s.sol`
registers Asset Hub (1000), People (1004), Bulletin (1010), Asset Hub Next (1500), Bulletin
Next (1501) and People Next (1502); other chains are added to `launch()` once measured and
tested, and the **Configure contract** workflow registers them on the deployed contract
([Adding a destination](../README.md#adding-a-destination)).
Whitelisted accounts (REQ-19) are added by the owner after the deploy, with `setWhitelisted`.

Start with a canary, using small balances. A successful build or simulated claim is
not evidence of a real host proof or remote token arrival.

## 1. Choose the network and product identity first

| Setting | This implementation |
| --- | --- |
| Contract chain | Public Paseo Asset Hub, para 1000 |
| Ethereum RPC | `https://eth-rpc-testnet.polkadot.io` |
| Ethereum chain ID | `420420417` |
| Asset Hub genesis | `0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2` |
| People genesis | `0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec` |
| SDK descriptor | `devnet_asset_hub`, checked against that genesis |
| Contract domain | `paseo-faucet:v2` |
| App names and storage | the PCF devnet: DotNS v1.0.0 on Paseo Asset Hub (registry `0xb052E5EfC5ADEff1f21d48DEfb5169Cb394A1a73`), storage on Bulletin, para 1010 |
| Publishing tool | `@polkadot-community-foundation/polkadot-app-deploy` 0.16.7, environment `devnet` |
| Gateways | IPFS `https://devnet-ipfs.api.polkadotcommunity.foundation`, web `dev-dot.li` |

The PCF devnet runs on the public Paseo system chains: the same Asset Hub and People as the
contract and the frontend's descriptor. The current Apps documentation targets **Paseo
Next v2**, with `.paseo` names and a different genesis; its default publishing commands do
not target this network. Do not switch only the RPC, use mainnet, or bypass genesis checks to make
the app connect. Migrating networks requires reviewing descriptors, precompiles,
proof collections, product identity and XCM destinations together.

Reserve a product name on the PCF devnet DotNS before deploying the contract. `faucet.dot` is an example, not an assigned name.
The actual host product ID, contract `productId()` and frontend `VITE_PRODUCT_ID`
must be identical. The contract's product ID and epoch duration are immutable.

The deploys run in GitHub Actions, from a `paseo` environment holding the secrets and
settings listed in the README's [From GitHub Actions](../README.md#from-github-actions).
You need the operator account (section 2), PAS and pUSD to fund payouts, and a compatible
Polkadot host that exposes both chains above and a real matching People or People Lite
key. Local checks need Node.js 22+, npm and Foundry (`forge` and `cast`).

## 2. Prepare the operator account and name

One account operates the faucet: the sr25519 root account (no derivation path) of the
`MNEMONIC` secret on the `paseo` environment. It deploys the contract, owns the product
name, publishes the app and keeps it stored; with `OWNER` and `PAUSER` set to its Ethereum
address it is also the owner and the pauser, so that secret controls the faucet's funds,
its settings and its name. Generate the mnemonic offline, store it only in that secret,
and note the account's address; no step below needs the mnemonic again. A multisig can
take ownership later with `transferOwnership`. The account must:

1. **Own the product name** on the PCF devnet DotNS: register it to the account, or
   transfer it there. Names of eight characters or fewer cannot be registered freely on
   DotNS v1.0.0; Root grants them. `polkadot-app-deploy` writes the name's records as its
   owner.
2. **Be authorized to store on Bulletin 1010.** The deploy and every keep-alive pass store
   with it. Both workflows grant or extend the authorization themselves with the
   `BULLETIN_AUTHORIZER` secret, the key URI of a Bulletin storage authorizer; on the PCF
   devnet that is `//Eve`.
3. **Hold some PAS on Paseo Asset Hub**: about 1.1 PAS for each contract deploy, in fees and
   storage deposits, and a little for the DotNS record updates.

## 3. Build and check before deployment

From the repository root:

```sh
git submodule update --init --recursive
cd contracts
forge build
forge test
cd ../frontend
npm ci
npm run abi
npm test
npx playwright install chromium
npm run test:ui
npm run build
cd ..
```

Run browser tests before adding a real faucet address: their landing-page checks
expect the disconnected configuration. If an existing `.env` is present, temporarily
move it outside the project and clear any exported `VITE_FAUCET_ADDRESS` for those tests.
Restore the configuration afterwards. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select
an already installed Chrome/Chromium executable.

Run the live fork check separately, with access to the chain RPCs:

```sh
cd fork
npm ci
npm run check
cd ..
```

Review the refreshed `docs/evidence/fork-check.json`, including live runtime versions
and destination measurements. Fork checks and SDK test doubles do not generate
a real user's PoP proof. See the [full contract preflight](../README.md#pre-flight-checks)
for the precompile checks and reference context vector.

## 4. Deploy and fund a canary contract

Deploy the contract with the **Deploy contract** workflow, or by hand with the [contract
deployment runbook](../README.md#calls), steps 1 to 4; then fund it (steps 6 and 7), after
`OWNER` accepts ownership (step 5) if it is not the deployer. Use canary values, as
variables on the `paseo` environment for the workflow or exported for the runbook:

```sh
export RPC=https://eth-rpc-testnet.polkadot.io
cast chain-id --rpc-url "$RPC"  # must print 420420417
export OWNER=0x_REPLACE_WITH_OWNER_H160
export PAUSER=0x_REPLACE_WITH_PAUSER_H160
export EPOCH_SECONDS=600
export MAX_DRIPS_PER_EPOCH=10
export LITE_PAS=20000000000      # 2 PAS, native plancks (10 decimals)
export FULL_PAS=50000000000      # 5 PAS
export LITE_PUSD=100000          # 0.1 pUSD (6 decimals)
export FULL_PUSD=200000          # 0.2 pUSD
```

These are canary examples, not production budgets. The script enables both tiers and
registers the six launch destinations, so one claim pays all of them: it needs the tier's
PAS six times, 0.5 PAS of delivery headroom for each of the five remote chains (their
`maxDeliveryFee`), and the tier's pUSD twice, for Asset Hub and People. A chain the faucet
cannot fund is skipped (`DripSkipped`), and pUSD it lacks is left out. Fund about 100 PAS and
10 pUSD rather than the runbook's 1,000 of each, and note the deployed address, which the
workflow's run summary prints, as `FAUCET`.

Then run the runbook's [verification](../README.md#verification) calls, plus:

```sh
cast call "$FAUCET" 'DOMAIN()(bytes15)' --rpc-url "$RPC"  # 0x706173656f2d6661756365743a7632
```

Expect the configured owner and pauser, no pending owner, `paused=false`, the exact
product ID, domain `paseo-faucet:v2`, the configured tier amounts, cap and epoch,
enabled destinations 1000, 1004, 1010, 1500, 1501 and 1502, and balances that cover payouts
plus delivery fees.

## 5. Publish the frontend

Set `FAUCET_ADDRESS` on the `paseo` environment to `$FAUCET` and run **Deploy app** from
`main`. It refuses an address that is not a `paseo-faucet:v2` contract for `PRODUCT_ID`,
builds `frontend/` with both values, publishes `dist/` under `PRODUCT_ID`, archives every
block the name then points at, and releases the archive as `app/<YYYY-MM-DD>.<n>`. Vite
embeds both values at build time, so changing either needs a new deploy. Never put a
private key or seed phrase in a `VITE_` variable.

Open `$PRODUCT_ID` in the compatible host's product navigator. Check it resolves the
root named in the release, reports the expected product identity, loads the dynamic SDK
files and requests the expected chain access. A gateway or a normal browser rendering
the page does not prove that it is running in a host.

Bulletin keeps stored data for 14 days. **Keep app alive** runs every day and stores the
latest release's blocks again once the oldest is 13 days old (README,
[Keeping the app stored](../README.md#keeping-the-app-stored)). After the first deploy,
run it once with `force` to check the account's authorization end to end.

## 6. Test a real proof of personhood claim

### Get a compatible PoP identity

Use a Polkadot App/host build configured for **the public-Paseo People genesis in
section 1**, and complete its supported People Lite or full People enrollment.
If testing through Desktop, pair it with that mobile app. A mainnet or Next v2
identity does not establish membership in public-Paseo rings. Exact enrollment
screens depend on the host build; ask the host/People operator for a compatible
test identity if public-Paseo enrollment is unavailable.

The faucet needs permission to access foreign ring keys owned by **`peopl.dot`**.
Ask the host operator to allow the faucet product identity if that access is
restricted. There is no permission bypass in the frontend and no real-proof
generator in this repository.

Expected membership metadata is People pallet instance 67, with the public-Paseo
People genesis and the 32-byte, space-padded collection ID for either
`pop:polkadot.network/people` (full, tier 2) or
`pop:polkadot.network/people-lite` (lite, tier 1).

### First claim

1. Record the recipient's balances on Asset Hub and on People, the current epoch, and
   `dripsInEpoch(epoch)`. Use a Substrate recipient address for easy comparison.
2. Open the published product **inside the compatible host**, click **Connect
   Polkadot app**, and approve the requested account/chain permissions.
3. Enter the recipient, check the amounts listed for Asset Hub and People, and click
   **Get some PAS**.
4. Approve the personhood and transaction prompts. The app obtains the contract's
   `contextFor(epoch)` and `messageFor(epoch, recipient)`, asks the host for a Ring-VRF
   proof, checks its contextual alias, dry-runs `drip`, then submits with **zero native
   value**. Full is preferred; Lite can be used when full membership is missing or its
   alias has nothing left to claim.
5. Wait for finality and follow the transaction link. Check successful execution and
   one `Dripped` event per enabled destination, `1000` and `1004`, with the intended
   recipient, tier and amounts, and no `DripSkipped`. Verify the recipient's PAS and pUSD
   increase on Asset Hub, and on People (PAS, and pUSD in its Digital Dollar asset) once
   the transfer arrives. People's PAS can be smaller than the drip because its execution
   fee is deducted; Asset Hub finality confirms dispatch, not arrival.

Use `cast receipt TX_HASH --rpc-url "$RPC"` for an Ethereum transaction hash.
The host may instead provide a Substrate extrinsic hash; inspect it in the
Asset Hub explorer rather than passing it to the Ethereum receipt method.

### Verify the quota

Read the alias and tier from a `Dripped` event (no private identity material is
needed) and query:

```sh
export CLAIM_EPOCH=REPLACE_WITH_EVENT_EPOCH
export CLAIM_TIER=REPLACE_WITH_EVENT_TIER
export CLAIM_ALIAS=0x_REPLACE_WITH_EVENT_ALIAS
for id in 1000 1004; do
  cast call "$FAUCET" 'hasClaimed(uint64,uint8,bytes32,uint32)(bool)' \
    "$CLAIM_EPOCH" "$CLAIM_TIER" "$CLAIM_ALIAS" "$id" --rpc-url "$RPC"
done
cast call "$FAUCET" 'dripsInEpoch(uint64)(uint32)' "$CLAIM_EPOCH" --rpc-url "$RPC"
cast call "$FAUCET" 'nextEpochStart()(uint64)' --rpc-url "$RPC"
```

Expect `hasClaimed=true` for both chains. The count rises once per person and epoch;
other users may also be claiming. The quota is per **epoch, tier, alias and
destination**, not per wallet. A second attempt using the same tier and alias in the
same epoch must fail with `AlreadyClaimed`. A full+lite identity can legitimately make
another claim through its unused Lite tier; use a Lite-only identity to test the
duplicate rejection unambiguously. Changing only the recipient does not reset the quota.

Optionally, check a skipped destination on the canary. The owner sets People's
`maxDeliveryFee` to 1 plank with `setDestination`, and a new identity (or a new epoch)
claims: Asset Hub is paid, the event list has `DripSkipped` for `1004` with reason
`PayoutFailed` (3), and nothing arrives on People. The owner restores the entry, the
same identity claims again in the same epoch, and only People is paid.

Repeat with a Lite identity and a full identity, and with a newly created product
account holding **zero PAS**. For the latter, confirm PGAS allocation precedes
account mapping and that setup, fees and storage deposits actually succeed without
PAS. Record the host/app versions and chain blocks along with the successful
claim hashes. If any of these steps fail, the canary has not passed.

## Troubleshooting and rollback

| Symptom | Check/action |
| --- | --- |
| Faucet being prepared / no connection | Address embedded at build time, full bundle uploaded, host context present |
| Product mismatch | Host ID, contract `productId()` and `VITE_PRODUCT_ID`; a wrong contract ID requires redeployment |
| Unsupported network | Compare genesis values; RPC overrides do not migrate DotNS contracts or PoP identities |
| No supported key / permission denied | Matching People collection, actual membership, `peopl.dot` access policy |
| Invalid proof | Matching context/message, ring revision and root propagation; frontend regenerates once before submission |
| Already claimed | Every enabled destination has paid this alias, tier and epoch; wait for `nextEpochStart`, not another wallet address |
| `DripSkipped` | `InsufficientPas`: fund the contract, including delivery-fee headroom; PGAS is not payout liquidity. `BelowMinimum`: the tier's PAS is below that chain's `minPas`. `PayoutFailed`: XCM failed or delivery exceeded `maxDeliveryFee`; the chain stays claimable this epoch |
| Mapping or fee allocation fails | Host PGAS allowance and support for a fresh zero-PAS account; do not mark the zero-PAS test passed |
| People dispatch succeeds but funds missing | Inspect destination XCM execution and balances before retrying |
| Transaction outcome uncertain | Inspect finality/events/balances; never blindly resubmit |
| Keep the storage authorization: not a Bulletin storage authorizer | `BULLETIN_AUTHORIZER` is no longer in Bulletin 1010's `TransactionStorage.AllowedAuthorizers`; set the key URI of one that is. Until then the app expires 14 days after its oldest block was stored |
| Keep app alive: the name points elsewhere | The name's content changed outside **Deploy app**; deploy again so the archive holds what the name points at |

To stop claims, the owner or pauser calls `pause()`. To restore an earlier frontend,
revert it on `main` and run **Deploy app**, which publishes and archives it like any
release; pointing the name at an older root by hand leaves the keep-alive refusing to
run until the next deploy. An owner can disable
a failing destination; contract migration and fund withdrawal are covered in the
[operations runbook](../README.md#failure-modes-and-rollback).

## References

- [Repository contract deployment](../README.md#deployment) and
  [frontend integration details](../frontend/README.md).
- [polkadot-app-deploy 0.16.7](https://www.npmjs.com/package/@polkadot-community-foundation/polkadot-app-deploy/v/0.16.7),
  the publishing tool.
- [PoP in the Polkadot App](https://docs.polkadot.com/reference/apps/hosts/polkadot-app/pop/);
  host enrollment remains dependent on the available app/network build.
