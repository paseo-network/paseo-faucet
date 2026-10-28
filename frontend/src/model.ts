import { getSs58AddressInfo } from 'polkadot-api';
import { bytesToHex, hexToBytes, type Hex } from 'viem';

export const ASSET_HUB = 1000;
export const ASSET_HUB_GENESIS = '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2';
export const PEOPLE_GENESIS = '0xe6c30d6e148f250b887105237bcaa5cb9f16dd203bf7b5b9d4f1da7387cb86ec';
/** `explorer` is a block explorer for the chain, where one exists. */
export interface Chain { id: number; name: string; explorer?: string; }
const CHAINS: Chain[] = [
  { id: 0, name: 'Paseo Relay', explorer: 'https://paseo.subscan.io' },
  { id: 1000, name: 'Asset Hub', explorer: 'https://assethub-paseo.subscan.io' },
  { id: 1004, name: 'People' },
  { id: 1010, name: 'Bulletin' },
  { id: 1500, name: 'Asset Hub Next' },
  { id: 1501, name: 'Bulletin Next' },
  { id: 1502, name: 'People Next' },
];
/** Display data for a para id. Which chains a claim pays comes from the contract, not from this list. */
export function chainInfo(id: number): Chain {
  return CHAINS.find((chain) => chain.id === id) ?? { id, name: `Parachain ${id}` };
}
export interface Destination {
  id: number; enabled: boolean; pasTransfer: number; pusdTransfer: number;
  remoteFee: bigint; maxDeliveryFee: bigint; minPas: bigint; minPusd: bigint;
}
export interface TierConfig { enabled: boolean; pas: bigint; pusd: bigint; }
export interface Snapshot {
  epoch: bigint; nextEpochStart: bigint; paused: boolean; cap: number; used: number;
  pasBalance: bigint; pusdBalance: bigint; destinations: Destination[];
  lite: TierConfig; full: TierConfig;
}
/** The contract's `Skip` reasons, indexed by their enum value. */
export const SKIP_REASONS = ['None', 'BelowMinimum', 'InsufficientPas', 'PayoutFailed'] as const;
export type SkipReason = Exclude<(typeof SKIP_REASONS)[number], 'None'>;
/** One destination's payout; `pas` is the gross amount, as `Dripped` reports it. */
export interface Payout { id: number; pas: bigint; pusd: bigint; }
export interface Skipped { id: number; reason: SkipReason; }
export interface Receipt { txHash: string; recipient: Hex; paid: Payout[]; skipped: Skipped[]; }
/** The faucet through a Polkadot host: anyone can read it, a signed-in person can claim. */
export interface FaucetHost {
  refresh(): Promise<Snapshot>;
  /** The signed-in person's account, or `null` while nobody is signed in to the host. */
  connect(): Promise<FaucetService | null>;
  /** Asks the host to show its sign-in, such as the code that pairs the Polkadot app; false if the person cancels it. */
  signIn(): Promise<boolean>;
  /** Calls back whenever someone signs in to or out of the host; returns the unsubscribe. */
  onSignInChange(callback: (signedIn: boolean) => void): () => void;
  destroy(): void;
}
export interface FaucetService {
  address: string;
  /**
   * The tiers the person holds a personhood key for, full (2) before lite (1), without those whose key the host reports is
   * not a member of its ring, at connecting or at a claim.
   */
  heldTiers: number[];
  /** Whether the host confirmed that the first held tier's key is a ring member, so a claim pays that tier. */
  memberConfirmed: boolean;
  /** The tiers whose key the host reports is not a member of its ring yet, such as a full personhood still onboarding. */
  notMemberTiers: number[];
  claim(recipient: Hex, progress: (message: string) => void): Promise<Receipt>;
  destroy(): void;
}

