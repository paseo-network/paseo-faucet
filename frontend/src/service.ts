import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { createChainClient } from '@parity/product-sdk-chain-client';
import { devnet_asset_hub } from '@parity/product-sdk-descriptors/devnet-asset-hub';
import { createContractFromClient, createContractRuntimeFromClient, isContractAccountMapped, ensureContractAccountMapped, type AbiEntry } from '@parity/product-sdk-contracts';
import { SignerManager } from '@parity/product-sdk-signer';
import { isInsideContainer, requestResourceAllocation, type RingLocation } from '@parity/product-sdk-host';
import abi from './faucet.abi.json';
import { ASSET_HUB_GENESIS, PEOPLE_GENESIS, bytesEqual, claimBlocker, encodeProof, formatAmount, type Destination, type FaucetService, type Snapshot, type TierConfig } from './model';

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
}
function tierFrom(value: unknown): TierConfig {
  const tuple = value as [boolean, bigint, bigint];
  return { enabled: tuple[0], pas: BigInt(tuple[1]), pusd: BigInt(tuple[2]) };
}
const defaultDependencies = {
  createChainClient, SignerManager, isInsideContainer, createContractFromClient,
  createContractRuntimeFromClient, isContractAccountMapped, ensureContractAccountMapped, requestResourceAllocation,
};
export type FaucetDependencies = typeof defaultDependencies;

async function allocateFees(request = requestResourceAllocation) {
  const allocation = await request([{ tag: 'SmartContractAllowance', value: { tag: 'Index', value: 0 } }]);
  if (!allocation.ok) throw allocation.error;
  if (allocation.value[0] !== 'Allocated') throw new Error('This host cannot provide PGAS for the claim. Try a supported Polkadot host.');
}

