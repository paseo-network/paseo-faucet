import { bytesToHex, decodeEventLog, hexToBytes, type Abi, type Hex } from 'viem';
import { createChainClient } from '@parity/product-sdk-chain-client';
import { devnet_asset_hub } from '@parity/product-sdk-descriptors/devnet-asset-hub';
import { QUERY_FALLBACK_ORIGIN, createContractFromClient, createContractRuntimeFromClient, isContractAccountMapped, ensureContractAccountMapped, type AbiEntry, type ContractRuntime } from '@parity/product-sdk-contracts';
import { SignerManager } from '@parity/product-sdk-signer';
import { formatHostError, getAccountsProvider, isInsideContainer, requestResourceAllocation, type RingLocation } from '@parity/product-sdk-host';
import abi from './faucet.abi.json';
import { ASSET_HUB_GENESIS, PEOPLE_GENESIS, SKIP_REASONS, bytesEqual, chainInfo, claimBlocker, encodeProof, planPayouts, type Destination, type FaucetHost, type FaucetService, type Payout, type Skipped, type Snapshot, type TierConfig } from './model';

const SIGN_IN = 'Sign in to this Polkadot host with your Polkadot app, then connect again.';
/** How long a chain read may take. */
const READ_TIMEOUT_MS = 60_000;
/** How long a host call that may wait for the person's approval in the Polkadot app may take. */
const APPROVAL_TIMEOUT_MS = 120_000;
/** How long the host's sign-in, such as pairing the Polkadot app, may take. */
const SIGN_IN_TIMEOUT_MS = 300_000;
/** How long connecting waits for the host to check a personhood key's ring membership. */
const MEMBERSHIP_TIMEOUT_MS = 20_000;

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
}
/** Rejects, naming the step, unless `promise` settles within `ms`. */
function within<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${step} took too long. Please try again.`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}
// product-sdk-contracts returns a function's several named outputs as an object keyed by name.
function tierFrom(value: unknown): TierConfig {
  const tier = value as { enabled: boolean; pas: bigint; pusd: bigint };
  return { enabled: tier.enabled, pas: BigInt(tier.pas), pusd: BigInt(tier.pusd) };
}
/** The tags of a host error, outermost first, such as `Domain`, `V1`, `NotConnected`. */
function hostTags(error: unknown): string[] {
  const tags: string[] = [];
  let value = error instanceof Error ? error.cause : error;
  while (value && typeof value === 'object' && tags.length < 8) {
    const { tag, value: inner } = value as { tag?: unknown; value?: unknown };
    if (typeof tag === 'string') tags.push(tag);
    value = inner;
  }
  return tags;
}
/** A host refusal of personhood keys or proofs in words; any other error as it is. */
function keyRefusal(error: unknown): Error {
  const tags = hostTags(error);
  if (tags.includes('NotConnected')) return new Error(SIGN_IN);
  if (tags.includes('NotAllowlisted')) return new Error('This Polkadot host does not allow the faucet to use your personhood proof yet.');
  if (tags.includes('Rejected')) return new Error('The personhood proof was declined in the Polkadot host.');
  return error instanceof Error ? error : new Error(errorText(error));
}
/** The faucet's `Dripped` and `DripSkipped` events among a transaction's events. */
export function claimOutcome(events: unknown[], address: Hex): { paid: Payout[]; skipped: Skipped[] } {
  const paid: Payout[] = [];
  const skipped: Skipped[] = [];
  for (const event of events as { type?: string; value?: { type?: string; value?: { contract: Hex; data: Uint8Array; topics: Hex[] } } }[]) {
    const emitted = event.type === 'Revive' && event.value?.type === 'ContractEmitted' ? event.value.value : undefined;
    if (!emitted || emitted.contract.toLowerCase() !== address.toLowerCase()) continue;
    const log = decodeEventLog({ abi: abi as Abi, data: bytesToHex(emitted.data), topics: emitted.topics as [Hex, ...Hex[]] });
    const args = log.args as unknown as Record<string, unknown>;
    if (log.eventName === 'Dripped') paid.push({ id: Number(args.destinationId), pas: BigInt(args.pas as bigint), pusd: BigInt(args.pusd as bigint) });
    if (log.eventName === 'DripSkipped') skipped.push({ id: Number(args.destinationId), reason: SKIP_REASONS[Number(args.reason)] as Skipped['reason'] });
  }
  return { paid, skipped };
}
const defaultDependencies = {
  createChainClient, SignerManager, isInsideContainer, getAccountsProvider, createContractFromClient,
  createContractRuntimeFromClient, isContractAccountMapped, ensureContractAccountMapped, requestResourceAllocation,
};
export type FaucetDependencies = typeof defaultDependencies;

/**
 * The key's People (tier 2) or People Lite (tier 1) ring on Paseo People, if it has one. Matched by chain and
 * collection: hosts differ on whether a ring names the Members pallet, and the proof uses the ring as declared.
 */
function ringOf(key: { rings: readonly RingLocation[] }, tier: number): RingLocation | undefined {
  const collection = bytesToHex(new TextEncoder().encode((tier === 2 ? 'pop:polkadot.network/people' : 'pop:polkadot.network/people-lite').padEnd(32, ' ')));
  return key.rings.find((ring) => ring.chainId.toLowerCase() === PEOPLE_GENESIS
    && ring.junctions.some((junction) => junction.tag === 'CollectionId' && junction.value.toLowerCase() === collection));
}

async function allocateFees(request = requestResourceAllocation) {
  const allocation = await within(request([{ tag: 'SmartContractAllowance', value: { tag: 'Index', value: 0 } }]), APPROVAL_TIMEOUT_MS, 'Preparing transaction fees');
  if (!allocation.ok) throw allocation.error;
  if (allocation.value[0] === 'Rejected') throw new Error('PGAS for the claim was declined in the Polkadot host.');
  if (allocation.value[0] !== 'Allocated') throw new Error('This host cannot provide PGAS for the claim. Try a supported Polkadot host.');
}

function openClient(create: FaucetDependencies['createChainClient']) {
  return create({ chains: { assetHub: devnet_asset_hub } });
}
/** What the faucet, open to anyone, shares with a signed-in account's claims. */
interface Reader {
  address: Hex;
  productId: string;
  /** The personhood product that holds People and People Lite keys. */
  personhood: string;
  client: Awaited<ReturnType<typeof openClient>>;
  runtime: ContractRuntime;
  query<T>(method: string, ...args: unknown[]): Promise<T>;
  refresh(): Promise<Snapshot>;
}

/**
 * Opens the faucet through the Polkadot host, or returns `null` outside one. Reading it needs nobody signed in;
 * claiming needs the account `connect` returns. Never calls the legacy faucet backend.
 */
export async function openFaucet(address: Hex, productId: string, dependencies: FaucetDependencies = defaultDependencies): Promise<FaucetHost | null> {
  const { createChainClient, isInsideContainer, getAccountsProvider, createContractFromClient, createContractRuntimeFromClient } = dependencies;
  if (!(await isInsideContainer())) return null;
  const accounts = await getAccountsProvider();
  if (!accounts) return null;
  if (devnet_asset_hub.genesis !== ASSET_HUB_GENESIS) throw new Error('The SDK descriptor does not match Paseo Asset Hub.');
  const client = await openClient(createChainClient);
  const subscriptions = new Set<{ unsubscribe(): void }>();
  try {
    const faucet = createContractFromClient(client.raw.assetHub, devnet_asset_hub, address, abi as AbiEntry[], { defaultOrigin: QUERY_FALLBACK_ORIGIN });
    async function query<T>(method: string, ...args: unknown[]): Promise<T> {
      const result = await within(faucet[method].query(...args), READ_TIMEOUT_MS, 'Reading the faucet');
      if (!result.success) throw new Error(`${method}: ${errorText(result.value)}`);
      return result.value as T;
    }
    if (await query<string>('productId') !== productId) throw new Error('The faucet product name does not match this app.');
    if (await query<string>('DOMAIN') !== bytesToHex(new TextEncoder().encode('paseo-faucet:v2'))) {
      throw new Error('This frontend requires the paseo-faucet:v2 contract. Update the ABI and integration for another version.');
    }
    const reader: Reader = {
      address, productId, client, query,
      // The TLD belongs to the network, so the personhood product shares this product's.
      personhood: `peopl.${productId.slice(productId.lastIndexOf('.') + 1)}`,
      runtime: createContractRuntimeFromClient(client.raw.assetHub, devnet_asset_hub),
      async refresh(): Promise<Snapshot> {
        const epoch = await query<bigint>('currentEpoch');
        const [next, paused, cap, used, balances, destinations, lite, full] = await Promise.all([
          query<bigint>('nextEpochStart'), query<boolean>('paused'), query<number>('maxDripsPerEpoch'),
          query<number>('dripsInEpoch', epoch), query<{ pas: bigint; pusd: bigint }>('balances'),
          query<Destination[]>('destinations'), query<unknown>('tiers', 1), query<unknown>('tiers', 2),
        ]);
        return { epoch: BigInt(epoch), nextEpochStart: BigInt(next), paused, cap: Number(cap), used: Number(used),
          pasBalance: BigInt(balances.pas), pusdBalance: BigInt(balances.pusd), destinations,
          lite: tierFrom(lite), full: tierFrom(full) };
      },
    };
    return {
      refresh: reader.refresh,
      connect: () => connectAccount(reader, dependencies),
      async signIn() {
        const outcome = await within(accounts.requestLogin('Sign in to claim Paseo test tokens.').match(
          (response) => ({ response }),
          (error) => ({ error }),
        ), SIGN_IN_TIMEOUT_MS, 'Signing in');
        if ('response' in outcome) return outcome.response !== 'Rejected';
        // A host that predates the call leaves signing in to its own controls.
        if (hostTags(outcome.error).includes('Unsupported')) throw new Error(SIGN_IN);
        throw new Error(`Sign-in failed: ${formatHostError(outcome.error)}`);
      },
      onSignInChange(callback) {
        const subscription = accounts.subscribeAccountConnectionStatus((status) => callback(status === 'Connected'));
        subscriptions.add(subscription);
        return () => { subscriptions.delete(subscription); subscription.unsubscribe(); };
      },
      destroy() {
        for (const subscription of subscriptions) subscription.unsubscribe();
        subscriptions.clear();
        client.destroy();
      },
    };
  } catch (error) { client.destroy(); throw error; }
}

/**
 * The signed-in person's product account, or `null` when nobody is signed in to the host. Fees and account setup wait
 * for the first claim.
 */
async function connectAccount(reader: Reader, dependencies: FaucetDependencies): Promise<FaucetService | null> {
  const { address, productId, personhood, client, runtime, query, refresh } = reader;
  const { SignerManager, createContractFromClient, isContractAccountMapped, ensureContractAccountMapped, requestResourceAllocation } = dependencies;
  const signerManager = new SignerManager({ dappName: productId, ss58Prefix: 0 });
  try {
    const connected = await within(signerManager.connect(), APPROVAL_TIMEOUT_MS, 'Connecting to the Polkadot host');
    if (!connected.ok) throw connected.error;
    const account = await within(signerManager.getProductAccount(productId, 0), APPROVAL_TIMEOUT_MS, 'Connecting to the Polkadot host');
    if (!account.ok) {
      if (hostTags(account.error).includes('NotConnected')) { signerManager.destroy(); return null; }
      throw account.error;
    }
    const productAccount = account.value;
    const signer = productAccount.getSigner();
    async function ensureFees() {
      // Public Paseo PGAS uses 10 decimal places. Keep a conservative 1-PGAS
      // fee/deposit buffer, rather than consuming a host allocation per click.
      const gas = await within(client.assetHub.query.Assets.Account.getValue(2000000000, productAccount.address, { at: 'best' }), READ_TIMEOUT_MS, 'Preparing transaction fees');
      if ((gas?.balance ?? 0n) < 10_000_000_000n) await allocateFees(requestResourceAllocation);
    }
    let mapped = false;
    async function prepareAccount(progress: (message: string) => void) {
      // Bootstrap fees before asking a new, zero-PAS account to sign its mapping.
      progress('Preparing transaction fees');
      await ensureFees();
      if (mapped) return;
      const check = await within(isContractAccountMapped(runtime, productAccount.address), READ_TIMEOUT_MS, 'Preparing transaction fees');
      if (!check.ok) throw check.error;
      if (!check.value) {
        progress('Confirm the one-time account setup in your Polkadot app');
        const setup = await ensureContractAccountMapped(runtime, productAccount.address, signer);
        if (!setup.ok) throw setup.error;
        progress('Preparing transaction fees');
        await ensureFees();
      }
      mapped = true;
    }
    const faucet = createContractFromClient(client.raw.assetHub, devnet_asset_hub, address, abi as AbiEntry[], {
      defaultOrigin: productAccount.address, defaultSigner: signer,
    });
    const listed = await within(signerManager.listRingVrfKeys(personhood), APPROVAL_TIMEOUT_MS, 'Reading your personhood keys');
    const heldKeys = listed.ok ? listed.value : [];
    const heldTiers = [2, 1].filter((tier) => heldKeys.some((key) => ringOf(key, tier)));
    /** Whether the host reports the tier's key a member of its ring; undefined when it cannot tell. */
    async function isMember(tier: number, epoch: bigint): Promise<boolean | undefined> {
      const key = heldKeys.find((k) => ringOf(k, tier))!;
      const context = { productId, suffix: { tag: 'Index' as const, value: Number(epoch) } };
      try {
        // The host derives a contextual alias only for a ring member, and without creating a proof.
        const alias = await within(signerManager.getProductAccountAlias(key.handle, context, ringOf(key, tier)!), MEMBERSHIP_TIMEOUT_MS, 'Checking your personhood');
        if (alias.ok) return true;
        return hostTags(alias.error).includes('NotMember') ? false : undefined;
      } catch { return undefined; }
    }
    const notMemberTiers: number[] = [];
    let memberConfirmed = false;
    if (heldTiers.length) {
      const epoch = await query<bigint>('currentEpoch');
      for (const tier of [...heldTiers]) {
        const member = await isMember(tier, epoch);
        if (member === false) { heldTiers.splice(heldTiers.indexOf(tier), 1); notMemberTiers.push(tier); continue; }
        memberConfirmed = member === true;
        break;
      }
    }
    let claiming = false;
    const service: FaucetService = {
      address: productAccount.address,
      heldTiers,
      memberConfirmed,
      notMemberTiers,
      async claim(recipient, progress) {
        if (claiming) throw new Error('A claim is already in progress.');
        claiming = true;
        try {
          // Resource allocation must precede the first contract transaction for a zero-PAS signer.
          await prepareAccount(progress);
          const keys = await within(signerManager.listRingVrfKeys(personhood), APPROVAL_TIMEOUT_MS, 'Reading your personhood keys');
          if (!keys.ok) throw keyRefusal(keys.error);
          // Retry proof preparation only. Never automatically resubmit an uncertain signed transaction.
          for (let attempt = 0; attempt < 2; attempt++) {
            const state = await refresh();
            if (state.epoch > 0xffffffffn) throw new Error('The faucet epoch exceeds the host’s proof index range.');
            const context = await query<Hex>('contextFor', state.epoch);
            const message = await query<Hex>('messageFor', state.epoch, recipient);
            const proofContext = { productId, suffix: { tag: 'Index' as const, value: Number(state.epoch) } };
            const candidates: { tier: number; key: typeof keys.value[number]; ring: RingLocation }[] = [];
            for (const tier of [2, 1]) {
              const config = tier === 2 ? state.full : state.lite;
              if (!config.enabled || !service.heldTiers.includes(tier)) continue;
              for (const key of keys.value) {
                const ring = ringOf(key, tier);
                if (ring) { candidates.push({ tier, key, ring }); break; }
              }
            }
            if (!candidates.length) throw new Error('No supported personhood key is available. The host must allow this faucet to use your People or People Lite proof.');
            let selected: { tier: number; proof: Awaited<ReturnType<typeof signerManager.createRingVRFProof>> & { ok: true }; alias: Hex; due: Destination[] } | undefined;
            let rejection = 'No eligible personhood tier is available.';
            for (const candidate of candidates) {
              const blocked = claimBlocker(state, candidate.tier === 2 ? state.full : state.lite);
              if (blocked) { rejection = blocked; continue; }
              progress('Proving personhood');
              const proof = await within(signerManager.createRingVRFProof(candidate.key.handle, proofContext, candidate.ring, hexToBytes(message)), APPROVAL_TIMEOUT_MS, 'Proving personhood');
              if (!proof.ok) {
                if (hostTags(proof.error).includes('NotMember')) {
                  service.heldTiers = service.heldTiers.filter((tier) => tier !== candidate.tier);
                  service.notMemberTiers = [...service.notMemberTiers, candidate.tier];
                  service.memberConfirmed = false;
                  continue;
                }
                throw keyRefusal(proof.error); // Permission failures must not be hidden by a tier fallback.
              }
              if (!bytesEqual(proof.value.contextualAlias.context, context)) throw new Error('The host proof context does not match the faucet.');
              if (candidate.tier === service.heldTiers[0]) service.memberConfirmed = true;
              const alias = bytesToHex(proof.value.contextualAlias.alias);
              const enabled = state.destinations.filter((d) => d.enabled);
              const claimed = await Promise.all(enabled.map((d) => query<boolean>('hasClaimed', state.epoch, candidate.tier, alias, d.id)));
              const due = enabled.filter((_, i) => !claimed[i]);
              if (!due.length) {
                rejection = 'You have already claimed this period. Choose “Refresh” to see when the next period starts.';
                continue;
              }
              selected = { tier: candidate.tier, proof, alias, due }; break;
            }
            if (!selected) throw new Error(rejection);
            if (BigInt(await query<bigint>('currentEpoch')) !== state.epoch) continue;
            const { proof, alias, tier, due } = selected;
            const args = [tier, recipient, encodeProof(proof.value.proof), alias, proof.value.ringIndex, proof.value.ringRevision];
            progress('Checking your claim');
            const dry = await within(faucet.drip.query(...args), READ_TIMEOUT_MS, 'Checking your claim');
            if (!dry.success) {
              const text = errorText(dry.value);
              if (attempt === 0 && text.includes('InvalidProof')) continue;
              throw new Error(text);
            }
            const { paid } = planPayouts(due, state, tier === 2 ? state.full : state.lite);
            progress(`Confirm the claim to ${recipient} on ${paid.map((p) => chainInfo(p.id).name).join(', ')} in your Polkadot app`);
            const result = await faucet.drip.tx(...args, {
              signer, waitFor: 'finalized',
              onStatus: (status: string) => {
                if (status === 'broadcasting') progress('Submitting the claim');
                if (status === 'in-block') progress('Waiting for finality');
              },
            });
            if (!result.ok) throw result.error;
            return { txHash: result.value.txHash, recipient, ...claimOutcome(result.value.events, address) };
          }
          throw new Error('The period or proof changed while preparing the claim. Please try again.');
        } finally { claiming = false; }
      },
      destroy() { signerManager.destroy(); },
    };
    return service;
  } catch (error) { signerManager.destroy(); throw error; }
}
