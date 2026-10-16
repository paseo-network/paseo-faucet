# Background

What a reviewer needs to know before reading [SPEC.md](SPEC.md). Every claim carries a
reference id (`[F1]`, `[P3]`, …) resolved in [REFERENCES.md](REFERENCES.md). Live numbers come
from [`evidence/live-facts.json`](evidence/live-facts.json) (Paseo Asset Hub block `14473665`,
Paseo People block `7759733`); the storage items behind each value are listed in
[REFERENCES.md](REFERENCES.md#live-evidence).

1. [The faucet today](#1-the-faucet-today)
2. [Proof of personhood on Polkadot and Paseo](#2-proof-of-personhood-on-polkadot-and-paseo)
3. [What a contract on Paseo Asset Hub can check](#3-what-a-contract-on-paseo-asset-hub-can-check)
4. [How a product obtains a proof](#4-how-a-product-obtains-a-proof)
5. [pUSD, the Paseo counterpart of dotUSD](#5-pusd-the-paseo-counterpart-of-dotusd)
6. [Contract mechanics on Paseo Asset Hub](#6-contract-mechanics-on-paseo-asset-hub)
7. [How products are built and deployed](#7-how-products-are-built-and-deployed)
8. [Paseo versus Polkadot](#8-paseo-versus-polkadot)

---

## 1. The faucet today

`paritytech/polkadot-testnet-faucet` [F1] serves Paseo at `faucet.polkadot.io` and is the
faucet listed on the Paseo website [W1].

**Architecture.** A Node.js backend (Express, TypeORM, PostgreSQL) plus a SvelteKit client.
The backend holds the faucet mnemonic in its environment (`FAUCET_ACCOUNT_MNEMONIC`) and signs
every drip itself [F2]. Two front doors reach it:

- a Matrix bot (`!drip <address>[:paraId]`) [F3];
- a web form (`POST /drip/web`) protected by reCAPTCHA v2 [F4].

**Paseo configuration** [F5]:

| Setting | Value |
|---|---|
| Source chain | Paseo Asset Hub (`id: 1000`), RPC `wss://sys.turboflakes.io/asset-hub-paseo` |
| Drip | 5000 PAS |
| Balance cap | 5500 PAS (no drip if the recipient already holds more) |
| Destinations | Asset Hub, relay, Bridge Hub, People, Coretime, AH Next, People Next (by `limited_teleport_assets`) |
| Quota | one drip per address (and per Matrix user) per 20 h, stored as sha256 hashes in PostgreSQL [F6] |
| Privileged | Matrix users matching a whitelist (Parity, Web3 Foundation, a few named accounts) skip the quota [F5] [F4] |

At the snapshot the faucet account held about 3,052,437 PAS [E3].

**It is already a DotNS product.** CI publishes the client to Bulletin and points `faucet.dot`
at it (`bulletin-deploy`, [F7]). Inside a Polkadot host (Polkadot Desktop, dot.li, the mobile
app) the client uses `product-sdk` to read the host account and to sign a message
`faucet:{address}:{timestamp}`, which the backend accepts **instead of the captcha** [F8] [F9].
Any freshly generated account can produce that signature, so in host mode the only sybil
control left is the per-address quota.

**What does not change by moving to a contract**: the Matrix bot needs a long-running process
with a Matrix access token, so it cannot be "web3". Either it stays on the legacy backend or it
is retired (decision D7 in the spec).

## 2. Proof of personhood on Polkadot and Paseo

The individuality pallets live in `paritytech/individuality-community` [P1] and are pulled into
the Paseo runtimes as a git dependency pinned at commit `1e7dcb9` [R1].

### Collections, rings and roots

Personhood is membership of one of two **collections** in the `Members` pallet on the People
chain (Paseo People index 67):

| Collection | Identifier (32 bytes, space-padded) | Who is in it |
|---|---|---|
| People (full) | `pop:polkadot.network/people     ` | recognised persons (proof of ink, games, or Root recognition) |
| People Lite | `pop:polkadot.network/people-lite` | lite persons (attested unique device, or paid registration) |

Each member holds a Bandersnatch ring-VRF key. Keys are grouped into **rings** of at most 255
members (ring exponent `R2e9` for both collections) [P2]. Each ring has a **root** (a KZG
commitment to its keys) and a **revision** that increases every time the ring is rebuilt.

On Paseo People (snapshot): 41 keys in the full ring 0 (revision 1); 886 lite keys in rings 0 to
3 (255, 255, 255, 121; revisions 254, 236, 171, 57) [E1].

### Contextual aliases

A member proves membership anonymously: the proof shows "some key in this ring signed this
message" without revealing which. Each proof also yields a **contextual alias**,
`alias = hash(VRF output)` over the input `"VerifiableBandersnatchVrfInput" ++ context` [P3].
The alias depends only on (member key, context), so:

- the same person gets the **same alias every time** in one context (across rings and
  revisions);
- the same person gets **unrelated aliases** in different contexts;
- the anonymity set is the ring (up to 255 members), not the whole collection.

The alias is therefore a natural per-person, per-application key: exactly what a faucet needs
to rate-limit people instead of addresses.

### Becoming a lite person on Paseo

- **Attested**: an attester holding an `AttestationAllowance` submits `PeopleLite.attest` for a
  candidate (fee-free). Allowances are granted by Root [P4] [R14]. On Paseo, every one of the 604
  registered lite people was attested by one account,
  `5HECKTpBe95rgbptG812Gh61VH3pjDfhgtE6xq5mHvRSUSo3`, which is the Polkadot app's onboarding
  (device uniqueness) attester and has 999,114 attestations left [E1].
- **Paid**: `PeopleLite.register_with_fee` is permissionless. The fee is a Root dynamic
  parameter, default **75 PAS**, non-refundable [P5] [R15]. Nobody has used it on Paseo yet. The
  runtime itself flags that this fee is the only rate limit on a permissionless path into the
  ring "on a chain whose native token is faucet-dispensed" [R16].
- `Members.OnboardingSize` is 1 for both collections on Paseo, so every new member triggers a
  ring rebuild [E1].
- The lite ring is append-only. 886 keys are in lite rings but only 604 accounts are registered:
  the difference are keys whose registry entries were reset. Those keys still prove lite
  personhood, so some humans hold more than one lite key (and therefore more than one alias per
  context) [E1].

### Becoming a full person on Paseo

`DummyDim.recognize_personhood` requires Root [P7] [R17]. All 41 full people on Paseo were recognised
this way (sudo key `5EyFpXybSYon74HVGUZVyvtYxTLy4EuqUxMhgXcmLM2qz1BL`) [E1]. Proof of ink, games
and mob rule exist in the runtime but have produced no persons. In practice, **full personhood on
Paseo is granted by sudo**.

### Ring roots reach Asset Hub

`MembersNotifier` on People (index 69) pushes root updates by XCM to `MembersSubscriber` on
Asset Hub (index 97); only para 1004 may deliver them [R2]. On Paseo AH the subscription is
`Active` and holds roots for lite rings 0 to 3 and the full ring 0 [E1].

Asset Hub keeps at most **3 recent roots per ring**, and a superseded root stays valid for
**21,600 s (6 h)** after its successor arrived [R3]. Lite ring 3 moved two revisions within an
hour on the snapshot day, so a client must prove against a revision Asset Hub still holds. A
re-proof at a newer revision yields the same alias.

### PGAS

PGAS (Paseo AH asset `2000000000`, non-transferable) is the fee token a person claims for free
with a ring proof: `Pgas.claim_pgas` is `Pays::No`, mints 5 PGAS per claim into any target
account, at most 100 claims per period for a full person and 40 for a lite person [P8] [E1].
`ChargePGAS` lets PGAS pay the fee of any `Revive` call (or a batch made only of `Revive`
calls), and contract storage deposits are taken in PGAS first (`PGasDeposit`) [R4].

## 3. What a contract on Paseo Asset Hub can check

Paseo AH exposes a pallet-revive precompile `IPersonhood` at
`0x000000000000000000000000000000000a010000` [P9] [R5]:

```solidity
struct PersonhoodInfo { uint8 status; bytes32 contextAlias; }   // 0 none, 1 lite, 2 full

struct ProofVerificationRequest {
    uint8   expectedStatus; // 1 lite, 2 full
    bytes   proof;          // SCALE-encoded ring-VRF proof
    bytes32 expectedAlias;
    uint32  ringIndex;
    bytes32 context;
    uint32  revision;
    bytes   message;
}

function personhoodStatus(address account, bytes32 context) external view returns (PersonhoodInfo memory);
function personhoodInfoByProof(ProofVerificationRequest calldata request) external view returns (bool);
```

### `personhoodStatus`: reads an account binding (closed on Paseo)

It returns the alias an account bound for exactly that `context` in the `AliasAccounts`
pallet [P10]. A binding is created with `AliasAccounts.set_alias_account(proof, collection,
ring_index, ring_revision, context, proof_valid_at)`, which burns a PGAS fee, and an account can
hold **one** binding (one alias, one context) [P11].

On Paseo AH the fee is the Root dynamic parameter `AliasFee`, default `None`, and no override is
stored, so every `set_alias_account` fails with `AliasFeeUnset` [R6] [E1]. There are 0 bindings,
and `personhoodStatus` returns status 0 for every account. Opening it needs Root
(`Parameters.set_parameter`). On Polkadot AH the fee is always set [K1].

The only deployed caller of `IPersonhood` is DotNS `PopRules`, which reads
`personhoodStatus(account, bytes32("dotns"))` [D1], so on Paseo it also sees no persons.

### `personhoodInfoByProof`: stateless verification (usable today)

It verifies a ring-VRF proof against the root of `(collection, ringIndex, revision)` held on
Asset Hub, for `context` and `message`, and checks that the proof derives `expectedAlias` [P13].
It records nothing. Properties that matter for a faucet:

- **No sender binding.** The precompile does not look at `msg.sender`. The interface tells
  callers to bind the account into `message` themselves [P9].
- **No nullifier.** The same calldata verifies again for as long as the root is retained (for a
  frozen full ring, indefinitely). The calling contract must record spent aliases itself.
- **No time window and no context allowlist.** Any 32-byte context is accepted.
- **Encoding.** `proof` is SCALE `BoundedVec<u8, 1265>`: the raw proof (785 bytes for one
  context) **prefixed with its compact length**, 787 bytes in total, 1267 at most [P14].
- **Cost.** `20,089,078,000` ref-time (about 20 ms of a 2 s block) and 4,470 proof bytes per
  call, charged up front [R7]. At the live fee multiplier that is about 0.009 PAS.

## 4. How a product obtains a proof

A "product" is a web app served from DotNS and run inside a Polkadot host. Hosts expose TrUAPI.

**The call.** `account.createAccountProof(keyHandle, context, ringLocation, message)` returns
`{ proof, contextualAlias: { context, alias }, ringIndex, ringRevision }`: everything
`personhoodInfoByProof` needs [T1]. `product-sdk` wraps it (`createRingVRFProof`) together with
`listRingVrfKeys`, which returns the opaque key handles [T2].

**The context is product-scoped.** A product does not pass a raw `bytes32`; it passes
`{ productId, suffix }` and the host computes

```
context = blake2b_256("product/" ++ productId ++ "/" ++ idx32(suffix))
idx32(Index n) = u32_le(n) ++ blake2b_256("product-account-index")[0..28]
idx32(Raw b)   = b
```

The runtime builds the same value from `product_name ++ "." ++ NETWORK_SUFFIX` (Paseo:
`"dot"`) [P15] [R8]. Examples (computed, see [REFERENCES.md](REFERENCES.md#computed-values)):

| productId | suffix | context |
|---|---|---|
| `faucet.dot` | `Index(0)` | `0x31c1b89cf59d9a9e3feeb55781674e2608785c7743d990f1eabc84f2c185e202` |
| `faucet.dot` | `Index(1)` | `0x2e49b0091ac03891906d1ce9354c1287f6bac0a594b95de162a92f10e0703da1` |

**The key belongs to the personhood product.** Person keys live in the ring-VRF domain of the
personhood product `peopl.<tld>` (`peopl.dot` on Paseo): index 0 is the full key, index 1 the
lite key. A full person who also holds a lite key has **two** aliases per context. TrUAPI
RFC-0024 makes using another product's key subject to the owner's allowlist:

> A Host MUST reject `account_create_account_proof` and `account_ring_vrf_sign` with a foreign
> `key_handle` unless the key's owning product has allowlisted the calling product in its
> manifest [T3].

**Host support today** (host builds read for this spec):

| Host | Proof with the `peopl.dot` key for a third-party product | Evidence |
|---|---|---|
| Polkadot app, Android | works; reserved handles served to any product (no allowlist check yet) | [H1] |
| Polkadot app, iOS | fails: container unpacks the old 3-tuple while host-api sends 4 arguments (code reading, not device-tested) | [H2] |
| Polkadot Desktop | refused with `NotAllowlisted` ("there is no manifest allowlist yet") | [H3] |
| dot.li | refused with `NotAllowlisted` | [H4] |

So a third-party product can obtain a People proof **only on Android today**, and only because
Android does not yet enforce RFC-0024. A durable, multi-host faucet needs `peopl.dot` to
allowlist it and hosts to implement manifest allowlists.

**Paying fees.** Hosts implement `resourceAllocation.request([SmartContractAllowance])`: the
phone claims PGAS into the product account with a ring proof [T4]. Android also tops up PGAS
automatically when it signs a transaction made only of `Revive` calls [H5]. Products sign as
their **product account** (sr25519 at `//product//{productId}/{index}`, RFC-0022 [T5]) through
substrate `Revive.call` extrinsics; TrUAPI has no Ethereum signing.

## 5. pUSD, the Paseo counterpart of dotUSD

Polkadot AH: **dotUSD** is asset `7873` (6 decimals), with a PSM against USDt (`1984`) [E2].

Paseo AH: **pUSD** ("People USD") is asset `50000413` [E1]:

| Field | Value |
|---|---|
| owner = issuer = admin = freezer | `5FX9eGJYqJTmjJDQrQpzEjGh7qQHNscW9uL1X17aXkiFN6u1` |
| decimals, min balance | 6, 10 base units |
| sufficient | yes (can create an account on its own) |
| supply | 20,995,901,990,000,487,560,486,857 base units (about 2.1e19 pUSD; issuance is not a constraint) |
| PSM | pUSD against USDt (`1984`) only, mint fee 0, redeem fee 0.01%, max debt 10,000,000 pUSD |
| AMM | PAS/pUSD pool (LP token 14), reserves about 2,496,973 PAS and 2,863,072 pUSD |

The value-transfer authorisation that used to guard pUSD transfers on Paseo was removed in
runtimes v2.5.2 [R9] [R10]. A plain signed origin (and a contract) can move pUSD on Asset Hub
today.

On People, pUSD exists as the chain's "external asset": a local `Assets` entry at the Asset Hub
location `(1, Parachain(1000), PalletInstance(50), GeneralIndex(50000413))`, named "Digital
Dollar", minimum balance 0.01 pUSD [R22] [E5]. People accepts it only as a teleport from Asset
Hub and uses it for coinage, proof of ink, scores, mob rule and fees [R21]. Coretime and Bridge
Hub have no assets pallet at all, so they cannot hold pUSD [R20].

Who can produce pUSD for a faucet:

- the **issuer** (`5FX9eGJYqJTmjJDQrQpzEjGh7qQHNscW9uL1X17aXkiFN6u1`) can `Assets.mint` any amount, or hand the issuer role to another
  account with `set_team`;
- **anyone holding USDt** can `Psm.mint` pUSD 1:1 (the PSM has no precompile, so a contract
  cannot do this itself) [R11];
- **anyone holding PAS** can swap PAS for pUSD in the AMM, including a contract through the
  asset-conversion precompile at `0x…0420` [R12]. This moves the pool price.

## 6. Contract mechanics on Paseo Asset Hub

pallet-revive on Paseo AH [R5] [R13]:

| Property | Value |
|---|---|
| EVM chain id | `420420417` (also used by other Polkadot test networks; not a unique domain separator) |
| Bytecode | PolkaVM (resolc, Rust) **and** EVM (`AllowEVMBytecode = true`; solc output deploys) |
| PAS in EVM units | `NativeToEthRatio = 10^8`: 1 planck = 10^8 wei, 1 PAS = 10^18 wei |
| Address mapping | `AccountId32Mapper`, `AutoMap = true`: accounts created **after** AutoMap are mapped at creation |
| Storage deposit | `PGasDeposit`: PGAS first, native fallback; 0.2 PAS per item, 0.00001 PAS per byte; only 10% of a PGAS deposit is refunded on release |
| eth-rpc / explorers | `https://eth-rpc-testnet.polkadot.io`; `https://blockscout-testnet.polkadot.io`, `https://assethub-paseo.subscan.io` |

Precompiles relevant to a faucet:

| Precompile | Address | Use |
|---|---|---|
| `ISystem` | `0x…0900` | `hashBlake256` (compute product contexts on chain), `toAccountId` (detect mapped accounts) [S1] |
| ERC20, trust-backed assets | `[asset id u32 BE] ++ 0x00…00 ++ 0x0120 ++ 0x0000`; pUSD = `0x02FaF21d00000000000000000000000001200000` | `transfer`, `balanceOf`, `approve`, `transferFrom`, EIP-2612 `permit` [S2] |
| XCM | `0x00000000000000000000000000000000000A0000` | `execute`, `send`, `weighMessage` (XCM v5, raw SCALE) [S3] |
| Asset conversion | `0x…0420` | swaps and quotes, assets given as SCALE `Location` [R12] |
| `IPersonhood` | `0x…0a010000` | section 3 |

Three mechanics shape the design:

1. **A contract can only reach an `AccountId32` through its H160.** Value and ERC20 transfers
   resolve the recipient H160 through `OriginalAccount`; if there is no mapping the funds go to
   the fallback account `h160 ++ 0xEE…EE` [S4]. Accounts created before AutoMap are unmapped
   (the pUSD issuer and the PAS/pUSD pool account among them), and an account that does not
   exist yet has no mapping. Ethereum-native accounts are exactly the `0xEE`-suffixed fallback
   form, so they always work. The XCM precompile can deposit to any `AccountId32` directly.
2. **New native recipients cost the signer an ED.** A contract value transfer to a non-existent
   account first moves the existential deposit (0.01 PAS) from the transaction origin [S5]. A
   signer paying in PGAS only may fail here (not verified live). An XCM `DepositAsset` of at
   least ED creates the account from the deposited funds.
3. **Only the signer pays.** There is no paymaster. Substrate-signed `Revive.call` pays fees in
   PGAS (`ChargePGAS`); Ethereum-signed transactions pay native PAS [R4].

## 7. How products are built and deployed

A product is a static web bundle:

1. built with `product-sdk` (host detection, accounts, signing, chain access through the host's
   provider, contract helpers);
2. uploaded to the Bulletin chain and bound to a DotNS name (`bulletin-deploy`, or `pad` in the
   PCF docs) [F7] [T6];
3. opened by name in the Polkadot app, Polkadot Desktop or `<name>.dot.li`.

Points that matter here:

- **The name fixes the context.** `productId` is the DotNS name, so renaming the product changes
  every person's alias (section 4).
- **Name length.** DotNS `PopRules` reserves 6 to 8 character labels for full persons until Root
  opens them; labels of 9 or more characters are open [D2]. `faucet` (6) is already registered as
  `faucet.dot` by the current faucet's CI [F7].
- **Network naming trap.** In `product-sdk` presets, "devnet" is the live Paseo Asset Hub
  genesis and "paseo" is Paseo Next [T6].
- **Wire version skew.** Upstream `product-sdk` pins `@parity/truapi ^0.24.0`, while the hosts
  in section 4 speak the 0.13 wire that the PCF fork of `product-sdk` pins [T7]. A product must
  use the SDK line its target hosts speak.

## 8. Paseo versus Polkadot

| | Paseo | Polkadot |
|---|---|---|
| Ring roots on Asset Hub | subscribed, 5 rings | subscription `Inactive`, no roots [E2] |
| Persons | 886 lite keys, 41 full | none yet |
| `AliasFee` (alias binding) | unset, binding closed | set, open [K1] |
| Root retention on AH | 21,600 s [R3] | 600 s [K2] |
| Lite registration fee | 75 PAS (faucet-dispensed) | 75 DOT |
| Full personhood | sudo `DummyDim` | Root `DummyDim` only |
| Network suffix | `dot` | `polkadot` |

A PoP-gated faucet contract can run on Paseo today. The same design is not usable on Polkadot
until its Asset Hub subscribes to People ring roots.