/** Connects only through the Polkadot host; never calls the legacy faucet backend. */
export async function connectFaucet(address: Hex, productId: string, dependencies: FaucetDependencies = defaultDependencies): Promise<FaucetService> {
  const { createChainClient, SignerManager, isInsideContainer, createContractFromClient,
    createContractRuntimeFromClient, isContractAccountMapped, ensureContractAccountMapped, requestResourceAllocation } = dependencies;
  if (!isInsideContainer()) throw new Error('Open this faucet inside a Polkadot host to connect your app and prove personhood.');
  if (devnet_asset_hub.genesis !== ASSET_HUB_GENESIS) throw new Error('The SDK descriptor does not match Paseo Asset Hub.');
  const client = await createChainClient({ chains: { assetHub: devnet_asset_hub } });
  const signerManager = new SignerManager({ dappName: productId, ss58Prefix: 0 });
  try {
    const connected = await signerManager.connect();
    if (!connected.ok) throw connected.error;
    const account = await signerManager.getProductAccount(productId, 0);
    if (!account.ok) throw account.error;
    const productAccount = account.value;
    const signer = productAccount.getSigner();
    async function ensureFees() {
      // Public Paseo PGAS uses 10 decimal places. Keep a conservative 1-PGAS
      // fee/deposit buffer, rather than consuming a host allocation per click.
      const gas = await client.assetHub.query.Assets.Account.getValue(2000000000, productAccount.address, { at: 'best' });
      if ((gas?.balance ?? 0n) < 10_000_000_000n) await allocateFees(requestResourceAllocation);
    }
    const runtime = createContractRuntimeFromClient(client.raw.assetHub, devnet_asset_hub);
    const mapped = await isContractAccountMapped(runtime, productAccount.address);
    if (!mapped.ok) throw mapped.error;
    if (!mapped.value) {
      // Bootstrap fees before asking a new, zero-PAS account to sign its mapping.
      await ensureFees();
      const setup = await ensureContractAccountMapped(runtime, productAccount.address, signer);
      if (!setup.ok) throw setup.error;
    }
    const faucet = createContractFromClient(client.raw.assetHub, devnet_asset_hub, address, abi as AbiEntry[], {
      defaultOrigin: productAccount.address, defaultSigner: signer,
    });
    async function query<T>(method: string, ...args: unknown[]): Promise<T> {
      const result = await faucet[method].query(...args);
      if (!result.success) throw new Error(`${method}: ${errorText(result.value)}`);
      return result.value as T;
    }
    if (await query<string>('productId') !== productId) throw new Error('The faucet product name does not match this app.');
    if (await query<string>('DOMAIN') !== bytesToHex(new TextEncoder().encode('paseo-faucet:v1'))) {
      throw new Error('This frontend requires the v1 single-destination faucet contract. Update the ABI and integration for v2.');
    }
    let claiming = false;
    const service: FaucetService = {
      address: productAccount.address,
      async refresh(): Promise<Snapshot> {
        const epoch = await query<bigint>('currentEpoch');
        const [next, paused, cap, used, balances, destinations, lite, full] = await Promise.all([
          query<bigint>('nextEpochStart'), query<boolean>('paused'), query<number>('maxDripsPerEpoch'),
          query<number>('dripsInEpoch', epoch), query<[bigint, bigint]>('balances'),
          query<Destination[]>('destinations'), query<unknown>('tiers', 1), query<unknown>('tiers', 2),
        ]);
        return { epoch: BigInt(epoch), nextEpochStart: BigInt(next), paused, cap: Number(cap), used: Number(used),
          pasBalance: BigInt(balances[0]), pusdBalance: BigInt(balances[1]), destinations,
          lite: tierFrom(lite), full: tierFrom(full) };
      },
      async claim(destination, recipient, progress) {
        if (claiming) throw new Error('A claim is already in progress.');
        claiming = true;
        try {
          // Resource allocation must precede the first contract transaction for a zero-PAS signer.
          progress('Preparing transaction fees');
          await ensureFees();
          const keys = await signerManager.listRingVrfKeys('peopl.dot');
          if (!keys.ok) throw keys.error;
          // Retry proof preparation only. Never automatically resubmit an uncertain signed transaction.
          for (let attempt = 0; attempt < 2; attempt++) {
            const state = await service.refresh();
            if (state.epoch > 0xffffffffn) throw new Error('The faucet epoch exceeds the host’s proof index range.');
            const context = await query<Hex>('contextFor', state.epoch);
            const message = await query<Hex>('messageFor', state.epoch, destination, recipient);
            const proofContext = { productId, suffix: { tag: 'Index' as const, value: Number(state.epoch) } };
            const candidates: { tier: number; key: typeof keys.value[number]; ring: RingLocation }[] = [];
            for (const tier of [2, 1]) {
              const config = tier === 2 ? state.full : state.lite;
              if (!config.enabled) continue;
              const collection = bytesToHex(new TextEncoder().encode((tier === 2 ? 'pop:polkadot.network/people' : 'pop:polkadot.network/people-lite').padEnd(32, ' ')));
              for (const key of keys.value) {
                const ring = key.rings.find((ring) => ring.chainId.toLowerCase() === PEOPLE_GENESIS
                  && ring.junctions.length === 2 && ring.junctions[0].tag === 'PalletInstance' && ring.junctions[0].value === 67
                  && ring.junctions[1].tag === 'CollectionId' && ring.junctions[1].value.toLowerCase() === collection);
                if (ring) { candidates.push({ tier, key, ring }); break; }
              }
            }
            if (!candidates.length) throw new Error('No supported personhood key is available. The host must allow this faucet to use your People or People Lite proof.');
            let selected: { tier: number; proof: Awaited<ReturnType<typeof signerManager.createRingVRFProof>> & { ok: true }; alias: Hex } | undefined;
            let rejection = 'No eligible personhood tier is available.';
            for (const candidate of candidates) {
              const blocked = claimBlocker(state, destination, candidate.tier === 2 ? state.full : state.lite);
              if (blocked) { rejection = blocked; continue; }
              progress('Proving personhood');
              const proof = await signerManager.createRingVRFProof(candidate.key.handle, proofContext, candidate.ring, hexToBytes(message));
              if (!proof.ok) {
                if (/NotMember|NotAMember/i.test(errorText(proof.error))) continue;
                throw proof.error; // Permission failures must not be hidden by a tier fallback.
              }
              if (!bytesEqual(proof.value.contextualAlias.context, context)) throw new Error('The host proof context does not match the faucet.');
              const alias = bytesToHex(proof.value.contextualAlias.alias);
              if (await query<boolean>('hasClaimed', state.epoch, candidate.tier, alias)) {
                rejection = 'You have already claimed this period. Choose “Refresh” to see when the next period starts.';
                continue;
              }
              selected = { tier: candidate.tier, proof, alias }; break;
            }
            if (!selected) throw new Error(rejection);
            if (BigInt(await query<bigint>('currentEpoch')) !== state.epoch) continue;
            const { proof, alias, tier } = selected;
            const args = [tier, destination, recipient, encodeProof(proof.value.proof), alias, proof.value.ringIndex, proof.value.ringRevision];
            progress('Checking your claim');
            const dry = await faucet.drip.query(...args);
            if (!dry.success) {
              const text = errorText(dry.value);
              if (attempt === 0 && text.includes('InvalidProof')) continue;
              throw new Error(text);
            }
            const payout = tier === 2 ? state.full : state.lite;
            const target = state.destinations.find(d => d.id === destination)!;
            progress(`Confirm ${formatAmount(payout.pas - target.remoteFee, 10)} PAS${target.pusdTransfer !== 0 ? ` + ${formatAmount(payout.pusd, 6)} pUSD` : ''} to ${recipient} on chain ${destination} in your Polkadot app`);
            const result = await faucet.drip.tx(...args, { signer, waitFor: 'finalized' });
            if (!result.ok) throw result.error;
            return { txHash: result.value.txHash, destination, recipient };
          }
          throw new Error('The period or proof changed while preparing the claim. Please try again.');
        } finally { claiming = false; }
      },
      destroy() { signerManager.destroy(); client.destroy(); },
    };
    return service;
  } catch (error) { signerManager.destroy(); client.destroy(); throw error; }
}
