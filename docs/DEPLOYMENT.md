# Deploy and test the Paseo faucet

This runbook deploys the contract and the frontend as a Polkadot product on **public
Paseo**. One claim pays every enabled destination. `contracts/script/Deploy.s.sol`
registers Asset Hub (1000) and People (1004); other chains are added with
`setDestination` once measured and tested ([Adding a destination](../README.md#adding-a-destination)).
The whitelist (REQ-19) is not built yet.

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

The current Apps documentation targets **Paseo Next v2**, with `.paseo` names and
a different genesis. Its default publishing commands do not target this contract
network. Do not switch only the RPC, use mainnet, or bypass genesis checks to make
the app connect. Migrating networks requires reviewing descriptors, precompiles,
proof collections, product identity and XCM destinations together.

Reserve a product name you control on the host's public-Paseo DotNS deployment
before deploying the contract. `faucet.dot` is an example, not an assigned name.
The actual host product ID, contract `productId()` and frontend `VITE_PRODUCT_ID`
must be identical. The contract's product ID and epoch duration are immutable.

You need Node.js 22+, npm, Foundry (`forge` and `cast`), a funded deployer, an owner
and pauser, PAS and pUSD to fund payouts, a DotNS publishing account with Bulletin
storage authorization, and a compatible Polkadot host. The host must expose both
public-Paseo chains above and a real matching People or People Lite key.

## 2. Prepare the publishing account and name

The published `@parity/dotns-cli@0.6.1` bundle contains the matching public-Paseo
descriptor and legacy DotNS addresses. Its command help and bundled configuration
were inspected for this guide. These publication transactions have **not** been
tested end to end here. Confirm with the host operator that this legacy DotNS and
Bulletin deployment is still supported before paying for registration.

Use this isolated bundle so it does not replace an installed newer CLI:

```sh
export DOTNS_TOOL_DIR="$(mktemp -d)"
npm pack @parity/dotns-cli@0.6.1 --pack-destination "$DOTNS_TOOL_DIR" --ignore-scripts
tar -xzf "$DOTNS_TOOL_DIR/parity-dotns-cli-0.6.1.tgz" -C "$DOTNS_TOOL_DIR"
dotns() { node "$DOTNS_TOOL_DIR/package/dist/cli.js" "$@"; }
dotns --version
export DOTNS_RPC=wss://asset-hub-paseo-rpc.n.dwellir.com
```

This version uses public Paseo directly; it does not take the modern `--env paseo-v2`
flag. Its bundled registrar controller is
`0xd09e0F1c1E6CE8Cf40df929ef4FC778629573651`. Check it has code on the contract
RPC and that the host resolves names through this same deployment. If it does not,
obtain the supported legacy deployment/tooling from the host operator; a newer CLI
with a public-Paseo RPC override retains its newer contract addresses.

```sh
cast code 0xd09e0F1c1E6CE8Cf40df929ef4FC778629573651 \
  --rpc-url https://eth-rpc-testnet.polkadot.io
```

This should return non-empty bytecode, not `0x`. Code presence alone does not
establish ABI compatibility or host support.

Import your publishing account using the interactive secret and password prompts:

```sh
dotns auth set --account publisher
dotns account address --account publisher
dotns account info --account publisher
dotns account map --account publisher
```

Fund that account on public Paseo for mapping, registration and record updates.
Skip mapping if it is already mapped. Request Bulletin storage authorization for
the same Substrate account from the public-Paseo Bulletin operator, then check it:

```sh
dotns bulletin status --account publisher
```

The CLI's administrative `bulletin authorize` command requires privileged access;
an ordinary publisher cannot grant itself storage. Likewise, `pop set` in this old
CLI is not a way to obtain a real ring key or a faucet proof.

For a name you already own, check ownership. Otherwise register an available label
for which your account meets the registrar's rules:

```sh
export PRODUCT_LABEL=replace-with-your-label
export PRODUCT_ID="$PRODUCT_LABEL.dot"
dotns lookup owner-of "$PRODUCT_LABEL"
# Only if the label is available and you intend to register it:
dotns register domain --name "$PRODUCT_LABEL" --account publisher
dotns lookup owner-of "$PRODUCT_LABEL"
```

Registration may require an operator grant or personhood depending on the name.
Confirm the host reports exactly `$PRODUCT_ID` before continuing. Keep this shell
open for the remaining commands; reconnecting requires restoring the variables
and the `dotns` function.

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

Deploy, verify, hand over ownership and fund the contract with the
[contract deployment runbook](../README.md#calls), steps 1 to 7, in the same shell
(`PRODUCT_ID` is already set) and with canary values:

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
registers Asset Hub and People, so one claim pays both: it needs the tier's PAS twice,
People's `maxDeliveryFee` (0.5 PAS) of delivery headroom, and the tier's pUSD twice. A
chain the faucet cannot fund is skipped (`DripSkipped`), and pUSD it lacks is left out.
Fund about 100 PAS and 10 pUSD rather than the runbook's 1,000 of each, and export the
deployed address as `FAUCET`.

Then run the runbook's [verification](../README.md#verification) calls, plus:

```sh
cast call "$FAUCET" 'DOMAIN()(bytes15)' --rpc-url "$RPC"  # 0x706173656f2d6661756365743a7632
```

Expect the configured owner and pauser, no pending owner, `paused=false`, the exact
product ID, domain `paseo-faucet:v2`, the configured tier amounts, cap and epoch,
enabled destinations 1000 and 1004, and balances that cover payouts plus delivery fees.

## 5. Build and publish the frontend to Bulletin + DotNS

From the repository root in the same shell:

```sh
cd frontend
cp .env.example .env
```

Edit `.env` so `VITE_FAUCET_ADDRESS` is `$FAUCET` and `VITE_PRODUCT_ID` is the exact
`$PRODUCT_ID` from above. Vite embeds these public values at build time: changing
them requires rebuilding and publishing a new bundle. Never put a private key,
seed phrase or keystore password in a `VITE_` variable.

```sh
npm run build
npm run preview
```

Review the preview URL Vite prints, then stop it with Ctrl+C. The ordinary browser
can render the page but cannot provide host signing or personhood proofs. Upload
the **directory contents represented by `dist/`**, including all lazy-loaded SDK
chunks, fonts and assets; do not upload the source tree, `.env`, or just `index.html`.

```sh
dotns bulletin upload ./dist --account publisher \
  --bulletin-rpc wss://paseo-bulletin-rpc.polkadot.io
export FRONTEND_CID=REPLACE_WITH_RETURNED_DIRECTORY_CID
# Save the current CID first if this name already points to a release:
dotns content view "$PRODUCT_LABEL"
dotns content set "$PRODUCT_LABEL" "$FRONTEND_CID" --account publisher
dotns content view "$PRODUCT_LABEL"
dotns bulletin verify "$FRONTEND_CID"
cd ..
```

Open `$PRODUCT_ID` using the compatible host's product navigator on public Paseo.
Check it resolves the new CID, reports the expected product identity, loads the
dynamic SDK files and requests the expected chain access. A gateway URL or a
normal browser rendering the page does not prove that it is running in a host.
If the host cannot resolve this legacy name or supply the public-Paseo chains,
stop here and coordinate a supported environment; do not assume Next v2 is equivalent.

Preserve the previous CID for rollback and record the publishing tool version,
chain genesis, contract address, build commit and new CID. Confirm the network's
Bulletin retention/renewal policy with its operator; a DotNS record alone does
not keep uploaded content available indefinitely.

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

To stop claims, the owner or pauser calls `pause()`. To restore an earlier frontend,
set the name's content hash back to the recorded previous CID. An owner can disable
a failing destination; contract migration and fund withdrawal are covered in the
[operations runbook](../README.md#failure-modes-and-rollback).

## References

- [Repository contract deployment](../README.md#deployment) and
  [frontend integration details](../frontend/README.md).
- [Current DotNS CLI reference](https://docs.polkadot.com/reference/apps/infrastructure/dotns/cli/)
  and [Apps publishing guide](https://docs.polkadot.com/apps/deploy-your-app/),
  which target newer environments than this implementation.
- [Pinned legacy CLI package](https://www.npmjs.com/package/@parity/dotns-cli/v/0.6.1).
- [PoP in the Polkadot App](https://docs.polkadot.com/reference/apps/hosts/polkadot-app/pop/);
  host enrollment remains dependent on the available app/network build.