/** Decodes an SS58 address, an AccountId32 or an H160 (as its `0xEE` account) to an AccountId32. */
export function parseRecipient(value: string): Hex {
  const input = value.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) return `${input.toLowerCase()}${'ee'.repeat(12)}` as Hex;
  if (/^0x[0-9a-fA-F]{64}$/.test(input)) return input.toLowerCase() as Hex;
  try {
    const info = getSs58AddressInfo(input);
    if (info.isValid) return bytesToHex(info.publicKey);
  } catch { /* Show the actionable address error below. */ }
  throw new Error('Enter a valid Substrate or Ethereum address.');
}

/** An Ethereum-derived account can only be used on Asset Hub, the one destination with an EVM. */
export function isEthereumDerived(account: Hex): boolean {
  return account.slice(-24).toLowerCase() === 'ee'.repeat(12);
}

/** Runtime expects SCALE BoundedVec, while the host returns raw proof bytes. */
export function encodeProof(raw: Uint8Array): Hex {
  if (raw.length === 0 || raw.length > 1265) throw new Error('The host returned an invalid proof length.');
  const length = raw.length < 64 ? Uint8Array.of(raw.length << 2)
    : Uint8Array.of(((raw.length << 2) | 1) & 255, raw.length >> 6);
  return bytesToHex(new Uint8Array([...length, ...raw]));
}

export function formatAmount(value: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const integer = (value / divisor).toLocaleString('en-US');
  const fraction = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return integer + (fraction ? `.${fraction}` : '');
}

/**
 * What a claim would pay each enabled destination, in registry order, by the contract's rules: a destination is
 * skipped below its `minPas` or when the faucet cannot cover the drip plus its `maxDeliveryFee`, and gets pUSD only
 * where it takes pUSD, the amount reaches its `minPusd` and the faucet holds it. Advisory: balances move.
 */
export function planPayouts(destinations: Destination[], state: Snapshot, tier: TierConfig): { paid: Payout[]; skipped: Skipped[] } {
  let pas = state.pasBalance;
  let pusd = state.pusdBalance;
  const paid: Payout[] = [];
  const skipped: Skipped[] = [];
  for (const d of destinations) {
    if (!d.enabled) continue;
    if (tier.pas < d.minPas) { skipped.push({ id: d.id, reason: 'BelowMinimum' }); continue; }
    if (pas < tier.pas + d.maxDeliveryFee) { skipped.push({ id: d.id, reason: 'InsufficientPas' }); continue; }
    const withPusd = d.pusdTransfer !== 0 && tier.pusd >= d.minPusd && pusd >= tier.pusd;
    pas -= tier.pas + d.maxDeliveryFee;
    if (withPusd) pusd -= tier.pusd;
    paid.push({ id: d.id, pas: tier.pas, pusd: withPusd ? tier.pusd : 0n });
  }
  return { paid, skipped };
}

/** The PAS a recipient receives at least: the drip, less the destination's execution fee budget. */
export function netPas(payout: Payout, destinations: Destination[]): bigint {
  const fee = destinations.find((d) => d.id === payout.id)?.remoteFee ?? 0n;
  return payout.pas > fee ? payout.pas - fee : 0n;
}

export function claimBlocker(state: Snapshot, tier: TierConfig): string | null {
  if (state.paused) return 'The faucet is paused. Please try again later.';
  if (!tier.enabled) return 'Claims for this personhood tier are temporarily disabled.';
  if (state.used >= state.cap) return 'All claims for this period have been used. Try again next period.';
  if (!state.destinations.some((d) => d.enabled)) return 'No chain is open for claims right now.';
  const { paid, skipped } = planPayouts(state.destinations, state, tier);
  if (paid.length) return null;
  if (skipped.every((s) => s.reason === 'BelowMinimum')) return 'This payout is below every chain’s minimum balance.';
  return 'The faucet needs a refill. Please try again later.';
}

export function bytesEqual(a: Uint8Array, hex: Hex): boolean {
  const b = hexToBytes(hex);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
